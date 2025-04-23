import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, EventBooking, EventBookingStatus, PaymentStatus, RefundDetails // Added RefundDetails
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions'; // <-- Import REAL helper
import { voidAuthorization, processRefund, extractPaymentDetailsFromResult } from '../utils/payment_helpers'; // Import payment helpers for potential void/refund
// import { logUserActivity, logAdminAction } from '../utils/logging'; // Using mocks below
// import { deleteGoogleCalendarEvent } from '../utils/google_calendar_helpers'; // Using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
async function deleteGoogleCalendarEvent(eventId: string): Promise<{ success: boolean; error?: string }> { logger.info(`[Mock GCal] Deleting event ${eventId}`); await new Promise(res => setTimeout(res, 300)); return { success: true }; }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
// const EVENT_CALENDAR_DELETE_TOPIC = "delete-google-calendar-event"; // If triggering background func via Pub/Sub

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Booking or User not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for cancellation
    Aborted = "ABORTED", // Transaction or Payment Void/Refund failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    NotBookingOwnerOrAdmin = "NOT_BOOKING_OWNER_OR_ADMIN",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not cancellable from this state
    PaymentVoidFailed = "PAYMENT_VOID_FAILED",
    PaymentRefundFailed = "PAYMENT_REFUND_FAILED",
    MissingPaymentInfo = "MISSING_PAYMENT_INFO",
    GcalDeleteFailed = "GCAL_DELETE_FAILED",
    TransactionFailed = "TRANSACTION_FAILED", // Added for TX errors
}

// --- Interfaces ---
interface CancelEventBookingInput {
    bookingId: string;
    reason?: string | null; // Reason for cancellation
}

// --- The Cloud Function ---
// Renamed export to avoid conflict with rental cancellation function if both are in index.ts
export const cancelEventBooking = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for reads/transaction/payment/gcal
        timeoutSeconds: 120, // Increase timeout for payment/gcal processing
        // secrets: ["PAYMENT_GATEWAY_SECRET", "GOOGLE_API_CREDENTIALS"], // Example secrets
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[cancelEventBooking V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid; // User initiating cancellation (Customer or Admin)
        const data = request.data as CancelEventBookingInput;
        const logContext: any = { userId, bookingId: data?.bookingId, reason: data?.reason };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            (data.reason != null && typeof data.reason !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { bookingId, reason } = data;

        // --- Variables ---
        let bookingData: EventBooking;
        let userData: User;
        let userRole: string | null; // Fetch role
        let voidResult: Awaited<ReturnType<typeof voidAuthorization>> | null = null;
        let refundResult: Awaited<ReturnType<typeof processRefund>> | null = null;
        let updatedPaymentStatus: PaymentStatus;
        let refundDetails: RefundDetails | null = null;
        let gcalDeleteSuccess = true; // Assume success unless GCal interaction fails

        // --- Firestore References ---
        const bookingRef = db.collection('eventBookings').doc(bookingId);
        const userRef = db.collection('users').doc(userId); // Needed for role check

        try {
            // 3. Fetch User and Booking Data Concurrently
            const [userSnap, bookingSnap] = await Promise.all([userRef.get(), bookingRef.get()]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            userRole = userData.role; // Get role
            logContext.userRole = userRole;

            // Validate Booking
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Event booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.event.bookingNotFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.paymentStatus = bookingData.paymentStatus;
            logContext.bookingCustomerId = bookingData.customerId;
            logContext.googleCalendarEventId = bookingData.googleCalendarEventId;

            // 4. Permission Check (Using REAL helper)
            const isOwner = userId === bookingData.customerId;
            const isAdmin = userRole === 'Admin' || userRole === 'SuperAdmin';
            const requiredPermission = isOwner ? 'event:cancel:own' : (isAdmin ? 'event:cancel:any' : 'permission_denied');
            // Pass fetched role to checkPermission
            const hasPermission = await checkPermission(userId, userRole, requiredPermission, logContext);

            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${userId} (Role: ${userRole}) to cancel event booking ${bookingId}.`, logContext);
                const errorCode = (requiredPermission === 'permission_denied') ? ErrorCode.PermissionDenied : ErrorCode.NotBookingOwnerOrAdmin;
                return { success: false, error: "error.permissionDenied.cancelEvent", errorCode: errorCode };
            }

            // 5. State Validation
            // Allow cancellation from various pending/confirmed states, but not completed/already cancelled.
            const cancellableStatuses: string[] = [
                EventBookingStatus.PendingAdminApproval,
                EventBookingStatus.PendingCustomerConfirmation,
                EventBookingStatus.Confirmed,
                EventBookingStatus.Scheduled,
                EventBookingStatus.Preparing, // Maybe allow cancelling before InProgress?
                EventBookingStatus.Delayed,
                EventBookingStatus.RequiresAdminAttention,
            ];
            if (!cancellableStatuses.includes(bookingData.bookingStatus)) {
                logger.warn(`${functionName} Event booking ${bookingId} cannot be cancelled from status '${bookingData.bookingStatus}'.`, logContext);
                return { success: false, error: `error.event.invalidStatus.cancel::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }
             if (bookingData.bookingStatus === EventBookingStatus.Cancelled) {
                  logger.warn(`${functionName} Event booking ${bookingId} is already cancelled.`, logContext);
                  return { success: false, error: "error.event.alreadyCancelled", errorCode: ErrorCode.FailedPrecondition };
             }

            // 6. Handle Payment Void/Refund (if applicable)
            // This depends heavily on the payment flow (deposit vs full payment, timing)
            // Let's assume payment happens at 'confirmEventAgreement' and is 'Paid' or 'ChargeFailed' by now.
            updatedPaymentStatus = bookingData.paymentStatus;

            if (bookingData.paymentStatus === PaymentStatus.Paid || bookingData.paymentStatus === PaymentStatus.Captured) { // If payment was successful
                 // --- Process Refund ---
                 // Check cancellation policy - full refund? Partial? Fee?
                 // For now, assume full refund of totalAmount. Add fee logic later.
                 const transactionId = bookingData.paymentDetails?.transactionId; // Assuming charge ID is stored here
                 const amountToRefund = bookingData.totalAmountSmallestUnit; // Refund full amount for now

                 if (!transactionId) {
                      logger.error(`${functionName} Cannot refund payment for booking ${bookingId}: Missing transactionId in paymentDetails.`, logContext);
                      // Don't fail the whole cancellation, but log and maybe flag for admin.
                      updatedPaymentStatus = PaymentStatus.RefundFailed; // Mark as failed due to missing info
                 } else if (amountToRefund == null || amountToRefund <= 0) {
                      logger.warn(`${functionName} Booking ${bookingId}: No amount to refund (${amountToRefund}). Skipping refund process.`, logContext);
                 } else {
                     logger.info(`${functionName} Booking ${bookingId}: Payment is ${bookingData.paymentStatus}. Attempting to refund ${amountToRefund} ${bookingData.currencyCode} for transaction ${transactionId}...`, logContext);
                     refundResult = await processRefund(
                         transactionId,
                         amountToRefund,
                         bookingData.currencyCode,
                         reason || (isOwner ? "customer_request" : "admin_cancellation"),
                         bookingId
                     );

                     if (!refundResult.success) {
                         updatedPaymentStatus = PaymentStatus.RefundFailed; // Mark as failed
                         logger.error(`${functionName} Payment refund failed for booking ${bookingId}, TxID: ${transactionId}.`, { ...logContext, error: refundResult.errorMessage, code: refundResult.errorCode });
                         // Still cancel the booking, but mark payment status.
                     } else {
                         updatedPaymentStatus = PaymentStatus.Refunded;
                         logger.info(`${functionName} Payment refund successful for booking ${bookingId}, TxID: ${transactionId}, RefundID: ${refundResult.refundId}.`, logContext);
                         refundDetails = {
                             refundId: refundResult.refundId, refundTimestamp: refundResult.timestamp,
                             refundAmountSmallestUnit: refundResult.amountRefunded, gatewayName: refundResult.gatewayName,
                             reason: reason || (isOwner ? "customer_request" : "admin_cancellation"),
                         };
                     }
                  }
            } else if (bookingData.paymentStatus === PaymentStatus.Authorized) {
                 // If using auth/capture for events (less common), void the auth here.
                 const authId = bookingData.paymentDetails?.authorizationId; // Assuming auth details are stored if used
                 if (!authId) {
                      logger.error(`${functionName} Cannot void payment for booking ${bookingId}: Missing authorizationId.`, logContext);
                      updatedPaymentStatus = PaymentStatus.VoidFailed;
                 } else {
                     logger.info(`${functionName} Booking ${bookingId}: Payment is Authorized. Attempting to void authorization ${authId}...`, logContext);
                     voidResult = await voidAuthorization(authId);
                     updatedPaymentStatus = voidResult.success ? PaymentStatus.Voided : PaymentStatus.VoidFailed;
                     if (!voidResult.success) logger.error(`${functionName} Payment void failed.`, { ...logContext, error: voidResult.errorMessage });
                     else logger.info(`${functionName} Payment void successful.`, logContext);
                 }
            } else {
                 logger.info(`${functionName} Booking ${bookingId}: No payment action required for cancellation based on current payment status '${bookingData.paymentStatus}'.`, logContext);
            }
            logContext.updatedPaymentStatus = updatedPaymentStatus;


            // 7. Delete Google Calendar Event (if exists)
            if (bookingData.googleCalendarEventId) {
                 logger.info(`${functionName} Attempting to delete Google Calendar event: ${bookingData.googleCalendarEventId}`, logContext);
                 const gcalResult = await deleteGoogleCalendarEvent(bookingData.googleCalendarEventId);
                 if (!gcalResult.success) {
                      logger.error(`${functionName} Failed to delete Google Calendar event ${bookingData.googleCalendarEventId}.`, { ...logContext, error: gcalResult.error });
                      gcalDeleteSuccess = false; // Mark failure but continue cancellation
                      // Flag for manual check?
                 } else {
                      logger.info(`${functionName} Google Calendar event ${bookingData.googleCalendarEventId} deleted successfully.`, logContext);
                 }
            }

            // 8. Firestore Transaction to Update Booking Status
            logger.info(`${functionName} Starting Firestore transaction to update booking status...`, logContext);
            await db.runTransaction(async (transaction) => {
                const bookingTxSnap = await transaction.get(bookingRef);
                if (!bookingTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BookingNotFound}`);
                const bookingTxData = bookingTxSnap.data() as EventBooking;

                // Re-validate status
                if (bookingTxData.bookingStatus === EventBookingStatus.Cancelled) {
                     logger.warn(`${functionName} TX Conflict: Booking ${bookingId} was already cancelled. Aborting update.`);
                     return;
                }
                if (!cancellableStatuses.includes(bookingTxData.bookingStatus)) {
                     logger.warn(`${functionName} TX Conflict: Booking ${bookingId} status changed to ${bookingTxData.bookingStatus} during TX. Aborting cancellation.`);
                     return;
                }

                // Prepare Booking Update
                const now = Timestamp.now();
                const updateData: { [key: string]: any } = {
                    bookingStatus: EventBookingStatus.Cancelled,
                    paymentStatus: updatedPaymentStatus, // Update based on void/refund result
                    updatedAt: FieldValue.serverTimestamp(),
                    cancellationTimestamp: now,
                    cancelledBy: userId,
                    cancellationReason: reason || null,
                    statusChangeHistory: FieldValue.arrayUnion({
                        from: bookingData.bookingStatus,
                        to: EventBookingStatus.Cancelled,
                        timestamp: now,
                        userId: userId,
                        role: userRole,
                        reason: `Cancelled by ${userRole ?? 'User'}${reason ? `: ${reason}` : ''}`
                    }),
                    processingError: null, // Clear previous errors
                    needsManualGcalDelete: !gcalDeleteSuccess, // Flag if GCal delete failed
                };
                // Add refund details if applicable
                if (refundDetails) {
                    updateData.refundDetails = refundDetails;
                }
                // Add void/refund failure details?
                 if (voidResult && !voidResult.success) {
                     updateData['paymentDetails.voidErrorCode'] = voidResult.errorCode;
                     updateData['paymentDetails.voidErrorMessage'] = voidResult.errorMessage;
                 }
                 if (refundResult && !refundResult.success) {
                      updateData['paymentDetails.refundErrorCode'] = refundResult.errorCode;
                      updateData['paymentDetails.refundErrorMessage'] = refundResult.errorMessage;
                 }

                // Perform Write
                transaction.update(bookingRef, updateData);
            }); // End Transaction
            logger.info(`${functionName} Event booking ${bookingId} status updated to Cancelled successfully.`, logContext);


            // 9. Log Action (Async)
            const logDetails = { bookingId, customerId: bookingData.customerId, cancelledBy: userId, userRole, reason, initialStatus: bookingData.bookingStatus, finalPaymentStatus: updatedPaymentStatus, gcalDeleteSuccess };
            if (isAdmin) {
                logAdminAction("CancelEventBooking", logDetails).catch(err => logger.error("Failed logging admin action", { err }));
            } else {
                logUserActivity("CancelEventBooking", logDetails, userId).catch(err => logger.error("Failed logging user activity", { err }));
            }

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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.cancelEvent.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            } else if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            }

            logUserActivity("CancelEventBookingFailed", { bookingId, reason, error: error.message }, userId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
