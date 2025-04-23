import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, Order, OrderStatus, PaymentStatus, PaymentMethod
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions'; // Might not be needed if only owner can cancel
// import { voidAuthorization } from '../utils/payment_helpers'; // Payment gateway interaction
// import { triggerCancellationSideEffects } from '../utils/background_triggers'; // Background task trigger
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`, context); return userId != null; }
async function voidAuthorization(gatewayTransactionId: string): Promise<{ success: boolean; error?: string }> { logger.info(`[Mock Payment] Voiding Auth ${gatewayTransactionId}`); await new Promise(res => setTimeout(res, 500)); if (gatewayTransactionId.includes("fail_void")) { logger.error("[Mock Payment] Void FAILED."); return { success: false, error: "Mock Void Failed" }; } return { success: true }; }
async function triggerCancellationSideEffects(params: { orderId: string }): Promise<void> { logger.info(`[Mock Trigger] Triggering cancellation side effects for order ${params.orderId}`); }
interface AdminAlertParams { subject: string; body: string; orderId?: string; severity: "critical" | "warning" | "info"; }
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Order or User not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for cancellation
    Aborted = "ABORTED", // Payment Void failed or Transaction failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    OrderNotFound = "ORDER_NOT_FOUND",
    NotOrderOwner = "NOT_ORDER_OWNER",
    InvalidOrderStatus = "INVALID_ORDER_STATUS", // Not cancellable from this state
    PaymentVoidFailed = "PAYMENT_VOID_FAILED", // Critical failure during void attempt
    SideEffectTriggerFailed = "SIDE_EFFECT_TRIGGER_FAILED",
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- Interfaces ---
interface CancelOrderInput {
    orderId: string;
    reason?: string | null; // Optional reason from customer
}

// --- The Cloud Function ---
export const cancelOrder = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory for payment interaction + transaction
        timeoutSeconds: 60,
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // If voidAuthorization needs secret
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[cancelOrder (Customer) V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const customerId = request.auth.uid; // Customer cancelling their own order
        const data = request.data as CancelOrderInput;
        const logContext: any = { customerId, orderId: data?.orderId, reason: data?.reason };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.orderId || typeof data.orderId !== 'string') {
            logger.error(`${functionName} Invalid input: Missing orderId.`, logContext);
            return { success: false, error: "error.invalidInput.missingOrderId", errorCode: ErrorCode.InvalidArgument };
        }
        const { orderId, reason } = data;

        // --- Variables ---
        let orderData: Order;
        let voidFailed = false;
        let sideEffectsTriggerFailed = false;
        let finalPaymentStatus: PaymentStatus | string | null;

        try {
            // 3. Fetch Order Data
            const orderRef = db.collection('orders').doc(orderId);
            const orderSnap = await orderRef.get();

            if (!orderSnap.exists) {
                logger.warn(`${functionName} Order ${orderId} not found.`, logContext);
                return { success: false, error: "error.order.notFound", errorCode: ErrorCode.OrderNotFound };
            }
            orderData = orderSnap.data() as Order;
            logContext.currentStatus = orderData.status;
            logContext.orderCustomerId = orderData.customerId;
            logContext.paymentStatus = orderData.paymentStatus;

            // 4. Ownership Check
            if (orderData.customerId !== customerId) {
                logger.error(`${functionName} User ${customerId} attempted to cancel order ${orderId} owned by ${orderData.customerId}.`, logContext);
                return { success: false, error: "error.permissionDenied.notOrderOwner", errorCode: ErrorCode.NotOrderOwner };
            }

            // 5. State Validation (Can only cancel before it's ready/delivered?)
            // Allow cancellation from Red or Yellow status by customer?
            const cancellableStatuses: string[] = [
                OrderStatus.Red.toString(),
                OrderStatus.Yellow.toString(),
                // Maybe PendingCourier too, if applicable?
                PaymentStatus.PendingCourier.toString(),
            ];
            if (!cancellableStatuses.includes(orderData.status)) {
                logger.warn(`${functionName} Order ${orderId} cannot be cancelled by customer from status '${orderData.status}'.`, logContext);
                 // Idempotency: If already cancelled, return success
                 if (orderData.status === OrderStatus.Cancelled) {
                     logger.info(`${functionName} Order ${orderId} already cancelled. Idempotent success.`);
                     return { success: true };
                 }
                return { success: false, error: `error.order.invalidStatus.cancel::${orderData.status}`, errorCode: ErrorCode.InvalidOrderStatus };
            }

            // 6. Void Payment Authorization (if applicable)
            finalPaymentStatus = orderData.paymentStatus ?? PaymentStatus.Pending; // Start with current status
            const authTxId = orderData.authDetails?.gatewayTransactionId;
            if (orderData.paymentStatus === PaymentStatus.Authorized && authTxId) {
                logger.info(`${functionName} Order ${orderId}: Attempting to void payment authorization ${authTxId}...`, logContext);
                try {
                    const voidResult = await voidAuthorization(authTxId); // Replace mock
                    if (!voidResult.success) {
                        voidFailed = true;
                        finalPaymentStatus = PaymentStatus.VoidFailed;
                        logger.error(`${functionName} CRITICAL: Failed to void authorization ${authTxId} for cancelled order ${orderId}. Manual void required.`, { ...logContext, error: voidResult.error });
                        // Alert Admin
                        sendPushNotification({ subject: `Payment Void FAILED - Order ${orderId}`, body: `Failed to void auth ${authTxId} for order ${orderId} cancelled by customer. Manual void REQUIRED.`, orderId, severity: "critical" }).catch(...);
                        logAdminAction("OrderAuthVoidFailedDuringCancel", { orderId, authTxId, reason: voidResult.error, triggerUserId: customerId }).catch(...);
                        // Continue with cancellation despite void failure
                    } else {
                        logger.info(`${functionName} Successfully voided authorization ${authTxId}.`, logContext);
                        finalPaymentStatus = PaymentStatus.Voided;
                    }
                } catch (voidError: any) {
                    voidFailed = true;
                    finalPaymentStatus = PaymentStatus.VoidFailed;
                    logger.error(`${functionName} CRITICAL: Error during void attempt for ${authTxId}. Manual void likely required.`, { ...logContext, error: voidError?.message });
                    sendPushNotification({ subject: `Payment Void FAILED - Order ${orderId}`, body: `Error attempting to void auth ${authTxId} for order ${orderId} cancelled by customer. Manual void REQUIRED. Error: ${voidError.message}`, orderId, severity: "critical" }).catch(...);
                }
            } else if (orderData.paymentStatus !== PaymentStatus.Voided && orderData.paymentStatus !== PaymentStatus.Cancelled) {
                // If it wasn't Authorized (e.g., Pending, Failed, PendingCourier), mark as Cancelled
                finalPaymentStatus = PaymentStatus.Cancelled;
            }


            // 7. Update Order Document & Trigger Side Effects (Transaction?)
            // Using a transaction here is safer if triggerCancellationSideEffects modifies related data (like inventory)
            logger.info(`${functionName} Starting transaction to cancel order ${orderId}...`, logContext);
            await db.runTransaction(async (transaction) => {
                const now = Timestamp.now();
                const serverTimestamp = FieldValue.serverTimestamp();

                // Re-read order within transaction
                const orderTxSnap = await transaction.get(orderRef);
                if (!orderTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.OrderNotFound}`);
                const orderTxData = orderTxSnap.data() as Order;

                // Re-validate status
                if (!cancellableStatuses.includes(orderTxData.status)) {
                     logger.warn(`${functionName} TX Conflict: Order ${orderId} status changed to ${orderTxData.status} during TX. Aborting cancellation.`, logContext);
                     return; // Abort gracefully
                }

                // Prepare Order Update
                const updateData: { [key: string]: any } = { // Use generic object for flexibility
                    status: OrderStatus.Cancelled,
                    paymentStatus: finalPaymentStatus,
                    cancellationReason: reason ?? "Cancelled by customer",
                    cancelledBy: customerId,
                    cancellationTimestamp: now,
                    updatedAt: serverTimestamp,
                    processingError: voidFailed ? `Payment void failed, requires manual action.` : null,
                    // Mark side effects as NOT processed yet, the background function will handle it
                    cancellationSideEffectsProcessed: false,
                };
                 // Update paymentDetails with void status
                 if (finalPaymentStatus === PaymentStatus.Voided || finalPaymentStatus === PaymentStatus.VoidFailed) {
                     updateData.paymentDetails = {
                         ...(orderTxData.paymentDetails ?? {}),
                         ...(orderTxData.authDetails ?? {}),
                         voidTimestamp: now,
                         voidSuccess: !voidFailed,
                         voidError: voidFailed ? (orderData.paymentDetails?.voidError ?? 'Void failed during cancellation') : null,
                     };
                 }

                // Perform Write
                transaction.update(orderRef, updateData);

            }); // End Transaction
            logger.info(`${functionName} Order ${orderId} updated successfully to Cancelled status.`);


            // 8. Trigger Async Side Effects (Inventory Restore, Notifications etc.)
            // Crucial: Only trigger if the update was successful.
            logger.info(`${functionName} Triggering cancellation side effects for order ${orderId}...`, logContext);
            try {
                // This background function should handle inventory restoration,
                // potentially notifying courier if it was assigned (Yellow status), etc.
                // It should also set cancellationSideEffectsProcessed = true on the order doc when done.
                await triggerCancellationSideEffects({ orderId }); // Replace mock
            } catch (triggerError: any) {
                 sideEffectsTriggerFailed = true;
                 logger.error(`${functionName} Failed to trigger cancellation side effects for order ${orderId}. Manual review needed.`, { ...logContext, error: triggerError.message });
                 // Update booking with flag (best effort)
                 orderRef.update({ processingError: `Cancellation side effect trigger failed: ${triggerError.message}` }).catch(...);
                 logAdminAction("OrderCancelSideEffectTriggerFailed", { orderId, reason: triggerError.message }).catch(...);
                 // Do NOT fail the main function for this async trigger failure.
            }

            // 9. Log User Activity (Async)
            logUserActivity("CancelOrder", { orderId, reason, voidFailed, sideEffectsTriggerFailed }, customerId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 10. Return Success
            return { success: true };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            const code = isHttpsError ? error.code : 'UNKNOWN';
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.cancelOrder.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            } else if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            }

            // Log failure activity?
            logUserActivity("CancelOrderFailed", { orderId, reason, error: error.message }, customerId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
