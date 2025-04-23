import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

// --- Import Models ---
import { Order, OrderStatus, Box, OrderItem } from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { logAdminAction } from '../utils/logging'; // Log critical errors/actions

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

const functionConfig = {
    region: FUNCTION_REGION,
    memory: "256MiB" as const, // Relatively simple operation
    timeoutSeconds: 60,
    // ** IMPORTANT: Configure Pub/Sub retries & DLQ for this topic **
};

// Ensure this matches the Pub/Sub topic triggered by cancelOrder/updateOrderStatus(Cancelled)
const PUBSUB_TOPIC = "order-cancellation-side-effects"; // <<<--- CHANGE TO YOUR TOPIC NAME

// --- Enums ---
enum ErrorCode {
    OrderNotFound = "ORDER_NOT_FOUND",
    InvalidOrderStatus = "INVALID_ORDER_STATUS", // Not Cancelled
    BoxNotFound = "BOX_NOT_FOUND", // Box associated with order not found
    TransactionFailed = "TRANSACTION_FAILED",
    InternalError = "INTERNAL_ERROR",
}

// --- The Cloud Function (Pub/Sub Triggered - V2) ---
export const handleOrderCancellationSideEffects = functions.pubsub
    .topic(PUBSUB_TOPIC)
    .onMessagePublished(
        {
            ...functionConfig,
            // Ensure Pub/Sub Subscription has retry policy and Dead Letter Topic configured!
        },
        async (message): Promise<void> => {
            const functionName = "[handleOrderCancellationSideEffects V1]";
            const startTimeFunc = Date.now();
            const messageId = message.id;

            let orderId: string;
            let orderRef: admin.firestore.DocumentReference;
            const logContext: any = { messageId };

            try {
                // 1. Extract orderId & Fetch Order
                if (!message.json?.orderId || typeof message.json.orderId !== 'string') {
                    logger.error(`${functionName} Invalid Pub/Sub payload: Missing/invalid 'orderId'. ACK.`, { messageData: message.json, messageId });
                    return; // ACK bad format
                }
                orderId = message.json.orderId;
                logContext.orderId = orderId;
                logger.info(`${functionName} Invoked for order ${orderId}`, logContext);

                orderRef = db.collection('orders').doc(orderId);
                const orderSnap = await orderRef.get();

                if (!orderSnap.exists) {
                    logger.error(`${functionName} Order ${orderId}: Not found. ACK.`, logContext);
                    return; // ACK - order deleted?
                }
                const orderData = orderSnap.data() as Order;
                logContext.currentOrderStatus = orderData.status;
                logContext.customerId = orderData.customerId;
                logContext.boxId = orderData.boxId;

                // 2. Validate Status & Idempotency
                // Expecting 'Cancelled' status set by cancelOrder or updateOrderStatus
                if (orderData.status !== OrderStatus.Cancelled) {
                    logger.warn(`${functionName} Order ${orderId}: Invalid status '${orderData.status}'. Expected '${OrderStatus.Cancelled}'. ACK.`, logContext);
                    return; // ACK - Order not actually cancelled?
                }
                // Idempotency Check: Has this function already processed this order?
                if (orderData.cancellationSideEffectsProcessed === true) {
                     logger.info(`${functionName} Order ${orderId}: Cancellation side effects already processed. ACK.`, logContext);
                     return; // ACK - Already handled
                }

                // 3. Restore Inventory (Transactional)
                const boxId = orderData.boxId;
                if (!boxId) {
                    logger.error(`${functionName} Order ${orderId}: Missing boxId. Cannot restore inventory. Setting error flag.`, logContext);
                    await orderRef.update({ processingError: "Missing boxId for inventory restore", cancellationSideEffectsProcessed: true }).catch(err => logger.error("Failed update order processingError", {err}));
                    logAdminAction("CancelSideEffectFailed", { orderId, reason: "Missing boxId" });
                    return; // ACK
                }
                const boxRef = db.collection('boxes').doc(boxId);

                logger.info(`${functionName} Order ${orderId}: Starting transaction to restore inventory to box ${boxId}...`, logContext);
                await db.runTransaction(async (transaction) => {
                    const boxSnap = await transaction.get(boxRef);
                    if (!boxSnap.exists) {
                        // If box doesn't exist, we can't restore inventory. Log critical error.
                        throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}::${boxId}`);
                    }

                    const inventoryUpdates: { [key: string]: admin.firestore.FieldValue } = {};
                    let itemsRestored = 0;
                    orderData.items.forEach((item: OrderItem) => {
                        if (item.productId && item.quantity > 0) {
                            inventoryUpdates[`inventory.${item.productId}`] = FieldValue.increment(item.quantity);
                            itemsRestored += item.quantity;
                        } else {
                             logger.warn(`${functionName} Order ${orderId}: Skipping inventory restore for invalid item.`, { item });
                        }
                    });

                    if (itemsRestored > 0) {
                        logger.info(`${functionName} Order ${orderId}: Restoring ${itemsRestored} items to box ${boxId}.`, logContext);
                        // Update Box Inventory
                        transaction.update(boxRef, inventoryUpdates);
                    } else {
                        logger.info(`${functionName} Order ${orderId}: No valid items found to restore inventory for.`, logContext);
                    }

                    // Update Order: Mark side effects as processed
                    transaction.update(orderRef, {
                        cancellationSideEffectsProcessed: true,
                        processingError: null, // Clear previous errors if successful
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                }); // End Transaction
                logger.info(`${functionName} Order ${orderId}: Inventory restored and order marked as processed.`, logContext);

                // 4. Additional Side Effects (Optional)
                // - Notify courier if order was assigned (Yellow status before cancel)?
                // - Update analytics?
                // - Send customer final cancellation confirmation? (Maybe done in cancelOrder itself)

                logAdminAction("OrderCancelSideEffectsSuccess", { orderId });


            } catch (error: any) {
                // 5. Handle Errors
                const errorMessage = error.message || "An unknown internal error occurred.";
                let errorCode = ErrorCode.InternalError;
                let processingErrorMsg = `Internal error processing side effects: ${errorMessage.substring(0, 200)}`;

                if (error.message?.startsWith("TX_ERR::")) {
                    const parts = error.message.split('::');
                    const txErrCode = parts[1] as ErrorCode;
                    errorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                    processingErrorMsg = `Transaction failed (${errorCode}): ${parts[2] ?? errorMessage}`;
                }

                logger.error(`${functionName} Order ${orderId}: Failed to process cancellation side effects. Error Code: ${errorCode}`, { error: errorMessage, messageId });

                // Attempt to update order with error flag (best effort)
                try {
                    if (orderId) { // Ensure orderId is defined
                        await db.collection('orders').doc(orderId).update({
                            cancellationSideEffectsProcessed: true, // Mark as processed (even if failed) to avoid retries on persistent errors? Or false to retry? Let's mark true for now.
                            processingError: processingErrorMsg,
                            updatedAt: FieldValue.serverTimestamp()
                        });
                    }
                } catch (updateError: any) {
                    logger.error(`${functionName} Order ${orderId}: FAILED to update order status after side effect error.`, { updateError });
                }
                logAdminAction("OrderCancelSideEffectFailed", { orderId: orderId || 'Unknown', messageId: messageId, errorMessage: errorMessage, errorCode: errorCode }).catch(...);
                // Throw the original error to potentially trigger Pub/Sub retries for transient errors?
                // Or ACK to avoid loops if error is persistent (e.g., BoxNotFound)? Let's ACK.
                // throw error;
            }
            // Successful completion implicitly ACKs the message
             logger.info(`${functionName} Execution finished for order ${orderId}. Duration: ${Date.now() - startTimeFunc}ms`, { messageId });

        }); // End onMessagePublished
