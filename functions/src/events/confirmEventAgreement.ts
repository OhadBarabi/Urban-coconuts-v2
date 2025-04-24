import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, EventBooking, EventBookingStatus, PaymentStatus, PaymentDetails
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { chargePaymentMethod, extractPaymentDetailsFromResult } from '../utils/payment_helpers';
import { logUserActivity } from '../utils/logging'; // Using mock below
// import { createGoogleCalendarEvent } from './createGoogleCalendarEvent'; // Background function triggered separately

// --- Mocks for other required helper functions (Replace with actual implementations) ---
// async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); } // Imported
// createGoogleCalendarEvent is a background function
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
    Aborted = "ABORTED", // Transaction or Payment Charge failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    NotBookingOwner = "NOT_BOOKING_OWNER",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not 'PendingCustomerConfirmation'
    PaymentChargeFailed = "PAYMENT_CHARGE_FAILED",
    PaymentActionRequired = "PAYMENT_ACTION_REQUIRED",
}

// --- Interfaces ---
interface ConfirmEventAgreementInput {
    bookingId: string;
    paymentMethodToken?: string | null; // Optional: If payment needs a new token
}

// --- The Cloud Function ---
export const confirmEventAgreement = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for reads/payment
        timeoutSeconds: 120, // Increase timeout for payment processing
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // Uncomment if payment helper needs secrets
    },
    async (request): Promise<{ success: true; requiresAction?: boolean; actionUrl?: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[confirmEventAgreement V2 - Permissions]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const customerId = request.auth.uid;
        const data = request.data as ConfirmEventAgreementInput;
        const logContext: any = { customerId, bookingId: data?.bookingId };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            (data.paymentMethodToken != null && typeof data.paymentMethodToken !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { bookingId, paymentMethodToken } = data;

        // --- Variables ---
        let bookingData: EventBooking;
        let userData: User;
        let chargeResult: Awaited<ReturnType<typeof chargePaymentMethod>> | null = null;
        let paymentStatus: PaymentStatus;
        let paymentDetails: PaymentDetails | null = null;

        // --- Firestore References ---
        const bookingRef = db.collection('eventBookings').doc(bookingId);
        const userRef = db.collection('users').doc(customerId);

        try {
            // 3. Fetch User and Booking Data Concurrently
            const [userSnap, bookingSnap] = await Promise.all([userRef.get(), bookingRef.get()]);

            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            logContext.userRole = userData.role;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });

            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Event booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.event.bookingNotFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.bookingCustomerId = bookingData.customerId;
            logContext.totalAmount = bookingData.totalAmountSmallestUnit;
            logContext.currencyCode = bookingData.currencyCode;

            // 4. Permission/Ownership Check
            if (bookingData.customerId !== customerId) {
                 logger.error(`${functionName} User ${customerId} attempted to confirm agreement for booking ${bookingId} owned by ${bookingData.customerId}.`, logContext);
                 return { success: false, error: "error.permissionDenied.notBookingOwner", errorCode: ErrorCode.NotBookingOwner };
            }

            // 5. State Validation
            if (bookingData.bookingStatus !== EventBookingStatus.PendingCustomerConfirmation) {
                logger.warn(`${functionName} Event booking ${bookingId} is not in 'PendingCustomerConfirmation' status (current: ${bookingData.bookingStatus}). Cannot confirm agreement.`, logContext);
                 if (bookingData.bookingStatus === EventBookingStatus.Confirmed || bookingData.bookingStatus === EventBookingStatus.Scheduled) {
                      logger.info(`${functionName} Booking ${bookingId} already confirmed (status: ${bookingData.bookingStatus}). Assuming idempotent call.`, logContext);
                      return { success: true };
                 }
                return { success: false, error: `error.event.invalidStatus.confirm::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 6. Process Event Payment
            const amountToCharge = bookingData.totalAmountSmallestUnit;
            paymentStatus = PaymentStatus.ChargePending;

            if (amountToCharge == null || amountToCharge <= 0) {
                logger.warn(`${functionName} Booking ${bookingId} has zero or invalid total amount (${amountToCharge}). Marking as Paid without charge.`, logContext);
                paymentStatus = PaymentStatus.Paid;
            } else {
                logger.info(`${functionName} Attempting to charge ${amountToCharge} ${bookingData.currencyCode} for event booking ${bookingId}...`, logContext);
                chargeResult = await chargePaymentMethod(
                    customerId, amountToCharge, bookingData.currencyCode,
                    `Payment for Event Booking ${bookingId}`,
                    paymentMethodToken, userData.paymentGatewayCustomerId, bookingId
                );
                paymentDetails = extractPaymentDetailsFromResult(chargeResult);

                if (!chargeResult.success || (!chargeResult.transactionId && !chargeResult.requiresAction)) {
                    paymentStatus = PaymentStatus.ChargeFailed;
                    logger.error(`${functionName} Event payment charge failed for booking ${bookingId}.`, { ...logContext, error: chargeResult.errorMessage, code: chargeResult.errorCode });
                } else {
                    paymentStatus = PaymentStatus.Paid;
                    logger.info(`${functionName} Event payment charge successful for booking ${bookingId}. TxID: ${chargeResult.transactionId}`, logContext);
                    if (chargeResult.requiresAction) {
                        paymentStatus = PaymentStatus.ChargeActionRequired;
                        logger.warn(`${functionName} Event payment charge requires further action (e.g., 3DS).`, logContext);
                    }
                }
            }
            logContext.paymentStatus = paymentStatus;

            // 7. Update Event Booking Document
            const now = Timestamp.now();
            let finalBookingStatus = bookingData.bookingStatus;
            if (paymentStatus === PaymentStatus.Paid || paymentStatus === PaymentStatus.ChargeActionRequired) {
                 finalBookingStatus = EventBookingStatus.Confirmed;
            }
            logContext.newStatus = finalBookingStatus;

            const updateData: { [key: string]: any } = {
                bookingStatus: finalBookingStatus,
                agreementConfirmedTimestamp: now,
                paymentStatus: paymentStatus,
                paymentDetails: paymentDetails ?? bookingData.paymentDetails,
                updatedAt: FieldValue.serverTimestamp(),
                statusChangeHistory: FieldValue.arrayUnion({
                    from: bookingData.bookingStatus, to: finalBookingStatus, timestamp: now, userId: customerId, role: userData.role,
                    reason: `Customer confirmed agreement. Payment Status: ${paymentStatus}`
                }),
                processingError: paymentStatus === PaymentStatus.ChargeFailed ? `Payment Charge Failed: ${chargeResult?.errorMessage ?? 'Unknown'}` : null,
            };

            logger.info(`${functionName} Updating event booking ${bookingId} status to ${finalBookingStatus} and payment status to ${paymentStatus}...`, logContext);
            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully.`, logContext);

            // 8. Log User Activity (Async)
            logUserActivity("ConfirmEventAgreement", { bookingId, paymentStatus, totalAmount: amountToCharge }, customerId)
                .catch(err => logger.error("Failed logging ConfirmEventAgreement user activity", { err })); // Fixed catch

            // 9. Return Success
            const successResponse: { success: true; requiresAction?: boolean; actionUrl?: string } = { success: true };
            if (paymentStatus === PaymentStatus.ChargeActionRequired && chargeResult?.requiresAction) {
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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.confirmAgreement.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            logUserActivity("ConfirmEventAgreementFailed", { bookingId, error: error.message }, customerId)
                .catch(err => logger.error("Failed logging ConfirmEventAgreementFailed user activity", { err })); // Fixed catch

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
