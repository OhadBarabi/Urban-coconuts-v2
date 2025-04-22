import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

// --- Import Models ---
import {
    RentalBooking, RentalBookingStatus, PaymentStatus, PaymentDetails, RentalItem, AppConfigMatRentalSettings
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { finalizeAuthorization } from '../utils/payment_helpers'; // Handles Capture/Void/Partial Capture
// import { sendPushNotification } from '../utils/notifications';
// import { logAdminAction } from '../utils/logging'; // Log critical errors/actions
// import { fetchMatRentalSettings } from '../config/config_helpers';

// --- Mocks for required helper functions (Replace with actual implementations) ---
interface FinalizeResult { success: boolean; transactionId?: string; finalAmountCharged?: number; error?: string; }
async function finalizeAuthorization(authTxId: string, finalAmountSmallestUnit: number, originalAmountSmallestUnit: number, currency: string, orderId: string): Promise<FinalizeResult> {
    logger.info(`[Mock Payment] Finalizing Auth ${authTxId} for order ${orderId}: Original=${originalAmountSmallestUnit}, Final=${finalAmountSmallestUnit} ${currency}`);
    await new Promise(res => setTimeout(res, 1500));
    if (finalAmountSmallestUnit < 0) { // Should not happen with logic below, but good check
        return { success: false, error: "Final amount cannot be negative" };
    }
    if (authTxId.includes("fail_finalize")) {
        logger.error("[Mock Payment] Finalize FAILED (Capture/Void).");
        return { success: false, error: "Mock Finalize Failed" };
    }
    if (finalAmountSmallestUnit === 0) {
        logger.info("[Mock Payment] Final amount is 0, performing Void.");
        return { success: true, transactionId: `VOID_${Date.now()}`, finalAmountCharged: 0 };
    } else if (finalAmountSmallestUnit < originalAmountSmallestUnit) {
        logger.info(`[Mock Payment] Final amount less than original, performing Partial Capture/Refund (Simulating Capture ${finalAmountSmallestUnit}).`);
        return { success: true, transactionId: `PCAP_${Date.now()}`, finalAmountCharged: finalAmountSmallestUnit };
    } else { // finalAmountSmallestUnit >= originalAmountSmallestUnit (Capture full or more? Cap at original for deposit)
        const captureAmount = Math.min(finalAmountSmallestUnit, originalAmountSmallestUnit); // Cap capture at original deposit auth
        logger.info(`[Mock Payment] Final amount >= original, performing Capture ${captureAmount}.`);
        return { success: true, transactionId: `CAP_${Date.now()}`, finalAmountCharged: captureAmount };
    }
}
interface AdminAlertParams { subject: string; body: string; bookingId?: string; severity: "critical" | "warning" | "info"; }
async function sendPushNotification(params: AdminAlertParams): Promise<void> { logger.info(`[Mock Notification] Sending ADMIN ALERT (${params.severity})`, params); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
async function fetchMatRentalSettings(): Promise<AppConfigMatRentalSettings | null> { logger.info(`[Mock Config] Fetching mat rental settings`); return { overtimeIntervalMinutes: 60, overtimeFeeSmallestUnit: 500, cleaningFeeSmallestUnit: 1000 }; }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

const functionConfig = {
    region: FUNCTION_REGION,
    memory: "512MiB" as const, // Allow memory for calculations and payment interaction
    timeoutSeconds: 120, // Allow time for payment processing
    // ** IMPORTANT: Configure Pub/Sub retries & DLQ for this topic **
    // secrets: ["PAYMENT_GATEWAY_SECRET"], // If finalizeAuthorization needs secret
};

// Ensure this matches the Pub/Sub topic triggered by confirmRentalReturn
const PUBSUB_TOPIC = "handle-rental-deposit"; // <<<--- CHANGE TO YOUR TOPIC NAME

// --- Enums ---
enum ErrorCode {
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not ReturnedPendingInspection
    MissingPaymentDetails = "MISSING_PAYMENT_DETAILS", // No auth Tx ID or amount
    RentalItemNotFound = "RENTAL_ITEM_NOT_FOUND", // Needed for fee calculation
    PaymentFinalizationFailed = "PAYMENT_FINALIZATION_FAILED", // Capture/Void failed
    InternalError = "INTERNAL_ERROR",
}

// --- The Cloud Function (Pub/Sub Triggered - V2) ---
export const handleRentalDeposit = functions.pubsub
    .topic(PUBSUB_TOPIC)
    .onMessagePublished(
        {
            ...functionConfig,
            // Ensure Pub/Sub Subscription has retry policy and Dead Letter Topic configured!
        },
        async (message): Promise<void> => {
            const functionName = "[handleRentalDeposit V1]";
            const startTimeFunc = Date.now();
            const messageId = message.id;

            let bookingId: string;
            let bookingRef: admin.firestore.DocumentReference;
            const logContext: any = { messageId };

            try {
                // 1. Extract bookingId & Fetch Booking
                if (!message.json?.bookingId || typeof message.json.bookingId !== 'string') {
                    logger.error(`${functionName} Invalid Pub/Sub payload: Missing/invalid 'bookingId'. ACK.`, { messageData: message.json, messageId });
                    return; // ACK bad format
                }
                bookingId = message.json.bookingId;
                logContext.bookingId = bookingId;
                logger.info(`${functionName} Invoked for booking ${bookingId}`, logContext);

                bookingRef = db.collection('rentalBookings').doc(bookingId);
                const bookingSnap = await bookingRef.get();

                if (!bookingSnap.exists) {
                    logger.error(`${functionName} Booking ${bookingId}: Not found. ACK.`, logContext);
                    return; // ACK - booking deleted?
                }
                const bookingData = bookingSnap.data() as RentalBooking;
                logContext.currentBookingStatus = bookingData.bookingStatus;
                logContext.customerId = bookingData.customerId;
                logContext.rentalItemId = bookingData.rentalItemId;

                // 2. Validate Status & Idempotency
                // Expecting 'ReturnedPendingInspection' status set by confirmRentalReturn
                if (bookingData.bookingStatus !== RentalBookingStatus.ReturnedPendingInspection) {
                    logger.warn(`${functionName} Booking ${bookingId}: Invalid status '${bookingData.bookingStatus}'. Expected '${RentalBookingStatus.ReturnedPendingInspection}'. ACK.`, logContext);
                    // Check if already processed to avoid double processing
                    if (bookingData.bookingStatus === RentalBookingStatus.Completed || bookingData.bookingStatus === RentalBookingStatus.AwaitingFinalPayment || bookingData.bookingStatus === RentalBookingStatus.PaymentFailed) {
                        logger.info(`${functionName} Booking ${bookingId} seems already processed or pending payment. ACK.`);
                        return; // ACK - Already handled or in payment state
                    }
                    // If in another unexpected state, maybe log error but ACK to avoid infinite retries
                    logger.error(`${functionName} Booking ${bookingId} in unexpected state ${bookingData.bookingStatus} for deposit handling. ACK.`);
                    return;
                }
                if (bookingData.depositProcessed === true) {
                     logger.info(`${functionName} Booking ${bookingId}: Deposit already marked as processed. ACK.`, logContext);
                     return; // ACK - Idempotency check
                }

                // 3. Get Necessary Data for Calculation
                const {
                    rentalItemId,
                    pickupTimestamp,
                    actualReturnTimestamp,
                    returnedCondition,
                    rentalFeeSmallestUnit,
                    depositSmallestUnit,
                    currencyCode,
                    paymentDetails,
                    paymentStatus,
                } = bookingData;

                // Validate essential data
                if (!rentalItemId || !pickupTimestamp || !actualReturnTimestamp || !rentalFeeSmallestUnit || !depositSmallestUnit || !currencyCode) {
                    logger.error(`${functionName} Booking ${bookingId}: Missing critical data for fee calculation. Setting to RequiresManualReview.`, { ...logContext, bookingData });
                    await bookingRef.update({ bookingStatus: RentalBookingStatus.RequiresManualReview, processingError: "Missing essential data for final calculation.", updatedAt: FieldValue.serverTimestamp() }).catch(err => logger.error("Failed update to RequiresManualReview", { err }));
                    sendPushNotification({ subject: `Rental Calc Failed (Data Missing) - Booking ${bookingId}`, body: `Final calculation for rental ${bookingId} failed due to missing data. Manual review required.`, bookingId, severity: "critical" }).catch(...);
                    return; // ACK
                }

                // Check if payment was authorized (needed for finalize)
                const originalAuthTxId = paymentDetails?.gatewayTransactionId;
                const originalAuthAmount = paymentDetails?.authAmountSmallestUnit;
                if (paymentStatus !== PaymentStatus.Authorized || !originalAuthTxId || originalAuthAmount !== depositSmallestUnit) {
                     logger.error(`${functionName} Booking ${bookingId}: Payment status is not 'Authorized' or deposit auth details are missing/incorrect. Cannot finalize. Setting to RequiresManualReview.`, { ...logContext, paymentStatus, paymentDetails });
                     await bookingRef.update({ bookingStatus: RentalBookingStatus.RequiresManualReview, processingError: "Missing or incorrect deposit authorization details.", updatedAt: FieldValue.serverTimestamp() }).catch(err => logger.error("Failed update to RequiresManualReview", { err }));
                     sendPushNotification({ subject: `Rental Calc Failed (Payment Auth) - Booking ${bookingId}`, body: `Cannot finalize payment for rental ${bookingId} due to missing/incorrect deposit auth details. Manual review required.`, bookingId, severity: "critical" }).catch(...);
                     return; // ACK
                }

                // 4. Fetch Settings & Item Data (Needed for fees)
                const settingsPromise = fetchMatRentalSettings();
                const itemRef = db.collection('rentalItems').doc(rentalItemId);
                const [settings, itemSnap] = await Promise.all([settingsPromise, itemRef.get()]);

                if (!itemSnap.exists) {
                     logger.error(`${functionName} Booking ${bookingId}: Rental Item ${rentalItemId} not found. Setting to RequiresManualReview.`, logContext);
                     await bookingRef.update({ bookingStatus: RentalBookingStatus.RequiresManualReview, processingError: `Rental item ${rentalItemId} not found.`, updatedAt: FieldValue.serverTimestamp() }).catch(err => logger.error("Failed update to RequiresManualReview", { err }));
                     sendPushNotification({ subject: `Rental Calc Failed (Item Missing) - Booking ${bookingId}`, body: `Cannot calculate final fees for rental ${bookingId} because item ${rentalItemId} was not found. Manual review required.`, bookingId, severity: "critical" }).catch(...);
                     return; // ACK
                }
                const itemData = itemSnap.data() as RentalItem;

                // 5. Calculate Final Amount (Rental Fee + Penalties)
                logger.info(`${functionName} Booking ${bookingId}: Calculating final amount...`, logContext);
                let finalChargeSmallestUnit = rentalFeeSmallestUnit; // Start with base rental fee
                let overtimeFee = 0;
                let cleaningFee = 0;
                let damageFee = 0; // Assume damage fee needs manual assessment/setting

                // Calculate Overtime Fee
                const overtimeIntervalMinutes = settings?.overtimeIntervalMinutes ?? 60; // e.g., 60 minutes
                const overtimeFeeRate = settings?.overtimeFeeSmallestUnit ?? 0; // Fee per interval
                if (bookingData.expectedReturnTimestamp && actualReturnTimestamp > bookingData.expectedReturnTimestamp && overtimeFeeRate > 0 && overtimeIntervalMinutes > 0) {
                    const overdueMillis = actualReturnTimestamp.toMillis() - bookingData.expectedReturnTimestamp.toMillis();
                    const overdueIntervals = Math.ceil(overdueMillis / (overtimeIntervalMinutes * 60 * 1000));
                    overtimeFee = overdueIntervals * overtimeFeeRate;
                    finalChargeSmallestUnit += overtimeFee;
                    logger.info(`Overtime detected: ${overdueIntervals} intervals. Fee: ${overtimeFee}`, logContext);
                }

                // Calculate Cleaning Fee
                const cleaningFeeRate = settings?.cleaningFeeSmallestUnit ?? 0;
                if (returnedCondition === "Dirty" && cleaningFeeRate > 0) {
                    cleaningFee = cleaningFeeRate;
                    finalChargeSmallestUnit += cleaningFee;
                    logger.info(`Cleaning fee applied: ${cleaningFee}`, logContext);
                }

                // Handle Damage Fee (Assume set manually later or a fixed fee from item?)
                // For now, we assume damage means full deposit might be kept, pending review?
                // Let's cap the charge at the deposit amount if damaged for now.
                if (returnedCondition === "Damaged") {
                     // Option 1: Cap charge at deposit amount
                     finalChargeSmallestUnit = Math.min(finalChargeSmallestUnit, depositSmallestUnit);
                     damageFee = finalChargeSmallestUnit - rentalFeeSmallestUnit - overtimeFee - cleaningFee; // Calculate implied damage fee
                     logger.warn(`Item returned damaged. Capping final charge at deposit amount: ${depositSmallestUnit}. Implied damage fee: ${damageFee}. Requires review.`, logContext);
                     // Option 2: Set status to RequiresManualReview for damage?
                }

                // Ensure final charge is not negative
                finalChargeSmallestUnit = Math.max(0, finalChargeSmallestUnit);

                logContext.finalCharge = finalChargeSmallestUnit;
                logger.info(`${functionName} Booking ${bookingId}: Final calculated charge: ${finalChargeSmallestUnit} ${currencyCode}`, logContext);

                // 6. Finalize Payment (Capture/Void/Partial Capture)
                logger.info(`${functionName} Booking ${bookingId}: Finalizing payment authorization ${originalAuthTxId}...`, logContext);
                const finalizeResult = await finalizeAuthorization(
                    originalAuthTxId,
                    finalChargeSmallestUnit, // Amount to actually charge/capture
                    depositSmallestUnit,    // Original authorized amount
                    currencyCode,
                    bookingId
                );

                // 7. Update Booking based on Finalization Result
                const now = Timestamp.now();
                const finalUpdate: Partial<RentalBooking> & { updatedAt: admin.firestore.FieldValue } = {
                    updatedAt: FieldValue.serverTimestamp(),
                    depositProcessed: true, // Mark as processed
                    finalChargeSmallestUnit: finalChargeSmallestUnit,
                    overtimeFeeChargedSmallestUnit: overtimeFee > 0 ? overtimeFee : null,
                    cleaningFeeChargedSmallestUnit: cleaningFee > 0 ? cleaningFee : null,
                    damageFeeChargedTotalSmallestUnit: damageFee > 0 ? damageFee : null, // Store calculated damage fee
                    processingError: null, // Clear previous errors
                };

                if (finalizeResult.success) {
                    logger.info(`${functionName} Booking ${bookingId}: Payment finalization successful. TxID: ${finalizeResult.transactionId}, Amount Charged: ${finalizeResult.finalAmountCharged}`, logContext);
                    finalUpdate.bookingStatus = RentalBookingStatus.Completed; // Final success state
                    finalUpdate.paymentStatus = (finalizeResult.finalAmountCharged ?? 0) > 0 ? PaymentStatus.Paid : PaymentStatus.Voided; // Or Refunded if partial? Use Paid/Voided for now.
                    finalUpdate.paymentDetails = { // Update payment details
                        ...(bookingData.paymentDetails ?? {}), // Keep auth info
                        settlementTimestamp: now,
                        settlementTransactionId: finalizeResult.transactionId,
                        settlementAmountSmallestUnit: finalizeResult.finalAmountCharged,
                        settlementSuccess: true,
                        settlementError: null,
                    };
                    logAdminAction("HandleRentalDepositSuccess", { bookingId, finalCharge: finalChargeSmallestUnit, deposit: depositSmallestUnit, outcome: finalUpdate.paymentStatus });

                    // Trigger invoice generation on success
                    // generateEventInvoice({ bookingId }).catch(err => logger.error(`Failed invoice trigger for ${bookingId}`, {err}));

                } else { // Finalization Failed
                    logger.error(`${functionName} Booking ${bookingId}: Payment finalization FAILED. Setting to RequiresManualReview.`, { ...logContext, error: finalizeResult.error });
                    finalUpdate.bookingStatus = RentalBookingStatus.RequiresManualReview; // Error state
                    finalUpdate.paymentStatus = (finalChargeSmallestUnit > 0) ? PaymentStatus.CaptureFailed : PaymentStatus.VoidFailed;
                    finalUpdate.processingError = `Payment Finalization Failed: ${finalizeResult.error || 'Unknown gateway error'}`;
                    finalUpdate.paymentDetails = { // Update payment details with failure
                        ...(bookingData.paymentDetails ?? {}),
                        settlementTimestamp: now,
                        settlementSuccess: false,
                        settlementError: finalizeResult.error || 'Unknown gateway error',
                    };
                    logAdminAction("HandleRentalDepositFailed", { bookingId, finalCharge: finalChargeSmallestUnit, deposit: depositSmallestUnit, reason: finalizeResult.error });
                    // Send Admin Alert
                    sendPushNotification({ subject: `Rental Payment Finalization FAILED - Booking ${bookingId}`, body: `Failed to finalize payment (Capture/Void) for rental ${bookingId}. Auth Tx: ${originalAuthTxId}. Reason: ${finalizeResult.error}. MANUAL ACTION REQUIRED.`, bookingId, severity: "critical" }).catch(...);
                    // Throw error to potentially trigger Pub/Sub retry? Or just ACK? Let's ACK to avoid loops if gateway issue persists.
                    // throw new Error(ErrorCode.PaymentFinalizationFailed);
                }

                await bookingRef.update(finalUpdate);
                logger.info(`${functionName} Booking ${bookingId}: Final Firestore update complete. Status: ${finalUpdate.bookingStatus}`);

            } catch (error: any) {
                // 8. Handle Internal Function Errors
                const errorMessage = error.message || "An unknown internal error occurred.";
                const errorCode = Object.values(ErrorCode).includes(errorMessage as ErrorCode) ? errorMessage as ErrorCode : ErrorCode.InternalError;
                logger.error(`${functionName} Booking ${bookingId}: Unhandled internal error. Error Code: ${errorCode}`, { error: errorMessage, messageId });

                // Attempt to update booking status to RequiresManualReview
                try {
                    if (bookingId) { // Ensure bookingId is defined
                        await db.collection('rentalBookings').doc(bookingId).update({
                            bookingStatus: RentalBookingStatus.RequiresManualReview,
                            processingError: `Internal function error (${errorCode}): ${errorMessage.substring(0, 200)}`,
                            updatedAt: FieldValue.serverTimestamp()
                        });
                    }
                } catch (updateError: any) {
                    logger.error(`${functionName} Booking ${bookingId}: FAILED to update booking status after internal error.`, { updateError });
                }
                logAdminAction("HandleRentalDepositFailedInternal", { bookingId: bookingId || 'Unknown', messageId: messageId, errorMessage: errorMessage, errorCode: errorCode }).catch(...);
                // Throw the original error to trigger Pub/Sub retries for internal errors
                throw error;
            }
            // Successful completion implicitly ACKs the message
             logger.info(`${functionName} Execution finished for booking ${bookingId}. Duration: ${Date.now() - startTimeFunc}ms`, { messageId });

        }); // End onMessagePublished
