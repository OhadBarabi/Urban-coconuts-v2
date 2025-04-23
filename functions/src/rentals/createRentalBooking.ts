import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, RentalItem, Box, RentalBooking, RentalBookingStatus, PaymentStatus, PaymentDetails
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
// import { checkPermission } from '../utils/permissions'; // Still using mock below
import { initiateAuthorization, extractPaymentDetailsFromResult } from '../utils/payment_helpers'; // <-- Import from new helper
// import { logUserActivity } from '../utils/logging'; // Still using mock below

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null; }
// initiateAuthorization is now imported from the helper
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User, RentalItem, or Box not found
    FailedPrecondition = "FAILED_PRECONDITION", // Item inactive, Box inactive, Item not available
    Aborted = "ABORTED", // Transaction or Payment failed
    ResourceExhausted = "RESOURCE_EXHAUSTED", // Inventory unavailable
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND",
    RentalItemNotFound = "RENTAL_ITEM_NOT_FOUND",
    RentalItemInactive = "RENTAL_ITEM_INACTIVE",
    BoxNotFound = "BOX_NOT_FOUND",
    BoxInactive = "BOX_INACTIVE", // Added
    InventoryUnavailable = "INVENTORY_UNAVAILABLE",
    PaymentAuthFailed = "PAYMENT_AUTH_FAILED",
    PaymentActionRequired = "PAYMENT_ACTION_REQUIRED",
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- Interfaces ---
interface CreateRentalBookingInput {
    rentalItemId: string;
    pickupBoxId: string;
    expectedReturnTimestamp?: string | null; // ISO Date string (optional for now)
    paymentMethodToken?: string | null; // Token from client-side payment SDK
}

// --- The Cloud Function ---
export const createRentalBooking = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for reads/transaction/payment
        timeoutSeconds: 120, // Increase timeout for payment processing
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // Uncomment if payment helper needs secrets
    },
    async (request): Promise<{ success: true; bookingId: string; requiresAction?: boolean; actionUrl?: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createRentalBooking V2 - Refactored]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const customerId = request.auth.uid;
        const data = request.data as CreateRentalBookingInput;
        const logContext: any = { customerId, rentalItemId: data?.rentalItemId, pickupBoxId: data?.pickupBoxId };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.rentalItemId || typeof data.rentalItemId !== 'string' ||
            !data?.pickupBoxId || typeof data.pickupBoxId !== 'string' ||
            (data.expectedReturnTimestamp != null && typeof data.expectedReturnTimestamp !== 'string') || // Basic check, more robust date validation needed if used
            (data.paymentMethodToken != null && typeof data.paymentMethodToken !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { rentalItemId, pickupBoxId, expectedReturnTimestamp, paymentMethodToken } = data;

        // --- Variables ---
        let userData: User;
        let userRole: string | null;
        let rentalItemData: RentalItem;
        let boxData: Box;
        let authorizationResult: Awaited<ReturnType<typeof initiateAuthorization>> | null = null;
        let paymentStatus: PaymentStatus;
        let authDetails: PaymentDetails | null = null;
        const bookingId = db.collection('rentalBookings').doc().id; // Pre-generate booking ID

        try {
            // 3. Fetch User, Rental Item, and Box Data Concurrently
            const userRef = db.collection('users').doc(customerId);
            const itemRef = db.collection('rentalItems').doc(rentalItemId);
            const boxRef = db.collection('boxes').doc(pickupBoxId);

            logger.info(`${functionName} Fetching user, rental item, and box data...`, logContext);
            const [userSnap, itemSnap, boxSnap] = await Promise.all([
                userRef.get(),
                itemRef.get(),
                boxRef.get()
            ]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            userRole = userData.role;
            logContext.userRole = userRole;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });

            // Validate Rental Item
            if (!itemSnap.exists) throw new HttpsError('not-found', `error.rentalItem.notFound::${rentalItemId}`, { errorCode: ErrorCode.RentalItemNotFound });
            rentalItemData = itemSnap.data() as RentalItem;
            logContext.depositAmount = rentalItemData.depositSmallestUnit;
            logContext.itemCurrency = rentalItemData.currencyCode;
            if (!rentalItemData.isActive) throw new HttpsError('failed-precondition', `error.rentalItem.inactive::${rentalItemId}`, { errorCode: ErrorCode.RentalItemInactive });
            if (!rentalItemData.depositSmallestUnit || rentalItemData.depositSmallestUnit <= 0) {
                 throw new HttpsError('failed-precondition', `error.rentalItem.noDeposit::${rentalItemId}`, { errorCode: ErrorCode.FailedPrecondition });
            }

            // Validate Box
            if (!boxSnap.exists) throw new HttpsError('not-found', `error.box.notFound::${pickupBoxId}`, { errorCode: ErrorCode.BoxNotFound });
            boxData = boxSnap.data() as Box;
            if (!boxData.isActive) throw new HttpsError('failed-precondition', `error.box.inactive::${pickupBoxId}`, { errorCode: ErrorCode.BoxInactive });
            // Check if box currency matches item currency? Important!
            if (boxData.currencyCode !== rentalItemData.currencyCode) {
                 logger.error(`${functionName} Currency mismatch: Box (${boxData.currencyCode}) vs Rental Item (${rentalItemData.currencyCode}).`, logContext);
                 throw new HttpsError('failed-precondition', `error.rental.currencyMismatch`, { errorCode: ErrorCode.FailedPrecondition });
            }

            // 4. Permission Check (Basic: Is user allowed to rent?)
            const hasPermission = await checkPermission(customerId, userRole, 'rental:create');
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${customerId} to create rental booking.`, logContext);
                return { success: false, error: "error.permissionDenied.createRental", errorCode: ErrorCode.PermissionDenied };
            }

            // 5. Authorize Deposit Payment
            logger.info(`${functionName} Initiating deposit authorization for ${rentalItemData.depositSmallestUnit} ${rentalItemData.currencyCode}...`, logContext);
            paymentStatus = PaymentStatus.AuthorizationPending;
            authorizationResult = await initiateAuthorization(
                customerId,
                rentalItemData.depositSmallestUnit,
                rentalItemData.currencyCode,
                `Deposit for Rental ${rentalItemId} - Booking ${bookingId}`,
                paymentMethodToken,
                userData.paymentGatewayCustomerId,
                bookingId // Link to booking ID
            );

            authDetails = extractPaymentDetailsFromResult(authorizationResult); // Extract details

            if (!authorizationResult.success) {
                paymentStatus = PaymentStatus.AuthorizationFailed;
                logger.error(`${functionName} Deposit authorization failed.`, { ...logContext, error: authorizationResult.errorMessage, code: authorizationResult.errorCode });
                if (authorizationResult.requiresAction) {
                     return { success: false, error: "error.payment.actionRequired", errorCode: ErrorCode.PaymentActionRequired, requiresAction: true, actionUrl: authorizationResult.actionUrl };
                } else {
                     return { success: false, error: `error.payment.authFailed::${authorizationResult.errorCode || 'Unknown'}`, errorCode: ErrorCode.PaymentAuthFailed };
                }
            }
            // If successful authorization
            paymentStatus = PaymentStatus.Authorized;
            logger.info(`${functionName} Deposit authorization successful. AuthID: ${authorizationResult.authorizationId}`, logContext);
             if (authorizationResult.requiresAction) {
                 paymentStatus = PaymentStatus.AuthorizationActionRequired;
                 logger.warn(`${functionName} Deposit authorization requires further action (e.g., 3DS).`, logContext);
             }
            logContext.paymentStatus = paymentStatus;


            // 6. Firestore Transaction to Create Booking and Update Inventory
            logger.info(`${functionName} Starting Firestore transaction...`, logContext);
            await db.runTransaction(async (transaction) => {
                // Re-read box data within transaction
                const boxTxSnap = await transaction.get(boxRef);
                if (!boxTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}`);
                const boxTxData = boxTxSnap.data() as Box;

                // --- Inventory Check and Update ---
                const currentInventory = boxTxData.rentalInventory ?? {};
                const currentStock = currentInventory[rentalItemId] ?? 0;
                if (currentStock < 1) { // Need at least 1 item
                    logger.error(`${functionName} TX Check: Insufficient inventory for rental item ${rentalItemId} in box ${pickupBoxId}. Available: ${currentStock}.`, logContext);
                    throw new Error(`TX_ERR::${ErrorCode.InventoryUnavailable}::${rentalItemId}`);
                }
                const inventoryUpdate = {
                    [`rentalInventory.${rentalItemId}`]: FieldValue.increment(-1)
                };

                // --- Create RentalBooking Document ---
                const now = Timestamp.now();
                const initialStatus = RentalBookingStatus.PendingPickup;
                let parsedExpectedReturn: Timestamp | null = null;
                if (expectedReturnTimestamp) {
                    try { parsedExpectedReturn = Timestamp.fromDate(new Date(expectedReturnTimestamp)); } catch (e) { logger.warn("Invalid expectedReturnTimestamp format", { input: expectedReturnTimestamp }); }
                }

                const newBookingData: RentalBooking = {
                    bookingId: bookingId, // Store generated ID
                    customerId: customerId,
                    rentalItemId: rentalItemId,
                    bookingStatus: initialStatus,
                    pickupBoxId: pickupBoxId,
                    returnBoxId: null,
                    pickupCourierId: null,
                    returnCourierId: null,
                    pickupTimestamp: null,
                    expectedReturnTimestamp: parsedExpectedReturn,
                    actualReturnTimestamp: null,
                    returnedCondition: null,
                    returnedConditionPhotoUrl: null,
                    courierNotesOnReturn: null,
                    rentalFeeSmallestUnit: rentalItemData.rentalFeeSmallestUnit, // Snapshot fee
                    depositSmallestUnit: rentalItemData.depositSmallestUnit, // Snapshot deposit
                    currencyCode: rentalItemData.currencyCode, // Snapshot currency
                    paymentStatus: paymentStatus, // Set based on auth result
                    paymentDetails: authDetails, // Store details from authorization attempt
                    finalChargeSmallestUnit: null,
                    overtimeFeeChargedSmallestUnit: null,
                    cleaningFeeChargedSmallestUnit: null,
                    damageFeeChargedTotalSmallestUnit: null,
                    depositProcessed: false, // Flag for background function
                    processingError: null,
                    createdAt: now,
                    updatedAt: now,
                };
                const bookingRef = db.collection('rentalBookings').doc(bookingId);
                transaction.set(bookingRef, newBookingData);

                // --- Perform Writes ---
                // 1. Update Box Inventory
                transaction.update(boxRef, inventoryUpdate);

            }); // End Transaction
            logger.info(`${functionName} Transaction successful. Rental booking ${bookingId} created.`, logContext);


            // 7. Log User Activity (Async)
            logUserActivity("CreateRentalBooking", { bookingId, rentalItemId, pickupBoxId, depositAmount: rentalItemData.depositSmallestUnit, paymentStatus }, customerId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 8. Return Success (potentially with action required)
             const successResponse: { success: true; bookingId: string; requiresAction?: boolean; actionUrl?: string } = {
                 success: true,
                 bookingId: bookingId
             };
             if (paymentStatus === PaymentStatus.AuthorizationActionRequired && authorizationResult?.requiresAction) {
                 successResponse.requiresAction = true;
                 successResponse.actionUrl = authorizationResult.actionUrl ?? undefined;
             }
             return successResponse;

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.createRental.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            } else if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            }

            // Log failure activity?
            logUserActivity("CreateRentalBookingFailed", { rentalItemId, pickupBoxId, error: error.message }, customerId).catch(...)

            // Attempt to void authorization if it succeeded but transaction failed? Complex logic needed.
            // For now, just return the error. The auth might need manual voiding.
            if (authorizationResult?.success && !authorizationResult.requiresAction && authorizationResult.authorizationId) {
                 logger.warn(`${functionName} Transaction failed after successful authorization (${authorizationResult.authorizationId}). Manual void might be required.`, logContext);
                 // TODO: Consider adding a mechanism to automatically attempt voiding here or flag for admin.
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
