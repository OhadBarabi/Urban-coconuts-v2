import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, EventBooking, EventBookingStatus, StatusHistoryEntry
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity, logAdminAction } from '../utils/logging';
// import { updateGoogleCalendarEventStatus } from '../utils/google_calendar_helpers'; // Optional GCal update

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null; }
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
async function updateGoogleCalendarEventStatus(eventId: string, newStatus: EventBookingStatus, details?: any): Promise<void> { logger.info(`[Mock GCal Update] Updating event ${eventId} status to ${newStatus}`, details); }
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
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status transition
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Invalid current or target status
    InvalidStatusTransition = "INVALID_STATUS_TRANSITION",
}
// Define valid target statuses for this function
const VALID_TARGET_STATUSES: EventBookingStatus[] = [
    EventBookingStatus.Preparing,
    EventBookingStatus.InProgress,
    EventBookingStatus.Delayed,
    EventBookingStatus.Completed,
    EventBookingStatus.RequiresAdminAttention, // Allow setting this status manually
];

// --- Interfaces ---
interface UpdateEventStatusInput {
    bookingId: string;
    newStatus: EventBookingStatus | string; // Allow string for validation
    details?: {
        actualStartTime?: string | null; // ISO String (for InProgress)
        actualEndTime?: string | null;   // ISO String (for Completed)
        reason?: string | null;         // For Delayed or RequiresAdminAttention
    } | null;
}

// --- The Cloud Function ---
export const updateEventStatus = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "256MiB",
        timeoutSeconds: 30,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[updateEventStatus V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const userId = request.auth.uid; // Admin or Lead Courier
        const data = request.data as UpdateEventStatusInput;
        const logContext: any = { userId, bookingId: data?.bookingId, newStatus: data?.newStatus };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            !data.newStatus || !VALID_TARGET_STATUSES.includes(data.newStatus as EventBookingStatus) ||
            (data.details != null && typeof data.details !== 'object'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { bookingId, newStatus, details } = data;
        const typedNewStatus = newStatus as EventBookingStatus;
        let actualStartTime: Timestamp | null = null;
        let actualEndTime: Timestamp | null = null;
        const reason = details?.reason ?? null;

        try {
             if (details?.actualStartTime) actualStartTime = Timestamp.fromDate(new Date(details.actualStartTime));
             if (details?.actualEndTime) actualEndTime = Timestamp.fromDate(new Date(details.actualEndTime));
             if ((details?.actualStartTime && isNaN(actualStartTime!.toDate().getTime())) || (details?.actualEndTime && isNaN(actualEndTime!.toDate().getTime()))) {
                 throw new Error("Invalid date format for actual times");
             }
        } catch (dateError: any) {
            logger.error(`${functionName} Invalid date format in details.`, { ...logContext, error: dateError.message });
            return { success: false, error: "error.invalidInput.dateFormat", errorCode: ErrorCode.InvalidArgument };
        }

        // Validate required details based on newStatus
        if (typedNewStatus === EventBookingStatus.InProgress && !actualStartTime) {
             return { success: false, error: "error.invalidInput.missingActualStartTime", errorCode: ErrorCode.InvalidArgument };
        }
        if (typedNewStatus === EventBookingStatus.Completed && !actualEndTime) {
             return { success: false, error: "error.invalidInput.missingActualEndTime", errorCode: ErrorCode.InvalidArgument };
        }
        if (typedNewStatus === EventBookingStatus.Delayed && !reason) {
             return { success: false, error: "error.invalidInput.missingDelayReason", errorCode: ErrorCode.InvalidArgument };
        }

        // --- Variables ---
        let bookingData: EventBooking;
        let userRole: string | null;

        try {
            // Fetch User Role & Booking Data Concurrently
            const userRef = db.collection('users').doc(userId);
            const bookingRef = db.collection('eventBookings').doc(bookingId);

            const [userSnap, bookingSnap] = await Promise.all([userRef.get(), bookingRef.get()]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
            userRole = (userSnap.data() as User)?.role ?? null;
            logContext.userRole = userRole;

            // Validate Booking Exists
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.booking.notFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.customerId = bookingData.customerId;

            // 3. Permission Check (Admin or Assigned Lead Courier?)
            const isLeadCourier = userId === bookingData.assignedLeadCourierId;
            const requiredPermission = 'event:update_status'; // Single permission for now
            const hasPermission = await checkPermission(userId, userRole, requiredPermission, { bookingId, isLeadCourier });
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${userId} (Role: ${userRole}, IsLead: ${isLeadCourier}).`, logContext);
                return { success: false, error: "error.permissionDenied.updateEventStatus", errorCode: ErrorCode.PermissionDenied };
            }

            // 4. State Validation (Define valid transitions)
            const currentStatus = bookingData.bookingStatus;
            const validTransitions: { [key in EventBookingStatus]?: EventBookingStatus[] } = {
                [EventBookingStatus.Confirmed]: [EventBookingStatus.Preparing, EventBookingStatus.RequiresAdminAttention, EventBookingStatus.CancelledByAdmin], // Admin can cancel from here too? Add separate cancel function.
                [EventBookingStatus.Preparing]: [EventBookingStatus.InProgress, EventBookingStatus.Delayed, EventBookingStatus.RequiresAdminAttention],
                [EventBookingStatus.InProgress]: [EventBookingStatus.Completed, EventBookingStatus.Delayed, EventBookingStatus.RequiresAdminAttention],
                [EventBookingStatus.Delayed]: [EventBookingStatus.InProgress, EventBookingStatus.Completed, EventBookingStatus.RequiresAdminAttention], // Can resume or complete from delayed
                // Completed, Cancelled, RequiresAdminAttention are typically final states for this function
            };

            // Allow setting RequiresAdminAttention from most states?
            const alwaysAllowedTarget = EventBookingStatus.RequiresAdminAttention;

            if (typedNewStatus !== alwaysAllowedTarget && !validTransitions[currentStatus as EventBookingStatus]?.includes(typedNewStatus)) {
                 logger.warn(`${functionName} Invalid status transition: ${currentStatus} -> ${typedNewStatus} for booking ${bookingId}.`, logContext);
                 return { success: false, error: `error.event.invalidTransition::${currentStatus}>>${typedNewStatus}`, errorCode: ErrorCode.InvalidStatusTransition };
            }

            // Idempotency Check
            if (currentStatus === typedNewStatus) {
                 logger.info(`${functionName} Booking ${bookingId} is already in status '${typedNewStatus}'. No update needed.`, logContext);
                 return { success: true };
            }

            // 5. Update Booking Document
            logger.info(`${functionName} Updating booking ${bookingId} status to ${typedNewStatus}...`, logContext);
            const now = Timestamp.now();
            const serverTimestamp = FieldValue.serverTimestamp();
            const updateData: { [key: string]: any } = {
                bookingStatus: typedNewStatus,
                updatedAt: serverTimestamp,
                statusChangeHistory: FieldValue.arrayUnion({
                    from: currentStatus,
                    to: typedNewStatus,
                    timestamp: now,
                    userId: userId,
                    role: userRole,
                    reason: reason // Include reason if provided (esp. for Delayed/RequiresAttention)
                }),
                processingError: null, // Clear previous errors on status change
            };

            // Add specific fields based on new status
            if (typedNewStatus === EventBookingStatus.InProgress && actualStartTime) {
                updateData.actualStartTime = actualStartTime;
            }
            if (typedNewStatus === EventBookingStatus.Completed && actualEndTime) {
                updateData.actualEndTime = actualEndTime;
                // Optionally calculate final duration here?
            }
            if (typedNewStatus === EventBookingStatus.Delayed && reason) {
                updateData.lastDelayReason = reason;
            }

            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully.`);

            // 6. Trigger Notifications (Async)
            const notificationPromises: Promise<void>[] = [];
             // Notify Customer? (Maybe only for major changes like Completed or Delayed?)
             let customerNotificationType: string | null = null;
             let customerTitleKey: string | null = null;
             let customerMessageKey: string | null = null;
             const customerMessageParams: any = { bookingIdShort: bookingId.substring(0, 6) };

             if (typedNewStatus === EventBookingStatus.InProgress) {
                 customerNotificationType = "EventInProgress";
                 customerTitleKey = "notification.eventInProgress.title";
                 customerMessageKey = "notification.eventInProgress.message";
             } else if (typedNewStatus === EventBookingStatus.Completed) {
                 customerNotificationType = "EventCompleted";
                 customerTitleKey = "notification.eventCompleted.title";
                 customerMessageKey = "notification.eventCompleted.message";
             } else if (typedNewStatus === EventBookingStatus.Delayed) {
                 customerNotificationType = "EventDelayed";
                 customerTitleKey = "notification.eventDelayed.title";
                 customerMessageKey = "notification.eventDelayed.message";
                 customerMessageParams.reason = reason ?? "Unexpected delay";
             } else if (typedNewStatus === EventBookingStatus.RequiresAdminAttention) {
                 // Don't notify customer directly, notify admin instead
             }

             if (customerNotificationType && bookingData.customerId) {
                 notificationPromises.push(sendPushNotification({
                     userId: bookingData.customerId, type: customerNotificationType, langPref: bookingData.customerLanguagePref, // Need customer lang pref
                     titleKey: customerTitleKey, messageKey: customerMessageKey,
                     messageParams: customerMessageParams,
                     payload: { bookingId: bookingId, screen: 'EventDetails' }
                 }).catch(err => logger.error("Failed sending customer event status update notification", { err })) );
             }

             // Notify Admin if RequiresAdminAttention is set
             if (typedNewStatus === EventBookingStatus.RequiresAdminAttention) {
                 notificationPromises.push(sendPushNotification({
                     topic: "admin-event-attention", // Or specific admins
                     type: "AdminEventRequiresAttention",
                     titleKey: "notification.adminEventAttention.title", messageKey: "notification.adminEventAttention.message",
                     messageParams: { bookingId: bookingId, reason: reason ?? "Status set by " + (userRole ?? userId) },
                     payload: { bookingId: bookingId, screen: 'AdminEventDetails' }
                 }).catch(err => logger.error("Failed sending admin event attention notification", { err })) );
             }

             // 7. Update Google Calendar Event Status (Optional, Async)
             if (bookingData.googleCalendarEventId) {
                 notificationPromises.push(updateGoogleCalendarEventStatus(bookingData.googleCalendarEventId, typedNewStatus, { reason })
                     .catch(err => logger.error(`Failed to update GCal status for event ${bookingData.googleCalendarEventId}`, { err })) );
             }

            Promise.allSettled(notificationPromises);


            // 8. Log Action (Async)
            const logDetails = { bookingId, customerId: bookingData.customerId, oldStatus: currentStatus, newStatus: typedNewStatus, reason, triggerUserId: userId, triggerUserRole: userRole };
            if (userRole === 'Admin' || userRole === 'SuperAdmin') {
                logAdminAction("UpdateEventStatus", logDetails).catch(err => logger.error("Failed logging admin action", { err }));
            } else { // Assume Lead Courier
                logUserActivity("UpdateEventStatus", logDetails, userId).catch(err => logger.error("Failed logging user activity", { err }));
            }

            // 9. Return Success
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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.updateEventStatus.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            // Log failure
            logAdminAction("UpdateEventStatusFailed", { inputData: data, triggerUserId: userId, triggerUserRole: userRole, errorMessage: error.message, finalErrorCode }).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
