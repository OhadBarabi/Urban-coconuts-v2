import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, EventBooking, EventBookingStatus, EventResource, EventResourceType
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { triggerUpdateGCalAttendees } from '../utils/background_triggers'; // Trigger GCal update
// import { sendPushNotification } from '../utils/notifications';
// import { logAdminAction } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null && (userRole === 'Admin' || userRole === 'SuperAdmin'); }
async function triggerUpdateGCalAttendees(params: { bookingId: string; assignedResources: { [key: string]: string[] } }): Promise<void> { logger.info(`[Mock Trigger] Triggering GCal attendee update for booking ${params.bookingId}`, { assignments: params.assignedResources }); }
interface AdminAlertParams { subject: string; body: string; bookingId?: string; severity: "critical" | "warning" | "info"; }
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Booking, User, or Resource not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid booking status
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not Confirmed or InProgress etc.
    ResourceNotFound = "RESOURCE_NOT_FOUND",
    ResourceInactive = "RESOURCE_INACTIVE",
    ResourceAlreadyAssigned = "RESOURCE_ALREADY_ASSIGNED", // Resource assigned to another overlapping event
    SideEffectTriggerFailed = "SIDE_EFFECT_TRIGGER_FAILED", // GCal trigger failed
}

// --- Interfaces ---
interface EventAssignmentsInput {
    // Map where key is resource type (e.g., "Team", "Vehicle") and value is array of resource IDs
    [resourceType: string]: string[];
}
interface AssignEventResourcesInput {
    bookingId: string;
    assignments: EventAssignmentsInput; // The resources to assign
    // Optional: leadCourierId to explicitly assign a lead
    leadCourierId?: string | null;
}

// --- The Cloud Function ---
export const assignEventResources = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for multiple resource/booking checks
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[assignEventResources V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const adminUserId = request.auth.uid;
        const data = request.data as AssignEventResourcesInput;
        const logContext: any = { adminUserId, bookingId: data?.bookingId, assignments: data?.assignments, leadCourierId: data?.leadCourierId };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            !data.assignments || typeof data.assignments !== 'object' ||
            (data.leadCourierId != null && typeof data.leadCourierId !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        // Further validation: ensure assignment values are arrays of strings
        for (const key in data.assignments) {
            if (!Array.isArray(data.assignments[key]) || data.assignments[key].some(id => typeof id !== 'string')) {
                 logger.error(`${functionName} Invalid assignments format for type '${key}'. Must be array of strings.`, logContext);
                 return { success: false, error: `error.invalidInput.assignmentsFormat::${key}`, errorCode: ErrorCode.InvalidArgument };
            }
        }
        const { bookingId, assignments, leadCourierId } = data;
        const allResourceIds = Object.values(assignments).flat();

        // --- Variables ---
        let bookingData: EventBooking;
        let adminUserRole: string | null;
        let gcalTriggerFailed = false;

        try {
            // Fetch Admin User Role & Booking Data Concurrently
            const adminUserRef = db.collection('users').doc(adminUserId);
            const bookingRef = db.collection('eventBookings').doc(bookingId);

            const [adminUserSnap, bookingSnap] = await Promise.all([adminUserRef.get(), bookingRef.get()]);

            // Validate Admin User
            if (!adminUserSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${adminUserId}`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (adminUserSnap.data() as User)?.role ?? null;
            logContext.adminUserRole = adminUserRole;

            // Validate Booking Exists
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.booking.notFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.customerId = bookingData.customerId;
            logContext.eventTime = { start: bookingData.startTime.toDate(), end: bookingData.endTime.toDate() };

            // 3. Permission Check
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'event:assign_resources', { bookingId });
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId}.`, logContext);
                return { success: false, error: "error.permissionDenied.assignResources", errorCode: ErrorCode.PermissionDenied };
            }

            // 4. State Validation (e.g., must be Confirmed or maybe InProgress?)
            const assignableStatuses: string[] = [
                EventBookingStatus.Confirmed.toString(),
                EventBookingStatus.Preparing.toString(), // Allow assignment during prep?
                EventBookingStatus.InProgress.toString() // Allow changes while in progress?
            ];
            if (!assignableStatuses.includes(bookingData.bookingStatus)) {
                logger.warn(`${functionName} Booking ${bookingId} is not in an assignable status (Current: ${bookingData.bookingStatus}).`, logContext);
                return { success: false, error: `error.booking.invalidStatus.assignment::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 5. Validate Assigned Resources (Existence, Activity, Availability)
            if (allResourceIds.length > 0) {
                logger.info(`${functionName} Validating ${allResourceIds.length} assigned resources...`, logContext);
                const resourceRefs = allResourceIds.map(id => db.collection('eventResources').doc(id));
                const resourceSnaps = await db.getAll(...resourceRefs);
                const foundResourceIds = new Set<string>();

                for (const doc of resourceSnaps) {
                    if (!doc.exists) {
                        const missingId = allResourceIds.find(id => !resourceSnaps.some(snap => snap.id === id)); // Find which one is missing
                        logger.error(`${functionName} Assigned resource ID '${missingId || 'unknown'}' not found.`, logContext);
                        throw new HttpsError('not-found', `error.resource.notFound::${missingId || 'unknown'}`, { errorCode: ErrorCode.ResourceNotFound });
                    }
                    const resourceData = doc.data() as EventResource;
                    if (!resourceData.isActive) {
                        logger.error(`${functionName} Assigned resource '${doc.id}' (${resourceData.name}) is inactive.`, logContext);
                        throw new HttpsError('failed-precondition', `error.resource.inactive::${doc.id}`, { errorCode: ErrorCode.ResourceInactive });
                    }
                    foundResourceIds.add(doc.id);
                }

                // Check for resource conflicts (assigned to another overlapping Confirmed/InProgress event)
                const overlappingBookingsQuery = db.collection('eventBookings')
                    .where(admin.firestore.FieldPath.documentId(), '!=', bookingId) // Exclude current booking
                    .where('bookingStatus', 'in', [EventBookingStatus.Confirmed.toString(), EventBookingStatus.InProgress.toString()])
                    .where('endTime', '>', bookingData.startTime) // Overlaps if ends after our start
                    .where('startTime', '<', bookingData.endTime); // And starts before our end

                const overlappingSnaps = await overlappingBookingsQuery.get();

                for (const doc of overlappingSnaps.docs) {
                    const otherBooking = doc.data() as EventBooking;
                    if (otherBooking.assignedResources) {
                        const otherResourceIds = Object.values(otherBooking.assignedResources).flat();
                        const conflict = allResourceIds.find(id => otherResourceIds.includes(id));
                        if (conflict) {
                            logger.error(`${functionName} Resource conflict: Resource '${conflict}' is already assigned to overlapping booking '${doc.id}'.`, logContext);
                            throw new HttpsError('failed-precondition', `error.resource.alreadyAssigned::${conflict}::${doc.id}`, { errorCode: ErrorCode.ResourceAlreadyAssigned });
                        }
                    }
                }
                logger.info(`${functionName} All assigned resources validated and available.`, logContext);
            }

            // 6. Update Booking Document
            logger.info(`${functionName} Updating booking ${bookingId} with resource assignments...`, logContext);
            const updateData: Partial<EventBooking> & { updatedAt: admin.firestore.FieldValue } = {
                assignedResources: assignments,
                assignedLeadCourierId: leadCourierId === undefined ? bookingData.assignedLeadCourierId : (leadCourierId ?? null), // Update only if provided, allow null to clear
                updatedAt: FieldValue.serverTimestamp(),
                processingError: null, // Clear previous errors
            };

            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully.`);

            // 7. Trigger Google Calendar Attendee Update (Async)
            // Check if GCal integration is enabled and event exists
            const settings = await fetchEventSettings(); // Fetch fresh settings
            if (settings?.googleCalendarIntegrationEnabled && bookingData.googleCalendarEventId) {
                logger.info(`${functionName} Triggering Google Calendar attendee update for booking ${bookingId}...`, logContext);
                try {
                    // Pass only the assignments, not the whole booking data
                    await triggerUpdateGCalAttendees({ bookingId, assignedResources: assignments });
                } catch (triggerError: any) {
                     gcalTriggerFailed = true;
                     logger.error(`${functionName} CRITICAL: Failed to trigger GCal attendee update for booking ${bookingId}. Manual update required.`, { ...logContext, error: triggerError.message });
                     // Update booking with flag (best effort outside TX)
                     bookingRef.update({ needsManualGcalCheck: true, processingError: `GCal attendee update trigger failed: ${triggerError.message}` }).catch(...);
                     logAdminAction("GCalAttendeeUpdateTriggerFailed", { bookingId, reason: triggerError.message }).catch(...);
                     // Send Admin Alert
                     sendPushNotification({ subject: `GCal Attendee Update Trigger FAILED - Booking ${bookingId}`, body: `Failed to trigger GCal attendee update for booking ${bookingId}. Manual update REQUIRED.`, bookingId, severity: "critical" }).catch(...);
                     // Do NOT fail the main function for this async trigger failure.
                }
            } else {
                 logger.info(`${functionName} GCal integration disabled or no GCal event ID found. Skipping attendee update trigger.`);
            }

            // 8. Trigger Notifications (Async) - Optional
            // Notify assigned resources? (e.g., Lead Courier)
             if (leadCourierId && leadCourierId !== bookingData.assignedLeadCourierId) { // Notify only if changed or newly assigned
                 sendPushNotification({
                     userId: leadCourierId, type: "AssignedAsEventLead",
                     titleKey: "notification.eventLeadAssigned.title", messageKey: "notification.eventLeadAssigned.message",
                     messageParams: { bookingId: bookingId, eventTime: bookingData.startTime.toDate().toLocaleString() }, // Format time nicely
                     payload: { bookingId: bookingId, screen: 'EventDetails' }
                 }).catch(err => logger.error("Failed sending lead courier assignment notification", { err }));
             }
            // Notify customer? Probably not necessary for resource assignment.

            // 9. Log Admin Action (Async)
            logAdminAction("AssignEventResources", { bookingId, customerId: bookingData.customerId, assignments, leadCourierId, gcalTriggerFailed, triggerUserId: adminUserId })
                .catch(err => logger.error("Failed logging admin action", { err }));

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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.assignResources.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            // Log failure
            logAdminAction("AssignEventResourcesFailed", { inputData: data, triggerUserId: adminUserId, errorMessage: error.message, finalErrorCode }).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
