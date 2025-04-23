import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, EventBooking, EventBookingStatus, PaymentStatus, PaymentDetails
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { chargePaymentMethod } from '../utils/payment_helpers'; // Payment gateway interaction
// import { triggerCreateGoogleCalendarEvent } from '../utils/background_triggers'; // Trigger GCal creation
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity, logAdminAction } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`, context); return userId != null; }
interface ChargeResult { success: boolean; transactionId?: string; error?: string; }
async function chargePaymentMethod(customerId: string, amountSmallestUnit: number, currencyCode: string, description: string, paymentMethodToken?: string | null, paymentGatewayCustomerId?: string | null): Promise<ChargeResult> {
    logger.info(`[Mock Payment] Charging ${amountSmallestUnit} ${currencyCode} for customer ${customerId}. Desc: ${description}. Token provided: ${!!paymentMethodToken}`);
    await new Promise(res => setTimeout(res, 1800)); // Simulate payment processing time
    if (Math.random() < 0.08) { // Simulate higher failure rate for charge
        logger.error("[Mock Payment] Charge FAILED.");
        return { success: false, error: "Mock Charge Declined/Failed" };
    }
    return { success: true, transactionId: `CHG_${Date.now()}` };
}
async function triggerCreateGoogleCalendarEvent(params: { bookingId: string }): Promise<void> { logger.info(`[Mock Trigger] Triggering GCal event creation for booking ${params.bookingId}`); }
interface AdminAlertParams { subject: string; body: string; bookingId?: string; severity: "critical" | "warning" | "info"; }
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
    NotFound = "NOT_FOUND", // Booking or User not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for confirmation
    Aborted = "ABORTED", // Payment Charge failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not PendingCustomerAgreement
    PaymentChargeFailed = "PAYMENT_CHARGE_FAILED",
    SideEffectTriggerFailed = "SIDE_EFFECT_TRIGGER_FAILED", // GCal trigger failed
}

// --- Interfaces ---
interface ConfirmEventAgreementInput {
    bookingId: string;
    paymentMethodToken?: string | null; // Optional: Token from client-side integration (e.g., Stripe, Braintree)
    // Optional: agreeToTerms: boolean; // Could add explicit terms agreement flag
}

// --- The Cloud Function ---
export const confirmEventAgreement = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory for payment interaction
        timeoutSeconds: 90, // Allow more time for payment processing
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // If chargePaymentMethod needs secret
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[confirmEventAgreement V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const customerId = request.auth.uid;
        const data = request.data as ConfirmEventAgreementInput;
        const logContext: any = { customerId, bookingId: data?.bookingId };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            (data.paymentMethodToken != null && typeof data.paymentMethodToken !== 'string'))
        {
            logger.error(`${functionName} Invalid input: Missing bookingId or invalid token type.`, logContext);
            return { success: false, error: "error.invalidInput.bookingIdOrToken", errorCode: ErrorCode.InvalidArgument };
        }
        const { bookingId, paymentMethodToken } = data;

        // --- Variables ---
        let bookingData: EventBooking;
        let userData: User;
        let chargeResult: ChargeResult | null = null;
        let gcalTriggerFailed = false;

        try {
            // Fetch User & Booking Data Concurrently
            const userRef = db.collection('users').doc(customerId);
            const bookingRef = db.collection('eventBookings').doc(bookingId);

            const [userSnap, bookingSnap] = await Promise.all([userRef.get(), bookingRef.get()]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });

            // Validate Booking Exists
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.booking.notFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.totalAmount = bookingData.totalAmountSmallestUnit;
            logContext.currency = bookingData.currencyCode;

            // 3. Ownership Check
            if (bookingData.customerId !== customerId) {
                logger.error(`${functionName} User ${customerId} attempted to confirm agreement for booking ${bookingId} owned by ${bookingData.customerId}.`, logContext);
                return { success: false, error: "error.permissionDenied.notBookingOwner", errorCode: ErrorCode.PermissionDenied };
            }

            // 4. State Validation (Must be PendingCustomerAgreement)
            if (bookingData.bookingStatus !== EventBookingStatus.PendingCustomerAgreement) {
                logger.warn(`${functionName} Booking ${bookingId} is not in PendingCustomerAgreement status (Current: ${bookingData.bookingStatus}).`, logContext);
                 // Idempotency: If already confirmed, return success
                 if (bookingData.bookingStatus === EventBookingStatus.Confirmed) {
                     logger.info(`${functionName} Booking ${bookingId} already confirmed. Idempotent success.`);
                     return { success: true };
                 }
                return { success: false, error: `error.booking.invalidStatus.confirmation::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 5. Process Payment (if total amount > 0)
            const amountToCharge = bookingData.totalAmountSmallestUnit;
            const currencyCode = bookingData.currencyCode;
            let finalPaymentStatus: PaymentStatus | string = bookingData.paymentStatus ?? PaymentStatus.Pending;
            let paymentDetailsUpdate: Partial<PaymentDetails> | null = null;
            const now = Timestamp.now();

            if (amountToCharge > 0) {
                logger.info(`${functionName} Booking ${bookingId}: Attempting to charge ${amountToCharge} ${currencyCode}...`, logContext);
                chargeResult = await chargePaymentMethod(
                    customerId,
                    amountToCharge,
                    currencyCode,
                    `Event Booking ${bookingId}`,
                    paymentMethodToken, // Pass token if provided
                    userData.paymentGatewayCustomerId // Pass stored customer ID if available
                );

                if (!chargeResult.success || !chargeResult.transactionId) {
                    logger.error(`${functionName} Booking ${bookingId}: Payment charge FAILED.`, { ...logContext, error: chargeResult.error });
                    // Update booking status to reflect payment failure before throwing
                    await bookingRef.update({
                        paymentStatus: PaymentStatus.Failed,
                        paymentDetails: {
                            ...(bookingData.paymentDetails ?? {}),
                            chargeTimestamp: now,
                            chargeSuccess: false,
                            chargeError: chargeResult.error || 'Unknown charge error',
                        },
                        processingError: `Payment failed: ${chargeResult.error || 'Unknown'}`,
                        updatedAt: FieldValue.serverTimestamp(),
                    }).catch(err => logger.error("Failed to update booking after payment failure", {err}));
                    throw new HttpsError('aborted', `error.payment.chargeFailed::${chargeResult.error || 'Unknown'}`, { errorCode: ErrorCode.PaymentChargeFailed });
                }

                logger.info(`${functionName} Booking ${bookingId}: Payment charge successful. TxID: ${chargeResult.transactionId}`, logContext);
                finalPaymentStatus = PaymentStatus.Paid; // Or Captured? Use Paid for simplicity.
                paymentDetailsUpdate = { // Prepare details for successful charge
                    chargeTimestamp: now,
                    chargeTransactionId: chargeResult.transactionId,
                    chargeAmountSmallestUnit: amountToCharge,
                    chargeSuccess: true,
                    chargeError: null,
                    currencyCode: currencyCode,
                    // gatewayName: 'MockGateway' // Add if known
                };

            } else {
                logger.info(`${functionName} Booking ${bookingId}: Total amount is 0. Skipping payment charge.`, logContext);
                finalPaymentStatus = PaymentStatus.Paid; // Consider 0 amount as Paid
            }

            // 6. Update Booking Document
            logger.info(`${functionName} Updating booking ${bookingId} status to Confirmed...`, logContext);
            const updateData: Partial<EventBooking> & { updatedAt: admin.firestore.FieldValue } = {
                bookingStatus: EventBookingStatus.Confirmed,
                agreementConfirmedTimestamp: now,
                paymentStatus: finalPaymentStatus,
                updatedAt: FieldValue.serverTimestamp(),
                processingError: null, // Clear previous errors
            };
            if (paymentDetailsUpdate) {
                 updateData.paymentDetails = { ...(bookingData.paymentDetails ?? {}), ...paymentDetailsUpdate };
            }

            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully to Confirmed.`);

            // 7. Trigger Google Calendar Event Creation (Async)
            // Check if GCal integration is enabled in settings (fetch again or pass from create?)
            const settings = await fetchEventSettings(); // Fetch fresh settings
            if (settings?.googleCalendarIntegrationEnabled) {
                logger.info(`${functionName} Triggering Google Calendar event creation for booking ${bookingId}...`, logContext);
                try {
                    await triggerCreateGoogleCalendarEvent({ bookingId });
                } catch (triggerError: any) {
                     gcalTriggerFailed = true;
                     logger.error(`${functionName} CRITICAL: Failed to trigger GCal event creation for booking ${bookingId}. Manual creation required.`, { ...logContext, error: triggerError.message });
                     // Update booking with flag (best effort outside TX)
                     bookingRef.update({ needsManualGcalCheck: true, processingError: `GCal creation trigger failed: ${triggerError.message}` }).catch(...);
                     logAdminAction("GCalCreateTriggerFailed", { bookingId, reason: triggerError.message }).catch(...);
                     // Send Admin Alert
                     sendPushNotification({ subject: `GCal Creation Trigger FAILED - Booking ${bookingId}`, body: `Failed to trigger GCal event creation for confirmed booking ${bookingId}. Manual creation REQUIRED.`, bookingId, severity: "critical" }).catch(...);
                     // Do NOT fail the main function for this async trigger failure.
                }
            } else {
                 logger.info(`${functionName} GCal integration disabled. Skipping trigger.`);
            }

            // 8. Trigger Notifications (Async)
            // Notify Customer of Confirmation
            sendPushNotification({
                userId: customerId, type: "EventBookingConfirmed", langPref: userData.preferredLanguage,
                titleKey: "notification.eventConfirmed.title", messageKey: "notification.eventConfirmed.message",
                messageParams: { bookingIdShort: bookingId.substring(0, 6) },
                payload: { bookingId: bookingId, screen: 'EventDetails' }
            }).catch(err => logger.error("Failed sending customer event confirmed notification", { err }));
            // Notify Admin/Team? (Optional)
            sendPushNotification({
                topic: "admin-confirmed-events", // Or specific users
                type: "AdminEventConfirmedNotice",
                titleKey: "notification.adminEventConfirmed.title", messageKey: "notification.adminEventConfirmed.message",
                messageParams: { bookingId: bookingId, customerName: userData.displayName ?? customerId },
                payload: { bookingId: bookingId, screen: 'AdminEventDetails' }
            }).catch(err => logger.error("Failed sending admin event confirmed notification", { err }));


            // 9. Log User Activity (Async)
            logUserActivity("ConfirmEventAgreement", { bookingId, paymentAttempted: amountToCharge > 0, paymentSuccess: chargeResult?.success ?? (amountToCharge === 0), paymentAmount: amountToCharge, gcalTriggerFailed }, customerId)
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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.confirmAgreement.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            // Log admin action failure
            logAdminAction("ConfirmEventAgreementFailed", { inputData: data, triggerUserId: customerId, errorMessage: error.message, finalErrorCode }).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
