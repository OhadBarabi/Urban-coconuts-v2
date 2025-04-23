import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, Order, OrderStatus, PaymentStatus, PaymentDetails
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { chargePaymentMethod } from '../utils/payment_helpers';
import { sendPushNotification } from '../utils/notifications'; // <-- Import REAL helper
// import { logUserActivity } from '../utils/logging'; // Still using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
// sendPushNotification is now imported from the helper
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
    UserNotFound = "USER_NOT_FOUND",
    NotOrderOwner = "NOT_ORDER_OWNER",
    InvalidOrderStatus = "INVALID_ORDER_STATUS", // Not 'Black' (Completed)
    TipAlreadyAdded = "TIP_ALREADY_ADDED",
    InvalidTipAmount = "INVALID_TIP_AMOUNT",
    PaymentChargeFailed = "PAYMENT_CHARGE_FAILED",
    PaymentActionRequired = "PAYMENT_ACTION_REQUIRED",
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
        const functionName = "[addTipToOrder V4 - Notifications]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const customerId = request.auth.uid;
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
        let chargeResult: Awaited<ReturnType<typeof chargePaymentMethod>> | null = null;

        try {
            // 3. Fetch User & Order Data Concurrently
            const userRef = db.collection('users').doc(customerId);
            const orderRef = db.collection('orders').doc(orderId);
            const [userSnap, orderSnap] = await Promise.all([userRef.get(), orderRef.get()]);

            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });

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
            if (orderData.status !== OrderStatus.Black) {
                 logger.warn(`${functionName} Cannot add tip to order ${orderId} because its status is '${orderData.status}'.`, logContext);
                 return { success: false, error: `error.order.invalidStatus.addTip::${orderData.status}`, errorCode: ErrorCode.InvalidOrderStatus };
            }
            if (orderData.tipAmountSmallestUnit != null && orderData.tipAmountSmallestUnit > 0) {
                 logger.warn(`${functionName} Tip already added to order ${orderId}.`, logContext);
                 return { success: false, error: "error.order.tipAlreadyAdded", errorCode: ErrorCode.TipAlreadyAdded };
            }

            // 6. Process Tip Payment
            logger.info(`${functionName} Order ${orderId}: Attempting to charge tip amount ${tipAmountSmallestUnit} ${orderData.currencyCode}...`, logContext);
            chargeResult = await chargePaymentMethod(
                customerId, tipAmountSmallestUnit, orderData.currencyCode,
                `Tip for Order ${orderId} - Urban Coconuts`,
                paymentMethodToken, userData.paymentGatewayCustomerId, orderId
            );

            if (!chargeResult.success || (!chargeResult.transactionId && !chargeResult.requiresAction)) {
                 logger.error(`${functionName} Order ${orderId}: Tip charge FAILED.`, { ...logContext, error: chargeResult.errorMessage, code: chargeResult.errorCode });
                 if (chargeResult.requiresAction) {
                      return { success: false, error: "error.payment.actionRequired", errorCode: ErrorCode.PaymentActionRequired, requiresAction: true, actionUrl: chargeResult.actionUrl };
                 } else {
                      return { success: false, error: `error.payment.chargeFailed::${chargeResult.errorCode || 'Unknown'}`, errorCode: ErrorCode.PaymentChargeFailed };
                 }
            }
            logger.info(`${functionName} Order ${orderId}: Tip charge initiated. TxID/IntentID: ${chargeResult.transactionId}. Requires Action: ${chargeResult.requiresAction}`, logContext);

            // 7. Update Order Document with Tip and New Final Amount
            const newFinalAmount = (orderData.finalAmount ?? 0) + tipAmountSmallestUnit;
            const now = Timestamp.now();
            const serverTimestamp = FieldValue.serverTimestamp();
            const tipPaymentDetails: PaymentDetails = {
                 chargeTimestamp: now,
                 chargeTransactionId: chargeResult.transactionId ?? `ACTION_REQ_${chargeResult.timestamp?.toMillis()}`,
                 chargeAmountSmallestUnit: tipAmountSmallestUnit,
                 chargeSuccess: !chargeResult.requiresAction,
                 currencyCode: orderData.currencyCode,
                 gatewayName: chargeResult.gatewayName,
                 paymentMethodType: chargeResult.paymentMethodType,
                 paymentMethodLast4: chargeResult.last4,
                 requiresAction: chargeResult.requiresAction,
                 actionUrl: chargeResult.actionUrl,
                 errorCode: chargeResult.errorCode,
                 errorMessage: chargeResult.errorMessage,
            };

            logger.info(`${functionName} Updating order ${orderId} with tip amount and details...`, logContext);
            await orderRef.update({
                tipAmountSmallestUnit: tipAmountSmallestUnit,
                finalAmount: newFinalAmount,
                tipPaymentDetails: tipPaymentDetails,
                updatedAt: serverTimestamp,
            });
            logger.info(`${functionName} Order ${orderId} updated successfully with tip details.`);

            // 8. Trigger Notifications (Using REAL Helper - currently Mock)
            if (!chargeResult.requiresAction && chargeResult.success && orderData.courierId) {
                 // Call the imported helper function
                 sendPushNotification({
                     userId: orderData.courierId, // Target the courier
                     type: "TipReceived",
                     titleKey: "notification.tipReceived.title", // i18n keys for client app
                     messageKey: "notification.tipReceived.message",
                     messageParams: { // Parameters for localization
                         // Consider privacy: maybe don't send customer name?
                         // customerName: userData.displayName ?? 'Customer',
                         amount: (tipAmountSmallestUnit / 100).toFixed(2), // Format amount
                         currency: orderData.currencyCode
                     },
                     payload: { // Optional data for client app navigation
                         orderId: orderId,
                         screen: 'orderDetails' // Example screen hint
                     }
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

            logUserActivity("AddTipToOrderFailed", { orderId, tipAmount: data?.tipAmountSmallestUnit, error: error.message }, customerId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
