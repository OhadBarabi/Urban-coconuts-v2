import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, RentalBooking, RentalBookingStatus, Box } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions'; // <-- Import REAL helper
// import { logUserActivity } from '../utils/logging'; // Still using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const RENTAL_DEPOSIT_TOPIC = "rental-deposit-processing"; // Pub/Sub topic to trigger deposit handling

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Booking, User, or Box not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for return, Invalid condition value
    Aborted = "ABORTED", // Transaction failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    BoxNotFound = "BOX_NOT_FOUND",
    NotCourier = "NOT_COURIER",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not 'Out'
    InvalidReturnCondition = "INVALID_RETURN_CONDITION",
    CourierMismatch = "COURIER_MISMATCH", // Courier not assigned to return box
    PubSubError = "PUB_SUB_ERROR", // Failed to publish message
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- Interfaces ---
type ReturnCondition = "OK" | "Dirty" | "Damaged";
interface ConfirmRentalReturnInput {
    bookingId: string;
    returnBoxId: string; // ID of the box where the item is being returned
    condition: ReturnCondition; // Condition of the returned item
    conditionPhotoBase64?: string | null; // Optional Base64 encoded photo
    courierNotes?: string | null; // Optional notes from the courier
}

// --- Helper to publish to Pub/Sub ---
// TODO: Move to a dedicated Pub/Sub helper file?
async function publishToPubSub(topicName: string, jsonData: object): Promise<void> {
    const functionName = "[publishToPubSub]";
    try {
        const { PubSub } = await import('@google-cloud/pubsub'); // Lazy load
        const pubSubClient = new PubSub();
        const dataBuffer = Buffer.from(JSON.stringify(jsonData));
        const messageId = await pubSubClient.topic(topicName).publishMessage({ data: dataBuffer });
        logger.info(`${functionName} Message ${messageId} published to topic ${topicName}.`, { topicName, jsonData });
    } catch (error: any) {
        logger.error(`${functionName} Failed to publish message to topic ${topicName}.`, { error: error.message, topicName, jsonData });
        // Throw a specific error to be caught by the main function
        throw new HttpsError('internal', `Failed to publish to Pub/Sub topic ${topicName}`, { errorCode: ErrorCode.PubSubError });
    }
}


// --- The Cloud Function ---
export const confirmRentalReturn = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for transaction + potential image handling + pubsub
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[confirmRentalReturn V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const courierId = request.auth.uid; // Courier performing the action
        const data = request.data as ConfirmRentalReturnInput;
        const logContext: any = { courierId, bookingId: data?.bookingId, returnBoxId: data?.returnBoxId, condition: data?.condition };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        const validConditions: ReturnCondition[] = ["OK", "Dirty", "Damaged"];
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            !data?.returnBoxId || typeof data.returnBoxId !== 'string' ||
            !data?.condition || !validConditions.includes(data.condition) ||
            (data.conditionPhotoBase64 != null && typeof data.conditionPhotoBase64 !== 'string') || // Basic check
            (data.courierNotes != null && typeof data.courierNotes !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            let errorCode = ErrorCode.InvalidArgument;
            if (data?.condition && !validConditions.includes(data.condition)) {
                errorCode = ErrorCode.InvalidReturnCondition;
            }
            return { success: false, error: "error.invalidInput.structureOrCondition", errorCode: errorCode };
        }
        const { bookingId, returnBoxId, condition, conditionPhotoBase64, courierNotes } = data;

        // TODO: Handle conditionPhotoBase64 - upload to Cloud Storage and get URL

        // --- Firestore References ---
        const bookingRef = db.collection('rentalBookings').doc(bookingId);
        const courierRef = db.collection('users').doc(courierId); // Needed for role check
        const returnBoxRef = db.collection('boxes').doc(returnBoxId); // Needed for inventory update

        try {
            // 3. Fetch User, Booking, and Return Box Data Concurrently
            const [courierSnap, bookingSnap, returnBoxSnap] = await Promise.all([
                courierRef.get(),
                bookingRef.get(),
                returnBoxRef.get()
            ]);

            // Validate User (Courier)
            if (!courierSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${courierId}`, { errorCode: ErrorCode.UserNotFound });
            const courierData = courierSnap.data() as User;
            const courierRole = courierData.role; // Get role
            logContext.userRole = courierRole;
            if (courierRole !== 'Courier') {
                 logger.warn(`${functionName} User ${courierId} is not a Courier.`, logContext);
                 return { success: false, error: "error.permissionDenied.notCourier", errorCode: ErrorCode.NotCourier };
            }

            // Validate Booking
            if (!bookingSnap.exists) {
                logger.warn(`${functionName} Rental booking ${bookingId} not found.`, logContext);
                return { success: false, error: "error.rental.bookingNotFound", errorCode: ErrorCode.BookingNotFound };
            }
            const bookingData = bookingSnap.data() as RentalBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.rentalItemId = bookingData.rentalItemId; // Needed for inventory update

            // Validate Return Box
            if (!returnBoxSnap.exists) {
                 logger.warn(`${functionName} Return box ${returnBoxId} not found.`, logContext);
                 return { success: false, error: "error.box.notFound", errorCode: ErrorCode.BoxNotFound };
            }
             // Optional: Check if return box is active?
             // const returnBoxData = returnBoxSnap.data() as Box;
             // if (!returnBoxData.isActive) { ... }


            // 4. Permission Check (Using REAL helper)
            // Courier needs permission to confirm return, potentially tied to the box they are assigned to.
            // Define permission: 'rental:return:confirm'
            // Pass fetched role to checkPermission
            const hasPermission = await checkPermission(courierId, courierRole, 'rental:return:confirm', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for courier ${courierId} to confirm return for booking ${bookingId}.`, logContext);
                return { success: false, error: "error.permissionDenied.confirmReturn", errorCode: ErrorCode.PermissionDenied };
            }
            // Additional check: Is the courier assigned to the RETURN box?
            if (courierData.currentBoxId !== returnBoxId) {
                 logger.warn(`${functionName} Courier ${courierId} is not currently assigned to the return box ${returnBoxId} for booking ${bookingId}.`, logContext);
                 return { success: false, error: "error.rental.courierMismatchReturn", errorCode: ErrorCode.CourierMismatch };
            }


            // 5. State Validation
            if (bookingData.bookingStatus !== RentalBookingStatus.Out) {
                logger.warn(`${functionName} Rental booking ${bookingId} is not in 'Out' status (current: ${bookingData.bookingStatus}). Cannot confirm return.`, logContext);
                 // Handle case where it might already be 'Returned' - maybe return success?
                 if (bookingData.bookingStatus === RentalBookingStatus.Returned) {
                      logger.info(`${functionName} Booking ${bookingId} already marked as 'Returned'. Assuming confirmation already happened.`, logContext);
                      return { success: true }; // Idempotency
                 }
                return { success: false, error: `error.rental.invalidStatus.return::${bookingData.bookingStatus}`, errorCode: ErrorCode.InvalidBookingStatus };
            }

            // 6. Firestore Transaction to Update Booking Status and Restore Inventory
            logger.info(`${functionName} Starting Firestore transaction...`, logContext);
            const conditionPhotoUrl = null; // Placeholder - Upload photo logic needed here
            logContext.conditionPhotoUrl = conditionPhotoUrl; // Log placeholder or actual URL

            await db.runTransaction(async (transaction) => {
                // Re-read booking and box within transaction
                const bookingTxSnap = await transaction.get(bookingRef);
                const boxTxSnap = await transaction.get(returnBoxRef); // Read return box

                if (!bookingTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BookingNotFound}`);
                if (!boxTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}::${returnBoxId}`);
                const bookingTxData = bookingTxSnap.data() as RentalBooking;
                // const boxTxData = boxTxSnap.data() as Box; // Not needed for write logic

                 // Re-validate status
                 if (bookingTxData.bookingStatus !== RentalBookingStatus.Out) {
                     logger.warn(`${functionName} TX Conflict: Booking ${bookingId} status changed to ${bookingTxData.bookingStatus} during TX. Aborting return confirmation.`);
                     return; // Abort gracefully
                 }

                // --- Prepare Booking Update ---
                const now = Timestamp.now();
                const updateData: { [key: string]: any } = {
                    bookingStatus: RentalBookingStatus.Returned,
                    returnBoxId: returnBoxId,
                    actualReturnTimestamp: now,
                    returnedCondition: condition,
                    returnedConditionPhotoUrl: conditionPhotoUrl, // Add the actual URL if uploaded
                    courierNotesOnReturn: courierNotes ?? null,
                    returnCourierId: courierId, // Record which courier confirmed return
                    updatedAt: FieldValue.serverTimestamp(),
                    processingError: null, // Clear previous errors
                    depositProcessed: false, // Ensure flag is false before triggering background function
                };
                transaction.update(bookingRef, updateData);

                // --- Prepare Inventory Update ---
                // Return the item to the RETURN box's inventory
                const inventoryUpdate = {
                    [`rentalInventory.${bookingData.rentalItemId}`]: FieldValue.increment(1)
                };
                transaction.update(returnBoxRef, inventoryUpdate);

            }); // End Transaction
            logger.info(`${functionName} Transaction successful. Booking ${bookingId} marked as Returned and inventory restored to box ${returnBoxId}.`, logContext);

            // 7. Trigger Background Function to Handle Deposit (Capture/Void)
            // Publish bookingId to Pub/Sub topic
            logger.info(`${functionName} Publishing message to ${RENTAL_DEPOSIT_TOPIC} for booking ${bookingId}...`, logContext);
            await publishToPubSub(RENTAL_DEPOSIT_TOPIC, { bookingId: bookingId });
            logger.info(`${functionName} Message published successfully.`, logContext);


            // 8. Log User Activity (Async)
            logUserActivity("ConfirmRentalReturn", { bookingId, customerId: bookingData.customerId, returnBoxId, condition }, courierId)
                .catch(err => logger.error("Failed logging user activity", { err }));

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
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.confirmReturn.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
                 // Handle specific Pub/Sub error
                 if (finalErrorCode === ErrorCode.PubSubError) {
                     finalErrorMessageKey = "error.pubsub.publishFailed";
                 }
            } else if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            }

            logUserActivity("ConfirmRentalReturnFailed", { bookingId, returnBoxId, condition, error: error.message }, courierId).catch(...)

            // If transaction succeeded but Pub/Sub failed, the booking is marked 'Returned' but deposit won't be processed automatically.
            // May need manual intervention or retry mechanism for Pub/Sub.
            if (finalErrorCode === ErrorCode.PubSubError) {
                 logger.error(`${functionName} CRITICAL: Transaction succeeded but failed to trigger deposit processing for booking ${bookingId}. Requires manual check.`, logContext);
                 // Optionally update the booking with an error flag specifically for Pub/Sub failure?
                 // await bookingRef.update({ processingError: "Failed to trigger deposit processing" });
            }


            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
