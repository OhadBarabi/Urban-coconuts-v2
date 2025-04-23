import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    User, Box, RentalItem, RentalBooking, RentalBookingStatus, PaymentStatus, PaymentDetails
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { initiateAuthorization, voidAuthorization } from '../utils/payment_helpers'; // Payment gateway interaction
// import { checkOperatingHours } from '../utils/time_utils';
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity } from '../utils/logging';
// import { fetchMatRentalSettings } from '../config/config_helpers';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`); return userId != null; }
interface AuthResult { success: boolean; gatewayTransactionId?: string; error?: string; }
async function initiateAuthorization(amountSmallestUnit: number, currencyCode: string, customerId: string, paymentMethod: string, boxId: string, description: string): Promise<AuthResult> { logger.info(`[Mock Payment] Authorizing DEPOSIT ${amountSmallestUnit} ${currencyCode} for user ${customerId} via ${paymentMethod} for box ${boxId} - ${description}`); await new Promise(res => setTimeout(res, 1000)); if (Math.random() < 0.05) { logger.error("[Mock Payment] Auth FAILED."); return { success: false, error: "Mock Auth Declined" }; } return { success: true, gatewayTransactionId: `AUTH_${Date.now()}` }; }
async function voidAuthorization(gatewayTransactionId: string): Promise<{ success: boolean; error?: string }> { logger.info(`[Mock Payment] Voiding Auth ${gatewayTransactionId}`); await new Promise(res => setTimeout(res, 500)); if (gatewayTransactionId.includes("fail_void")) { logger.error("[Mock Payment] Void FAILED."); return { success: false, error: "Mock Void Failed" }; } return { success: true }; }
interface OperatingHours { /* Define structure */ }
function checkOperatingHours(operatingHours: OperatingHours | undefined | null, checkTime: Date, timeZone?: string): boolean { logger.info(`[Mock Time Check] Checking operating hours (Mock: always true)`); return true; }
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
interface MatRentalSettings { /* Define needed settings */ }
async function fetchMatRentalSettings(): Promise<MatRentalSettings | null> { logger.info(`[Mock Config] Fetching mat rental settings`); return {}; }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Box, RentalItem, User not found
    FailedPrecondition = "FAILED_PRECONDITION", // Box inactive, Item inactive, Box closed
    Aborted = "ABORTED", // Transaction failed or Payment Auth failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BoxNotFound = "BOX_NOT_FOUND", BoxInactive = "BOX_INACTIVE", BoxClosed = "BOX_CLOSED",
    RentalItemNotFound = "RENTAL_ITEM_NOT_FOUND", RentalItemInactive = "RENTAL_ITEM_INACTIVE",
    UserNotFound = "USER_NOT_FOUND",
    PaymentAuthFailed = "PAYMENT_AUTH_FAILED", PaymentVoidFailed = "PAYMENT_VOID_FAILED", // If void is attempted on failure
    TransactionFailed = "TRANSACTION_FAILED",
    InventoryUnavailable = "INVENTORY_UNAVAILABLE", // Added for rental inventory check
}

// --- Interfaces ---
interface CreateRentalBookingInput {
    rentalItemId: string;
    pickupBoxId: string;
    // Assuming payment method is implicitly the user's default or handled client-side for token
    // paymentMethodToken?: string; // Optional: if client provides a specific token
    expectedReturnTimestamp?: string | null; // ISO String, optional for now
}

// --- The Cloud Function ---
export const createRentalBooking = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory for multiple reads/writes/transaction
        timeoutSeconds: 60,
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // Add secrets if needed
    },
    async (request): Promise<{ success: true; bookingId: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createRentalBooking V1]";
        const startTime = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const customerId = request.auth.uid;
        const data = request.data as CreateRentalBookingInput;
        const logContext: any = { customerId, rentalItemId: data?.rentalItemId, pickupBoxId: data?.pickupBoxId };

        logger.info(`${functionName} Invoked.`, logContext);

        // Basic Permission Check
        const hasPermission = await checkPermission(customerId, 'rental:create');
        if (!hasPermission) {
            logger.warn(`${functionName} Permission denied for user ${customerId}.`, logContext);
            return { success: false, error: "error.permissionDenied.createRental", errorCode: ErrorCode.PermissionDenied };
        }

        // 2. Input Validation
        if (!data?.rentalItemId || typeof data.rentalItemId !== 'string' ||
            !data.pickupBoxId || typeof data.pickupBoxId !== 'string' ||
            (data.expectedReturnTimestamp != null && typeof data.expectedReturnTimestamp !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { rentalItemId, pickupBoxId } = data;
        let expectedReturnTimestamp: Timestamp | null = null;
        if (data.expectedReturnTimestamp) {
             try {
                 const parsedDate = new Date(data.expectedReturnTimestamp);
                 if (!isNaN(parsedDate.getTime())) {
                     expectedReturnTimestamp = Timestamp.fromDate(parsedDate);
                 } else {
                      throw new Error("Invalid date format");
                 }
             } catch (e: any) {
                 logger.error(`${functionName} Invalid expectedReturnTimestamp format.`, { timestamp: data.expectedReturnTimestamp, error: e.message });
                 return { success: false, error: "error.invalidInput.returnTimestamp", errorCode: ErrorCode.InvalidArgument };
             }
        }


        // --- Variables ---
        let boxData: Box;
        let userData: User;
        let rentalItemData: RentalItem;
        let authResult: AuthResult | null = null;
        let finalPaymentStatus: PaymentStatus;
        let finalBookingStatus: RentalBookingStatus;

        try {
            // 3. Pre-Transaction Data Fetching & Validation (Concurrent)
            logger.info(`${functionName} Fetching initial data...`, logContext);
            const boxRef = db.collection('boxes').doc(pickupBoxId);
            const userRef = db.collection('users').doc(customerId);
            const rentalItemRef = db.collection('rentalItems').doc(rentalItemId);
            // Fetch settings if needed (e.g., default rental duration)
            // const settingsPromise = fetchMatRentalSettings();

            const [boxSnap, userSnap, rentalItemSnap] = await Promise.all([
                boxRef.get(),
                userRef.get(),
                rentalItemRef.get(),
                // settingsPromise
            ]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });

            // Validate Box
            if (!boxSnap.exists) throw new HttpsError('not-found', `error.box.notFound::${pickupBoxId}`, { errorCode: ErrorCode.BoxNotFound });
            boxData = boxSnap.data() as Box;
            if (!boxData.isActive) throw new HttpsError('failed-precondition', `error.box.inactive::${pickupBoxId}`, { errorCode: ErrorCode.BoxInactive });
            // Check if box is currently open
            if (!checkOperatingHours(boxData.operatingHours, new Date())) {
                 throw new HttpsError('failed-precondition', `error.box.closed::${pickupBoxId}`, { errorCode: ErrorCode.BoxClosed });
            }

            // Validate Rental Item
            if (!rentalItemSnap.exists) throw new HttpsError('not-found', `error.rentalItem.notFound::${rentalItemId}`, { errorCode: ErrorCode.RentalItemNotFound });
            rentalItemData = rentalItemSnap.data() as RentalItem;
            if (!rentalItemData.isActive) throw new HttpsError('failed-precondition', `error.rentalItem.inactive::${rentalItemId}`, { errorCode: ErrorCode.RentalItemInactive });

            // Get deposit amount and currency
            const depositAmount = rentalItemData.depositSmallestUnit;
            const currencyCode = rentalItemData.currencyCode ?? boxData.currencyCode ?? 'ILS'; // Prioritize item currency, then box, then default
            logContext.depositAmount = depositAmount;
            logContext.currencyCode = currencyCode;

            if (typeof depositAmount !== 'number' || depositAmount < 0) {
                 throw new HttpsError('internal', `error.internal.invalidDepositAmount::${rentalItemId}`);
            }

            // 4. Payment Authorization (Deposit)
            if (depositAmount > 0) {
                logger.info(`${functionName} Initiating deposit authorization for ${depositAmount} ${currencyCode}...`, logContext);
                // Assume default payment method or client provides token
                const paymentMethodForAuth = "CreditCardApp"; // Placeholder - needs logic to get user's method or use token
                authResult = await initiateAuthorization(depositAmount, currencyCode, customerId, paymentMethodForAuth, pickupBoxId, `Deposit for ${rentalItemData.itemName_i18n?.['en'] ?? rentalItemId}`);

                if (!authResult.success || !authResult.gatewayTransactionId) {
                    logger.error(`${functionName} Deposit authorization failed.`, { ...logContext, error: authResult.error });
                    // Set statuses to reflect failure before throwing
                    finalBookingStatus = RentalBookingStatus.DepositFailed;
                    finalPaymentStatus = PaymentStatus.Failed;
                    // We might still create the booking in a failed state, or just throw
                    throw new HttpsError('aborted', `error.payment.authFailed::${authResult.error || 'Unknown'}`, { errorCode: ErrorCode.PaymentAuthFailed });
                }
                logger.info(`${functionName} Deposit authorization successful. TxID: ${authResult.gatewayTransactionId}`, logContext);
                finalBookingStatus = RentalBookingStatus.DepositAuthorized; // Ready for pickup step
                finalPaymentStatus = PaymentStatus.Authorized;
            } else {
                logger.info(`${functionName} No deposit required for item ${rentalItemId}.`, logContext);
                finalBookingStatus = RentalBookingStatus.AwaitingPickup; // No deposit needed, ready for pickup
                finalPaymentStatus = PaymentStatus.Pending; // No payment action occurred
            }


            // 5. Firestore Transaction
            logger.info(`${functionName} Starting Firestore transaction...`, logContext);
            const newBookingId = db.collection('rentalBookings').doc().id;
            const bookingRef = db.collection('rentalBookings').doc(newBookingId);
            const now = Timestamp.now();

            await db.runTransaction(async (transaction) => {
                // Read data within transaction for consistency checks
                const boxTxSnap = await transaction.get(boxRef);
                const rentalItemTxSnap = await transaction.get(rentalItemRef);

                if (!boxTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}`);
                const boxTxData = boxTxSnap.data() as Box;
                if (!boxTxData.isActive) throw new Error(`TX_ERR::${ErrorCode.BoxInactive}`);
                // Re-check operating hours? Might be overkill if TX is fast.

                if (!rentalItemTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.RentalItemNotFound}`);
                const rentalItemTxData = rentalItemTxSnap.data() as RentalItem;
                if (!rentalItemTxData.isActive) throw new Error(`TX_ERR::${ErrorCode.RentalItemInactive}`);

                // Check Inventory (Crucial Step!)
                // Assuming inventory is stored like: box.rentalInventory = { "mat_standard": 5, "mat_large": 2 }
                const currentStock = boxTxData.rentalInventory?.[rentalItemId] ?? 0;
                if (currentStock <= 0) {
                    logger.warn(`${functionName} TX Check: No inventory for item ${rentalItemId} in box ${pickupBoxId}.`, logContext);
                    throw new Error(`TX_ERR::${ErrorCode.InventoryUnavailable}::${rentalItemId}`);
                }
                const inventoryUpdate = { [`rentalInventory.${rentalItemId}`]: FieldValue.increment(-1) };


                // Prepare Booking Document Data
                const newBookingData: RentalBooking = {
                    customerId: customerId,
                    rentalItemId: rentalItemId,
                    bookingStatus: finalBookingStatus, // DepositAuthorized or AwaitingPickup
                    pickupBoxId: pickupBoxId,
                    // returnBoxId: null, // Set on return
                    // pickupCourierId: null, // Set on pickup
                    // returnCourierId: null, // Set on return
                    // pickupTimestamp: null, // Set on pickup
                    expectedReturnTimestamp: expectedReturnTimestamp, // Optional, from input
                    // actualReturnTimestamp: null, // Set on return
                    // returnedCondition: null, // Set on return
                    rentalFeeSmallestUnit: rentalItemData.rentalFeeSmallestUnit, // Snapshot fee
                    depositSmallestUnit: rentalItemData.depositSmallestUnit, // Snapshot deposit
                    currencyCode: currencyCode,
                    paymentStatus: finalPaymentStatus, // Authorized or Pending
                    paymentDetails: authResult?.success ? { // Store successful auth details
                        gatewayTransactionId: authResult.gatewayTransactionId,
                        authAmountSmallestUnit: depositAmount,
                        authTimestamp: now,
                        authSuccess: true,
                        currencyCode: currencyCode,
                        // gatewayName: 'MockGateway'
                    } : null,
                    // finalChargeSmallestUnit: null, // Set after return
                    // overtimeFeeChargedSmallestUnit: null,
                    // cleaningFeeChargedSmallestUnit: null,
                    // damageFeeChargedTotalSmallestUnit: null,
                    depositProcessed: false, // Mark as not yet processed by background function
                    // processingError: null,
                    createdAt: now,
                    updatedAt: now,
                };

                // --- Perform Writes ---
                // 1. Create Rental Booking
                transaction.set(bookingRef, newBookingData);
                // 2. Update Box Inventory
                transaction.update(boxRef, inventoryUpdate);

            }); // End Firestore Transaction

            logger.info(`${functionName} Firestore transaction successful for booking ${newBookingId}.`, logContext);

            // 6. Trigger Notifications (Async) - e.g., to customer confirming booking
            sendPushNotification({
                userId: customerId, type: "RentalBookingCreated", titleKey: "notification.rentalCreated.title",
                messageKey: "notification.rentalCreated.message", messageParams: { itemName: rentalItemData.itemName_i18n?.['en'] ?? rentalItemId },
                payload: { bookingId: newBookingId, screen: 'RentalDetails' }
            }).catch(err => logger.error("Failed sending customer notification", { err }));

            // 7. Log User Activity (Async)
            logUserActivity("CreateRentalBooking", { bookingId: newBookingId, rentalItemId, pickupBoxId, depositAmount, authSuccess: authResult?.success ?? (depositAmount === 0) }, customerId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 8. Return Success
            return { success: true, bookingId: newBookingId };

        } catch (error: any) {
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });

            // --- Error Handling & Cleanup ---
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.rental.creationFailed";

            if (error instanceof HttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.rental.${finalErrorCode.toLowerCase()}`;
                if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            } else if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            }

            // Attempt to void authorization if it succeeded but transaction failed
            if (authResult?.success && authResult.gatewayTransactionId) {
                logger.warn(`${functionName} Transaction failed after successful auth. Attempting to void authorization ${authResult.gatewayTransactionId}...`, logContext);
                try {
                    const voidResult = await voidAuthorization(authResult.gatewayTransactionId);
                    if (!voidResult.success) {
                        logger.error(`${functionName} CRITICAL: Failed to void authorization ${authResult.gatewayTransactionId} after transaction failure. Manual void required.`, { ...logContext, voidError: voidResult.error });
                        // Alert Admin!
                        sendPushNotification({ subject: `Payment Void FAILED - Rental Booking Attempt ${logContext.pickupBoxId}`, body: `Failed to void auth ${authResult.gatewayTransactionId} for failed rental booking attempt. Manual void REQUIRED.`, severity: "critical" }).catch(...);
                        finalErrorCode = ErrorCode.PaymentVoidFailed; // Override error code
                        finalErrorMessageKey = "error.payment.voidFailed";
                    } else {
                        logger.info(`${functionName} Successfully voided authorization ${authResult.gatewayTransactionId}.`, logContext);
                    }
                } catch (voidError: any) {
                    logger.error(`${functionName} CRITICAL: Error during void attempt for ${authResult.gatewayTransactionId}. Manual void likely required.`, { ...logContext, voidError: voidError?.message });
                    finalErrorCode = ErrorCode.PaymentVoidFailed;
                    finalErrorMessageKey = "error.payment.voidFailed";
                }
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTime}ms`, logContext);
        }
    }
);
