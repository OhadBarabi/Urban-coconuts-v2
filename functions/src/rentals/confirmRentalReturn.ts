import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, RentalBooking, RentalBookingStatus, Box } from '../models'; // Adjust path if needed

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
async function publishToPubSub(topicName: string, jsonData: object): Promise<void> {
    const functionName = "[publishToPubSub]";
    try {
        const { PubSub } = await import('@google-cloud/pubsub');
        const pubSubClient = new PubSub();
        const dataBuffer = Buffer.from(JSON.stringify(jsonData));
        const messageId = await pubSubClient.topic(topicName).publishMessage({ data: dataBuffer });
        logger.info(`${functionName} Message ${messageId} published to topic ${topicName}.`, { topicName, jsonData });
    } catch (error: any) {
        logger.error(`${functionName} Failed to publish message to topic ${topicName}.`, { error: error.message, topicName, jsonData });
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
        const functionName = "[confirmRentalReturn V2 - Permissions]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const courierId = request.auth.uid;
        const data = request.data as ConfirmRentalReturnInput;
        const logContext: any = { courierId, bookingId: data?.bookingId, returnBoxId: data?.returnBoxId, condition: data?.condition };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        const validConditions: ReturnCondition[] = ["OK", "Dirty", "Damaged"];
        if (!data?.bookingId || typeof data.bookingId !== 'string' ||
            !data?.returnBoxId || typeof data.returnBoxId !== 'string' ||
            !data?.condition || !validConditions.includes(data.condition) ||
            (data.conditionPhotoBase64 != null && typeof data.conditionPhotoBase64 !== 'string') ||
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

        // --- Firestore References ---
        const bookingRef = db.collection('rentalBookings').doc(bookingId);
        const courierRef = db.collection('users').doc(courierId);
        const returnBoxRef = db.collection('boxes').doc(returnBoxId);

        try {
            // 3. Fetch User, Booking, and Return Box Data Concurrently
            const [courierSnap, bookingSnap, returnBoxSnap] = await Promise.all([
                courierRef.get(),
                bookingRef.get(),
                returnBoxRef.get()
            ]);

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
            logContext.rentalItemId = bookingData.rentalItemId;

            if (!returnBoxSnap.exists) {
                 logger.warn(`${functionName} Return box ${returnBoxId} not found.`, logContext);
                 return { success: false, error: "error.box.notFound", errorCode: ErrorCode.BoxNotFound };
            }

            // 4. Permission Check
            const hasPermission = await checkPermission(courierId, courierRole, 'rental:return:confirm', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for courier ${courierId} to confirm return for booking ${bookingId}.`, logContext);
                return { success: false, error: "error.permissionDenied.confirmReturn", errorCode: ErrorCode.PermissionDenied };
            }
            if (courierData.currentBoxId !== returnBoxId) {
                 logger.warn(