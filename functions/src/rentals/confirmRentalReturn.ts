import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, Box, RentalItem, RentalBooking, RentalBookingStatus
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { triggerHandleRentalDeposit } from '../utils/background_triggers'; // Trigger for deposit processing
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity, logAdminAction } from '../utils/logging';
// import { uploadImageToStorage } from '../utils/storage_helpers'; // If uploading photo

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`, context); return userId != null; }
async function triggerHandleRentalDeposit(params: { bookingId: string }): Promise<void> { logger.info(`[Mock Trigger] Triggering deposit handling for booking ${params.bookingId}`); }
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
async function uploadImageToStorage(base64Image: string, path: string): Promise<string | null> { logger.info(`[Mock Storage] Uploading image to ${path}`); if (base64Image) return `https://mockstorage.google.com/${path}`; return null; }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const RENTAL_RETURN_IMAGES_PATH = 'rentalReturns'; // Storage path

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Booking, User, Box not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status or mismatch
    Aborted = "ABORTED", // Transaction failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not PickedUp or ReturnOverdue
    CourierNotAssignedToBox = "COURIER_NOT_ASSIGNED_TO_BOX", // Courier not at the return box
    InvalidReturnCondition = "INVALID_RETURN_CONDITION",
    StorageUploadFailed = "STORAGE_UPLOAD_FAILED",
    TransactionFailed = "TRANSACTION_FAILED",
    SideEffectTriggerFailed = "SIDE_EFFECT_TRIGGER_FAILED",
}

// Valid return conditions courier can select
const VALID_RETURN_CONDITIONS = ["OK", "Dirty", "Damaged"];

// --- Interfaces ---
interface ConfirmRentalReturnInput {
    bookingId: string;
    returnBoxId: string; // Box where item is being returned
    condition: "OK" | "Dirty" | "Damaged" | string; // Condition reported by courier
    conditionPhotoBase64?: string | null; // Optional Base64 encoded photo for Dirty/Damaged
    courierNotes?: string | null; // Optional notes from courier
}

// --- The Cloud Function ---
export const confirmRentalReturn = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for potential image upload + transaction
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[confirmRentalReturn V1]";
        const startTime = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const courierId = request.auth.uid; // Courier performing the return confirmation
        const data = request.data as ConfirmRentalReturnInput;
        const logContext: any = { courierId, bookingId: data?.bookingId, returnBoxId: data?.returnBoxId, condition: data?.condition };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            !data.returnBoxId || typeof data.returnBoxId !== 'string' ||
            !data.condition || !VALID_RETURN_CONDITIONS.includes(data.condition) ||
            (data.conditionPhotoBase64 != null && typeof data.conditionPhotoBase64 !== 'string') || // Basic check
            (data.courierNotes != null && typeof data.courierNotes !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: { ...data, conditionPhotoBase64: data.conditionPhotoBase64 ? 'Present' : 'Not Present'} });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { bookingId, returnBoxId, condition, conditionPhotoBase64, courierNotes } = data;

        // Validate photo requirement for Dirty/Damaged
        if ((condition === "Dirty" || condition === "Damaged") && !conditionPhotoBase64) {
             logger.error(`${functionName} Photo required for condition '${condition}'.`, logContext);
             return { success: false, error: `error.invalidInput.photoRequired::${condition}`, errorCode: ErrorCode.InvalidArgument };
        }

        // --- Variables ---
        let bookingData: RentalBooking;
        let courierData: User;
        let returnBoxData: Box;
        let rentalItemData: RentalItem;
        let conditionPhotoUrl: string | null = null;
        let depositTriggerFailed = false;

        try {
            // Fetch Courier, Booking, Return Box, Rental Item Data Concurrently
            const courierRef = db.collection('users').doc(courierId);
            const bookingRef = db.collection('rentalBookings').doc(bookingId);
            const returnBoxRef = db.collection('boxes').doc(returnBoxId);
            // Fetching rentalItem is needed to know its ID for inventory update
            // We can get rentalItemId from the booking later

            const hasPermissionPromise = checkPermission(courierId, 'rental:confirm_return', { bookingId, returnBoxId });

            const [courierSnap, bookingSnap, returnBoxSnap, hasPermission] = await Promise.all([
                courierRef.get(), bookingRef.get(), returnBoxRef.get(), hasPermissionPromise
            ]);

            // Validate Permission
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for courier ${courierId}.`, logContext);
                return { success: false, error: "error.permissionDenied.confirmReturn", errorCode: ErrorCode.PermissionDenied };
            }

            // Validate Courier
            if (!courierSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${courierId}`, { errorCode: ErrorCode.UserNotFound });
            courierData = courierSnap.data() as User;
            if (courierData.role !== Role.Courier || !courierData.isActive) {
                 throw new HttpsError('permission-denied', "error.permissionDenied.notActiveCourier", { errorCode: ErrorCode.PermissionDenied });
            }

            // Validate Booking
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.booking.notFound", errorCode: ErrorCode.BookingNotFound };
            }
            bookingData = bookingSnap.data() as RentalBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.rentalItemId = bookingData.rentalItemId;
            logContext.customerId = bookingData.customerId;

            // Validate Booking Status (Must be picked up or overdue)
            const validReturnStatuses: string[] = [
                RentalBookingStatus.PickedUp.toString(),
                RentalBookingStatus.AwaitingReturn.toString(), // If using this alias
                RentalBookingStatus.ReturnOverdue.toString()
            ];
            if (!validReturnStatuses.includes(bookingData.bookingStatus)) {
                logger.warn(`${functionName} Booking ${bookingId} has invalid status: ${bookingData.bookingStatus}. Expected PickedUp/AwaitingReturn/ReturnOverdue.`, logContext);
                 // Idempotency: If already returned, maybe allow update of condition/notes? Or just succeed? Let's succeed.
                 if (bookingData.bookingStatus === RentalBookingStatus.ReturnedPendingInspection || bookingData.bookingStatus === RentalBookingStatus.ReturnProcessing || bookingData.bookingStatus === RentalBookingStatus.ReturnCompleted) {
                     logger.info(`${functionName} Booking ${bookingId} already marked as returned. Idempotent success.`);
                     return { success: true };
                 }
                return { success: false, error: `error.booking.invalidStatus.return::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // Validate Return Box
            if (!returnBoxSnap.exists) throw new HttpsError('not-found', `error.box.notFound::${returnBoxId}`, { errorCode: ErrorCode.BoxNotFound });
            returnBoxData = returnBoxSnap.data() as Box;
            if (!returnBoxData.isActive) throw new HttpsError('failed-precondition', `error.box.inactive::${returnBoxId}`, { errorCode: ErrorCode.BoxInactive });
            // Should we check if courier is assigned to the RETURN box? Yes.
            if (courierData.currentBoxId !== returnBoxId) {
                 logger.error(`${functionName} Courier ${courierId} is not currently assigned to return box ${returnBoxId} (Current: ${courierData.currentBoxId}).`, logContext);
                 return { success: false, error: "error.courier.notAtReturnBox", errorCode: ErrorCode.CourierNotAssignedToBox };
            }

            // Fetch Rental Item (Needed for inventory update)
            const rentalItemId = bookingData.rentalItemId;
            if (!rentalItemId) throw new HttpsError('internal', `Booking ${bookingId} missing rentalItemId.`);
            const rentalItemRef = db.collection('rentalItems').doc(rentalItemId);
            const rentalItemSnap = await rentalItemRef.get();
            if (!rentalItemSnap.exists) throw new HttpsError('not-found', `error.rentalItem.notFound::${rentalItemId}`, { errorCode: ErrorCode.RentalItemNotFound });
            rentalItemData = rentalItemSnap.data() as RentalItem;


            // 3. Upload Condition Photo (if provided)
            if (conditionPhotoBase64) {
                logger.info(`${functionName} Uploading condition photo for booking ${bookingId}...`, logContext);
                const imagePath = `${RENTAL_RETURN_IMAGES_PATH}/${bookingId}/${Date.now()}.jpg`; // Example path
                try {
                    // Assuming base64 includes data prefix (e.g., "data:image/jpeg;base64,...")
                    const base64Data = conditionPhotoBase64.split(',')[1] ?? conditionPhotoBase64;
                    conditionPhotoUrl = await uploadImageToStorage(base64Data, imagePath); // Use actual helper
                    if (!conditionPhotoUrl) throw new Error("Upload returned null URL");
                    logger.info(`${functionName} Condition photo uploaded successfully: ${conditionPhotoUrl}`, logContext);
                } catch (uploadError: any) {
                    logger.error(`${functionName} Failed to upload condition photo. Proceeding without photo URL.`, { ...logContext, error: uploadError.message });
                    // Don't fail the whole process, but log it. Maybe set a flag?
                    // throw new HttpsError('internal', "error.storage.uploadFailed", { errorCode: ErrorCode.StorageUploadFailed });
                }
            }

            // 4. Firestore Transaction
            logger.info(`${functionName} Starting Firestore transaction to process return for booking ${bookingId}...`, logContext);
            await db.runTransaction(async (transaction) => {
                const now = Timestamp.now();

                // Re-read Booking & Box within TX
                const bookingTxSnap = await transaction.get(bookingRef);
                const boxTxSnap = await transaction.get(returnBoxRef);
                // No need to re-read item type unless its status could change

                if (!bookingTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BookingNotFound}`);
                const bookingTxData = bookingTxSnap.data() as RentalBooking;
                if (!boxTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}`);
                const boxTxData = boxTxSnap.data() as Box;

                // Re-validate status
                if (!validReturnStatuses.includes(bookingTxData.bookingStatus)) {
                     logger.warn(`${functionName} TX Conflict: Booking ${bookingId} status changed to ${bookingTxData.bookingStatus} during TX. Aborting return.`, logContext);
                     return; // Abort gracefully
                }
                if (!boxTxData.isActive) throw new Error(`TX_ERR::${ErrorCode.BoxInactive}`);


                // Prepare Booking Update
                const bookingUpdateData: Partial<RentalBooking> = {
                    bookingStatus: RentalBookingStatus.ReturnedPendingInspection, // Move to inspection state
                    actualReturnTimestamp: now,
                    returnBoxId: returnBoxId,
                    returnCourierId: courierId,
                    returnedCondition: condition,
                    returnedConditionPhotoUrl: conditionPhotoUrl, // Store URL if upload succeeded
                    courierNotesOnReturn: courierNotes ?? null,
                    updatedAt: FieldValue.serverTimestamp(),
                    processingError: null, // Clear previous errors
                };

                // Prepare Box Inventory Update (Increment count for the returned item type)
                const inventoryUpdate = { [`rentalInventory.${rentalItemId}`]: FieldValue.increment(1) };

                // --- Perform Writes ---
                // 1. Update Rental Booking
                transaction.update(bookingRef, bookingUpdateData);
                // 2. Update Box Inventory
                transaction.update(returnBoxRef, inventoryUpdate);

            }); // End Firestore Transaction
            logger.info(`${functionName} Firestore transaction successful for booking ${bookingId} return.`);

            // 5. Trigger Deposit Handling Background Function (Async)
            logger.info(`${functionName} Triggering deposit handling for booking ${bookingId}...`, logContext);
            try {
                await triggerHandleRentalDeposit({ bookingId });
            } catch (triggerError: any) {
                 depositTriggerFailed = true;
                 logger.error(`${functionName} CRITICAL: Failed to trigger deposit handling for booking ${bookingId}. Manual processing required.`, { ...logContext, error: triggerError.message });
                 // Update booking with flag (best effort outside TX)
                 bookingRef.update({ processingError: `Deposit handling trigger failed: ${triggerError.message}` }).catch(...);
                 logAdminAction("DepositHandleTriggerFailed", { bookingId, reason: triggerError.message }).catch(...);
                 // Send Admin Alert
                 sendPushNotification({ subject: `Deposit Handling Trigger FAILED - Booking ${bookingId}`, body: `Failed to trigger deposit handling for returned rental ${bookingId}. Manual calculation and charge/refund required.`, bookingId, severity: "critical" }).catch(...);
                 // Do NOT fail the main function for this async trigger failure.
            }

            // 6. Trigger Notifications (Async) - e.g., to customer confirming return received
            if (bookingData.customerId) {
                sendPushNotification({
                    userId: bookingData.customerId, type: "RentalReturned", titleKey: "notification.rentalReturned.title",
                    messageKey: "notification.rentalReturned.message", messageParams: { itemName: rentalItemData.itemName_i18n?.['en'] ?? rentalItemId },
                    payload: { bookingId: bookingId, screen: 'RentalDetails' }
                }).catch(err => logger.error("Failed sending customer return notification", { err }));
            }

            // 7. Log Action (Async)
            logUserActivity("ConfirmRentalReturn", { bookingId, customerId: bookingData.customerId, rentalItemId, returnBoxId, condition, photoUploaded: !!conditionPhotoUrl, depositTriggerFailed }, courierId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 8. Return Success
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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.confirmRentalReturn.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            } else if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            }

            // Log admin action failure if needed
            logAdminAction("ConfirmRentalReturnFailed", { inputData: data, triggerUserId: courierId, errorMessage: error.message, finalErrorCode }).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTime}ms`, logContext);
        }
    }
);
