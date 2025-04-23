import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, RentalBooking, RentalBookingStatus
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity, logAdminAction } from '../utils/logging';
// import { fetchMatRentalSettings } from '../config/config_helpers';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`, context); return userId != null; }
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
interface MatRentalSettings { defaultRentalDurationHours?: number; }
async function fetchMatRentalSettings(): Promise<MatRentalSettings | null> { logger.info(`[Mock Config] Fetching mat rental settings`); return { defaultRentalDurationHours: 2 }; }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const DEFAULT_RENTAL_DURATION_HOURS = 2; // Default duration if not set in config

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Booking or User not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status or mismatch
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not AwaitingPickup or DepositAuthorized
    CourierNotAssignedToBox = "COURIER_NOT_ASSIGNED_TO_BOX", // Courier not assigned to the pickup box
}

// --- Interfaces ---
interface ConfirmRentalPickupInput {
    bookingId: string;
    // Optional: scannedItemId could be passed to verify against booking.rentalItemId
    // scannedItemId?: string;
}

// --- The Cloud Function ---
export const confirmRentalPickup = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "256MiB",
        timeoutSeconds: 30,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[confirmRentalPickup V1]";
        const startTime = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const courierId = request.auth.uid; // Courier performing the pickup confirmation
        const data = request.data as ConfirmRentalPickupInput;
        const logContext: any = { courierId, bookingId: data?.bookingId };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string') {
            logger.error(`${functionName} Invalid input: Missing bookingId.`, logContext);
            return { success: false, error: "error.invalidInput.bookingId", errorCode: ErrorCode.InvalidArgument };
        }
        const { bookingId } = data;

        // --- Variables ---
        let bookingData: RentalBooking;
        let courierData: User;

        try {
            // Fetch Courier Data (for box assignment check) & Permission Check
            const courierRef = db.collection('users').doc(courierId);
            const bookingRef = db.collection('rentalBookings').doc(bookingId);
            const settingsPromise = fetchMatRentalSettings(); // Fetch settings for default duration

            const hasPermissionPromise = checkPermission(courierId, 'rental:confirm_pickup', { bookingId });

            const [courierSnap, bookingSnap, settings, hasPermission] = await Promise.all([
                courierRef.get(), bookingRef.get(), settingsPromise, hasPermissionPromise
            ]);

            // Validate Courier & Permission
            if (!courierSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${courierId}`, { errorCode: ErrorCode.UserNotFound });
            courierData = courierSnap.data() as User;
            if (courierData.role !== Role.Courier || !courierData.isActive) {
                 throw new HttpsError('permission-denied', "error.permissionDenied.notActiveCourier", { errorCode: ErrorCode.PermissionDenied });
            }
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for courier ${courierId}.`, logContext);
                return { success: false, error: "error.permissionDenied.confirmPickup", errorCode: ErrorCode.PermissionDenied };
            }

            // Validate Booking
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.booking.notFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as RentalBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.pickupBoxId = bookingData.pickupBoxId;
            logContext.customerId = bookingData.customerId;

            // Validate Booking Status (Must be ready for pickup)
            const validPickupStatuses: string[] = [
                RentalBookingStatus.AwaitingPickup.toString(),
                RentalBookingStatus.DepositAuthorized.toString() // Allow pickup if deposit was authorized
            ];
            if (!validPickupStatuses.includes(bookingData.bookingStatus)) {
                logger.warn(`${functionName} Booking ${bookingId} has invalid status: ${bookingData.bookingStatus}. Expected AwaitingPickup or DepositAuthorized.`, logContext);
                 // Idempotency: If already picked up, return success
                 if (bookingData.bookingStatus === RentalBookingStatus.PickedUp) {
                     logger.info(`${functionName} Booking ${bookingId} already marked as PickedUp. Idempotent success.`);
                     return { success: true };
                 }
                return { success: false, error: `error.booking.invalidStatus.pickup::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // Validate Courier is assigned to the pickup box (using currentBoxId from shift)
            if (courierData.currentBoxId !== bookingData.pickupBoxId) {
                 logger.error(`${functionName} Courier ${courierId} is not currently assigned to pickup box ${bookingData.pickupBoxId} (Current: ${courierData.currentBoxId}).`, logContext);
                 return { success: false, error: "error.courier.notAtPickupBox", errorCode: ErrorCode.CourierNotAssignedToBox };
            }

            // 3. Update Booking Document
            logger.info(`${functionName} Updating booking ${bookingId} to PickedUp status...`, logContext);
            const now = Timestamp.now();
            const serverTimestamp = FieldValue.serverTimestamp();

            // Calculate expected return time if not already set
            let returnTimestamp = bookingData.expectedReturnTimestamp;
            if (!returnTimestamp) {
                const durationHours = settings?.defaultRentalDurationHours ?? DEFAULT_RENTAL_DURATION_HOURS;
                returnTimestamp = Timestamp.fromMillis(now.toMillis() + durationHours * 60 * 60 * 1000);
                logger.info(`Calculated expected return time: ${returnTimestamp.toDate()}`);
            }

            const updateData: Partial<RentalBooking> = {
                bookingStatus: RentalBookingStatus.PickedUp,
                pickupTimestamp: now,
                pickupCourierId: courierId,
                expectedReturnTimestamp: returnTimestamp, // Set calculated or existing
                updatedAt: serverTimestamp,
                processingError: null, // Clear previous errors
            };

            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully.`);

            // 4. Trigger Notifications (Async)
            // Notify Customer
            if (bookingData.customerId) {
                sendPushNotification({
                    userId: bookingData.customerId, type: "RentalPickedUp", titleKey: "notification.rentalPickedUp.title",
                    messageKey: "notification.rentalPickedUp.message", messageParams: { itemName: bookingData.rentalItemId }, // Use item ID if name isn't readily available
                    payload: { bookingId: bookingId, screen: 'RentalDetails' }
                }).catch(err => logger.error("Failed sending customer pickup notification", { err }));
            }

            // 5. Log Action (Async)
            // Log as UserActivity since it's courier-initiated
            logUserActivity("ConfirmRentalPickup", { bookingId, customerId: bookingData.customerId, rentalItemId: bookingData.rentalItemId }, courierId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 6. Return Success
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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.confirmRentalPickup.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 // Append detail if present
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTime}ms`, logContext);
        }
    }
);
