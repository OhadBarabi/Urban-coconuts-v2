import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

// --- Import Models ---
import { Order, OrderStatus, Box } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { logSystemActivity } from '../utils/logging'; // Using mock below

// --- Mocks ---
// async function logSystemActivity(actionType: string, details: object): Promise<void> { logger.info(`[Mock System Log] Action: ${actionType}`, details); } // Imported
// --- End Mocks ---

// --- Configuration ---
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    NotFound = "NOT_FOUND", // Order or Box not found
    FailedPrecondition = "FAILED_PRECONDITION", // Order not cancelled or already processed
    Aborted = "ABORTED", // Transaction failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    OrderNotFound = "ORDER_NOT_FOUND",
    BoxNotFound = "BOX_NOT_FOUND",
    OrderNotCancelled = "ORDER_NOT_CANCELLED",
    SideEffectsAlreadyProcessed = "SIDE_EFFECTS_ALREADY_PROCESSED",
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- The Background Function (Triggered by Firestore update) ---
// Triggered when an order document is updated, specifically looking for status change to 'Cancelled'.
export const handleOrderCancellationSideEffects = functions.firestore
    .document('orders/{orderId}')
    .region(FUNCTION_REGION)
    .onUpdate(async (change, context): Promise<void> => {
        const functionName = "[handleOrderCancellationSideEffects V1]";
        const orderId = context.params.orderId;
        const beforeData = change.before.data() as Order | undefined;
        const afterData = change.after.data() as Order | undefined;
        const logContext = { functionName, trigger: "Firestore", orderId };

        if (!afterData) {
            logger.info(`${functionName} Order ${orderId} deleted. No action needed.`, logContext);
            return;
        }

        const beforeStatus = beforeData?.status;
        const afterStatus = afterData.status;
        logContext.beforeStatus = beforeStatus;
        logContext.afterStatus = afterStatus;
        logContext.sideEffectsProcessed = afterData.cancellationSideEffectsProcessed;

        // --- Trigger Condition ---
        // Run only if status changed TO 'Cancelled' AND side effects haven't been processed yet.
        if (afterStatus !== OrderStatus.Cancelled || beforeStatus === OrderStatus.Cancelled || afterData.cancellationSideEffectsProcessed === true) {
            // logger.debug(`${functionName} Conditions not met. No action needed.`, logContext);
            return;
        }

        logger.info(`${functionName} Processing cancelled order ${orderId} to handle side effects...`, logContext);

        const boxId = afterData.boxId;
        const itemsToReturn = afterData.items;

        if (!boxId || !itemsToReturn || itemsToReturn.length === 0) {
            logger.warn(`${functionName} Order ${orderId} is missing boxId or items. Cannot restore inventory. Marking as processed to prevent retries.`, logContext);
            try {
                await change.after.ref.update({ cancellationSideEffectsProcessed: true, updatedAt: FieldValue.serverTimestamp() });
            } catch (updateError) {
                logger.error(`${functionName} Failed to mark order ${orderId} as processed after missing data issue.`, { ...logContext, updateError });
            }
            return;
        }
        logContext.boxId = boxId;
        logContext.itemCount = itemsToReturn.length;

        // --- Firestore Transaction to Restore Inventory and Mark Order ---
        const boxRef = db.collection('boxes').doc(boxId);
        const orderRef = change.after.ref; // Reference to the updated order document

        try {
            logger.info(`${functionName} Starting Firestore transaction for order ${orderId}...`, logContext);
            await db.runTransaction(async (transaction) => {
                // Re-read order and box data within transaction
                const orderTxSnap = await transaction.get(orderRef);
                const boxTxSnap = await transaction.get(boxRef);

                if (!orderTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.OrderNotFound}`);
                if (!boxTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}::${boxId}`);

                const orderTxData = orderTxSnap.data() as Order;

                // Double-check conditions within transaction
                if (orderTxData.status !== OrderStatus.Cancelled) {
                    logger.warn(`${functionName} TX Conflict: Order ${orderId} status is no longer 'Cancelled' (${orderTxData.status}). Aborting side effects.`, logContext);
                    return; // Abort gracefully
                }
                if (orderTxData.cancellationSideEffectsProcessed === true) {
                    logger.warn(`${functionName} TX Conflict: Side effects for order ${orderId} already processed. Aborting.`, logContext);
                    return; // Abort gracefully
                }

                // --- Prepare Inventory Updates ---
                const inventoryUpdates: { [key: string]: admin.firestore.FieldValue } = {};
                itemsToReturn.forEach(item => {
                    if (item.productId && item.quantity > 0) {
                        inventoryUpdates[`inventory.${item.productId}`] = FieldValue.increment(item.quantity); // Add back the quantity
                    } else {
                        logger.warn(`${functionName} Skipping inventory return for invalid item in order ${orderId}.`, { ...logContext, item });
                    }
                });

                // --- Prepare Order Update ---
                const orderUpdate = {
                    cancellationSideEffectsProcessed: true, // Mark as processed
                    updatedAt: FieldValue.serverTimestamp() // Update timestamp
                };

                // --- Perform Writes ---
                if (Object.keys(inventoryUpdates).length > 0) {
                    logger.info(`${functionName} TX: Restoring inventory for ${Object.keys(inventoryUpdates).length} product types in box ${boxId}.`, logContext);
                    transaction.update(boxRef, inventoryUpdates);
                } else {
                    logger.warn(`${functionName} TX: No valid inventory updates to perform for order ${orderId}.`, logContext);
                }
                logger.info(`${functionName} TX: Marking order ${orderId} side effects as processed.`, logContext);
                transaction.update(orderRef, orderUpdate);

            }); // End Transaction
            logger.info(`${functionName} Transaction successful for order ${orderId}. Inventory restored and order marked.`, logContext);

            // Log system activity after successful transaction
            logSystemActivity("OrderCancellationSideEffectsSuccess", { orderId, boxId, itemsReturned: itemsToReturn.length })
                .catch(err => logger.error("Failed logging OrderCancellationSideEffectsSuccess system activity", { err })); // Fixed catch

        } catch (error: any) {
            logger.error(`${functionName} Failed to process side effects for cancelled order ${orderId}.`, { ...logContext, error: error.message, stack: error.stack });
            let finalErrorCode = ErrorCode.InternalError;
            let finalErrorMessage = "Failed to process cancellation side effects.";

            if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessage = `Transaction failed: ${finalErrorCode}`;
                 if (parts[2]) finalErrorMessage += ` (${parts[2]})`;
            }

            // Log failure
            logSystemActivity("OrderCancellationSideEffectsFailed", { orderId, boxId, error: error.message, errorCode: finalErrorCode })
                .catch(err => logger.error("Failed logging OrderCancellationSideEffectsFailed system activity", { err })); // Fixed catch

            // Consider retrying? Firestore triggers have built-in retry, but maybe flag the order?
            try {
                await orderRef.update({
                     processingError: `SideEffectsError: ${finalErrorMessage}`,
                     // Don't mark as processed if failed
                     updatedAt: FieldValue.serverTimestamp()
                });
            } catch (updateError) {
                 logger.error(`${functionName} Failed to update order ${orderId} with processing error after side effect failure.`, { ...logContext, updateError });
            }
        } finally {
             // No return value needed for background functions
             logger.info(`${functionName} Execution finished for order ${orderId}.`);
        }
    });

