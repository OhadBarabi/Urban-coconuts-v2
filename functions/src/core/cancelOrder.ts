import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, Order, OrderStatus, PaymentStatus, PaymentDetails, RefundDetails
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { voidAuthorization, processRefund, extractPaymentDetailsFromResult } from '../utils/payment_helpers';
import { logUserActivity, logAdminAction } from '../utils/logging'; // Using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
// async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); } // Imported
// async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); } // Imported
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
    Aborted = "ABORTED", // Transaction or Payment Void/Refund failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    OrderNotFound = "ORDER_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    NotOrderOwnerOrAdmin = "NOT_ORDER_OWNER_OR_ADMIN",
    InvalidOrderStatus = "INVALID_ORDER_STATUS", // Not cancellable from this state
    PaymentVoidFailed = "PAYMENT_VOID_FAILED",
    PaymentRefundFailed = "PAYMENT_REFUND_FAILED",
    MissingPaymentInfo = "MISSING_PAYMENT_INFO", // Missing authId or transactionId for void/refund
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- Interfaces ---
interface CancelOrderInput {
    orderId: string;
    reason?: string | null; // Reason for cancellation
}

// --- The Cloud Function ---
export const cancelOrder = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for reads/transaction/payment
        timeoutSeconds: 120, // Increase timeout for payment processing
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // Uncomment if payment helper needs secrets
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[cancelOrder V3 - Permissions]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid;
        const data = request.data as CancelOrderInput;
        const logContext: any = { userId, orderId: data?.orderId, reason: data?.reason };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.orderId || typeof data.orderId !== 'string' ||
            (data.reason != null && typeof data.reason !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { orderId, reason } = data;

        // --- Variables ---
        let orderData: Order;
        let userData: User;
        let userRole: string | null;
        let voidResult: Awaited<ReturnType<typeof voidAuthorization>> | null = null;
        let refundResult: Awaited<ReturnType<typeof processRefund>> | null = null;
        let updatedPaymentStatus: PaymentStatus;
        let refundDetails: RefundDetails | null = null;

        // --- Firestore References ---
        const orderRef = db.collection('orders').doc(orderId);
        const userRef = db.collection('users').doc(userId);

        try {
            // 3. Fetch User and Order Data Concurrently
            const [userSnap, orderSnap] = await Promise.all([userRef.get(), orderRef.get()]);

            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            userRole = userData.role;
            logContext.userRole = userRole;

            if (!orderSnap.exists) {
                logger.warn(`${functionName} Order ${orderId} not found.`, logContext);
                return { success: false, error: "error.order.notFound", errorCode: ErrorCode.OrderNotFound };
            }
            orderData = orderSnap.data() as Order;
            logContext.currentStatus = orderData.status;
            logContext.paymentStatus = orderData.paymentStatus;
            logContext.orderCustomerId = orderData.customerId;

            // 4. Permission Check
            const isOwner = userId === orderData.customerId;
            const isAdmin = userRole === 'Admin' || userRole === 'SuperAdmin';
            const requiredPermission = isOwner ? 'order:cancel:own' : (isAdmin ? 'order:cancel:any' : 'permission_denied');
            const hasPermission = await checkPermission(userId, userRole, requiredPermission, logContext);

            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${userId} (Role: ${userRole}) to cancel order ${orderId}.`, logContext);
                const errorCode = (requiredPermission === 'permission_denied') ? ErrorCode.PermissionDenied : ErrorCode.NotOrderOwnerOrAdmin;
                return { success: false, error: "error.permissionDenied.cancelOrder", errorCode: errorCode };
            }

            // 5. State Validation
            const cancellableStatuses: string[] = [OrderStatus.Red.toString(), OrderStatus.Yellow.toString()];
            if (!cancellableStatuses.includes(orderData.status)) {
                logger.warn(`${functionName} Order ${orderId} cannot be cancelled from status '${orderData.status}'.`, logContext);
                return { success: false, error: `error.order.invalidStatus.cancel::${orderData.status}`, errorCode: ErrorCode.InvalidOrderStatus };
            }
            if (orderData.status === OrderStatus.Cancelled) {
                 logger.warn(`${functionName} Order ${orderId} is already cancelled.`, logContext);
                 return { success: false, error: "error.order.alreadyCancelled", errorCode: ErrorCode.FailedPrecondition };
            }

            // 6. Handle Payment Void/Refund
            updatedPaymentStatus = orderData.paymentStatus;
            if (orderData.paymentStatus === PaymentStatus.Authorized) {
                const authId = orderData.authDetails?.authorizationId;
                if (!authId) {
                    throw new HttpsError('internal', `error.internal.missingPaymentInfo::${orderId}`, { errorCode: ErrorCode.MissingPaymentInfo });
                }
                logger.info(`${functionName} Order ${orderId}: Payment is Authorized. Attempting to void authorization ${authId}...`, logContext);
                voidResult = await voidAuthorization(authId);
                updatedPaymentStatus = voidResult.success ? PaymentStatus.Voided : PaymentStatus.VoidFailed;
                if (!voidResult.success) logger.error(`${functionName} Payment void failed.`, { ...logContext, error: voidResult.errorMessage });
                else logger.info(`${functionName} Payment void successful.`, logContext);
            } else if (orderData.paymentStatus === PaymentStatus.Captured || orderData.paymentStatus === PaymentStatus.Paid) {
                const transactionId = orderData.paymentDetails?.transactionId ?? orderData.authDetails?.transactionId;
                const amountToRefund = orderData.finalAmount;
                if (!transactionId) {
                     logger.error(`${functionName} Cannot refund payment for booking ${orderId}: Missing transactionId.`, logContext);
                     updatedPaymentStatus = PaymentStatus.RefundFailed;
                } else if (amountToRefund != null && amountToRefund > 0) {
                    logger.info(`${functionName} Attempting to refund ${amountToRefund} ${orderData.currencyCode} for transaction ${transactionId}...`, logContext);
                    refundResult = await processRefund( transactionId, amountToRefund, orderData.currencyCode, reason || (isOwner ? "customer_request" : "admin_cancellation"), orderId );
                    updatedPaymentStatus = refundResult.success ? PaymentStatus.Refunded : PaymentStatus.RefundFailed;
                    if (!refundResult.success) logger.error(`${functionName} Payment refund failed.`, { ...logContext, error: refundResult.errorMessage });
                    else {
                        logger.info(`${functionName} Payment refund successful. RefundID: ${refundResult.refundId}.`, logContext);
                        refundDetails = { refundId: refundResult.refundId, refundTimestamp: refundResult.timestamp, refundAmountSmallestUnit: refundResult.amountRefunded, gatewayName: refundResult.gatewayName, reason: reason || (isOwner ? "customer_request" : "admin_cancellation") };
                    }
                 } else {
                     logger.warn(`${functionName} Order ${orderId}: No amount to refund (${amountToRefund}). Skipping refund process.`, logContext);
                 }
            }
            logContext.updatedPaymentStatus = updatedPaymentStatus;

            // 7. Firestore Transaction to Update Order Status
            logger.info(`${functionName} Starting Firestore transaction to update order status...`, logContext);
            await db.runTransaction(async (transaction) => {
                const orderTxSnap = await transaction.get(orderRef);
                if (!orderTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.OrderNotFound}`);
                const orderTxData = orderTxSnap.data() as Order;

                if (orderTxData.status === OrderStatus.Cancelled) {
                    logger.warn(`${functionName} TX Conflict: Order ${orderId} was already cancelled. Aborting update.`);
                    return;
                }
                if (!cancellableStatuses.includes(orderTxData.status)) {
                     logger.warn(`${functionName} TX Conflict: Order ${orderId} status changed to ${orderTxData.status} during TX. Aborting cancellation.`);
                     return;
                }

                const now = Timestamp.now();
                const updateData: { [key: string]: any } = {
                    status: OrderStatus.Cancelled,
                    paymentStatus: updatedPaymentStatus,
                    updatedAt: FieldValue.serverTimestamp(),
                    statusHistory: FieldValue.arrayUnion({
                        status: OrderStatus.Cancelled, timestamp: now, userId: userId, role: userRole,
                        reason: `Cancelled by ${userRole ?? 'User'}${reason ? `: ${reason}` : ''}`
                    }),
                    processingError: null,
                };
                if (refundDetails) updateData.refundDetails = refundDetails;
                if (voidResult && !voidResult.success) {
                     updateData['authDetails.voidErrorCode'] = voidResult.errorCode;
                     updateData['authDetails.voidErrorMessage'] = voidResult.errorMessage;
                 }
                 if (refundResult && !refundResult.success) {
                      updateData['paymentDetails.refundErrorCode'] = refundResult.errorCode;
                      updateData['paymentDetails.refundErrorMessage'] = refundResult.errorMessage;
                 }
                transaction.update(orderRef, updateData);
            });
            logger.info(`${functionName} Order ${orderId} status updated to Cancelled successfully.`, logContext);

            // 8. Log Action (Async)
            const logDetails = { orderId, customerId: orderData.customerId, cancelledBy: userId, userRole, reason, initialStatus: orderData.status, finalPaymentStatus: updatedPaymentStatus };
            if (isAdmin) {
                logAdminAction("CancelOrder", logDetails)
                    .catch(err => logger.error("Failed logging CancelOrder admin action", { err })); // Fixed catch
            } else {
                logUserActivity("CancelOrder", logDetails, userId)
                    .catch(err => logger.error("Failed logging CancelOrder user activity", { err })); // Fixed catch
            }

            // 9. Return Success
            return { success: true };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
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

            logUserActivity("CancelOrderFailed", { orderId, reason, error: error.message }, userId)
                .catch(err => logger.error("Failed logging CancelOrderFailed user activity", { err })); // Fixed catch

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
