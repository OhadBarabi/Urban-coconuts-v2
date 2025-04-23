import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, Order, OrderStatus, PaymentStatus, PaymentDetails, RefundDetails
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
// import { checkPermission } from '../utils/permissions'; // Still using mock below
import { voidAuthorization, processRefund, extractPaymentDetailsFromResult } from '../utils/payment_helpers'; // <-- Import from new helper
// import { logUserActivity, logAdminAction } from '../utils/logging'; // Still using mock below

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null; }
// voidAuthorization and processRefund are now imported from the helper
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
    Aborted = "ABORTED", // Transaction or Payment Void/Refund failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    OrderNotFound = "ORDER_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND", // Added for completeness
    NotOrderOwnerOrAdmin = "NOT_ORDER_OWNER_OR_ADMIN", // Adjusted permission logic
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
        const functionName = "[cancelOrder V2 - Refactored]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid; // User initiating cancellation (Customer or Admin)
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
        const userRef = db.collection('users').doc(userId); // Needed for role check

        try {
            // 3. Fetch User and Order Data Concurrently
            const [userSnap, orderSnap] = await Promise.all([userRef.get(), orderRef.get()]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
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
            logContext.orderCustomerId = orderData.customerId;

            // 4. Permission Check (Allow owner or admin?)
            const isOwner = userId === orderData.customerId;
            const isAdmin = userRole === 'Admin' || userRole === 'SuperAdmin';
            // Define permissions needed: e.g., 'order:cancel:own', 'order:cancel:any'
            const requiredPermission = isOwner ? 'order:cancel:own' : (isAdmin ? 'order:cancel:any' : 'permission_denied'); // Deny if not owner or admin
            const hasPermission = await checkPermission(userId, userRole, requiredPermission, { orderId });

            if (!hasPermission) { // Simplified check: must be owner or admin
                logger.warn(`${functionName} Permission denied for user ${userId} (Role: ${userRole}) to cancel order ${orderId}.`, logContext);
                return { success: false, error: "error.permissionDenied.cancelOrder", errorCode: ErrorCode.NotOrderOwnerOrAdmin };
            }

            // 5. State Validation (Allow cancellation only in specific states)
            // Example: Allow cancelling 'Red' or 'Yellow' status orders. Maybe 'Authorized' payment status.
            const cancellableStatuses: string[] = [OrderStatus.Red.toString(), OrderStatus.Yellow.toString()];
            if (!cancellableStatuses.includes(orderData.status)) {
                logger.warn(`${functionName} Order ${orderId} cannot be cancelled from status '${orderData.status}'.`, logContext);
                return { success: false, error: `error.order.invalidStatus.cancel::${orderData.status}`, errorCode: ErrorCode.InvalidOrderStatus };
            }
            // Additional check: Don't allow cancelling if already cancelled
            if (orderData.status === OrderStatus.Cancelled) {
                 logger.warn(`${functionName} Order ${orderId} is already cancelled.`, logContext);
                 return { success: false, error: "error.order.alreadyCancelled", errorCode: ErrorCode.FailedPrecondition };
            }

            // 6. Handle Payment Void/Refund (if applicable)
            updatedPaymentStatus = orderData.paymentStatus; // Start with current status

            if (orderData.paymentStatus === PaymentStatus.Authorized) {
                // --- Void Authorization ---
                const authId = orderData.authDetails?.authorizationId;
                if (!authId) {
                    logger.error(`${functionName} Cannot void payment for order ${orderId}: Missing authorizationId in authDetails.`, logContext);
                    throw new HttpsError('internal', `error.internal.missingPaymentInfo::${orderId}`, { errorCode: ErrorCode.MissingPaymentInfo });
                }
                logger.info(`${functionName} Order ${orderId}: Payment is Authorized. Attempting to void authorization ${authId}...`, logContext);
                voidResult = await voidAuthorization(authId);

                if (!voidResult.success) {
                    updatedPaymentStatus = PaymentStatus.VoidFailed; // Mark as failed
                    logger.error(`${functionName} Payment void failed for order ${orderId}, AuthID: ${authId}.`, { ...logContext, error: voidResult.errorMessage, code: voidResult.errorCode });
                    // Should we still cancel the order in Firestore? Yes, but mark payment status accordingly.
                    // Don't throw error here, let the transaction handle the order status update.
                } else {
                    updatedPaymentStatus = PaymentStatus.Voided;
                    logger.info(`${functionName} Payment void successful for order ${orderId}, AuthID: ${authId}.`, logContext);
                }
            } else if (orderData.paymentStatus === PaymentStatus.Captured || orderData.paymentStatus === PaymentStatus.Paid) {
                // --- Process Refund ---
                // This might have different rules depending on who is cancelling and why.
                // For simplicity now, we'll try to refund the finalAmount if captured/paid.
                const transactionId = orderData.paymentDetails?.transactionId ?? orderData.authDetails?.transactionId; // Find the charge/capture ID
                const amountToRefund = orderData.finalAmount; // Refund the final amount paid

                if (!transactionId) {
                     logger.error(`${functionName} Cannot refund payment for order ${orderId}: Missing transactionId in paymentDetails/authDetails.`, logContext);
                     throw new HttpsError('internal', `error.internal.missingPaymentInfo::${orderId}`, { errorCode: ErrorCode.MissingPaymentInfo });
                }
                 if (amountToRefund == null || amountToRefund <= 0) {
                     logger.warn(`${functionName} Order ${orderId}: No amount to refund (${amountToRefund}). Skipping refund process.`, logContext);
                     // If amount is 0 (e.g., paid by UC coins), just proceed with cancellation.
                 } else {
                    logger.info(`${functionName} Order ${orderId}: Payment is ${orderData.paymentStatus}. Attempting to refund ${amountToRefund} ${orderData.currencyCode} for transaction ${transactionId}...`, logContext);
                    refundResult = await processRefund(
                        transactionId,
                        amountToRefund,
                        orderData.currencyCode,
                        reason || (isOwner ? "customer_request" : "admin_cancellation"),
                        orderId
                    );

                    if (!refundResult.success) {
                        updatedPaymentStatus = PaymentStatus.RefundFailed; // Mark as failed
                        logger.error(`${functionName} Payment refund failed for order ${orderId}, TxID: ${transactionId}.`, { ...logContext, error: refundResult.errorMessage, code: refundResult.errorCode });
                        // Still cancel the order, but mark payment status.
                    } else {
                        updatedPaymentStatus = PaymentStatus.Refunded;
                        logger.info(`${functionName} Payment refund successful for order ${orderId}, TxID: ${transactionId}, RefundID: ${refundResult.refundId}.`, logContext);
                        // Prepare refund details to store in the order
                        refundDetails = {
                            refundId: refundResult.refundId,
                            refundTimestamp: refundResult.timestamp,
                            refundAmountSmallestUnit: refundResult.amountRefunded,
                            gatewayName: refundResult.gatewayName,
                            reason: reason || (isOwner ? "customer_request" : "admin_cancellation"),
                        };
                    }
                 }

            } else {
                // Handle other payment statuses (Pending, Failed, Voided, Refunded etc.) - usually no payment action needed on cancellation.
                logger.info(`${functionName} Order ${orderId}: No payment action required for cancellation based on current payment status '${orderData.paymentStatus}'.`, logContext);
            }
            logContext.updatedPaymentStatus = updatedPaymentStatus;

            // 7. Firestore Transaction to Update Order Status
            // Note: Inventory restoration is handled by the background function triggered by order status change.
            logger.info(`${functionName} Starting Firestore transaction to update order status...`, logContext);
            await db.runTransaction(async (transaction) => {
                const orderTxSnap = await transaction.get(orderRef);
                if (!orderTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.OrderNotFound}`); // Should not happen
                const orderTxData = orderTxSnap.data() as Order;

                // Re-validate status in transaction
                if (orderTxData.status === OrderStatus.Cancelled) {
                    logger.warn(`${functionName} TX Conflict: Order ${orderId} was already cancelled. Aborting update.`);
                    return; // Already cancelled, do nothing
                }
                if (!cancellableStatuses.includes(orderTxData.status)) {
                     logger.warn(`${functionName} TX Conflict: Order ${orderId} status changed to ${orderTxData.status} during TX. Aborting cancellation.`);
                     return; // Status changed to non-cancellable state
                }

                // Prepare Order Update
                const now = Timestamp.now();
                const updateData: { [key: string]: any } = {
                    status: OrderStatus.Cancelled,
                    paymentStatus: updatedPaymentStatus, // Update based on void/refund result
                    updatedAt: FieldValue.serverTimestamp(),
                    statusHistory: FieldValue.arrayUnion({
                        status: OrderStatus.Cancelled,
                        timestamp: now,
                        userId: userId,
                        role: userRole,
                        reason: `Cancelled by ${userRole ?? 'User'}${reason ? `: ${reason}` : ''}`
                    }),
                    processingError: null, // Clear previous errors
                };
                // Add refund details if applicable
                if (refundDetails) {
                    updateData.refundDetails = refundDetails;
                }
                // Add void failure details? Maybe store in paymentDetails error fields?
                 if (voidResult && !voidResult.success) {
                     updateData['authDetails.voidErrorCode'] = voidResult.errorCode;
                     updateData['authDetails.voidErrorMessage'] = voidResult.errorMessage;
                 }
                 if (refundResult && !refundResult.success) {
                      updateData['paymentDetails.refundErrorCode'] = refundResult.errorCode; // Assuming paymentDetails exists if refund was attempted
                      updateData['paymentDetails.refundErrorMessage'] = refundResult.errorMessage;
                 }


                // Perform Write
                transaction.update(orderRef, updateData);
            }); // End Transaction
            logger.info(`${functionName} Order ${orderId} status updated to Cancelled successfully.`, logContext);


            // 8. Log Action (Async)
            const logDetails = { orderId, customerId: orderData.customerId, cancelledBy: userId, userRole, reason, initialStatus: orderData.status, finalPaymentStatus: updatedPaymentStatus };
            if (isAdmin) {
                logAdminAction("CancelOrder", logDetails).catch(err => logger.error("Failed logging admin action", { err }));
            } else {
                logUserActivity("CancelOrder", logDetails, userId).catch(err => logger.error("Failed logging user activity", { err }));
            }

            // Note: The background function 'handleOrderCancellationSideEffects' should be triggered
            // by this status update to handle inventory restoration, etc.

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

            // Log failure activity?
            logUserActivity("CancelOrderFailed", { orderId, reason, error: error.message }, userId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
