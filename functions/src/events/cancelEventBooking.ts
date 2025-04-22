import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, EventBooking, EventBookingStatus, PaymentStatus, AppConfigEventSettings
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { processRefund } from '../utils/payment_helpers'; // Payment gateway interaction for refund
// import { triggerDeleteGoogleCalendarEvent } from '../utils/background_triggers'; // Trigger GCal deletion
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity, logAdminAction } from '../utils/logging';
// import { fetchEventSettings } from '../config/config_helpers';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null; }
interface RefundResult { success: boolean; refundId?: string; error?: string; }
async function processRefund(chargeTxId: string, amountSmallestUnit: number, currencyCode: string, reason: string, bookingId: string): Promise<RefundResult> {
    logger.info(`[Mock Payment] Processing refund for charge ${chargeTxId}, amount ${amountSmallestUnit} ${currencyCode}. Reason: ${reason}. Booking: ${bookingId}`);
    await new Promise(res => setTimeout(res, 1700)); // Simulate refund processing time
    if (chargeTxId.includes("fail_refund")) {
        logger.error("[Mock Payment] Refund FAILED.");
        return { success: false, error: "Mock Refund Failed" };
    }
    return { success: true, refundId: `REF_${Date.now()}` };
}
async function triggerDeleteGoogleCalendarEvent(params: { bookingId: string; googleCalendarEventId: string }): Promise<void> { logger.info(`[Mock Trigger] Triggering GCal event deletion for booking ${params.bookingId}, event ${params.googleCalendarEventId}`); }
interface AdminAlertParams { subject: string; body: string; bookingId?: string; severity: "critical" | "warning" | "info"; }
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
interface EventSettings { cancellationWindowHours?: number; cancellationFeeSmallestUnit?: { [key: string]: number }; /* Add other settings */ }
async function fetchEventSettings(): Promise<EventSettings | null> { logger.info(`[Mock Config] Fetching event settings`); return { cancellationWindowHours: 24, cancellationFeeSmallestUnit: { 'ILS': 10000 } }; } // Example: 24 hours window, 100 ILS fee
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
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for cancellation
    Aborted = "ABORTED", // Refund failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not cancellable from this state
    PaymentRefundFailed = "PAYMENT_REFUND_FAILED", // Critical failure during refund attempt
    SideEffectTriggerFailed = "SIDE_EFFECT_TRIGGER_FAILED", // GCal deletion trigger failed
}

// --- Interfaces ---
interface CancelEventBookingInput {
    bookingId: string;
    reason: string; // Reason for cancellation
}

// --- The Cloud Function ---
export const cancelEventBooking = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory for payment interaction
        timeoutSeconds: 90, // Allow more time for potential refund processing
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // If processRefund needs secret
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[cancelEventBooking (Event) V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const userId = request.auth.uid; // User initiating cancellation (Customer or Admin)
        const data = request.data as CancelEventBookingInput;
        const logContext: any = { userId, bookingId: data?.bookingId, reason: data?.reason };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            !data.reason || typeof data.reason !== 'string' || data.reason.trim() === "")
        {
            logger.error(`${functionName} Invalid input: Missing bookingId or reason.`, logContext);
            return { success: false, error: "error.invalidInput.bookingIdOrReason", errorCode: ErrorCode.InvalidArgument };
        }
        const { bookingId, reason } = data;

        // --- Variables ---
        let bookingData: EventBooking;
        let userRole: string;
        let eventSettings: EventSettings | null;
        let refundResult: RefundResult | null = null;
        let cancellationFee = 0;
        let refundAmount = 0;
        let finalPaymentStatus: PaymentStatus | string;
        let gcalDeleteTriggerFailed = false;
        let userPreferredLanguage: string | undefined;

        try {
            // Fetch User Role, Booking Data, Event Settings Concurrently
            const userRef = db.collection('users').doc(userId);
            const bookingRef = db.collection('eventBookings').doc(bookingId);
            const settingsPromise = fetchEventSettings();

            const [userSnap, bookingSnap, settings] = await Promise.all([userRef.get(), bookingRef.get(), settingsPromise]);
            eventSettings = settings; // Assign fetched settings

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
            const userData = userSnap.data() as User;
            userRole = userData.role;
            userPreferredLanguage = userData.preferredLanguage;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });
            logContext.userRole = userRole;

            // Validate Booking Exists
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.booking.notFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.customerId = bookingData.customerId;
            logContext.paymentStatus = bookingData.paymentStatus;
            logContext.totalAmount = bookingData.totalAmountSmallestUnit;
            logContext.gcalEventId = bookingData.googleCalendarEventId;

            // 3. Permission/Ownership Check
            const isOwner = userId === bookingData.customerId;
            const requiredPermission = isOwner ? 'event:cancel:own' : 'event:cancel:any';
            const hasPermission = await checkPermission(userId, userRole, requiredPermission, { bookingData });
            if (!hasPermission) {
                logger.warn(`${functionName} Permission '${requiredPermission}' denied for user ${userId}.`, logContext);
                return { success: false, error: `error.permissionDenied.cancelEvent`, errorCode: ErrorCode.PermissionDenied };
            }

            // 4. State Validation (Can cancel from various states, but not Completed/Cancelled)
            const cancellableStatuses: string[] = [
                EventBookingStatus.PendingAdminApproval.toString(),
                EventBookingStatus.PendingCustomerAgreement.toString(),
                EventBookingStatus.Confirmed.toString(),
                EventBookingStatus.Preparing.toString(),
                EventBookingStatus.Delayed.toString(), // Allow cancellation even if delayed? Yes.
                EventBookingStatus.RequiresAdminAttention.toString() // Allow cancellation if requires attention? Yes.
                // Do NOT allow cancellation from InProgress or Completed via this function
            ];
            if (!cancellableStatuses.includes(bookingData.bookingStatus)) {
                logger.warn(`${functionName} Booking ${bookingId} cannot be cancelled from status '${bookingData.bookingStatus}'.`, logContext);
                 // Idempotency: If already cancelled, return success
                 if (bookingData.bookingStatus === EventBookingStatus.CancelledByAdmin || bookingData.bookingStatus === EventBookingStatus.CancelledByCustomer) {
                     logger.info(`${functionName} Booking ${bookingId} already cancelled. Idempotent success.`);
                     return { success: true };
                 }
                return { success: false, error: `error.booking.invalidStatus.cancel::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 5. Calculate Cancellation Fee & Refund Amount (if applicable)
            finalPaymentStatus = bookingData.paymentStatus ?? PaymentStatus.Pending; // Start with current
            const chargeTxId = bookingData.paymentDetails?.chargeTransactionId;
            const paidAmount = bookingData.paymentDetails?.chargeAmountSmallestUnit ?? 0;

            if (bookingData.paymentStatus === PaymentStatus.Paid && chargeTxId && paidAmount > 0) {
                const cancellationWindowHours = eventSettings?.cancellationWindowHours ?? 0;
                const now = new Date();
                const eventStartTime = bookingData.startTime.toDate();
                const hoursUntilEvent = (eventStartTime.getTime() - now.getTime()) / (1000 * 60 * 60);

                if (cancellationWindowHours > 0 && hoursUntilEvent < cancellationWindowHours) {
                    // Within cancellation window, apply fee
                    cancellationFee = eventSettings?.cancellationFeeSmallestUnit?.[bookingData.currencyCode] ?? 0;
                    refundAmount = Math.max(0, paidAmount - cancellationFee);
                    logger.info(`${functionName} Booking ${bookingId}: Cancellation within window (${hoursUntilEvent.toFixed(1)}h < ${cancellationWindowHours}h). Fee: ${cancellationFee}, Paid: ${paidAmount}, Refund: ${refundAmount}`, logContext);
                } else {
                    // Outside window or no window defined, full refund
                    cancellationFee = 0;
                    refundAmount = paidAmount;
                    logger.info(`${functionName} Booking ${bookingId}: Cancellation outside window or no fee. Full refund: ${refundAmount}`, logContext);
                }

                // Process Refund
                if (refundAmount > 0) {
                    logger.info(`${functionName} Booking ${bookingId}: Processing refund of ${refundAmount} ${bookingData.currencyCode}...`, logContext);
                    refundResult = await processRefund(chargeTxId, refundAmount, bookingData.currencyCode, `Cancellation: ${reason}`, bookingId);

                    if (!refundResult.success) {
                        finalPaymentStatus = PaymentStatus.RefundFailed;
                        logger.error(`${functionName} CRITICAL: Failed to process refund for cancelled booking ${bookingId}. Manual refund required.`, { ...logContext, error: refundResult.error });
                        sendPushNotification({ subject: `Payment Refund FAILED - Event Booking ${bookingId}`, body: `Failed to process refund of ${refundAmount} ${bookingData.currencyCode} for cancelled event booking ${bookingId}. Charge Tx: ${chargeTxId}. MANUAL REFUND REQUIRED.`, bookingId, severity: "critical" }).catch(...);
                        logAdminAction("EventPaymentRefundFailedDuringCancel", { bookingId, chargeTxId, refundAmount, reason: refundResult.error, triggerUserId: userId }).catch(...);
                        // Continue with cancellation despite refund failure
                    } else {
                        logger.info(`${functionName} Refund processed successfully. Refund ID: ${refundResult.refundId}`, logContext);
                        finalPaymentStatus = cancellationFee > 0 ? PaymentStatus.PartiallyRefunded : PaymentStatus.Refunded;
                    }
                } else {
                     logger.info(`${functionName} No refund amount to process (Fee >= Paid Amount or Paid Amount was 0).`, logContext);
                     finalPaymentStatus = PaymentStatus.Refunded; // Or keep as 'Paid' if fee=paid? Let's use Refunded.
                }

            } else {
                // If not paid, just mark payment as Cancelled
                finalPaymentStatus = PaymentStatus.Cancelled;
                logger.info(`${functionName} Booking ${bookingId} was not paid. Setting payment status to Cancelled.`, logContext);
            }


            // 6. Update Booking Document
            logger.info(`${functionName} Updating booking ${bookingId} status to Cancelled...`, logContext);
            const cancellationTimestamp = Timestamp.now();
            const updateData: Partial<EventBooking> & { updatedAt: admin.firestore.FieldValue } = {
                bookingStatus: isOwner ? EventBookingStatus.CancelledByCustomer : EventBookingStatus.CancelledByAdmin,
                cancellationReason: reason,
                cancelledBy: userRole,
                cancellationTimestamp: cancellationTimestamp,
                paymentStatus: finalPaymentStatus,
                cancellationFeeAppliedSmallestUnit: cancellationFee > 0 ? cancellationFee : null,
                updatedAt: FieldValue.serverTimestamp(),
                processingError: finalPaymentStatus === PaymentStatus.RefundFailed ? `Refund failed, requires manual action.` : null, // Set or clear error
            };
            // Update paymentDetails with refund info
            if (finalPaymentStatus === PaymentStatus.Refunded || finalPaymentStatus === PaymentStatus.PartiallyRefunded || finalPaymentStatus === PaymentStatus.RefundFailed) {
                 updateData.paymentDetails = {
                     ...(bookingData.paymentDetails ?? {}),
                     refundTimestamp: cancellationTimestamp,
                     refundId: refundResult?.refundId ?? null,
                     refundAmountSmallestUnit: refundAmount,
                     refundSuccess: refundResult?.success ?? false,
                     refundError: refundResult?.error ?? (finalPaymentStatus === PaymentStatus.RefundFailed ? 'Refund failed during cancellation' : null),
                 };
            }

            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully to cancelled status.`);

            // 7. Trigger Google Calendar Event Deletion (Async)
            if (bookingData.googleCalendarEventId) {
                logger.info(`${functionName} Triggering Google Calendar event deletion for booking ${bookingId}, event ${bookingData.googleCalendarEventId}...`, logContext);
                try {
                    await triggerDeleteGoogleCalendarEvent({ bookingId, googleCalendarEventId: bookingData.googleCalendarEventId });
                } catch (triggerError: any) {
                     gcalDeleteTriggerFailed = true;
                     logger.error(`${functionName} CRITICAL: Failed to trigger GCal event deletion for booking ${bookingId}. Manual deletion required.`, { ...logContext, error: triggerError.message });
                     // Update booking with flag (best effort outside TX)
                     bookingRef.update({ needsManualGcalDelete: true, processingError: `GCal deletion trigger failed: ${triggerError.message}` }).catch(...);
                     logAdminAction("GCalDeleteTriggerFailed", { bookingId, gcalEventId: bookingData.googleCalendarEventId, reason: triggerError.message }).catch(...);
                     // Send Admin Alert
                     sendPushNotification({ subject: `GCal Deletion Trigger FAILED - Booking ${bookingId}`, body: `Failed to trigger GCal event deletion for cancelled booking ${bookingId} (GCal ID: ${bookingData.googleCalendarEventId}). Manual deletion REQUIRED.`, bookingId, severity: "critical" }).catch(...);
                     // Do NOT fail the main function for this async trigger failure.
                }
            } else {
                 logger.info(`${functionName} No GCal event ID found for booking ${bookingId}. Skipping deletion trigger.`);
            }

            // 8. Trigger Notifications (Async)
            // Notify Customer
            if (bookingData.customerId) {
                 sendPushNotification({
                     userId: bookingData.customerId, type: "EventCancelled", langPref: userPreferredLanguage,
                     titleKey: "notification.eventCancelled.title", messageKey: "notification.eventCancelled.message",
                     messageParams: { bookingIdShort: bookingId.substring(0, 6), reason: reason },
                     payload: { bookingId: bookingId }
                 }).catch(err => logger.error("Failed sending customer event cancelled notification", { err }));
            }
            // Notify Admin (especially if refund/GCal deletion failed)
            if (finalPaymentStatus === PaymentStatus.RefundFailed || gcalDeleteTriggerFailed) {
                 // Critical alerts already sent
            } else {
                 // Standard admin notice
                 sendPushNotification({
                     topic: "admin-cancelled-events", // Or specific users
                     type: "AdminEventCancelledNotice",
                     titleKey: "notification.adminEventCancelled.title", messageKey: "notification.adminEventCancelled.message",
                     messageParams: { bookingId: bookingId, cancelledBy: userRole, reason: reason, refundAmount: refundAmount, fee: cancellationFee },
                     payload: { bookingId: bookingId, screen: 'AdminEventDetails' }
                 }).catch(err => logger.error("Failed sending admin event cancelled notification", { err }));
            }


            // 9. Log Action (Async)
            const logDetails = { bookingId, reason, cancelledByRole: userRole, paymentStatusBefore: bookingData.paymentStatus, paymentStatusAfter: finalPaymentStatus, refundAttempted: (bookingData.paymentStatus === PaymentStatus.Paid && paidAmount > 0), refundAmount, cancellationFee, refundFailed: (finalPaymentStatus === PaymentStatus.RefundFailed), gcalDeleteTriggerFailed };
            if (userRole === 'Admin' || userRole === 'SuperAdmin') {
                logAdminAction("EventBookingCancelled", logDetails).catch(err => logger.error("Failed logging admin action", { err }));
            } else {
                logUserActivity("CancelEventBooking", logDetails, userId).catch(err => logger.error("Failed logging user activity", { err }));
            }

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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.cancelEvent.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            // Log admin action failure
            logAdminAction("CancelEventBookingFailed", { inputData: data, triggerUserId: userId, triggerUserRole: userRole, errorMessage: error.message, finalErrorCode }).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
