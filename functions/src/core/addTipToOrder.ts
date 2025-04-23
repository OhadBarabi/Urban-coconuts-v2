import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, Order, OrderStatus, PaymentStatus, PaymentDetails
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions'; // Might not be needed if only owner can tip
// import { chargePaymentMethod } from '../utils/payment_helpers'; // Payment gateway interaction for tip charge
// import { logUserActivity } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`, context); return userId != null; }
interface ChargeResult { success: boolean; transactionId?: string; error?: string; }
async function chargePaymentMethod(customerId: string, amountSmallestUnit: number, currencyCode: string, description: string, paymentMethodToken?: string | null, paymentGatewayCustomerId?: string | null, orderId?: string): Promise<ChargeResult> {
    logger.info(`[Mock Payment] Charging TIP ${amountSmallestUnit} ${currencyCode} for customer ${customerId}. Order: ${orderId}. Token provided: ${!!paymentMethodToken}`);
    await new Promise(res => setTimeout(res, 1800)); // Simulate payment processing time
    if (Math.random() < 0.08) { // Simulate higher failure rate for charge
        logger.error("[Mock Payment] Tip Charge FAILED.");
        return { success: false, error: "Mock Tip Charge Declined/Failed" };
    }
    return { success: true, transactionId: `TIP_CHG_${Date.now()}` };
}
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
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
    NotOrderOwner = "NOT_ORDER_OWNER",
    InvalidOrderStatus = "INVALID_ORDER_STATUS", // Not 'Black' (Completed)
    TipAlreadyAdded = "TIP_ALREADY_ADDED",
    InvalidTipAmount = "INVALID_TIP_AMOUNT",
    PaymentChargeFailed = "PAYMENT_CHARGE_FAILED",
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
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // If chargePaymentMethod needs secret
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[addTipToOrder V1]";
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
        let chargeResult: ChargeResult | null = null;

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

            // 6. Process Tip Payment (if needed)
            // We need to charge the tip amount separately.
            // Assume the original order payment is already settled (Paid/Captured).
            logger.info(`${functionName} Order ${orderId}: Attempting to charge tip amount ${tipAmountSmallestUnit} ${orderData.currencyCode}...`, logContext);
            chargeResult = await chargePaymentMethod(
                customerId,
                tipAmountSmallestUnit,
                orderData.currencyCode,
                `Tip for Order ${orderId}`,
                paymentMethodToken, // Use new token if provided, otherwise default/stored method
                userData.paymentGatewayCustomerId,
                orderId // Pass orderId for reference in payment gateway
            );

            if (!chargeResult.success || !chargeResult.transactionId) {
                 logger.error(`${functionName} Order ${orderId}: Tip charge FAILED.`, { ...logContext, error: chargeResult.error });
                 // Don't update the order if tip charge fails.
                 throw new HttpsError('aborted', `error.payment.chargeFailed::${chargeResult.error || 'Unknown'}`, { errorCode: ErrorCode.PaymentChargeFailed });
            }
            logger.info(`${functionName} Order ${orderId}: Tip charge successful. TxID: ${chargeResult.transactionId}`, logContext);

            // 7. Update Order Document with Tip and New Final Amount
            const newFinalAmount = (orderData.finalAmount ?? 0) + tipAmountSmallestUnit;
            const now = Timestamp.now();
            const serverTimestamp = FieldValue.serverTimestamp();

            // Store tip payment details separately or append to existing paymentDetails?
            // Let's add a separate field for tip payment details for clarity.
            const tipPaymentDetails: PaymentDetails = {
                 chargeTimestamp: now,
                 chargeTransactionId: chargeResult.transactionId,
                 chargeAmountSmallestUnit: tipAmountSmallestUnit,
                 chargeSuccess: true,
                 currencyCode: orderData.currencyCode,
                 // gatewayName: 'MockGateway' // Add if known
            };

            logger.info(`${functionName} Updating order ${orderId} with tip amount and new final amount...`, logContext);
            await orderRef.update({
                tipAmountSmallestUnit: tipAmountSmallestUnit,
                finalAmount: newFinalAmount, // Update final amount to include tip
                tipPaymentDetails: tipPaymentDetails, // Store tip payment info
                updatedAt: serverTimestamp,
                // Add to status history? Optional.
                // statusHistory: FieldValue.arrayUnion({ status: orderData.status, timestamp: now, userId: customerId, reason: `Tip added: ${tipAmountSmallestUnit}` })
            });
            logger.info(`${functionName} Order ${orderId} updated successfully with tip.`);


            // 8. Trigger Notifications (Optional)
            // Notify Courier about the tip?
            if (orderData.courierId) {
                 sendPushNotification({
                     userId: orderData.courierId, type: "TipReceived",
                     titleKey: "notification.tipReceived.title", messageKey: "notification.tipReceived.message",
                     messageParams: { customerName: userData.displayName ?? 'Customer', amount: (tipAmountSmallestUnit / 100).toFixed(2), currency: orderData.currencyCode },
                     payload: { orderId: orderId }
                 }).catch(err => logger.error("Failed sending courier tip notification", { err }));
            }

            // 9. Log User Activity (Async)
            logUserActivity("AddTipToOrder", { orderId, tipAmount: tipAmountSmallestUnit, paymentSuccess: chargeResult.success }, customerId)
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
