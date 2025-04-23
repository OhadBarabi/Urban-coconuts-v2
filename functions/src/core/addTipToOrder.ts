import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, Order, OrderStatus, PaymentStatus, PaymentDetails
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
// import { checkPermission } from '../utils/permissions'; // Still using mock below
import { chargePaymentMethod } from '../utils/payment_helpers'; // <-- Import from new helper
// import { logUserActivity } from '../utils/logging'; // Still using mock below
// import { sendPushNotification } from '../utils/notifications'; // Still using mock below

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`, context); return userId != null; }
// chargePaymentMethod is now imported from the helper, mock is inside the helper file.
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
interface NotificationPayload { userId: string; type: string; titleKey: string; messageKey: string; messageParams?: { [key: string]: any }; payload?: { [key: string]: string }; }
async function sendPushNotification(notification: NotificationPayload): Promise<void> { logger.info(`[Mock Notification] Sending push notification to ${notification.userId}`, notification); }
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
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for adding tip, tip already added
    Aborted = "ABORTED", // Payment Charge failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    OrderNotFound = "ORDER_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND", // Added for completeness
    NotOrderOwner = "NOT_ORDER_OWNER",
    InvalidOrderStatus = "INVALID_ORDER_STATUS", // Not 'Black' (Completed)
    TipAlreadyAdded = "TIP_ALREADY_ADDED",
    InvalidTipAmount = "INVALID_TIP_AMOUNT",
    PaymentChargeFailed = "PAYMENT_CHARGE_FAILED",
    PaymentActionRequired = "PAYMENT_ACTION_REQUIRED", // Added in case direct charge needs action
}

// --- Interfaces ---
interface AddTipToOrderInput {
    orderId: string;
    tipAmountSmallestUnit: number; // Integer, must be > 0
    paymentMethodToken?: string | null; // Optional: If a new payment method/token is needed for the tip
}

// --- The Cloud Function ---
export const addTipToOrder = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory for payment interaction
        timeoutSeconds: 90, // Allow more time for payment processing
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // Uncomment if payment helper needs secrets
    },
    async (request): Promise<{ success: true; requiresAction?: boolean; actionUrl?: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[addTipToOrder V2 - Refactored]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const customerId = request.auth.uid; // Customer adding tip to their own order
        const data = request.data as AddTipToOrderInput;
        const logContext: any = { customerId, orderId: data?.orderId, tipAmount: data?.tipAmountSmallestUnit };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.orderId || typeof data.orderId !== 'string' ||
            typeof data.tipAmountSmallestUnit !== 'number' || !Number.isInteger(data.tipAmountSmallestUnit) || data.tipAmountSmallestUnit <= 0 ||
            (data.paymentMethodToken != null && typeof data.paymentMethodToken !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structureOrTipAmount", errorCode: ErrorCode.InvalidArgument };
        }
        const { orderId, tipAmountSmallestUnit, paymentMethodToken } = data;

        // --- Variables ---
        let orderData: Order;
        let userData: User;
        let chargeResult: Awaited<ReturnType<typeof chargePaymentMethod>> | null = null; // Use type from helper

        try {
            // 3. Fetch User & Order Data Concurrently
            const userRef = db.collection('users').doc(customerId);
            const orderRef = db.collection('orders').doc(orderId);

            const [userSnap, orderSnap] = await Promise.all([userRef.get(), orderRef.get()]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });

            // Validate Order Exists
            if (!orderSnap.exists) {
                logger.warn(`${functionName} Order ${orderId} not found.`, logContext);
                return { success: false, error: "error.order.notFound", errorCode: ErrorCode.OrderNotFound };
            }
            orderData = orderSnap.data() as Order;
            logContext.currentStatus = orderData.status;
            logContext.orderCustomerId = orderData.customerId;
            logContext.paymentStatus = orderData.paymentStatus;
            logContext.currentTip = orderData.tipAmountSmallestUnit;
            logContext.currencyCode = orderData.currencyCode;

            // 4. Ownership Check
            if (orderData.customerId !== customerId) {
                logger.error(`${functionName} User ${customerId} attempted to add tip to order ${orderId} owned by ${orderData.customerId}.`, logContext);
                return { success: false, error: "error.permissionDenied.notOrderOwner", errorCode: ErrorCode.NotOrderOwner };
            }

            // 5. State Validation
            // Allow adding tip only if order is completed ('Black')
            if (orderData.status !== OrderStatus.Black) {
                 logger.warn(`${functionName} Cannot add tip to order ${orderId} because its status is '${orderData.status}'.`, logContext);
                 return { success: false, error: `error.order.invalidStatus.addTip::${orderData.status}`, errorCode: ErrorCode.InvalidOrderStatus };
            }
            // Check if tip was already added
            if (orderData.tipAmountSmallestUnit != null && orderData.tipAmountSmallestUnit > 0) {
                 logger.warn(`${functionName} Tip already added to order ${orderId}.`, logContext);
                 return { success: false, error: "error.order.tipAlreadyAdded", errorCode: ErrorCode.TipAlreadyAdded };
            }

            // 6. Process Tip Payment
            logger.info(`${functionName} Order ${orderId}: Attempting to charge tip amount ${tipAmountSmallestUnit} ${orderData.currencyCode}...`, logContext);
            chargeResult = await chargePaymentMethod(
                customerId,
                tipAmountSmallestUnit,
                orderData.currencyCode,
                `Tip for Order ${orderId} - Urban Coconuts`,
                paymentMethodToken, // Use new token if provided, otherwise default/stored method
                userData.paymentGatewayCustomerId,
                orderId // Pass orderId for reference in payment gateway
            );

            if (!chargeResult.success || (!chargeResult.transactionId && !chargeResult.requiresAction)) {
                 logger.error(`${functionName} Order ${orderId}: Tip charge FAILED.`, { ...logContext, error: chargeResult.errorMessage, code: chargeResult.errorCode });
                 // Return specific error based on payment failure
                 if (chargeResult.requiresAction) {
                      // This case might be less common for tips, but handle it
                      return { success: false, error: "error.payment.actionRequired", errorCode: ErrorCode.PaymentActionRequired, requiresAction: true, actionUrl: chargeResult.actionUrl };
                 } else {
                      return { success: false, error: `error.payment.chargeFailed::${chargeResult.errorCode || 'Unknown'}`, errorCode: ErrorCode.PaymentChargeFailed };
                 }
            }
            logger.info(`${functionName} Order ${orderId}: Tip charge initiated. TxID/IntentID: ${chargeResult.transactionId}. Requires Action: ${chargeResult.requiresAction}`, logContext);

            // 7. Update Order Document with Tip and New Final Amount
            // We update the order even if requiresAction is true, but maybe set a specific payment status?
            const newFinalAmount = (orderData.finalAmount ?? 0) + tipAmountSmallestUnit;
            const now = Timestamp.now();
            const serverTimestamp = FieldValue.serverTimestamp();

            // Store tip payment details separately or append? Let's use a dedicated field.
            const tipPaymentDetails: PaymentDetails = {
                 chargeTimestamp: now,
                 chargeTransactionId: chargeResult.transactionId ?? `ACTION_REQ_${chargeResult.timestamp?.toMillis()}`, // Use placeholder if only action required
                 chargeAmountSmallestUnit: tipAmountSmallestUnit,
                 chargeSuccess: !chargeResult.requiresAction, // Mark as success only if no action needed immediately
                 currencyCode: orderData.currencyCode,
                 gatewayName: chargeResult.gatewayName,
                 paymentMethodType: chargeResult.paymentMethodType,
                 paymentMethodLast4: chargeResult.last4,
                 requiresAction: chargeResult.requiresAction,
                 actionUrl: chargeResult.actionUrl,
                 errorCode: chargeResult.errorCode,
                 errorMessage: chargeResult.errorMessage,
            };

            // Determine the payment status update
            let updatedPaymentStatus = orderData.paymentStatus; // Keep original status unless tip succeeds without action
            if (!chargeResult.requiresAction && chargeResult.success) {
                // If original was 'Paid', it remains 'Paid'. If it was something else (unlikely for completed order), update?
                // Let's assume the order payment status is already final ('Paid' or 'Captured'). Adding a tip doesn't change that status.
                // We just record the tip payment separately.
                 logger.info(`${functionName} Tip charge successful without action. Order payment status remains ${updatedPaymentStatus}.`, logContext);
            } else if (chargeResult.requiresAction) {
                 // What should the order payment status be if tip requires action?
                 // Maybe add a specific status like 'TipActionRequired'? Or just rely on tipPaymentDetails?
                 // Let's rely on tipPaymentDetails for now.
                 logger.warn(`${functionName} Tip charge requires further action. Order payment status remains ${updatedPaymentStatus}.`, logContext);
            }


            logger.info(`${functionName} Updating order ${orderId} with tip amount and details...`, logContext);
            await orderRef.update({
                tipAmountSmallestUnit: tipAmountSmallestUnit,
                finalAmount: newFinalAmount, // Update final amount to include tip
                tipPaymentDetails: tipPaymentDetails, // Store tip payment info
                // paymentStatus: updatedPaymentStatus, // Decide if order payment status needs update
                updatedAt: serverTimestamp,
            });
            logger.info(`${functionName} Order ${orderId} updated successfully with tip details.`);


            // 8. Trigger Notifications (Optional) - Only if charge succeeded without action?
            if (!chargeResult.requiresAction && chargeResult.success && orderData.courierId) {
                 sendPushNotification({
                     userId: orderData.courierId, type: "TipReceived",
                     titleKey: "notification.tipReceived.title", messageKey: "notification.tipReceived.message",
                     messageParams: { /*customerName: userData.displayName ?? 'Customer',*/ amount: (tipAmountSmallestUnit / 100).toFixed(2), currency: orderData.currencyCode }, // Removed name for privacy?
                     payload: { orderId: orderId }
                 }).catch(err => logger.error("Failed sending courier tip notification", { err }));
            }

            // 9. Log User Activity (Async)
            logUserActivity("AddTipToOrder", { orderId, tipAmount: tipAmountSmallestUnit, paymentSuccess: chargeResult.success, requiresAction: chargeResult.requiresAction }, customerId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 10. Return Success (potentially with action required)
            const successResponse: { success: true; requiresAction?: boolean; actionUrl?: string } = { success: true };
            if (chargeResult.requiresAction) {
                successResponse.requiresAction = true;
                successResponse.actionUrl = chargeResult.actionUrl ?? undefined;
            }
            return successResponse;

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.addTip.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            // Log failure activity?
            logUserActivity("AddTipToOrderFailed", { orderId, tipAmount: data?.tipAmountSmallestUnit, error: error.message }, customerId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
