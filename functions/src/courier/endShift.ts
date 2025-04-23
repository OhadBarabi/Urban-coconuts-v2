import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Box, Shift, ShiftStatus } from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { calculateExpectedCash } from '../utils/courier_calculations'; // Helper to calculate expected cash based on orders
// import { logUserActivity } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null && userRole === 'Courier'; }
async function calculateExpectedCash(shiftId: string, startCash: number): Promise<number> { logger.info(`[Mock Calc] Calculating expected cash for shift ${shiftId} starting with ${startCash}`); const mockCashOrders = 5500; /* Simulate cash collected */ return startCash + mockCashOrders; }
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
    NotFound = "NOT_FOUND", // User, Box, or Shift not found
    FailedPrecondition = "FAILED_PRECONDITION", // Not on shift, Shift ID mismatch
    Aborted = "ABORTED", // Transaction failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND",
    ShiftNotFound = "SHIFT_NOT_FOUND",
    BoxNotFound = "BOX_NOT_FOUND", // Needed if we clear box assignment based on shift's boxId
    NotCourier = "NOT_COURIER",
    NotOnShift = "NOT_ON_SHIFT",
    ShiftIdMismatch = "SHIFT_ID_MISMATCH", // If currentShiftId in User doc doesn't match Shift doc
    CalculationError = "CALCULATION_ERROR",
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- Interfaces ---
interface EndShiftInput {
    endCashSmallestUnit: number; // Final cash amount counted by courier (integer >= 0)
    notes?: string | null; // Optional notes from the courier about the shift
}

// --- The Cloud Function ---
export const endShift = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for calculation + transaction
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true; cashDifference: number } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[endShift V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const courierId = request.auth.uid;
        const data = request.data as EndShiftInput;
        const logContext: any = { courierId, endCash: data?.endCashSmallestUnit };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (typeof data?.endCashSmallestUnit !== 'number' || !Number.isInteger(data.endCashSmallestUnit) || data.endCashSmallestUnit < 0 ||
            (data.notes != null && typeof data.notes !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structureOrCash", errorCode: ErrorCode.InvalidArgument };
        }
        const { endCashSmallestUnit, notes } = data;

        // --- Firestore References ---
        const courierRef = db.collection('users').doc(courierId);
        // We need the shift ID from the courier document first
        let shiftId: string | null = null;
        let boxId: string | null = null; // Box ID associated with the shift
        let shiftRef: admin.firestore.DocumentReference | null = null;
        let boxRef: admin.firestore.DocumentReference | null = null;
        let cashDifference: number = 0;

        try {
            // 3. Get Current Shift ID and Box ID from Courier Document
            const courierSnapInitial = await courierRef.get();
            if (!courierSnapInitial.exists) throw new HttpsError('not-found', `error.user.notFound::${courierId}`, { errorCode: ErrorCode.UserNotFound });
            const courierDataInitial = courierSnapInitial.data() as User;

            if (courierDataInitial.role !== 'Courier') throw new HttpsError('permission-denied', "error.endShift.notCourier", { errorCode: ErrorCode.NotCourier });
            if (courierDataInitial.shiftStatus !== ShiftStatus.OnDuty || !courierDataInitial.currentShiftId) {
                logger.warn(`${functionName} Courier ${courierId} is not currently on shift.`, logContext);
                return { success: false, error: "error.endShift.notOnShift", errorCode: ErrorCode.NotOnShift };
            }
            shiftId = courierDataInitial.currentShiftId;
            boxId = courierDataInitial.currentBoxId; // Get the boxId the courier was assigned to
            logContext.shiftId = shiftId;
            logContext.boxId = boxId;

            if (!shiftId) throw new HttpsError('internal', "Courier is OnDuty but currentShiftId is missing.");
            if (!boxId) throw new HttpsError('internal', "Courier is OnDuty but currentBoxId is missing."); // Should not happen if startShift worked

            shiftRef = db.collection('shifts').doc(shiftId);
            boxRef = db.collection('boxes').doc(boxId);

            // 4. Calculate Expected Cash (Potentially outside transaction for performance)
            // Requires reading the shift document first to get startCash
            const shiftSnapInitial = await shiftRef.get();
            if (!shiftSnapInitial.exists) {
                 logger.error(`${functionName} Active shift document ${shiftId} not found for courier ${courierId}. Inconsistency detected.`, logContext);
                 // Attempt to clean up courier status? Or just return error? Let's return error.
                 return { success: false, error: "error.endShift.shiftNotFound", errorCode: ErrorCode.ShiftNotFound };
            }
            const shiftDataInitial = shiftSnapInitial.data() as Shift;
            const startCash = shiftDataInitial.startCashSmallestUnit;

            logger.info(`${functionName} Calculating expected cash for shift ${shiftId}...`, logContext);
            const expectedEndCash = await calculateExpectedCash(shiftId, startCash);
            cashDifference = endCashSmallestUnit - expectedEndCash;
            logContext.expectedCash = expectedEndCash;
            logContext.cashDifference = cashDifference;
            logger.info(`${functionName} Shift ${shiftId}: Start=${startCash}, End=${endCashSmallestUnit}, Expected=${expectedEndCash}, Diff=${cashDifference}`, logContext);


            // 5. Firestore Transaction to Update All Documents
            logger.info(`${functionName} Starting Firestore transaction...`, logContext);
            await db.runTransaction(async (transaction) => {
                // Re-read documents within transaction
                const [courierSnap, shiftSnap, boxSnap] = await Promise.all([
                    transaction.get(courierRef),
                    transaction.get(shiftRef!), // Use non-null assertion as we checked existence
                    transaction.get(boxRef!)   // Use non-null assertion
                ]);

                // --- Validate Courier State ---
                if (!courierSnap.exists) throw new Error(`TX_ERR::${ErrorCode.UserNotFound}`);
                const courierData = courierSnap.data() as User;
                if (courierData.shiftStatus !== ShiftStatus.OnDuty) throw new Error(`TX_ERR::${ErrorCode.NotOnShift}`); // Check again in TX
                if (courierData.currentShiftId !== shiftId) throw new Error(`TX_ERR::${ErrorCode.ShiftIdMismatch}`); // Crucial check

                 // --- Validate Shift State ---
                 if (!shiftSnap.exists) throw new Error(`TX_ERR::${ErrorCode.ShiftNotFound}`);
                 const shiftData = shiftSnap.data() as Shift;
                 if (shiftData.endTime !== null) { // Check if already ended
                     logger.warn(`${functionName} TX Conflict: Shift ${shiftId} was already ended.`, logContext);
                     // Allow ending again? Or throw error? Let's throw error to be safe.
                     throw new Error(`TX_ERR::${ErrorCode.FailedPrecondition}::ShiftAlreadyEnded`);
                 }

                // --- Validate Box State ---
                if (!boxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}`); // Box should exist
                const boxData = boxSnap.data() as Box;
                // Check if the box is still assigned to *this* courier. If not, something is wrong.
                if (boxData.assignedCourierId !== courierId) {
                    logger.warn(`${functionName} TX Conflict: Box ${boxId} is no longer assigned to courier ${courierId}. Current assignee: ${boxData.assignedCourierId}. Proceeding to end shift but not clearing box assignment.`, logContext);
                    // Decide: Proceed without clearing box assignment, or fail? Let's proceed but log warning.
                    // We will *not* update the box in this case.
                }


                // --- All checks passed (or warnings noted), perform writes ---
                const now = Timestamp.now();

                // 1. Update Shift document
                transaction.update(shiftRef!, {
                    endTime: now,
                    endCashSmallestUnit: endCashSmallestUnit,
                    expectedEndCashSmallestUnit: expectedEndCash,
                    cashDifferenceSmallestUnit: cashDifference,
                    notes: notes ?? shiftData.notes, // Update notes if provided
                    updatedAt: now,
                });

                // 2. Update Courier document
                transaction.update(courierRef, {
                    shiftStatus: ShiftStatus.OffDuty,
                    currentShiftId: null, // Clear current shift ID
                    currentBoxId: null,   // Clear current box ID
                    updatedAt: now,
                });

                // 3. Update Box document (ONLY if still assigned to this courier)
                if (boxData.assignedCourierId === courierId) {
                    transaction.update(boxRef!, {
                        assignedCourierId: null, // Clear assignment
                        updatedAt: now,
                    });
                } else {
                     logger.warn(`${functionName} TX Write Skipped: Did not clear assignedCourierId on box ${boxId} because it was assigned to ${boxData.assignedCourierId}, not ${courierId}.`);
                }

            }); // End Transaction
            logger.info(`${functionName} Transaction successful. Shift ${shiftId} ended for courier ${courierId}. Cash difference: ${cashDifference}`, logContext);


            // 6. Log User Activity (Async)
            logUserActivity("EndShift", { shiftId, endCash: endCashSmallestUnit, expectedCash: expectedEndCash, difference: cashDifference }, courierId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 7. Return Success
            return { success: true, cashDifference: cashDifference };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.endShift.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`; // Append specific reason if provided
            } else if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.endShift.generic`;
            }

            // Log failure activity?
            logUserActivity("EndShiftFailed", { shiftId: shiftId ?? 'Unknown', error: error.message }, courierId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
