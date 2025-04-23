import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, EventBooking, EventBookingStatus, SelectedEventItemInput, Menu,
    AppConfigEventSettings, PaymentStatus // Added PaymentStatus
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions'; // <-- Import REAL helper
// import { calculateEventTotal } from '../utils/event_calculations'; // Using mock below
// import { logAdminAction } from '../utils/logging'; // Using mock below
// import { sendPushNotification } from '../utils/notifications'; // Using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
// Mock for calculateEventTotal (if recalculation is needed for changes)
interface EventTotalResult { totalAmount: number; error?: string; minOrderRequirementMet?: boolean; currencyCode?: string; }
function calculateEventTotal(items: SelectedEventItemInput[], menu?: Menu | null, settings?: AppConfigEventSettings | null): EventTotalResult {
    logger.info(`[Mock Event Calc] Recalculating total for approval with ${items.length} items...`);
    let total = 0;
    items.forEach((item, index) => { total += (item.quantity ?? 1) * (1500 + index * 100); }); // Mock calculation
    const minOrderValue = settings?.minOrderValueSmallestUnit ?? 0;
    const currency = menu?.currencyCode ?? settings?.defaultCurrencyCode ?? 'ILS';
    return { totalAmount: total, minOrderRequirementMet: total >= minOrderValue, currencyCode: currency };
}
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
interface NotificationPayload { userId: string; type: string; titleKey: string; messageKey: string; messageParams?: { [key: string]: any }; payload?: { [key: string]: string }; }
async function sendPushNotification(notification: NotificationPayload): Promise<void> { logger.info(`[Mock Notification] Sending push notification to ${notification.userId}`, notification); }
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
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for approval, Min order not met after changes
    Aborted = "ABORTED", // Transaction failed (less likely here)
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND", // Admin user not found
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not 'PendingAdminApproval'
    InvalidApprovalStatus = "INVALID_APPROVAL_STATUS", // Invalid value for approvalStatus
    CalculationError = "CALCULATION_ERROR", // If recalculation fails
    MinOrderNotMet = "MIN_ORDER_NOT_MET", // If changes cause min order to fail
    ConfigNotFound = "CONFIG_NOT_FOUND", // Event settings missing for recalculation
    MenuNotFound = "MENU_NOT_FOUND", // If menu needed for recalculation
}

// --- Interfaces ---
type ApprovalStatus = "Approved" | "Rejected" | "ApprovedWithChanges";
interface ApproveEventBookingInput {
    bookingId: string;
    approvalStatus: ApprovalStatus; // The decision made by the admin
    adminNotes?: string | null; // Optional notes from the admin
    // Optional fields for 'ApprovedWithChanges'
    updatedItems?: SelectedEventItemInput[] | null; // The modified list of items
    updatedTotalAmountSmallestUnit?: number | null; // The new total amount if manually adjusted or recalculated
}

// --- The Cloud Function ---
export const approveEventBooking = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for reads/recalculation
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[approveEventBooking V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid; // Admin performing the action
        const data = request.data as ApproveEventBookingInput;
        const logContext: any = { adminUserId, bookingId: data?.bookingId, approvalStatus: data?.approvalStatus };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        const validApprovalStatuses: ApprovalStatus[] = ["Approved", "Rejected", "ApprovedWithChanges"];
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            !data?.approvalStatus || !validApprovalStatuses.includes(data.approvalStatus) ||
            (data.adminNotes != null && typeof data.adminNotes !== 'string') ||
            (data.approvalStatus === "ApprovedWithChanges" && (!Array.isArray(data.updatedItems) || data.updatedItems.length === 0)) || // Require items if changes approved
            (data.updatedTotalAmountSmallestUnit != null && (typeof data.updatedTotalAmountSmallestUnit !== 'number' || !Number.isInteger(data.updatedTotalAmountSmallestUnit) || data.updatedTotalAmountSmallestUnit < 0))
           )
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            let errorCode = ErrorCode.InvalidArgument;
            if (data?.approvalStatus && !validApprovalStatuses.includes(data.approvalStatus)) {
                errorCode = ErrorCode.InvalidApprovalStatus;
            }
            return { success: false, error: "error.invalidInput.structureOrStatus", errorCode: errorCode };
        }
        const { bookingId, approvalStatus, adminNotes, updatedItems, updatedTotalAmountSmallestUnit } = data;

        // --- Variables ---
        let bookingData: EventBooking;
        let adminUserData: User;
        let adminUserRole: string | null;
        let finalTotalAmount = updatedTotalAmountSmallestUnit; // Use provided amount if exists
        let finalSelectedItems = updatedItems ?? null; // Use provided items if exists

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
            // Admin needs permission to approve/reject events. Define: 'event:approve'
            // Pass fetched role to checkPermission
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'event:approve', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to approve/reject booking ${bookingId}.`, logContext);
                return { success: false, error: "error.permissionDenied.approveEvent", errorCode: ErrorCode.PermissionDenied };
            }

            // 5. State Validation
            if (bookingData.bookingStatus !== EventBookingStatus.PendingAdminApproval) {
                logger.warn(`${functionName} Event booking ${bookingId} is not in 'PendingAdminApproval' status (current: ${bookingData.bookingStatus}). Cannot approve/reject.`, logContext);
                // Handle cases where it might already be approved/rejected - maybe return success?
                if (bookingData.bookingStatus === EventBookingStatus.PendingCustomerConfirmation || bookingData.bookingStatus === EventBookingStatus.Rejected) {
                     logger.info(`${functionName} Booking ${bookingId} already processed (status: ${bookingData.bookingStatus}). Assuming idempotent call.`, logContext);
                     return { success: true }; // Idempotency
                }
                return { success: false, error: `error.event.invalidStatus.approve::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 6. Handle 'ApprovedWithChanges' - Recalculate total if not provided explicitly
            if (approvalStatus === "ApprovedWithChanges") {
                if (!finalSelectedItems) { // Should have been caught by validation, but double-check
                     throw new HttpsError('invalid-argument', "updatedItems are required for 'ApprovedWithChanges'.");
                }
                // If total amount wasn't provided, recalculate based on updatedItems
                if (finalTotalAmount == null) {
                    logger.info(`${functionName} Recalculating total for approved changes...`, logContext);
                    // Need event settings and potentially menu for recalculation
                    const settingsRef = db.collection('appConfig').doc('eventSettings');
                    const menuRef = bookingData.eventMenuId ? db.collection('menus').doc(bookingData.eventMenuId) : null;
                    const [settingsSnap, menuSnap] = await Promise.all([
                        settingsRef.get(),
                        menuRef ? menuRef.get() : Promise.resolve(null)
                    ]);
                    if (!settingsSnap.exists) throw new HttpsError('internal', "Event settings configuration not found.", { errorCode: ErrorCode.ConfigNotFound });
                    const eventSettings = settingsSnap.data() as AppConfigEventSettings;
                    let menuData: Menu | null = null;
                    if (menuRef && menuSnap && menuSnap.exists) menuData = menuSnap.data() as Menu;
                    else if (menuRef) throw new HttpsError('not-found', `Original menu ${bookingData.eventMenuId} not found for recalculation.`);

                    const recalcResult = calculateEventTotal(finalSelectedItems, menuData, eventSettings);
                    if (recalcResult.error) throw new HttpsError('internal', `Recalculation Error: ${recalcResult.error}`, { errorCode: ErrorCode.CalculationError });
                    if (!recalcResult.minOrderRequirementMet) {
                         logger.warn(`${functionName} Changes result in minimum order requirement not met.`, { ...logContext, newTotal: recalcResult.totalAmount });
                         return { success: false, error: "error.event.minOrderNotMetAfterChanges", errorCode: ErrorCode.MinOrderNotMet };
                    }
                    finalTotalAmount = recalcResult.totalAmount;
                    logContext.recalculatedTotal = finalTotalAmount;
                } else {
                    logContext.providedTotal = finalTotalAmount;
                }
                 // Ensure final amount is valid after potential recalculation or if provided
                 if (finalTotalAmount == null || finalTotalAmount < 0) {
                     throw new HttpsError('internal', "Invalid final total amount after changes.");
                 }
            }

            // 7. Determine New Booking Status and Prepare Update Data
            const now = Timestamp.now();
            let newStatus: EventBookingStatus;
            let updateData: { [key: string]: any } = {
                adminApprovalDetails: {
                    status: approvalStatus,
                    adminUserId: adminUserId,
                    timestamp: now,
                    notes: adminNotes ?? null,
                },
                updatedAt: FieldValue.serverTimestamp(),
                processingError: null, // Clear previous errors
            };

            if (approvalStatus === "Approved" || approvalStatus === "ApprovedWithChanges") {
                newStatus = EventBookingStatus.PendingCustomerConfirmation;
                updateData.bookingStatus = newStatus;
                // If approved with changes, update items and total amount
                if (approvalStatus === "ApprovedWithChanges") {
                    updateData.selectedItems = finalSelectedItems; // Already validated to exist
                    updateData.totalAmountSmallestUnit = finalTotalAmount; // Already validated > 0
                }
                // Set agreement sent timestamp? Or handle sending agreement separately? Let's set it here.
                updateData.agreementSentTimestamp = now;
            } else { // Rejected
                newStatus = EventBookingStatus.Rejected;
                updateData.bookingStatus = newStatus;
                // Payment status remains Pending or potentially Cancelled? Let's keep Pending.
            }
            logContext.newStatus = newStatus;

            // Add status history entry
            updateData.statusChangeHistory = FieldValue.arrayUnion({
                from: bookingData.bookingStatus,
                to: newStatus,
                timestamp: now,
                userId: adminUserId,
                role: adminUserRole,
                reason: `Admin ${approvalStatus}${adminNotes ? `: ${adminNotes}` : ''}`
            });

            // 8. Update Booking Document in Firestore
            logger.info(`${functionName} Updating event booking ${bookingId} status to ${newStatus}...`, logContext);
            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully.`, logContext);

            // 9. Send Notification to Customer (Async)
            // Use different notifications based on approval status
            let notificationType: string;
            let titleKey: string;
            let messageKey: string;
            if (newStatus === EventBookingStatus.PendingCustomerConfirmation) {
                 notificationType = "EventApproved";
                 titleKey = "notification.eventApproved.title";
                 messageKey = approvalStatus === "ApprovedWithChanges" ? "notification.eventApproved.messageChanges" : "notification.eventApproved.message";
            } else { // Rejected
                 notificationType = "EventRejected";
                 titleKey = "notification.eventRejected.title";
                 messageKey = "notification.eventRejected.message";
            }
            sendPushNotification({
                 userId: bookingData.customerId,
                 type: notificationType,
                 titleKey: titleKey,
                 messageKey: messageKey,
                 messageParams: { bookingId: bookingId, adminNotes: adminNotes ?? "" }, // Pass notes if available
                 payload: { bookingId: bookingId, screen: 'eventDetails' } // Navigate user to booking
            }).catch(err => logger.error("Failed sending customer notification", { err }));


            // 10. Log Admin Action (Async)
            logAdminAction("ApproveEventBooking", {
                bookingId, customerId: bookingData.customerId, decision: approvalStatus,
                notes: adminNotes, updatedItems: approvalStatus === "ApprovedWithChanges" ? updatedItems : null,
                updatedTotal: approvalStatus === "ApprovedWithChanges" ? finalTotalAmount : null,
                triggerUserId: adminUserId, triggerUserRole: adminUserRole
            }).catch(err => logger.error("Failed logging admin action", { err }));

            // 11. Return Success
            return { success: true };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.approveEvent.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }
            // No transaction errors expected here unless DB fails

            logAdminAction("ApproveEventBookingFailed", { bookingId, approvalStatus, error: error.message, triggerUserId: adminUserId }).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
