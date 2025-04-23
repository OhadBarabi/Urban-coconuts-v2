import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https"; // Might not be needed for background func

// --- Import Models ---
import {
    RentalBooking, RentalBookingStatus, PaymentStatus, PaymentDetails
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { processPaymentCapture, voidAuthorization, extractPaymentDetailsFromResult } from '../utils/payment_helpers'; // <-- Import from new helper
// import { calculateRentalFinalCharge } from '../utils/rental_calculations'; // Still using mock below
// import { logSystemActivity } from '../utils/logging'; // Using mock below

// --- Mocks for required helper functions (Replace with actual implementations) ---
// processPaymentCapture and voidAuthorization are now imported from the helper
interface FinalChargeResult { totalCharge: number; overtimeFee: number; cleaningFee: number; damageFee: number; error?: string; }
function calculateRentalFinalCharge(booking: RentalBooking): FinalChargeResult {
    logger.info(`[Mock Calc] Calculating final charge for booking ${booking.bookingId}...`);
    const overtimeFee = booking.expectedReturnTimestamp && booking.actualReturnTimestamp && booking.actualReturnTimestamp > booking.expectedReturnTimestamp ? 500 : 0; // Mock 5 ILS overtime
    const cleaningFee = booking.returnedCondition === 'Dirty' ? 1000 : 0; // Mock 10 ILS cleaning
    const damageFee = booking.returnedCondition === 'Damaged' ? 2500 : 0; // Mock 25 ILS damage
    const totalCharge = overtimeFee + cleaningFee + damageFee;
    logger.info(`[Mock Calc] Fees - Overtime: ${overtimeFee}, Cleaning: ${cleaningFee}, Damage: ${damageFee}. Total: ${totalCharge}`);
    // Ensure total charge doesn't exceed the original deposit amount?
    const depositAmount = booking.depositSmallestUnit ?? 0;
    const finalChargeCapped = Math.min(totalCharge, depositAmount);
    if (finalChargeCapped < totalCharge) {
        logger.warn(`[Mock Calc] Calculated charge (${totalCharge}) exceeds deposit (${depositAmount}). Capping charge at deposit amount.`);
    }
    return { totalCharge: finalChargeCapped, overtimeFee, cleaningFee, damageFee };
}
async function logSystemActivity(actionType: string, details: object): Promise<void> { logger.info(`[Mock System Log] Action: ${actionType}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const RENTAL_DEPOSIT_TOPIC = "rental-deposit-processing"; // Example Pub/Sub topic name

// --- Enums ---
enum ErrorCode {
    NotFound = "NOT_FOUND", // Booking not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status, already processed
    Aborted = "ABORTED", // Payment Capture/Void failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not 'Returned'
    DepositAlreadyProcessed = "DEPOSIT_ALREADY_PROCESSED",
    MissingPaymentInfo = "MISSING_PAYMENT_INFO", // Missing authId
    CalculationError = "CALCULATION_ERROR",
    PaymentCaptureFailed = "PAYMENT_CAPTURE_FAILED",
    PaymentVoidFailed = "PAYMENT_VOID_FAILED",
}

// --- Interfaces ---
// Message payload expected from Pub/Sub (or direct trigger)
interface DepositProcessingPayload {
    bookingId: string;
}

// --- The Background Function (Triggered by Pub/Sub) ---
// Note: Using Pub/Sub allows decoupling and retries. Alternatively, trigger directly from confirmRentalReturn.
export const handleRentalDeposit = functions.pubsub.topic(RENTAL_DEPOSIT_TOPIC)
    .region(FUNCTION_REGION)
    .onPublish(async (message): Promise<void> => {
        const functionName = "[handleRentalDeposit V2 - Refactored]";
        const startTimeFunc = Date.now();

        let bookingId: string | null = null;
        let logContext: any = { functionName, trigger: "Pub/Sub", topic: RENTAL_DEPOSIT_TOPIC };

        try {
            // 1. Parse Message Payload
            let payload: DepositProcessingPayload;
            try {
                payload = message.json as DepositProcessingPayload;
                bookingId = payload.bookingId;
                if (!bookingId) throw new Error("Missing bookingId in Pub/Sub message payload.");
                logContext.bookingId = bookingId;
                logger.info(`${functionName} Received request to process deposit.`, logContext);
            } catch (e: any) {
                logger.error(`${functionName} Failed to parse Pub/Sub message.`, { error: e.message, data: message.data ? Buffer.from(message.data, 'base64').toString() : null });
                // Acknowledge the message to prevent retries for invalid format
                return;
            }

            // 2. Fetch Rental Booking Data
            const bookingRef = db.collection('rentalBookings').doc(bookingId);
            const bookingSnap = await bookingRef.get();

            if (!bookingSnap.exists) {
                logger.error(`${functionName} Rental booking ${bookingId} not found.`, logContext);
                // Acknowledge the message - can't process a non-existent booking
                return;
            }
            const bookingData = bookingSnap.data() as RentalBooking;
            logContext.currentStatus = bookingData.bookingStatus;
            logContext.paymentStatus = bookingData.paymentStatus;
            logContext.depositProcessed = bookingData.depositProcessed;
            logContext.authId = bookingData.paymentDetails?.authorizationId;

            // 3. State Validation
            if (bookingData.bookingStatus !== RentalBookingStatus.Returned) {
                logger.warn(`${functionName} Booking ${bookingId} is not in 'Returned' status (current: ${bookingData.bookingStatus}). Skipping deposit processing.`, logContext);
                // Acknowledge - not ready to process yet or wrong trigger
                return;
            }
            if (bookingData.depositProcessed === true) {
                logger.warn(`${functionName} Deposit for booking ${bookingId} has already been processed. Skipping.`, logContext);
                // Acknowledge - already done
                return;
            }
            if (bookingData.paymentStatus !== PaymentStatus.Authorized) {
                 logger.error(`${functionName} Cannot process deposit for booking ${bookingId}: Payment status is not 'Authorized' (current: ${bookingData.paymentStatus}). Requires manual intervention?`, logContext);
                 // Acknowledge - cannot proceed automatically
                 await bookingRef.update({ processingError: `Cannot process deposit: Payment status is ${bookingData.paymentStatus}` });
                 return;
            }
            const authId = bookingData.paymentDetails?.authorizationId;
            if (!authId) {
                 logger.error(`${functionName} Cannot process deposit for booking ${bookingId}: Missing authorizationId in paymentDetails.`, logContext);
                 // Acknowledge - cannot proceed
                 await bookingRef.update({ processingError: `Cannot process deposit: Missing authorizationId` });
                 return;
            }

            // 4. Calculate Final Charges
            logger.info(`${functionName} Calculating final charges for booking ${bookingId}...`, logContext);
            const chargeResult = calculateRentalFinalCharge(bookingData);
            if (chargeResult.error) {
                 logger.error(`${functionName} Failed to calculate final charges for booking ${bookingId}.`, { ...logContext, error: chargeResult.error });
                 await bookingRef.update({ processingError: `Calculation Error: ${chargeResult.error}` });
                 return; // Acknowledge
            }
            const { totalCharge, overtimeFee, cleaningFee, damageFee } = chargeResult;
            logContext.totalCharge = totalCharge;
            logContext.overtimeFee = overtimeFee;
            logContext.cleaningFee = cleaningFee;
            logContext.damageFee = damageFee;

            // 5. Decide: Capture or Void?
            let updatedPaymentStatus: PaymentStatus = bookingData.paymentStatus; // Start with current
            let paymentResult: Awaited<ReturnType<typeof processPaymentCapture | typeof voidAuthorization>> | null = null;
            let finalChargeDetails: PaymentDetails | null = null; // To store capture details

            if (totalCharge > 0) {
                // --- Capture Part of the Deposit ---
                logger.info(`${functionName} Booking ${bookingId}: Attempting to capture ${totalCharge} ${bookingData.currencyCode} from deposit authorization ${authId}...`, logContext);
                paymentResult = await processPaymentCapture(
                    authId,
                    totalCharge,
                    bookingData.currencyCode
                );

                if (!paymentResult.success) {
                    updatedPaymentStatus = PaymentStatus.CaptureFailed;
                    logger.error(`${functionName} Deposit capture failed for booking ${bookingId}, AuthID: ${authId}.`, { ...logContext, error: paymentResult.errorMessage, code: paymentResult.errorCode });
                    await bookingRef.update({
                        processingError: `Deposit Capture Failed: ${paymentResult.errorMessage || paymentResult.errorCode || 'Unknown'}`,
                        paymentStatus: updatedPaymentStatus,
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                    return; // Acknowledge - failed
                } else {
                    updatedPaymentStatus = PaymentStatus.Captured; // Or maybe 'PartiallyCaptured'? Let's use Captured.
                    logger.info(`${functionName} Deposit capture successful for booking ${bookingId}. TxID: ${paymentResult.transactionId}`, logContext);
                    // Extract details to store
                    finalChargeDetails = extractPaymentDetailsFromResult(paymentResult);
                }

            } else {
                // --- Void the Full Deposit Authorization ---
                logger.info(`${functionName} Booking ${bookingId}: No charges apply. Attempting to void deposit authorization ${authId}...`, logContext);
                paymentResult = await voidAuthorization(authId);

                if (!paymentResult.success) {
                    updatedPaymentStatus = PaymentStatus.VoidFailed;
                    logger.error(`${functionName} Deposit void failed for booking ${bookingId}, AuthID: ${authId}.`, { ...logContext, error: paymentResult.errorMessage, code: paymentResult.errorCode });
                     await bookingRef.update({
                         processingError: `Deposit Void Failed: ${paymentResult.errorMessage || paymentResult.errorCode || 'Unknown'}`,
                         paymentStatus: updatedPaymentStatus,
                         updatedAt: FieldValue.serverTimestamp(),
                     });
                     return; // Acknowledge - failed
                } else {
                    updatedPaymentStatus = PaymentStatus.Voided;
                    logger.info(`${functionName} Deposit void successful for booking ${bookingId}, AuthID: ${authId}.`, logContext);
                }
            }
            logContext.updatedPaymentStatus = updatedPaymentStatus;

            // 6. Update Rental Booking Document
            logger.info(`${functionName} Updating booking document ${bookingId}...`, logContext);
            const updateData: { [key: string]: any } = {
                paymentStatus: updatedPaymentStatus,
                finalChargeSmallestUnit: totalCharge,
                overtimeFeeChargedSmallestUnit: overtimeFee > 0 ? overtimeFee : null,
                cleaningFeeChargedSmallestUnit: cleaningFee > 0 ? cleaningFee : null,
                damageFeeChargedTotalSmallestUnit: damageFee > 0 ? damageFee : null,
                depositProcessed: true, // Mark as processed
                processingError: null, // Clear previous errors
                updatedAt: FieldValue.serverTimestamp(),
            };
            // Add capture details if capture occurred
            if (finalChargeDetails) {
                updateData.finalChargePaymentDetails = finalChargeDetails; // Add a new field for this?
            }
             // Add void failure details?
             if (paymentResult && !paymentResult.success && 'errorCode' in paymentResult && updatedPaymentStatus === PaymentStatus.VoidFailed) {
                 updateData['paymentDetails.voidErrorCode'] = paymentResult.errorCode;
                 updateData['paymentDetails.voidErrorMessage'] = paymentResult.errorMessage;
             }
             // Add capture failure details?
              if (paymentResult && !paymentResult.success && 'errorCode' in paymentResult && updatedPaymentStatus === PaymentStatus.CaptureFailed) {
                  updateData['paymentDetails.captureErrorCode'] = paymentResult.errorCode; // Need dedicated fields
                  updateData['paymentDetails.captureErrorMessage'] = paymentResult.errorMessage;
              }


            await bookingRef.update(updateData);
            logger.info(`${functionName} Booking ${bookingId} updated successfully. Deposit processed.`, logContext);

            // 7. Log System Activity (Async)
            logSystemActivity("ProcessRentalDeposit", {
                bookingId,
                initialStatus: bookingData.bookingStatus,
                initialPaymentStatus: bookingData.paymentStatus,
                finalPaymentStatus: updatedPaymentStatus,
                totalCharge,
                captureSuccess: updatedPaymentStatus === PaymentStatus.Captured,
                voidSuccess: updatedPaymentStatus === PaymentStatus.Voided,
                paymentResultDetails: paymentResult // Log the raw result
            }).catch(err => logger.error("Failed logging system activity", { err }));

            // Acknowledge the message after successful processing
            return;

        } catch (error: any) {
            logger.error(`${functionName} Unhandled error during deposit processing.`, { ...logContext, error: error?.message, stack: error?.stack });
            // Attempt to mark the booking with an error, but don't throw to prevent Pub/Sub retries for fatal errors
            if (bookingId) {
                try {
                    await db.collection('rentalBookings').doc(bookingId).update({
                        processingError: `Fatal Error: ${error?.message ?? 'Unknown error'}`,
                        depositProcessed: false, // Ensure it's marked as not processed
                        updatedAt: FieldValue.serverTimestamp(),
                    });
                } catch (updateError) {
                     logger.error(`${functionName} Failed to update booking with fatal error info.`, { ...logContext, updateError });
                }
            }
            // Acknowledge the message even on fatal error to stop retries
            return;
        } finally {
            const duration = Date.now() - startTimeFunc;
            logger.info(`${functionName} Execution finished. Duration: ${duration}ms`, logContext);
        }
    });

