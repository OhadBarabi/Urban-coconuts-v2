import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, RentalBooking, RentalBookingStatus, PaymentStatus, Box // Added Box
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { voidAuthorization } from '../utils/payment_helpers'; // Payment gateway interaction
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity, logAdminAction } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null; }
async function voidAuthorization(gatewayTransactionId: string): Promise<{ success: boolean; error?: string }> { logger.info(`[Mock Payment] Voiding Auth ${gatewayTransactionId}`); await new Promise(res => setTimeout(res, 500)); if (gatewayTransactionId.includes("fail_void")) { logger.error("[Mock Payment] Void FAILED."); return { success: false, error: "Mock Void Failed" }; } return { success: true }; }
interface AdminAlertParams { subject: string; body: string; bookingId?: string; severity: "critical" | "warning" | "info"; }
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
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
    NotFound = "NOT_FOUND", // Booking or User not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for cancellation
    Aborted = "ABORTED", // Transaction or Payment Void failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not cancellable from this state
    PaymentVoidFailed = "PAYMENT_VOID_FAILED", // Critical failure during void attempt
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- Interfaces ---
interface CancelRentalBookingInput {
    bookingId: string;
    reason: string; // Reason for cancellation
}

// --- The Cloud Function ---
export const cancelRentalBooking = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory for payment interaction + transaction
        timeoutSeconds: 60,
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // If voidAuthorization needs secret
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[cancelRentalBooking V1]";
        const startTime = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const userId = request.auth.uid; // User initiating cancellation (Customer or Admin)
        const data = request.data as CancelRentalBookingInput;
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
        let bookingData: RentalBooking;
        let userRole: string;
        let voidFailed = false;
        let finalPaymentStatus: PaymentStatus | string | null;

        try {
            // Fetch User Role & Booking Data Concurrently
            const userRef = db.collection('users').doc(userId);
            const bookingRef = db.collection('rentalBookings').doc(bookingId);

            const [userSnap, bookingSnap] = await Promise.all([userRef.get(), bookingRef.get()]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
            const userData = userSnap.data() as User;
            userRole = userData.role;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });
            logContext.userRole = userRole;

            // Validate Booking
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.booking.notFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as RentalBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.customerId = bookingData.customerId;
            logContext.rentalItemId = bookingData.rentalItemId;
            logContext.pickupBoxId = bookingData.pickupBoxId;

            // 3. Permission/Ownership Check
            const isOwner = userId === bookingData.customerId;
            const requiredPermission = isOwner ? 'rental:cancel:own' : 'rental:cancel:any';
            const hasPermission = await checkPermission(userId, userRole, requiredPermission, { bookingData });
            if (!hasPermission) {
                logger.warn(`${functionName} Permission '${requiredPermission}' denied for user ${userId}.`, logContext);
                return { success: false, error: `error.permissionDenied.cancelRental`, errorCode: ErrorCode.PermissionDenied };
            }

            // 4. State Validation (Can only cancel before pickup)
            const cancellableStatuses: string[] = [
                RentalBookingStatus.PendingDeposit.toString(),
                RentalBookingStatus.DepositAuthorized.toString(),
                RentalBookingStatus.DepositFailed.toString(), // Allow cancelling even if deposit failed initially? Yes.
                RentalBookingStatus.AwaitingPickup.toString()
            ];
            if (!cancellableStatuses.includes(bookingData.bookingStatus)) {
                logger.warn(`${functionName} Booking ${bookingId} cannot be cancelled from status '${bookingData.bookingStatus}'.`, logContext);
                 // Idempotency: If already cancelled, return success
                 if (bookingData.bookingStatus === RentalBookingStatus.Cancelled) {
                     logger.info(`${functionName} Booking ${bookingId} already cancelled. Idempotent success.`);
                     return { success: true };
                 }
                return { success: false, error: `error.booking.invalidStatus.cancel::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 5. Void Deposit Authorization (if applicable)
            finalPaymentStatus = bookingData.paymentStatus ?? PaymentStatus.Pending; // Start with current status
            const authTxId = bookingData.paymentDetails?.gatewayTransactionId;
            if (bookingData.paymentStatus === PaymentStatus.Authorized && authTxId) {
                logger.info(`${functionName} Booking ${bookingId}: Attempting to void deposit authorization ${authTxId}...`, logContext);
                try {
                    const voidResult = await voidAuthorization(authTxId);
                    if (!voidResult.success) {
                        voidFailed = true;
                        finalPaymentStatus = PaymentStatus.VoidFailed;
                        logger.error(`${functionName} CRITICAL: Failed to void authorization ${authTxId} for cancelled booking ${bookingId}. Manual void required.`, { ...logContext, error: voidResult.error });
                        sendPushNotification({ subject: `Payment Void FAILED - Rental Booking ${bookingId}`, body: `Failed to void deposit auth ${authTxId} for cancelled rental booking ${bookingId}. Manual void REQUIRED.`, bookingId, severity: "critical" }).catch(...);
                        logAdminAction("RentalDepositVoidFailedDuringCancel", { bookingId, authTxId, reason: voidResult.error, triggerUserId: userId }).catch(...);
                        // Continue with cancellation despite void failure
                    } else {
                        logger.info(`${functionName} Successfully voided authorization ${authTxId}.`, logContext);
                        finalPaymentStatus = PaymentStatus.Voided;
                    }
                } catch (voidError: any) {
                    voidFailed = true;
                    finalPaymentStatus = PaymentStatus.VoidFailed;
                    logger.error(`${functionName} CRITICAL: Error during void attempt for ${authTxId}. Manual void likely required.`, { ...logContext, error: voidError?.message });
                    sendPushNotification({ subject: `Payment Void FAILED - Rental Booking ${bookingId}`, body: `Error attempting to void deposit auth ${authTxId} for cancelled rental booking ${bookingId}. Manual void REQUIRED. Error: ${voidError.message}`, bookingId, severity: "critical" }).catch(...);
                }
            } else if (bookingData.paymentStatus !== PaymentStatus.Voided && bookingData.paymentStatus !== PaymentStatus.Cancelled) {
                // If it wasn't Authorized (e.g., Pending, Failed), mark as Cancelled
                finalPaymentStatus = PaymentStatus.Cancelled;
            }


            // 6. Firestore Transaction
            logger.info(`${functionName} Starting Firestore transaction to finalize cancellation for booking ${bookingId}...`, logContext);
            await db.runTransaction(async (transaction) => {
                const now = Timestamp.now();

                // Re-read Booking & Box within TX
                const bookingTxSnap = await transaction.get(bookingRef);
                if (!bookingTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BookingNotFound}`);
                const bookingTxData = bookingTxSnap.data() as RentalBooking;

                const pickupBoxRef = db.collection('boxes').doc(bookingTxData.pickupBoxId);
                const boxTxSnap = await transaction.get(pickupBoxRef);
                if (!boxTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}::${bookingTxData.pickupBoxId}`);
                // Box status check (isActive) not strictly needed here, but good practice

                // Re-validate status
                if (!cancellableStatuses.includes(bookingTxData.bookingStatus)) {
                    logger.warn(`${functionName} TX Conflict: Booking ${bookingId} status changed to ${bookingTxData.bookingStatus} during TX. Aborting cancellation.`, logContext);
                    return; // Abort gracefully
                }

                // Prepare Booking Update
                const bookingUpdateData: Partial<RentalBooking> & { updatedAt: admin.firestore.FieldValue } = {
                    bookingStatus: RentalBookingStatus.Cancelled,
                    cancellationReason: reason,
                    cancelledBy: userRole, // Role of user initiating cancel
                    cancellationTimestamp: now,
                    paymentStatus: finalPaymentStatus, // Set calculated/attempted payment status
                    updatedAt: FieldValue.serverTimestamp(),
                    processingError: voidFailed ? `Payment void failed, requires manual action.` : null, // Set or clear error
                };
                 // Update paymentDetails with void status
                 if (finalPaymentStatus === PaymentStatus.Voided || finalPaymentStatus === PaymentStatus.VoidFailed) {
                     bookingUpdateData.paymentDetails = {
                         ...(bookingTxData.paymentDetails ?? {}),
                         voidTimestamp: now,
                         voidSuccess: !voidFailed,
                         voidError: voidFailed ? (bookingData.paymentDetails?.voidError ?? 'Void failed during cancellation') : null,
                     };
                 }


                // Prepare Box Inventory Update (Increment count for the cancelled item type)
                // **ASSUMPTION:** Inventory is stored like: box.rentalInventory = { "mat_standard": 5, "mat_large": 2 }
                const inventoryUpdate = { [`rentalInventory.${bookingTxData.rentalItemId}`]: FieldValue.increment(1) };

                // --- Perform Writes ---
                // 1. Update Rental Booking
                transaction.update(bookingRef, bookingUpdateData);
                // 2. Update Box Inventory
                transaction.update(pickupBoxRef, inventoryUpdate);

            }); // End Firestore Transaction
            logger.info(`${functionName} Firestore transaction successful for booking ${bookingId} cancellation.`);


            // 7. Trigger Async Notifications
            // Notify Customer
            if (bookingData.customerId) {
                 sendPushNotification({
                     userId: bookingData.customerId, type: "RentalCancelled", titleKey: "notification.rentalCancelled.title",
                     messageKey: "notification.rentalCancelled.message", messageParams: { bookingIdShort: bookingId.substring(0, 6), reason: reason },
                     payload: { bookingId: bookingId }
                 }).catch(err => logger.error("Failed sending customer cancellation notification", { err }));
            }
            // Notify Admin if void failed
            if (voidFailed) {
                 // Already sent critical alert inside the void attempt block
            } else {
                 // Send standard admin notice
                 sendPushNotification({
                     subject: `Rental Booking Cancelled: ${bookingId.substring(0,6)}`,
                     body: `Rental booking ${bookingId} was cancelled by ${userId} (${userRole}). Reason: ${reason}. Payment Status: ${finalPaymentStatus}.`,
                     bookingId: bookingId, severity: "info", type: "RentalCancelledAdminNotice"
                 }).catch(err => logger.error("Failed sending admin cancellation notice", { err }));
            }

            // 8. Log Action (Async)
            const logDetails = { bookingId, reason, cancelledByRole: userRole, paymentStatusBefore: bookingData.paymentStatus, paymentStatusAfter: finalPaymentStatus, voidAttempted: (bookingData.paymentStatus === PaymentStatus.Authorized && authTxId), voidFailed };
            if (userRole === 'Admin' || userRole === 'SuperAdmin') {
                logAdminAction("RentalBookingCancelled", logDetails).catch(err => logger.error("Failed logging admin action", { err }));
            } else {
                logUserActivity("CancelRentalBooking", logDetails, userId).catch(err => logger.error("Failed logging user activity", { err }));
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

            // Log admin action failure
            logAdminAction("CancelRentalBookingFailed", { inputData: data, triggerUserId: userId, triggerUserRole: userRole, errorMessage: error.message, finalErrorCode }).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTime}ms`, logContext);
        }
    }
);
