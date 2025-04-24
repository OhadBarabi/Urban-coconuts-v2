import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, RentalBooking, RentalBookingStatus, PaymentStatus, Box
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { voidAuthorization } from '../utils/payment_helpers';
import { logUserActivity, logAdminAction } from '../utils/logging'; // Using mock below

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
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for cancellation
    Aborted = "ABORTED", // Transaction or Payment Void failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    NotBookingOwnerOrAdmin = "NOT_BOOKING_OWNER_OR_ADMIN",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not cancellable from this state
    PaymentVoidFailed = "PAYMENT_VOID_FAILED",
    MissingPaymentInfo = "MISSING_PAYMENT_INFO", // Missing authId for void
    TransactionFailed = "TRANSACTION_FAILED",
    BoxNotFound = "BOX_NOT_FOUND",
}

// --- Interfaces ---
interface CancelRentalBookingInput {
    bookingId: string;
    reason?: string | null; // Reason for cancellation
}

// --- The Cloud Function ---
export const cancelRentalBooking = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for reads/transaction/payment
        timeoutSeconds: 120, // Increase timeout for payment processing
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // Uncomment if payment helper needs secrets
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[cancelRentalBooking V3 - Permissions]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid;
        const data = request.data as CancelRentalBookingInput;
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
        let bookingData: RentalBooking;
        let userData: User;
        let userRole: string | null;
        let voidResult: Awaited<ReturnType<typeof voidAuthorization>> | null = null;
        let updatedPaymentStatus: PaymentStatus;

        // --- Firestore References ---
        const bookingRef = db.collection('rentalBookings').doc(bookingId);
        const userRef = db.collection('users').doc(userId);

        try {
            // 3. Fetch User and Booking Data Concurrently
            const [userSnap, bookingSnap] = await Promise.all([userRef.get(), bookingRef.get()]);

            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            userRole = userData.role;
            logContext.userRole = userRole;

            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Rental booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.rental.bookingNotFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as RentalBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.paymentStatus = bookingData.paymentStatus;
            logContext.bookingCustomerId = bookingData.customerId;
            logContext.pickupBoxId = bookingData.pickupBoxId;
            logContext.rentalItemId = bookingData.rentalItemId;

            // 4. Permission Check
            const isOwner = userId === bookingData.customerId;
            const isAdmin = userRole === 'Admin' || userRole === 'SuperAdmin';
            const requiredPermission = isOwner ? 'rental:cancel:own' : (isAdmin ? 'rental:cancel:any' : 'permission_denied');
            const hasPermission = await checkPermission(userId, userRole, requiredPermission, logContext);

            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${userId} (Role: ${userRole}) to cancel rental booking ${bookingId}.`, logContext);
                const errorCode = (requiredPermission === 'permission_denied') ? ErrorCode.PermissionDenied : ErrorCode.NotBookingOwnerOrAdmin;
                return { success: false, error: "error.permissionDenied.cancelRental", errorCode: errorCode };
            }

            // 5. State Validation
            const cancellableStatuses: string[] = [RentalBookingStatus.PendingPickup.toString()];
            if (!cancellableStatuses.includes(bookingData.bookingStatus)) {
                logger.warn(`${functionName} Rental booking ${bookingId} cannot be cancelled from status '${bookingData.bookingStatus}'.`, logContext);
                return { success: false, error: `error.rental.invalidStatus.cancel::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
             }
             if (bookingData.bookingStatus === RentalBookingStatus.Cancelled) {
                  logger.warn(`${functionName} Rental booking ${bookingId} is already cancelled.`, logContext);
                  return { success: false, error: "error.rental.alreadyCancelled", errorCode: ErrorCode.FailedPrecondition };
             }

            // 6. Handle Payment Void
            updatedPaymentStatus = bookingData.paymentStatus;
            if (bookingData.paymentStatus === PaymentStatus.Authorized) {
                const authId = bookingData.paymentDetails?.authorizationId;
                if (!authId) {
                    throw new HttpsError('internal', `error.internal.missingPaymentInfo::${bookingId}`, { errorCode: ErrorCode.MissingPaymentInfo });
                }
                logger.info(`${functionName} Booking ${bookingId}: Deposit is Authorized. Attempting to void authorization ${authId}...`, logContext);
                voidResult = await voidAuthorization(authId);
                updatedPaymentStatus = voidResult.success ? PaymentStatus.Voided : PaymentStatus.VoidFailed;
                if (!voidResult.success) logger.error(`${functionName} Deposit void failed.`, { ...logContext, error: voidResult.errorMessage });
                else logger.info(`${functionName} Deposit void successful.`, logContext);
            } else if (bookingData.paymentStatus === PaymentStatus.Captured || bookingData.paymentStatus === PaymentStatus.Paid) {
                logger.warn(`${functionName} Booking ${bookingId}: Deposit payment status is ${bookingData.paymentStatus}. Cancellation does not automatically trigger refund.`, logContext);
            }
            logContext.updatedPaymentStatus = updatedPaymentStatus;

            // 7. Firestore Transaction to Update Booking Status and Restore Inventory
            logger.info(`${functionName} Starting Firestore transaction...`, logContext);
            const boxRef = db.collection('boxes').doc(bookingData.pickupBoxId);

            await db.runTransaction(async (transaction) => {
                const [bookingTxSnap, boxTxSnap] = await Promise.all([
                    transaction.get(bookingRef),
                    transaction.get(boxRef)
                ]);

                if (!bookingTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BookingNotFound}`);
                if (!boxTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}::${bookingData.pickupBoxId}`);
                const bookingTxData = bookingTxSnap.data() as RentalBooking;

                if (bookingTxData.bookingStatus === RentalBookingStatus.Cancelled) {
                    logger.warn(`${functionName} TX Conflict: Booking ${bookingId} was already cancelled. Aborting update.`);
                    return;
                }
                if (!cancellableStatuses.includes(bookingTxData.bookingStatus)) {
                     logger.warn(`${functionName} TX Conflict: Booking ${bookingId} status changed. Aborting cancellation.`);
                     return;
                }

                const now = Timestamp.now();
                const updateData: { [key: string]: any } = {
                    bookingStatus: RentalBookingStatus.Cancelled, paymentStatus: updatedPaymentStatus,
                    updatedAt: FieldValue.serverTimestamp(), cancellationTimestamp: now, cancelledBy: userId,
                    cancellationReason: reason || null, processingError: null,
                };
                 if (voidResult && !voidResult.success) {
                     updateData['paymentDetails.voidErrorCode'] = voidResult.errorCode;
                     updateData['paymentDetails.voidErrorMessage'] = voidResult.errorMessage;
                 }
                const inventoryUpdate = { [`rentalInventory.${bookingData.rentalItemId}`]: FieldValue.increment(1) };

                transaction.update(bookingRef, updateData);
                transaction.update(boxRef, inventoryUpdate);

            });
            logger.info(`${functionName} Transaction successful. Rental booking ${bookingId} cancelled and inventory restored.`, logContext);

            // 8. Log Action (Async)
            const logDetails = { bookingId, customerId: bookingData.customerId, cancelledBy: userId, userRole, reason, initialStatus: bookingData.bookingStatus, finalPaymentStatus: updatedPaymentStatus };
            if (isAdmin) {
                logAdminAction("CancelRentalBooking", logDetails)
                    .catch(err => logger.error("Failed logging CancelRentalBooking admin action", { err })); // Fixed catch
            } else {
                logUserActivity("CancelRentalBooking", logDetails, userId)
                    .catch(err => logger.error("Failed logging CancelRentalBooking user activity", { err })); // Fixed catch
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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.cancelRental.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            } else if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            }

            logUserActivity("CancelRentalBookingFailed", { bookingId, reason, error: error.message }, userId)
                .catch(err => logger.error("Failed logging CancelRentalBookingFailed user activity", { err })); // Fixed catch

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
