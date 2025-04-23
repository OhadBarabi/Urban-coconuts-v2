import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { v4 as uuidv4 } from 'uuid'; // Needed if updating items with new IDs

// --- Import Models ---
import {
    User, EventBooking, EventBookingStatus, EventBookingItem, AdminApprovalDetails, PaymentStatus
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { sendPushNotification } from '../utils/notifications';
// import { logAdminAction } from '../utils/logging';
// import { calculateEventPrice } from '../utils/event_calculations'; // If recalculating price

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null && (userRole === 'Admin' || userRole === 'SuperAdmin'); }
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
interface PriceCalculationResult { lineItems: EventBookingItem[]; totalAmountSmallestUnit: number; error?: string; }
async function calculateEventPrice(items: any[], menuId: string | null, currency: string, durationMinutes: number): Promise<PriceCalculationResult> {
    logger.info(`[Mock Calc] Recalculating event price...`);
    let total = 0;
    const lineItems: EventBookingItem[] = items.map((item, index) => {
        // If item has bookingItemId, keep it, otherwise generate new one? Or assume input items are the final ones?
        // Let's assume input `updatedItems` replaces the old `selectedItems` entirely if provided.
        const price = (item.quantity ?? 1) * 11000; // Mock slightly different price: 110 units
        total += price;
        return {
            ...item,
            bookingItemId: item.bookingItemId ?? uuidv4(), // Keep existing or generate new ID
            productName: item.productName ?? `Mock Updated Item ${index + 1}`, // Keep existing or use mock
            calculatedPriceSmallestUnit: price,
            appliedUnitPriceSmallestUnit: 11000, // Mock unit price
        };
    });
    return { lineItems, totalAmountSmallestUnit: total };
}
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
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for approval
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not PendingAdminApproval
    InvalidApprovalStatus = "INVALID_APPROVAL_STATUS",
    CalculationError = "CALCULATION_ERROR", // If recalculation fails
}
type ApprovalStatus = "Approved" | "Rejected" | "ApprovedWithChanges";
const VALID_APPROVAL_STATUSES: ApprovalStatus[] = ["Approved", "Rejected", "ApprovedWithChanges"];


// --- Interfaces ---
interface ApproveEventBookingInput {
    bookingId: string;
    approvalStatus: ApprovalStatus | string; // Allow string for validation
    adminNotes?: string | null;
    // Optional: If approving with changes, provide the updated items and total
    updatedItems?: EventBookingItem[] | null; // Use full EventBookingItem structure
    updatedTotalAmountSmallestUnit?: number | null; // Integer
}

// --- The Cloud Function ---
export const approveEventBooking = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory if price recalculation happens
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[approveEventBooking V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const adminUserId = request.auth.uid;
        const data = request.data as ApproveEventBookingInput;
        const logContext: any = { adminUserId, bookingId: data?.bookingId, approvalStatus: data?.approvalStatus };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            !data.approvalStatus || !VALID_APPROVAL_STATUSES.includes(data.approvalStatus as ApprovalStatus) ||
            (data.adminNotes != null && typeof data.adminNotes !== 'string') ||
            (data.approvalStatus === "ApprovedWithChanges" && (!Array.isArray(data.updatedItems) || data.updatedItems.length === 0 || typeof data.updatedTotalAmountSmallestUnit !== 'number')) ||
            (data.approvalStatus !== "ApprovedWithChanges" && (data.updatedItems != null || data.updatedTotalAmountSmallestUnit != null)) // Don't allow updates if not ApprovedWithChanges
           )
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { bookingId, approvalStatus, adminNotes } = data;
        const typedApprovalStatus = approvalStatus as ApprovalStatus;

        // --- Variables ---
        let bookingData: EventBooking;
        let adminUserRole: string | null;
        let nextBookingStatus: EventBookingStatus;
        let recalculationResult: PriceCalculationResult | null = null;

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

            // 3. Permission Check
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'event:approve', { bookingId });
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId}.`, logContext);
                return { success: false, error: "error.permissionDenied.approveEvent", errorCode: ErrorCode.PermissionDenied };
            }

            // 4. State Validation (Must be PendingAdminApproval)
            if (bookingData.bookingStatus !== EventBookingStatus.PendingAdminApproval) {
                logger.warn(`${functionName} Booking ${bookingId} is not in PendingAdminApproval status (Current: ${bookingData.bookingStatus}).`, logContext);
                // Idempotency: If already approved/rejected by *this* action, maybe return success?
                // Check if adminApprovalDetails matches current request? Complex. Let's return error for now.
                return { success: false, error: `error.booking.invalidStatus.approval::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 5. Determine Next Status & Recalculate Price if needed
            const adminApprovalDetails: AdminApprovalDetails = {
                status: typedApprovalStatus,
                adminUserId: adminUserId,
                timestamp: Timestamp.now(),
                notes: adminNotes ?? null,
            };

            if (typedApprovalStatus === "Approved" || typedApprovalStatus === "ApprovedWithChanges") {
                nextBookingStatus = EventBookingStatus.PendingCustomerAgreement;
                // If ApprovedWithChanges, use the provided updated items and total
                if (typedApprovalStatus === "ApprovedWithChanges") {
                    // Optional: Recalculate price server-side based on updatedItems for verification?
                    // recalculationResult = await calculateEventPrice(data.updatedItems!, bookingData.eventMenuId, bookingData.currencyCode, bookingData.durationMinutes ?? 0);
                    // if (recalculationResult.error || recalculationResult.totalAmountSmallestUnit !== data.updatedTotalAmountSmallestUnit) {
                    //     logger.error("Server recalculation mismatch or failed.", { clientTotal: data.updatedTotalAmountSmallestUnit, serverCalc: recalculationResult });
                    //     throw new HttpsError('internal', "Price recalculation mismatch.", { errorCode: ErrorCode.CalculationError });
                    // }
                    // For now, trust the admin input if provided correctly
                    if (!data.updatedItems || data.updatedTotalAmountSmallestUnit == null) {
                         throw new HttpsError('invalid-argument', "Missing updatedItems or updatedTotalAmount for ApprovedWithChanges."); // Should be caught by validation
                    }
                }
            } else { // Rejected
                nextBookingStatus = EventBookingStatus.CancelledByAdmin;
            }
            logContext.nextStatus = nextBookingStatus;

            // 6. Update Booking Document
            logger.info(`${functionName} Updating booking ${bookingId} status to ${nextBookingStatus}...`, logContext);
            const updateData: Partial<EventBooking> & { updatedAt: admin.firestore.FieldValue } = {
                bookingStatus: nextBookingStatus,
                adminApprovalDetails: adminApprovalDetails,
                updatedAt: FieldValue.serverTimestamp(),
                processingError: null, // Clear previous errors
            };

            // If approved with changes, update items and total
            if (typedApprovalStatus === "ApprovedWithChanges" && data.updatedItems && data.updatedTotalAmountSmallestUnit != null) {
                // Ensure bookingItemId exists for each updated item (or generate)
                const finalUpdatedItems = data.updatedItems.map(item => ({
                    ...item,
                    bookingItemId: item.bookingItemId || uuidv4(),
                }));
                updateData.selectedItems = finalUpdatedItems;
                updateData.totalAmountSmallestUnit = data.updatedTotalAmountSmallestUnit;
                // Recalculate minOrderRequirementMet based on new total?
                const minOrderValue = (await fetchEventSettings())?.minOrderValueSmallestUnit?.[bookingData.currencyCode] ?? 0;
                updateData.minOrderRequirementMet = data.updatedTotalAmountSmallestUnit >= minOrderValue;
            }

            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully.`);

            // 7. Trigger Notifications (Async)
            const notificationPromises: Promise<void>[] = [];
             // Notify Customer about the decision
             let customerNotificationType: string;
             let customerTitleKey: string;
             let customerMessageKey: string;
             const customerMessageParams: any = { bookingIdShort: bookingId.substring(0, 6) };

             if (typedApprovalStatus === "Approved") {
                 customerNotificationType = "EventBookingApproved";
                 customerTitleKey = "notification.eventApproved.title";
                 customerMessageKey = "notification.eventApproved.message";
             } else if (typedApprovalStatus === "ApprovedWithChanges") {
                 customerNotificationType = "EventBookingApprovedWithChanges";
                 customerTitleKey = "notification.eventApprovedChanges.title";
                 customerMessageKey = "notification.eventApprovedChanges.message";
                 customerMessageParams.reason = adminNotes ?? "Details updated.";
             } else { // Rejected
                 customerNotificationType = "EventBookingRejected";
                 customerTitleKey = "notification.eventRejected.title";
                 customerMessageKey = "notification.eventRejected.message";
                 customerMessageParams.reason = adminNotes ?? "Booking could not be confirmed.";
             }

             if (bookingData.customerId) {
                 notificationPromises.push(sendPushNotification({
                     userId: bookingData.customerId, type: customerNotificationType, langPref: bookingData.customerLanguagePref, // Need to fetch customer lang pref
                     titleKey: customerTitleKey, messageKey: customerMessageKey,
                     messageParams: customerMessageParams,
                     payload: { bookingId: bookingId, screen: 'EventDetails' } // Navigate to event details
                 }).catch(err => logger.error("Failed sending customer event approval notification", { err })) );
             }
            Promise.allSettled(notificationPromises);


            // 8. Log Admin Action (Async)
            logAdminAction("ApproveEventBooking", { bookingId, customerId: bookingData.customerId, approvalStatus: typedApprovalStatus, adminNotes, updatedItemsProvided: !!data.updatedItems, triggerUserId: adminUserId })
                .catch(err => logger.error("Failed logging admin action", { err }));

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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.approveEvent.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            // Log failure
            logAdminAction("ApproveEventBookingFailed", { inputData: data, triggerUserId: adminUserId, errorMessage: error.message, finalErrorCode }).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
