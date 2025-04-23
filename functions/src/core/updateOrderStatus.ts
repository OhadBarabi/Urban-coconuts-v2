import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Order, OrderStatus, PaymentStatus, PaymentDetails } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { processPaymentCapture } from '../utils/payment_helpers'; // For capturing payment on 'Black' status
import { logUserActivity, logAdminAction } from '../utils/logging'; // Using mocks below
import { sendPushNotification } from '../utils/notifications'; // Using mock below

// --- Mocks ---
// async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); } // Imported
// async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); } // Imported
// interface NotificationPayload { userId: string; type: string; titleKey: string; messageKey: string; messageParams?: { [key: string]: any }; payload?: { [key: string]: string }; } // Defined in notifications helper
// async function sendPushNotification(notification: NotificationPayload): Promise<void> { logger.info(`[Mock Notification] Sending push notification to ${notification.userId}`, notification); } // Imported
// --- End Mocks ---


// --- Configuration ---
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Order or User not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status transition
    Aborted = "ABORTED", // Transaction or Payment Capture failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    OrderNotFound = "ORDER_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    InvalidOrderStatus = "INVALID_ORDER_STATUS", // Invalid target status value
    InvalidStatusTransition = "INVALID_STATUS_TRANSITION",
    PaymentCaptureFailed = "PAYMENT_CAPTURE_FAILED",
    MissingPaymentInfo = "MISSING_PAYMENT_INFO", // Missing authId for capture
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- Interfaces ---
interface UpdateOrderStatusInput {
    orderId: string;
    newStatus: OrderStatus; // Must be one of the valid OrderStatus enum values
    details?: { // Optional details depending on the status update
        reason?: string | null; // e.g., reason for delay or cancellation by admin
        paymentTxId?: string | null; // If payment capture happens outside this function
        courierId?: string | null; // ID of the courier performing the action (if applicable)
    } | null;
}

// --- The Cloud Function ---
export const updateOrderStatus = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for potential payment capture
        timeoutSeconds: 120, // Allow time for payment capture
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // If payment capture needs secret
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[updateOrderStatus V1]"; // Keep original version name for now
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid; // User performing the action (Courier or Admin)
        const data = request.data as UpdateOrderStatusInput;
        const logContext: any = { userId, orderId: data?.orderId, newStatus: data?.newStatus };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.orderId || typeof data.orderId !== 'string' ||
            !data?.newStatus || !Object.values(OrderStatus).includes(data.newStatus) ||
            (data.details != null && typeof data.details !== 'object') ||
            (data.details?.reason != null && typeof data.details.reason !== 'string') ||
            (data.details?.paymentTxId != null && typeof data.details.paymentTxId !== 'string') ||
            (data.details?.courierId != null && typeof data.details.courierId !== 'string')
           )
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            let errorCode = ErrorCode.InvalidArgument;
            if (data?.newStatus && !Object.values(OrderStatus).includes(data.newStatus)) {
                errorCode = ErrorCode.InvalidOrderStatus;
            }
            return { success: false, error: "error.invalidInput.structureOrStatus", errorCode: errorCode };
        }
        const { orderId, newStatus, details } = data;

        // --- Variables ---
        let orderData: Order;
        let userData: User;
        let userRole: string | null;
        let captureResult: Awaited<ReturnType<typeof processPaymentCapture>> | null = null;
        let updatedPaymentStatus: PaymentStatus | null = null;
        let paymentDetailsUpdate: PaymentDetails | null = null;

        // --- Firestore References ---
        const orderRef = db.collection('orders').doc(orderId);
        const userRef = db.collection('users').doc(userId); // User performing the action

        try {
            // 3. Fetch User and Order Data Concurrently
            const [userSnap, orderSnap] = await Promise.all([userRef.get(), orderRef.get()]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `User ${userId} not found.`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            userRole = userData.role;
            logContext.userRole = userRole;

            // Validate Order
            if (!orderSnap.exists) {
                logger.warn(`${functionName} Order ${orderId} not found.`, logContext);
                return { success: false, error: "error.order.notFound", errorCode: ErrorCode.OrderNotFound };
            }
            orderData = orderSnap.data() as Order;
            logContext.currentStatus = orderData.status;
            logContext.paymentStatus = orderData.paymentStatus;
            logContext.customerId = orderData.customerId;

            // 4. Permission Check
            // Define permission: 'order:updateStatus' (or more granular like 'order:updateStatus:courier', 'order:updateStatus:admin')
            const hasPermission = await checkPermission(userId, userRole, 'order:updateStatus', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${userId} (Role: ${userRole}) to update status for order ${orderId}.`, logContext);
                return { success: false, error: "error.permissionDenied.updateStatus", errorCode: ErrorCode.PermissionDenied };
            }

            // 5. State Transition Validation
            // Define valid transitions based on current status and potentially user role
            const validTransitions: { [key in OrderStatus]?: OrderStatus[] } = {
                [OrderStatus.Red]: [OrderStatus.Yellow, OrderStatus.Cancelled], // From Red, can go to Yellow (prep) or Cancelled
                [OrderStatus.Yellow]: [OrderStatus.Green, OrderStatus.Cancelled], // From Yellow (prep), can go to Green (ready) or Cancelled
                [OrderStatus.Green]: [OrderStatus.Black, OrderStatus.Cancelled], // From Green (ready), can go to Black (delivered) or Cancelled (e.g., customer no-show)
                // Black (delivered) and Cancelled are final states for this function
            };

            const allowedNextStatuses = validTransitions[orderData.status];
            if (!allowedNextStatuses || !allowedNextStatuses.includes(newStatus)) {
                 // Allow Admin to force cancel maybe? Add specific check if needed.
                 if (newStatus === OrderStatus.Cancelled && (userRole === 'Admin' || userRole === 'SuperAdmin')) {
                      logger.warn(`${functionName} Admin override: Allowing cancellation from status ${orderData.status}.`, logContext);
                 } else {
                    logger.warn(`${functionName} Invalid status transition from ${orderData.status} to ${newStatus} for order ${orderId}.`, logContext);
                    return { success: false, error: `error.order.invalidStatusTransition::${orderData.status}->${newStatus}`, errorCode: ErrorCode.InvalidStatusTransition };
                 }
            }

            // 6. Handle Payment Capture on Completion (Moving to 'Black')
            if (newStatus === OrderStatus.Black && orderData.paymentStatus === PaymentStatus.Authorized) {
                const authId = orderData.authDetails?.authorizationId;
                const amountToCapture = orderData.finalAmount; // Capture the final calculated amount

                if (!authId) {
                     logger.error(`${functionName} Cannot capture payment for order ${orderId}: Missing authorizationId.`, logContext);
                     throw new HttpsError('internal', `error.internal.missingPaymentInfo::${orderId}`, { errorCode: ErrorCode.MissingPaymentInfo });
                }
                 if (amountToCapture == null || amountToCapture <= 0) {
                     logger.warn(`${functionName} Order ${orderId}: Final amount is ${amountToCapture}. Skipping payment capture. Marking as Paid.`, logContext);
                     updatedPaymentStatus = PaymentStatus.Paid; // Mark as paid if amount is 0
                 } else {
                     logger.info(`${functionName} Order ${orderId} moving to 'Black'. Attempting to capture ${amountToCapture} ${orderData.currencyCode} for authorization ${authId}...`, logContext);
                     captureResult = await processPaymentCapture(authId, amountToCapture, orderData.currencyCode);

                     paymentDetailsUpdate = extractPaymentDetailsFromResult(captureResult); // Get details

                     if (!captureResult.success) {
                         updatedPaymentStatus = PaymentStatus.CaptureFailed;
                         logger.error(`${functionName} Payment capture failed for order ${orderId}, AuthID: ${authId}.`, { ...logContext, error: captureResult.errorMessage, code: captureResult.errorCode });
                         // Should we prevent moving to 'Black'? Or move to 'Black' but flag payment error?
                         // Let's prevent moving to Black for now if capture fails.
                         throw new HttpsError('aborted', `error.payment.captureFailed::${captureResult.errorCode || 'Unknown'}`, { errorCode: ErrorCode.PaymentCaptureFailed });
                     } else {
                         updatedPaymentStatus = PaymentStatus.Captured; // Or Paid? Let's use Captured.
                         logger.info(`${functionName} Payment capture successful for order ${orderId}. TxID: ${captureResult.transactionId}`, logContext);
                     }
                 }
            }

            // 7. Firestore Transaction to Update Order Status
            logger.info(`${functionName} Starting Firestore transaction to update order ${orderId} status to ${newStatus}...`, logContext);
            await db.runTransaction(async (transaction) => {
                const orderTxSnap = await transaction.get(orderRef);
                if (!orderTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.OrderNotFound}`);
                const orderTxData = orderTxSnap.data() as Order;

                // Re-validate status transition within transaction
                const currentTxStatus = orderTxData.status;
                const allowedTxNextStatuses = validTransitions[currentTxStatus];
                 if (!allowedTxNextStatuses || !allowedTxNextStatuses.includes(newStatus)) {
                     if (newStatus === OrderStatus.Cancelled && (userRole === 'Admin' || userRole === 'SuperAdmin')) {
                          logger.warn(`${functionName} TX Conflict Check: Admin override: Allowing cancellation from status ${currentTxStatus}.`, logContext);
                     } else {
                        logger.warn(`${functionName} TX Conflict: Order ${orderId} status changed to ${currentTxStatus} during TX. Aborting update to ${newStatus}.`, logContext);
                        return; // Abort gracefully
                     }
                 }
                 // Prevent re-processing if already at target status
                 if (currentTxStatus === newStatus) {
                      logger.warn(`${functionName} TX Conflict: Order ${orderId} already in status ${newStatus}. Aborting update.`, logContext);
                      return;
                 }

                // Prepare Order Update
                const now = Timestamp.now();
                const updateData: { [key: string]: any } = {
                    status: newStatus,
                    updatedAt: FieldValue.serverTimestamp(),
                    statusHistory: FieldValue.arrayUnion({
                        status: newStatus,
                        timestamp: now,
                        userId: userId, // User performing the action
                        role: userRole,
                        reason: details?.reason ?? `Status updated to ${newStatus} by ${userRole ?? 'User'}`
                    }),
                    processingError: null, // Clear previous errors
                };

                // Add courier ID if provided and status is relevant (e.g., Green, Black)
                if (details?.courierId && (newStatus === OrderStatus.Green || newStatus === OrderStatus.Black)) {
                     updateData.courierId = details.courierId;
                }
                // Add delivered timestamp if moving to Black
                if (newStatus === OrderStatus.Black) {
                    updateData.deliveredTimestamp = now;
                }
                // Update payment status and details if capture was attempted
                if (updatedPaymentStatus) {
                    updateData.paymentStatus = updatedPaymentStatus;
                }
                if (paymentDetailsUpdate) {
                    // Merge capture details with existing payment details (if any)
                    updateData.paymentDetails = { ...(orderTxData.paymentDetails || {}), ...paymentDetailsUpdate };
                }
                 // Add capture failure details?
                 if (captureResult && !captureResult.success) {
                      updateData['paymentDetails.captureErrorCode'] = captureResult.errorCode;
                      updateData['paymentDetails.captureErrorMessage'] = captureResult.errorMessage;
                 }


                // Perform Write
                transaction.update(orderRef, updateData);
            }); // End Transaction
            logger.info(`${functionName} Transaction successful. Order ${orderId} status updated to ${newStatus}.`, logContext);


            // 8. Log Action (Async)
            const logDetails = { orderId, customerId: orderData.customerId, oldStatus: orderData.status, newStatus, details, triggerUserId: userId, triggerUserRole: userRole, paymentUpdate: updatedPaymentStatus };
            if (userRole === 'Admin' || userRole === 'SuperAdmin') {
                logAdminAction("UpdateOrderStatus", logDetails)
                    .catch(err => logger.error("Failed logging UpdateOrderStatus admin action", { err })); // Fixed catch
            } else { // Assume Courier or other allowed role
                logUserActivity("UpdateOrderStatus", logDetails, userId)
                    .catch(err => logger.error("Failed logging UpdateOrderStatus user activity", { err })); // Fixed catch
            }

            // 9. Send Notifications (Async) - e.g., notify customer their order is ready or delivered
            if (newStatus === OrderStatus.Green) {
                 sendPushNotification({
                     userId: orderData.customerId, type: "OrderReady",
                     titleKey: "notification.orderReady.title", messageKey: "notification.orderReady.message",
                     messageParams: { orderId: orderId.substring(0, 6) }, payload: { orderId: orderId, screen: 'orderDetails' }
                 }).catch(err => logger.error("Failed sending order ready notification", { err })); // Fixed catch
            } else if (newStatus === OrderStatus.Black) {
                 sendPushNotification({
                     userId: orderData.customerId, type: "OrderDelivered",
                     titleKey: "notification.orderDelivered.title", messageKey: "notification.orderDelivered.message",
                     messageParams: { orderId: orderId.substring(0, 6) }, payload: { orderId: orderId, screen: 'orderDetails' }
                 }).catch(err => logger.error("Failed sending order delivered notification", { err })); // Fixed catch
            }
            // Add notifications for other statuses if needed

            // 10. Return Success
            return { success: true };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.updateStatus.generic`;
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
            logUserActivity("UpdateOrderStatusFailed", { orderId, newStatus, error: error.message }, userId)
                .catch(err => logger.error("Failed logging UpdateOrderStatusFailed user activity", { err })); // Fixed catch

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
