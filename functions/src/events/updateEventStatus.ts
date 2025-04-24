import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, EventBooking, EventBookingStatus } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { logUserActivity, logAdminAction } from '../utils/logging'; // Using mocks below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
// async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); } // Imported
// async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); } // Imported
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
    Aborted = "ABORTED", // Transaction failed (less likely here)
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Invalid new status value
    InvalidStatusTransition = "INVALID_STATUS_TRANSITION", // Cannot move from current to new status
}

// --- Interfaces ---
// Define allowed target statuses for this function
type TargetEventStatus = EventBookingStatus.Preparing | EventBookingStatus.InProgress | EventBookingStatus.Completed | EventBookingStatus.Delayed | EventBookingStatus.RequiresAdminAttention;

interface UpdateEventStatusInput {
    bookingId: string;
    newStatus: TargetEventStatus; // The target status to set
    details?: { // Optional details depending on the status
        actualStartTime?: string | null; // ISO Date string (for InProgress/Completed)
        actualEndTime?: string | null; // ISO Date string (for Completed)
        reason?: string | null; // Reason for Delay or RequiresAdminAttention
    } | null;
}

// --- The Cloud Function ---
export const updateEventStatus = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "256MiB",
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[updateEventStatus V2 - Permissions]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid;
        const data = request.data as UpdateEventStatusInput;
        const logContext: any = { userId, bookingId: data?.bookingId, newStatus: data?.newStatus };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        const validTargetStatuses: TargetEventStatus[] = [
            EventBookingStatus.Preparing, EventBookingStatus.InProgress, EventBookingStatus.Completed,
            EventBookingStatus.Delayed, EventBookingStatus.RequiresAdminAttention
        ];
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            !data?.newStatus || !validTargetStatuses.includes(data.newStatus) ||
            (data.details != null && typeof data.details !== 'object') ||
            (data.details?.actualStartTime != null && typeof data.details.actualStartTime !== 'string') ||
            (data.details?.actualEndTime != null && typeof data.details.actualEndTime !== 'string') ||
            (data.details?.reason != null && typeof data.details.reason !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            let errorCode = ErrorCode.InvalidArgument;
            if (data?.newStatus && !validTargetStatuses.includes(data.newStatus)) {
                errorCode = ErrorCode.InvalidBookingStatus;
            }
            return { success: false, error: "error.invalidInput.structureOrStatus", errorCode: errorCode };
        }
        const { bookingId, newStatus, details } = data;
        logContext.details = details;

        // --- Variables ---
        let bookingData: EventBooking;
        let userData: User;
        let userRole: string | null;

        // --- Firestore References ---
        const bookingRef = db.collection('eventBookings').doc(bookingId);
        const userRef = db.collection('users').doc(userId);

        try {
            // 3. Fetch User and Booking Data Concurrently
            const [userSnap, bookingSnap] = await Promise.all([userRef.get(), bookingRef.get()]);

            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            userRole = userData.role;
            logContext.userRole = userRole;

            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Event booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.event.bookingNotFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.customerId = bookingData.customerId;

            // 4. Permission Check
            const hasPermission = await checkPermission(userId, userRole, 'event:updateStatus', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${userId} (Role: ${userRole}) to update status for booking ${bookingId}.`, logContext);
                return { success: false, error: "error.permissionDenied.updateEventStatus", errorCode: ErrorCode.PermissionDenied };
            }

            // 5. State Transition Validation
            const validTransitions: { [key in EventBookingStatus]?: EventBookingStatus[] } = {
                [EventBookingStatus.Scheduled]: [EventBookingStatus.Preparing, EventBookingStatus.Delayed, EventBookingStatus.RequiresAdminAttention],
                [EventBookingStatus.Preparing]: [EventBookingStatus.InProgress, EventBookingStatus.Delayed, EventBookingStatus.RequiresAdminAttention],
                [EventBookingStatus.InProgress]: [EventBookingStatus.Completed, EventBookingStatus.Delayed, EventBookingStatus.RequiresAdminAttention],
                [EventBookingStatus.Delayed]: [EventBookingStatus.Preparing, EventBookingStatus.InProgress, EventBookingStatus.RequiresAdminAttention],
                [EventBookingStatus.RequiresAdminAttention]: [EventBookingStatus.Preparing, EventBookingStatus.InProgress, EventBookingStatus.Delayed, EventBookingStatus.Completed],
            };

            const allowedNextStatuses = validTransitions[bookingData.bookingStatus];
            if (!allowedNextStatuses || !allowedNextStatuses.includes(newStatus)) {
                 logger.warn(`${functionName} Invalid status transition from ${bookingData.bookingStatus} to ${newStatus} for booking ${bookingId}.`, logContext);
                 return { success: false, error: `error.event.invalidStatusTransition::${bookingData.bookingStatus}->${newStatus}`, errorCode: ErrorCode.InvalidStatusTransition };
            }

            // 6. Prepare Update Data
            const now = Timestamp.now();
            const updateData: { [key: string]: any } = {
                bookingStatus: newStatus,
                updatedAt: FieldValue.serverTimestamp(),
                statusChangeHistory: FieldValue.arrayUnion({
                    from: bookingData.bookingStatus, to: newStatus, timestamp: now, userId: userId, role: userRole,
                    reason: details?.reason ?? `Status updated by ${userRole ?? 'User'}`
                }),
                processingError: null,
            };

            if (newStatus === EventBookingStatus.InProgress && details?.actualStartTime) {
                try { updateData.actualStartTime = Timestamp.fromDate(new Date(details.actualStartTime)); }
                catch (e) { logger.warn("Invalid actualStartTime format", { input: details.actualStartTime }); }
            }
            if (newStatus === EventBookingStatus.Completed) {
                if (details?.actualEndTime) {
                    try { updateData.actualEndTime = Timestamp.fromDate(new Date(details.actualEndTime)); }
                    catch (e) { logger.warn("Invalid actualEndTime format", { input: details.actualEndTime }); }
                } else {
                    updateData.actualEndTime = now;
                }
                if (!bookingData.actualStartTime && details?.actualStartTime) {
                     try { updateData.actualStartTime = Timestamp.fromDate(new Date(details.actualStartTime)); } catch (e) {}
                } else if (!bookingData.actualStartTime) {
                     updateData.actualStartTime = now;
                }
            }
            if ((newStatus === EventBookingStatus.Delayed || newStatus === EventBookingStatus.RequiresAdminAttention) && details?.reason) {
                updateData.lastDelayReason = details.reason;
            }

            // 7. Update Booking Document in Firestore
            logger.info(`${functionName} Updating event booking ${bookingId} status to ${newStatus}...`, logContext);
            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully.`, logContext);

            // 8. Log Action (Async)
            const logDetails = { bookingId, customerId: bookingData.customerId, oldStatus: bookingData.bookingStatus, newStatus, details, triggerUserId: userId, triggerUserRole: userRole };
            if (userRole === 'Admin' || userRole === 'SuperAdmin') {
                logAdminAction("UpdateEventStatus", logDetails)
                    .catch(err => logger.error("Failed logging UpdateEventStatus admin action", { err })); // Fixed catch
            } else {
                logUserActivity("UpdateEventStatus", logDetails, userId)
                    .catch(err => logger.error("Failed logging UpdateEventStatus user activity", { err })); // Fixed catch
            }

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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.updateEventStatus.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            logUserActivity("UpdateEventStatusFailed", { bookingId, newStatus, error: error.message }, userId)
                .catch(err => logger.error("Failed logging UpdateEventStatusFailed user activity", { err })); // Fixed catch

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
