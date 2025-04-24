import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, RentalBooking, RentalBookingStatus } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { logUserActivity } from '../utils/logging'; // Using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
// async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); } // Imported
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
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for pickup
    Aborted = "ABORTED", // Transaction failed (though less likely here)
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    NotCourier = "NOT_COURIER",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not 'PendingPickup'
    CourierMismatch = "COURIER_MISMATCH",
}

// --- Interfaces ---
interface ConfirmRentalPickupInput {
    bookingId: string;
}

// --- The Cloud Function ---
export const confirmRentalPickup = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "256MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[confirmRentalPickup V2 - Permissions]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const courierId = request.auth.uid;
        const data = request.data as ConfirmRentalPickupInput;
        const logContext: any = { courierId, bookingId: data?.bookingId };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string') {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { bookingId } = data;

        // --- Firestore References ---
        const bookingRef = db.collection('rentalBookings').doc(bookingId);
        const courierRef = db.collection('users').doc(courierId);

        try {
            // 3. Fetch User and Booking Data Concurrently
            const [courierSnap, bookingSnap] = await Promise.all([courierRef.get(), bookingRef.get()]);

            if (!courierSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${courierId}`, { errorCode: ErrorCode.UserNotFound });
            const courierData = courierSnap.data() as User;
            const courierRole = courierData.role;
            logContext.userRole = courierRole;
            if (courierRole !== 'Courier') {
                 logger.warn(`${functionName} User ${courierId} is not a Courier.`, logContext);
                 return { success: false, error: "error.permissionDenied.notCourier", errorCode: ErrorCode.NotCourier };
            }

            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Rental booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.rental.bookingNotFound", errorCode: ErrorCode.BookingNotFound };
            }
            const bookingData = bookingSnap.data() as RentalBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.pickupBoxId = bookingData.pickupBoxId;

            // 4. Permission Check
            const hasPermission = await checkPermission(courierId, courierRole, 'rental:pickup:confirm', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for courier ${courierId} to confirm pickup for booking ${bookingId}.`, logContext);
                return { success: false, error: "error.permissionDenied.confirmPickup", errorCode: ErrorCode.PermissionDenied };
            }
            if (courierData.currentBoxId !== bookingData.pickupBoxId) {
                 logger.warn(`${functionName} Courier ${courierId} is not currently assigned to the pickup box ${bookingData.pickupBoxId}.`, logContext);
                 return { success: false, error: "error.rental.courierMismatch", errorCode: ErrorCode.CourierMismatch };
            }

            // 5. State Validation
            if (bookingData.bookingStatus !== RentalBookingStatus.PendingPickup) {
                logger.warn(`${functionName} Rental booking ${bookingId} is not in 'PendingPickup' status (current: ${bookingData.bookingStatus}). Cannot confirm pickup.`, logContext);
                if (bookingData.bookingStatus === RentalBookingStatus.Out) {
                     logger.info(`${functionName} Booking ${bookingId} already marked as 'Out'. Assuming confirmation already happened.`, logContext);
                     return { success: true };
                }
                return { success: false, error: `error.rental.invalidStatus.pickup::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 6. Update Booking Document
            const now = Timestamp.now();
            const updateData = {
                bookingStatus: RentalBookingStatus.Out,
                pickupTimestamp: now,
                pickupCourierId: courierId,
                updatedAt: FieldValue.serverTimestamp(),
                processingError: null,
            };

            logger.info(`${functionName} Updating booking ${bookingId} status to 'Out'...`, logContext);
            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully.`, logContext);

            // 7. Log User Activity (Async)
            logUserActivity("ConfirmRentalPickup", { bookingId, customerId: bookingData.customerId }, courierId)
                .catch(err => logger.error("Failed logging ConfirmRentalPickup user activity", { err })); // Fixed catch

            // 8. Return Success
            return { success: true };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.confirmPickup.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            logUserActivity("ConfirmRentalPickupFailed", { bookingId, error: error.message }, courierId)
                .catch(err => logger.error("Failed logging ConfirmRentalPickupFailed user activity", { err })); // Fixed catch

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
