import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, EventBooking, EventBookingStatus, PaymentStatus, PaymentDetails
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions'; // <-- Import REAL helper
import { chargePaymentMethod, extractPaymentDetailsFromResult } from '../utils/payment_helpers'; // Use charge for event deposit/payment
// import { logUserActivity } from '../utils/logging'; // Using mock below
// import { createGoogleCalendarEvent } from './createGoogleCalendarEvent'; // Assuming background function is triggered separately or called if needed

// --- Mocks for other required helper functions (Replace with actual implementations) ---
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
// createGoogleCalendarEvent is a background function, likely triggered by status change, not called directly here.
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
// const EVENT_CALENDAR_TOPIC = "create-google-calendar-event"; // If triggering background func via Pub/Sub

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
    NotBookingOwner = "NOT_BOOKING_OWNER", // Only customer confirms
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not 'PendingCustomerConfirmation'
    PaymentChargeFailed = "PAYMENT_CHARGE_FAILED",
    PaymentActionRequired = "PAYMENT_ACTION_REQUIRED",
    // PubSubError = "PUB_SUB_ERROR", // If using Pub/Sub trigger
}

// --- Interfaces ---
interface ConfirmEventAgreementInput {
    bookingId: string;
    paymentMethodToken?: string | null; // Optional: If payment needs a new token (e.g., first payment)
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
        const functionName = "[confirmEventAgreement V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const customerId = request.auth.uid; // Customer confirming the agreement
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

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            logContext.userRole = userData.role; // Although likely 'Customer'
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });

            // Validate Booking
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Event booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.event.bookingNotFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.bookingCustomerId = bookingData.customerId;
            logContext.totalAmount = bookingData.totalAmountSmallestUnit;
            logContext.currencyCode = bookingData.currencyCode;

            // 4. Permission/Ownership Check (Using REAL helper or direct check)
            // Only the customer who owns the booking should confirm the agreement.
            if (bookingData.customerId !== customerId) {
                 logger.error(`${functionName} User ${customerId} attempted to confirm agreement for booking ${bookingId} owned by ${bookingData.customerId}.`, logContext);
                 return { success: false, error: "error.permissionDenied.notBookingOwner", errorCode: ErrorCode.NotBookingOwner };
            }
            // Optional: Use checkPermission if a specific permission exists ('event:confirmAgreement:own')
            // const hasPermission = await checkPermission(customerId, userData.role, 'event:confirmAgreement:own', logContext);
            // if (!hasPermission) { ... return permission denied ... }


            // 5. State Validation
            if (bookingData.bookingStatus !== EventBookingStatus.PendingCustomerConfirmation) {
                logger.warn(`${functionName} Event booking ${bookingId} is not in 'PendingCustomerConfirmation' status (current: ${bookingData.bookingStatus}). Cannot confirm agreement.`, logContext);
                 // Handle cases where it might already be confirmed - maybe return success?
                 if (bookingData.bookingStatus === EventBookingStatus.Confirmed || bookingData.bookingStatus === EventBookingStatus.Scheduled) {
                      logger.info(`${functionName} Booking ${bookingId} already confirmed (status: ${bookingData.bookingStatus}). Assuming idempotent call.`, logContext);
                      return { success: true }; // Idempotency
                 }
                return { success: false, error: `error.event.invalidStatus.confirm::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 6. Process Event Payment (Deposit or Full Amount?)
            // Assuming full payment or first installment is charged upon agreement confirmation.
            // Use chargePaymentMethod helper.
            const amountToCharge = bookingData.totalAmountSmallestUnit; // Charge the full amount for now
            paymentStatus = PaymentStatus.ChargePending; // Initial status before calling payment gateway

            if (amountToCharge == null || amountToCharge <= 0) {
                // Should not happen if validation during creation/approval worked, but handle defensively.
                logger.warn(`${functionName} Booking ${bookingId} has zero or invalid total amount (${amountToCharge}). Marking as Paid without charge.`, logContext);
                paymentStatus = PaymentStatus.Paid;
            } else {
                logger.info(`${functionName} Attempting to charge ${amountToCharge} ${bookingData.currencyCode} for event booking ${bookingId}...`, logContext);
                chargeResult = await chargePaymentMethod(
                    customerId,
                    amountToCharge,
                    bookingData.currencyCode,
                    `Payment for Event Booking ${bookingId}`,
                    paymentMethodToken,
                    userData.paymentGatewayCustomerId,
                    bookingId // Link charge to booking ID
                );

                paymentDetails = extractPaymentDetailsFromResult(chargeResult); // Extract details

                if (!chargeResult.success || (!chargeResult.transactionId && !chargeResult.requiresAction)) {
                    paymentStatus = PaymentStatus.ChargeFailed;
                    logger.error(`${functionName} Event payment charge failed for booking ${bookingId}.`, { ...logContext, error: chargeResult.errorMessage, code: chargeResult.errorCode });
                    // Update booking with failed status but don't throw error here, let the update proceed.
                } else {
                    paymentStatus = PaymentStatus.Paid; // Mark as Paid if successful charge
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
            const newStatus = (paymentStatus === PaymentStatus.Paid) ? EventBookingStatus.Confirmed : // Move to Confirmed if paid
                              (paymentStatus === PaymentStatus.ChargeActionRequired) ? EventBookingStatus.PendingPaymentAction : // Custom status? Or keep PendingCustomerConfirmation? Let's use Confirmed but rely on paymentStatus.
                              EventBookingStatus.PendingCustomerConfirmation; // Stay pending if charge failed? Or move to a failed state? Let's keep PendingConfirmation but log error.

            // Let's simplify: If payment succeeds (no action needed), status -> Confirmed.
            // If payment requires action, status -> Confirmed, paymentStatus -> ChargeActionRequired.
            // If payment fails, status -> PendingCustomerConfirmation, paymentStatus -> ChargeFailed.
            let finalBookingStatus = bookingData.bookingStatus; // Default to current
            if (paymentStatus === PaymentStatus.Paid || paymentStatus === PaymentStatus.ChargeActionRequired) {
                 finalBookingStatus = EventBookingStatus.Confirmed;
            }

            logContext.newStatus = finalBookingStatus;

            const updateData: { [key: string]: any } = {
                bookingStatus: finalBookingStatus,
                agreementConfirmedTimestamp: now,
                paymentStatus: paymentStatus, // Update payment status based on charge result
                paymentDetails: paymentDetails ?? bookingData.paymentDetails, // Store new payment details
                updatedAt: FieldValue.serverTimestamp(),
                statusChangeHistory: FieldValue.arrayUnion({
                    from: bookingData.bookingStatus,
                    to: finalBookingStatus,
                    timestamp: now,
                    userId: customerId,
                    role: userData.role,
                    reason: `Customer confirmed agreement. Payment Status: ${paymentStatus}`
                }),
                processingError: paymentStatus === PaymentStatus.ChargeFailed ? `Payment Charge Failed: ${chargeResult?.errorMessage ?? 'Unknown'}` : null, // Log error if charge failed
            };

            logger.info(`${functionName} Updating event booking ${bookingId} status to ${finalBookingStatus} and payment status to ${paymentStatus}...`, logContext);
            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully.`, logContext);

            // 8. Trigger Background Function for Google Calendar Event (Optional: if not triggered by status change)
            // if (finalBookingStatus === EventBookingStatus.Confirmed) {
            //     logger.info(`${functionName} Publishing message to ${EVENT_CALENDAR_TOPIC} for booking ${bookingId}...`, logContext);
            //     await publishToPubSub(EVENT_CALENDAR_TOPIC, { bookingId: bookingId });
            // }

            // 9. Log User Activity (Async)
            logUserActivity("ConfirmEventAgreement", { bookingId, paymentStatus, totalAmount: amountToCharge }, customerId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 10. Return Success (potentially with action required)
            const successResponse: { success: true; requiresAction?: boolean; actionUrl?: string } = { success: true };
            if (paymentStatus === PaymentStatus.ChargeActionRequired && chargeResult?.requiresAction) {
                successResponse.requiresAction = true;
                successResponse.actionUrl = chargeResult.actionUrl ?? undefined;
            }
            // Return success even if payment failed, as the agreement was conceptually confirmed. Client needs to check status.
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
            // No transaction errors expected here unless DB fails

            logUserActivity("ConfirmEventAgreementFailed", { bookingId, error: error.message }, customerId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
