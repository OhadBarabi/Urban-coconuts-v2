import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, Order, OrderStatus, PaymentStatus, StatusHistoryEntry, PaymentDetails, PaymentMethod // Added User, PaymentMethod
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { processPaymentCapture, processPaymentVoid } from '../utils/payment_helpers'; // Payment processing
// import { triggerCancellationSideEffects } from '../utils/background_triggers'; // Background task trigger
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity, logAdminAction } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`, context); return userId != null; }
interface PaymentResult { success: boolean; transactionId?: string; error?: string; }
async function processPaymentCapture(orderId: string, amount: number, currency: string, authTxId?: string | null): Promise<PaymentResult> { logger.info(`[Mock Payment] Capturing ${amount} ${currency} for order ${orderId} (Auth: ${authTxId})`); await new Promise(res => setTimeout(res, 1200)); if (Math.random() < 0.03) { logger.error("[Mock Payment] Capture FAILED."); return { success: false, error: "Mock Capture Failed" }; } return { success: true, transactionId: `CAP_${Date.now()}` }; }
async function processPaymentVoid(orderId: string, authTxId: string): Promise<{ success: boolean; error?: string }> { logger.info(`[Mock Payment] Voiding Auth ${authTxId} for order ${orderId}`); await new Promise(res => setTimeout(res, 600)); if (authTxId.includes("fail_void")) { logger.error("[Mock Payment] Void FAILED."); return { success: false, error: "Mock Void Failed" }; } return { success: true }; }
async function triggerCancellationSideEffects(params: { orderId: string }): Promise<void> { logger.info(`[Mock Trigger] Triggering cancellation side effects for order ${params.orderId}`); }
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
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status transition
    Aborted = "ABORTED", // Payment capture/void failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    OrderNotFound = "ORDER_NOT_FOUND",
    InvalidStatusTransition = "INVALID_STATUS_TRANSITION",
    PaymentCaptureFailed = "PAYMENT_CAPTURE_FAILED",
    PaymentVoidFailed = "PAYMENT_VOID_FAILED",
    SideEffectTriggerFailed = "SIDE_EFFECT_TRIGGER_FAILED",
}

// --- Interfaces ---
interface UpdateOrderStatusInput {
    orderId: string;
    newStatus: OrderStatus | string; // Allow string for input validation
    details?: {
        reason?: string | null; // For cancellation or other context
        paymentTxId?: string | null; // If payment confirmed externally (e.g., Cash)
        // Add other context fields as needed
    } | null;
}

// --- The Cloud Function ---
export const updateOrderStatus = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory for potential payment interactions
        timeoutSeconds: 60,
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // Add secrets if needed
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[updateOrderStatus V2]";
        const startTime = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const userId = request.auth.uid; // Could be Courier, Admin, or System
        const data = request.data as UpdateOrderStatusInput;
        const logContext: any = { userId, orderId: data?.orderId, newStatus: data?.newStatus };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.orderId || typeof data.orderId !== 'string' ||
            !data.newStatus || !Object.values(OrderStatus).includes(data.newStatus as OrderStatus) ||
            (data.details != null && typeof data.details !== 'object'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { orderId, newStatus, details } = data;
        const reason = details?.reason ?? null;

        // --- Variables ---
        let orderData: Order;
        let currentStatus: OrderStatus | string;
        let userRole: string | null = null; // Determine role for logging/permissions
        let paymentActionNeeded: 'capture' | 'void' | null = null;
        let sideEffectTriggerNeeded = false;
        let paymentResult: PaymentResult | { success: boolean; error?: string } | null = null;
        let finalPaymentStatus: PaymentStatus | string | null = null;

        try {
            // Fetch User Role (Optional but good for logging/context)
            try {
                const userSnap = await db.collection('users').doc(userId).get();
                if (userSnap.exists) {
                    userRole = (userSnap.data() as User)?.role ?? 'UnknownRole';
                    logContext.userRole = userRole;
                } else {
                    logger.warn(`${functionName} User ID ${userId} not found in users collection. Assuming system/internal trigger.`, logContext);
                    userRole = 'System';
                }
            } catch (userFetchError: any) {
                logger.error(`${functionName} Failed to fetch user role for ${userId}. Proceeding without role context.`, { error: userFetchError.message });
                userRole = 'ErrorFetchingRole';
            }

            // Permission Check (Example: Different permissions based on target status)
            let requiredPermission = 'order:update_status:any'; // Default broad permission
            if (newStatus === OrderStatus.Cancelled) requiredPermission = 'order:update_status:cancel';
            if (newStatus === OrderStatus.Black) requiredPermission = 'order:update_status:complete';
            if (newStatus === OrderStatus.Green) requiredPermission = 'order:update_status:ready'; // Example
            if (newStatus === OrderStatus.Yellow) requiredPermission = 'order:update_status:prepare'; // Example

            const hasPermission = await checkPermission(userId, requiredPermission, { orderId });
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${userId} (Role: ${userRole}) to set status ${newStatus}. Required: ${requiredPermission}`, logContext);
                return { success: false, error: `error.permissionDenied.updateStatus::${newStatus}`, errorCode: ErrorCode.PermissionDenied };
            }
            logger.info(`${functionName} Permission '${requiredPermission}' granted.`);

            // 3. Fetch Order & Validate Current Status
            const orderRef = db.collection('orders').doc(orderId);
            const orderSnap = await orderRef.get();

            if (!orderSnap.exists) {
                logger.warn(`${functionName} Order ${orderId} not found.`, logContext);
                return { success: false, error: "error.order.notFound", errorCode: ErrorCode.OrderNotFound };
            }
            orderData = orderSnap.data() as Order;
            currentStatus = orderData.status;
            logContext.currentStatus = currentStatus;
            logContext.currentPaymentStatus = orderData.paymentStatus;

            // Idempotency Check
            if (currentStatus === newStatus) {
                logger.info(`${functionName} Order ${orderId} is already in status '${newStatus}'. No update needed.`, logContext);
                return { success: true };
            }

            // 4. Validate Status Transition Logic
            const validTransitions: { [key in OrderStatus]?: OrderStatus[] } = {
                [OrderStatus.Red]: [OrderStatus.Yellow, OrderStatus.Cancelled],
                [OrderStatus.Yellow]: [OrderStatus.Green, OrderStatus.Cancelled],
                [OrderStatus.Green]: [OrderStatus.Black, OrderStatus.Cancelled],
                // Black and Cancelled are final states
            };

            if (!validTransitions[currentStatus as OrderStatus]?.includes(newStatus as OrderStatus)) {
                logger.warn(`${functionName} Invalid status transition: ${currentStatus} -> ${newStatus} for order ${orderId}.`, logContext);
                return { success: false, error: `error.order.invalidTransition::${currentStatus}>>${newStatus}`, errorCode: ErrorCode.InvalidStatusTransition };
            }
            logger.info(`${functionName} Status transition ${currentStatus} -> ${newStatus} validated.`);

            // 5. Determine Payment/Side Effect Actions based on transition
            const authDetails = orderData.authDetails;
            const authTxId = authDetails?.gatewayTransactionId ?? null;
            const authAmount = authDetails?.authAmountSmallestUnit ?? 0;
            const currency = orderData.currencyCode;
            finalPaymentStatus = orderData.paymentStatus; // Start with current payment status

            if (newStatus === OrderStatus.Black && currentStatus === OrderStatus.Green) {
                // Order completed - Capture payment if it was authorized
                if (orderData.paymentStatus === PaymentStatus.Authorized && authTxId && authAmount > 0 && currency) {
                    paymentActionNeeded = 'capture';
                } else if (orderData.paymentMethod === PaymentMethod.CashOnDelivery || orderData.paymentMethod === PaymentMethod.CreditOnDelivery) {
                    // Assuming cash/credit was handled by courier, mark as PaidToCourier
                    finalPaymentStatus = PaymentStatus.PaidToCourier; // Or just Paid?
                } else if (orderData.paymentStatus !== PaymentStatus.Paid && orderData.paymentStatus !== PaymentStatus.PaidToCourier) {
                    // If it wasn't Authorized or Cash/Credit, and not already Paid, mark as Paid (e.g., for UC Coins or 0 amount)
                    finalPaymentStatus = PaymentStatus.Paid;
                }
            } else if (newStatus === OrderStatus.Cancelled) {
                // Order cancelled - Void authorization or trigger refund side effects
                if (orderData.paymentStatus === PaymentStatus.Authorized && authTxId) {
                    paymentActionNeeded = 'void';
                } else if (orderData.paymentStatus === PaymentStatus.Paid || orderData.paymentStatus === PaymentStatus.Captured) {
                    // If already paid/captured, need to trigger refund process
                    sideEffectTriggerNeeded = true;
                    finalPaymentStatus = PaymentStatus.Pending; // Revert to pending until refund processed? Or 'RefundPending'?
                } else {
                    // If payment was Pending/Failed/Voided etc., just mark as Cancelled
                    finalPaymentStatus = PaymentStatus.Cancelled;
                }
            }
            logContext.paymentAction = paymentActionNeeded;
            logContext.sideEffectTrigger = sideEffectTriggerNeeded;
            logContext.finalPaymentStatus = finalPaymentStatus;

            // 6. Perform Payment Action (if needed)
            if (paymentActionNeeded === 'capture') {
                logger.info(`${functionName} Order ${orderId}: Attempting payment capture...`, logContext);
                paymentResult = await processPaymentCapture(orderId, authAmount, currency, authTxId);
                if (!paymentResult.success) {
                    logger.error(`${functionName} Order ${orderId}: Payment capture FAILED.`, { ...logContext, error: paymentResult.error });
                    // Throw error to prevent status change to Black
                    throw new HttpsError('aborted', `error.payment.captureFailed::${paymentResult.error || 'Unknown'}`, { errorCode: ErrorCode.PaymentCaptureFailed });
                }
                logger.info(`${functionName} Order ${orderId}: Payment capture successful. TxID: ${(paymentResult as PaymentResult).transactionId}`, logContext);
                finalPaymentStatus = PaymentStatus.Paid; // Or Captured
            } else if (paymentActionNeeded === 'void') {
                logger.info(`${functionName} Order ${orderId}: Attempting payment void...`, logContext);
                paymentResult = await processPaymentVoid(orderId, authTxId!);
                if (!paymentResult.success) {
                    logger.error(`${functionName} Order ${orderId}: Payment void FAILED. Manual void required.`, { ...logContext, error: paymentResult.error });
                    sendPushNotification({ subject: `Payment Void FAILED - Order ${orderId}`, body: `Failed to void auth ${authTxId} for cancelled order ${orderId}. Manual void REQUIRED.`, orderId, severity: "critical" }).catch(...);
                    finalPaymentStatus = PaymentStatus.VoidFailed; // Allow cancellation, but mark payment state
                } else {
                    logger.info(`${functionName} Order ${orderId}: Payment void successful.`, logContext);
                    finalPaymentStatus = PaymentStatus.Voided;
                }
            }

            // 7. Update Firestore Document
            logger.info(`${functionName} Order ${orderId}: Updating Firestore document...`, logContext);
            const now = Timestamp.now();
            const serverTimestamp = FieldValue.serverTimestamp();
            const updateData: { [key: string]: any } = {
                status: newStatus,
                updatedAt: serverTimestamp,
                statusHistory: FieldValue.arrayUnion({
                    from: currentStatus,
                    to: newStatus,
                    timestamp: now,
                    userId: userId,
                    role: userRole,
                    reason: reason
                })
            };

            // Update payment status if it changed
            if (finalPaymentStatus && finalPaymentStatus !== orderData.paymentStatus) {
                updateData.paymentStatus = finalPaymentStatus;
                // Update paymentDetails with results from capture/void if needed
                const currentPaymentDetails = orderData.paymentDetails ?? {};
                if (paymentActionNeeded === 'capture' && paymentResult?.success) {
                     updateData.paymentDetails = {
                         ...currentPaymentDetails,
                         chargeTimestamp: now,
                         chargeTransactionId: (paymentResult as PaymentResult).transactionId,
                         chargeAmountSmallestUnit: authAmount,
                         chargeSuccess: true,
                         chargeError: null,
                     };
                } else if (paymentActionNeeded === 'void' && paymentResult?.success) {
                    updateData.paymentDetails = {
                        ...currentPaymentDetails,
                        voidTimestamp: now,
                        voidSuccess: true,
                        voidError: null,
                    };
                } else if (paymentActionNeeded === 'void' && !paymentResult?.success) {
                     updateData.paymentDetails = {
                        ...currentPaymentDetails,
                        voidTimestamp: now,
                        voidSuccess: false,
                        voidError: paymentResult?.error ?? 'Unknown void error',
                    };
                }
                 // Add logic to update details for capture failure if needed and status change allowed
            }

            // Add deliveredTimestamp if completing
            if (newStatus === OrderStatus.Black) {
                updateData.deliveredTimestamp = now;
            }

            await orderRef.update(updateData);
            logger.info(`${functionName} Order ${orderId}: Firestore update successful.`);

            // 8. Trigger Async Side Effects (if needed)
            if (sideEffectTriggerNeeded) {
                logger.info(`${functionName} Order ${orderId}: Triggering cancellation side effects...`, logContext);
                try {
                    await triggerCancellationSideEffects({ orderId });
                } catch (triggerError: any) {
                    logger.error(`${functionName} Order ${orderId}: Failed to trigger cancellation side effects. Manual review needed.`, { ...logContext, error: triggerError.message });
                    orderRef.update({ processingError: `Cancellation side effect trigger failed: ${triggerError.message}` }).catch(...);
                    logAdminAction("CancellationSideEffectTriggerFailed", { orderId, reason: triggerError.message }).catch(...);
                }
            }

            // 9. Trigger Notifications (Async)
            const notificationPromises: Promise<void>[] = [];
            let customerNotificationType: string | null = null;
            let customerTitleKey: string | null = null;
            let customerMessageKey: string | null = null;
            const customerMessageParams: any = { orderIdShort: orderId.substring(0, 8) };

            if (newStatus === OrderStatus.Green) {
                customerNotificationType = "OrderReadyForPickup";
                customerTitleKey = "notification.orderReady.title";
                customerMessageKey = "notification.orderReady.message";
            } else if (newStatus === OrderStatus.Black) {
                customerNotificationType = "OrderCompleted";
                customerTitleKey = "notification.orderCompleted.title";
                customerMessageKey = "notification.orderCompleted.message";
            } else if (newStatus === OrderStatus.Cancelled) {
                customerNotificationType = "OrderCancelled";
                customerTitleKey = "notification.orderCancelled.title";
                customerMessageKey = "notification.orderCancelled.message";
                customerMessageParams.reason = reason ?? "Order was cancelled.";
            }

            if (customerNotificationType && orderData.customerId) {
                notificationPromises.push(sendPushNotification({
                    userId: orderData.customerId, type: customerNotificationType,
                    titleKey: customerTitleKey, messageKey: customerMessageKey,
                    messageParams: customerMessageParams, payload: { orderId: orderId, screen: 'OrderDetails' }
                }).catch(err => logger.error(`Failed sending customer notification for ${orderId}`, { err })));
            }
            // TODO: Notify Courier/Admin if needed based on status change?

            // 10. Log Action (Async)
            const logDetails = { orderId, oldStatus: currentStatus, newStatus, reason, paymentAction: paymentActionNeeded, paymentResultSuccess: paymentResult?.success ?? null, triggerUserId: userId, triggerUserRole: userRole };
            if (userRole === 'Admin' || userRole === 'SuperAdmin') {
                notificationPromises.push(logAdminAction("UpdateOrderStatus", logDetails).catch(err => logger.error("Failed logging admin action", { err })));
            } else {
                notificationPromises.push(logUserActivity("UpdateOrderStatus", logDetails, userId).catch(err => logger.error("Failed logging user activity", { err })));
            }

            Promise.allSettled(notificationPromises); // Don't await

            // 11. Return Success
            return { success: true };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Order ${orderId}: Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            const code = isHttpsError ? error.code : 'UNKNOWN';
            const details = isHttpsError ? error.details : null;
            let errorMessage = error.message || "An unknown error occurred.";
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = errorMessage.startsWith("error.") ? errorMessage : `error.updateOrderStatus.${finalErrorCode.toLowerCase()}`;
                if (errorMessage.includes("::")) { finalErrorMessageKey = errorMessage; }
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
            }

            logAdminAction("UpdateOrderStatusFailed", { inputData: data, triggerUserId: userId, triggerUserRole: userRole, errorMessage, finalErrorCode }).catch(...);

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished for order ${orderId}. Duration: ${Date.now() - startTime}ms`, logContext);
        }
    }
);
