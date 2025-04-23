import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, EventBooking, EventBookingStatus, EventResource } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions'; // <-- Import REAL helper
// import { logAdminAction } from '../utils/logging'; // Using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
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
    NotFound = "NOT_FOUND", // Booking, User, or Resource not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for assignment, Resource inactive/unavailable
    Aborted = "ABORTED", // Transaction failed (less likely here)
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND", // Admin user not found
    ResourceNotFound = "RESOURCE_NOT_FOUND", // Assigned resource ID doesn't exist
    ResourceInactive = "RESOURCE_INACTIVE", // Assigned resource is marked inactive
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not 'Confirmed' or similar status
}

// --- Interfaces ---
interface EventAssignmentsInput {
    [resourceType: string]: string[]; // e.g., { "Team": ["teamAlphaId"], "Vehicle": ["van01Id"] }
}
interface AssignEventResourcesInput {
    bookingId: string;
    assignments: EventAssignmentsInput; // Map of resource types to array of resource IDs
    leadCourierId?: string | null; // Optional: Assign a lead courier
}

// --- The Cloud Function ---
export const assignEventResources = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory for multiple reads
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[assignEventResources V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid; // Admin performing the action
        const data = request.data as AssignEventResourcesInput;
        const logContext: any = { adminUserId, bookingId: data?.bookingId };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            !data?.assignments || typeof data.assignments !== 'object' || Object.keys(data.assignments).length === 0 || // Must have at least one assignment type
            Object.values(data.assignments).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string')) || // Validate structure
            (data.leadCourierId != null && typeof data.leadCourierId !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { bookingId, assignments, leadCourierId } = data;
        logContext.assignmentTypes = Object.keys(assignments);
        logContext.leadCourierId = leadCourierId;

        // --- Variables ---
        let bookingData: EventBooking;
        let adminUserData: User;
        let adminUserRole: string | null;
        const allResourceIds = Object.values(assignments).flat(); // Get all resource IDs to validate

        // --- Firestore References ---
        const bookingRef = db.collection('eventBookings').doc(bookingId);
        const adminUserRef = db.collection('users').doc(adminUserId);

        try {
            // 3. Fetch Admin User and Booking Data Concurrently
            const [adminUserSnap, bookingSnap] = await Promise.all([adminUserRef.get(), bookingRef.get()]);

            // Validate Admin User
            if (!adminUserSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${adminUserId}`, { errorCode: ErrorCode.UserNotFound });
            adminUserData = adminUserSnap.data() as User;
            adminUserRole = adminUserData.role; // Get admin role
            logContext.adminUserRole = adminUserRole;

            // Validate Booking
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Event booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.event.bookingNotFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.customerId = bookingData.customerId;

            // 4. Permission Check (Using REAL helper)
            // Admin needs permission to assign resources. Define: 'event:assignResource'
            // Pass fetched role to checkPermission
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'event:assignResource', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to assign resources to booking ${bookingId}.`, logContext);
                return { success: false, error: "error.permissionDenied.assignResource", errorCode: ErrorCode.PermissionDenied };
            }

            // 5. State Validation
            // Allow assignment only when confirmed or scheduled?
            const assignableStatuses: string[] = [EventBookingStatus.Confirmed.toString(), EventBookingStatus.Scheduled.toString()];
            if (!assignableStatuses.includes(bookingData.bookingStatus)) {
                logger.warn(`${functionName} Event booking ${bookingId} is not in a status where resources can be assigned (current: ${bookingData.bookingStatus}).`, logContext);
                return { success: false, error: `error.event.invalidStatus.assign::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 6. Validate Assigned Resources (Existence and Activity)
            if (allResourceIds.length > 0) {
                logger.info(`${functionName} Validating ${allResourceIds.length} assigned resources...`, logContext);
                const resourceRefs = allResourceIds.map(id => db.collection('eventResources').doc(id));
                const resourceDocs = await db.getAll(...resourceRefs);

                for (const doc of resourceDocs) {
                    if (!doc.exists) {
                        const missingId = allResourceIds.find(id => id === doc.ref.id); // Find which ID was missing
                        logger.error(`${functionName} Assigned resource ID ${missingId} not found.`, logContext);
                        throw new HttpsError('not-found', `error.event.resourceNotFound::${missingId}`, { errorCode: ErrorCode.ResourceNotFound });
                    }
                    const resourceData = doc.data() as EventResource;
                    if (!resourceData.isActive) {
                         logger.error(`${functionName} Assigned resource ${doc.id} (${resourceData.name}) is inactive.`, logContext);
                         throw new HttpsError('failed-precondition', `error.event.resourceInactive::${doc.id}`, { errorCode: ErrorCode.ResourceInactive });
                    }
                }
                logger.info(`${functionName} All assigned resources validated successfully.`, logContext);
            }
            // Optional: Validate leadCourierId exists and is a courier?
            if (leadCourierId) {
                 const leadCourierSnap = await db.collection('users').doc(leadCourierId).get();
                 if (!leadCourierSnap.exists || leadCourierSnap.data()?.role !== 'Courier') {
                      logger.error(`${functionName} Assigned lead courier ${leadCourierId} not found or is not a courier.`, logContext);
                      throw new HttpsError('not-found', `error.event.leadCourierInvalid::${leadCourierId}`, { errorCode: ErrorCode.UserNotFound }); // Reuse UserNotFound?
                 }
            }


            // 7. Update Event Booking Document
            const now = Timestamp.now();
            // Determine new status - maybe move to 'Scheduled' once resources are assigned?
            const newStatus = EventBookingStatus.Scheduled;
            logContext.newStatus = newStatus;

            const updateData: { [key: string]: any } = {
                assignedResources: assignments, // Store the map directly
                assignedLeadCourierId: leadCourierId ?? null,
                bookingStatus: newStatus, // Update status
                updatedAt: FieldValue.serverTimestamp(),
                statusChangeHistory: FieldValue.arrayUnion({
                    from: bookingData.bookingStatus,
                    to: newStatus,
                    timestamp: now,
                    userId: adminUserId,
                    role: adminUserRole,
                    reason: `Resources assigned by admin`
                }),
                processingError: null, // Clear previous errors
            };

            logger.info(`${functionName} Updating event booking ${bookingId} with assigned resources and status ${newStatus}...`, logContext);
            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully.`, logContext);

            // 8. Log Admin Action (Async)
            logAdminAction("AssignEventResources", {
                bookingId, customerId: bookingData.customerId, assignments, leadCourierId,
                triggerUserId: adminUserId, triggerUserRole: adminUserRole
            }).catch(err => logger.error("Failed logging admin action", { err }));

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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.assignResource.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }
            // No transaction errors expected here unless DB fails

            logAdminAction("AssignEventResourcesFailed", { bookingId, assignments, leadCourierId, error: error.message, triggerUserId: adminUserId }).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
