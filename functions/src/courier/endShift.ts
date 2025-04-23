import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Box, Shift, ShiftStatus } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions'; // <-- Import REAL helper
// import { calculateExpectedCash } from '../utils/courier_calculations'; // Still using mock below
// import { logUserActivity } from '../utils/logging'; // Still using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
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
    BoxNotFound = "BOX_NOT_FOUND",
    NotCourier = "NOT_COURIER",
    NotOnShift = "NOT_ON_SHIFT",
    ShiftIdMismatch = "SHIFT_ID_MISMATCH",
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
        const functionName = "[endShift V2 - Permissions]"; // Updated version name
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
        let shiftId: string | null = null;
        let boxId: string | null = null;
        let shiftRef: admin.firestore.DocumentReference | null = null;
        let boxRef: admin.firestore.DocumentReference | null = null;
        let cashDifference: number = 0;

        try {
            // 3. Get Current Shift ID, Box ID, and Role from Courier Document
            const courierSnapInitial = await courierRef.get();
            if (!courierSnapInitial.exists) throw new HttpsError('not-found', `error.user.notFound::${courierId}`, { errorCode: ErrorCode.UserNotFound });
            const courierDataInitial = courierSnapInitial.data() as User;
            const courierRole = courierDataInitial.role; // Get role for permission check
            logContext.courierRole = courierRole;

            // 4. Permission Check (Using REAL helper)
            // Define permission: 'courier:shift:end'
            const hasPermission = await checkPermission(courierId, courierRole, 'courier:shift:end', logContext);
            if (!hasPermission) {
                const specificErrorCode = courierRole !== 'Courier' ? ErrorCode.NotCourier : ErrorCode.PermissionDenied;
                const errorMessage = courierRole !== 'Courier' ? "error.endShift.notCourier" : "error.permissionDenied.endShift";
                logger.warn(`${functionName} Permission denied for user ${courierId} (Role: ${courierRole}) to end shift.`, logContext);
                return { success: false, error: errorMessage, errorCode: specificErrorCode };
            }

            // 5. Validate Shift Status and Get IDs (after permission check)
            if (courierDataInitial.shiftStatus !== ShiftStatus.OnDuty || !courierDataInitial.currentShiftId) {
                logger.warn(`${functionName} Courier ${courierId} is not currently on shift.`, logContext);
                return { success: false, error: "error.endShift.notOnShift", errorCode: ErrorCode.NotOnShift };
            }
            shiftId = courierDataInitial.currentShiftId;
            boxId = courierDataInitial.currentBoxId;
            logContext.shiftId = shiftId;
            logContext.boxId = boxId;

            if (!shiftId) throw new HttpsError('internal', "Courier is OnDuty but currentShiftId is missing.");
            if (!boxId) throw new HttpsError('internal', "Courier is OnDuty but currentBoxId is missing.");

            shiftRef = db.collection('shifts').doc(shiftId);
            boxRef = db.collection('boxes').doc(boxId);

            // 6. Calculate Expected Cash - Logic remains the same as V1
            const shiftSnapInitial = await shiftRef.get();
            if (!shiftSnapInitial.exists) {
                 logger.error(`${functionName} Active shift document ${shiftId} not found for courier ${courierId}. Inconsistency detected.`, logContext);
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

            // 7. Firestore Transaction to Update All Documents - Logic remains the same as V1
            logger.info(`${functionName} Starting Firestore transaction...`, logContext);
            await db.runTransaction(async (transaction) => {
                const [courierSnap, shiftSnap, boxSnap] = await Promise.all([
                    transaction.get(courierRef),
                    transaction.get(shiftRef!),
                    transaction.get(boxRef!)
                ]);

                if (!courierSnap.exists) throw new Error(`TX_ERR::${ErrorCode.UserNotFound}`);
                const courierData = courierSnap.data() as User;
                if (courierData.shiftStatus !== ShiftStatus.OnDuty) throw new Error(`TX_ERR::${ErrorCode.NotOnShift}`);
                if (courierData.currentShiftId !== shiftId) throw new Error(`TX_ERR::${ErrorCode.ShiftIdMismatch}`);

                 if (!shiftSnap.exists) throw new Error(`TX_ERR::${ErrorCode.ShiftNotFound}`);
                 const shiftData = shiftSnap.data() as Shift;
                 if (shiftData.endTime !== null) {
                     logger.warn(`${functionName} TX Conflict: Shift ${shiftId} was already ended.`, logContext);
                     throw new Error(`TX_ERR::${ErrorCode.FailedPrecondition}::ShiftAlreadyEnded`);
                 }

                if (!boxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}`);
                const boxData = boxSnap.data() as Box;
                let updateBox = false; // Flag to track if box needs update
                if (boxData.assignedCourierId === courierId) {
                     updateBox = true;
                } else {
                     logger.warn(`${functionName} TX Write Skipped: Did not clear assignedCourierId on box ${boxId} because it was assigned to ${boxData.assignedCourierId}, not ${courierId}.`);
                }

                const now = Timestamp.now();
                transaction.update(shiftRef!, {
                    endTime: now, endCashSmallestUnit: endCashSmallestUnit,
                    expectedEndCashSmallestUnit: expectedEndCash, cashDifferenceSmallestUnit: cashDifference,
                    notes: notes ?? shiftData.notes, updatedAt: now,
                });
                transaction.update(courierRef, {
                    shiftStatus: ShiftStatus.OffDuty, currentShiftId: null, currentBoxId: null, updatedAt: now,
                });
                if (updateBox) {
                    transaction.update(boxRef!, { assignedCourierId: null, updatedAt: now });
                }
            });
            logger.info(`${functionName} Transaction successful. Shift ${shiftId} ended for courier ${courierId}. Cash difference: ${cashDifference}`, logContext);

            // 8. Log User Activity (Async) - Logic remains the same as V1
            logUserActivity("EndShift", { shiftId, endCash: endCashSmallestUnit, expectedCash: expectedEndCash, difference: cashDifference }, courierId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 9. Return Success - Logic remains the same as V1
            return { success: true, cashDifference: cashDifference };

        } catch (error: any) {
            // Error Handling - Logic remains the same as V1
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.endShift.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            } else if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.endShift.generic`;
            }

            logUserActivity("EndShiftFailed", { shiftId: shiftId ?? 'Unknown', error: error.message }, courierId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
