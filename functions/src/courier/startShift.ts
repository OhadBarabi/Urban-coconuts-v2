import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Box, Shift, ShiftStatus } from '../models'; // Adjust path if needed

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

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User or Box not found
    FailedPrecondition = "FAILED_PRECONDITION", // Already on shift, Box inactive/unassigned, Box already taken
    Aborted = "ABORTED", // Transaction failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND",
    BoxNotFound = "BOX_NOT_FOUND",
    NotCourier = "NOT_COURIER",
    AlreadyOnShift = "ALREADY_ON_SHIFT",
    BoxNotAssignedToCourier = "BOX_NOT_ASSIGNED_TO_COURIER",
    BoxInactive = "BOX_INACTIVE",
    BoxAlreadyAssigned = "BOX_ALREADY_ASSIGNED",
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- Interfaces ---
interface StartShiftInput {
    boxId: string; // ID of the box to start shift at
    startCashSmallestUnit: number; // Starting cash amount (integer >= 0)
}

// --- The Cloud Function ---
export const startShift = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory for transaction reads/writes
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true; shiftId: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[startShift V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const courierId = request.auth.uid;
        const data = request.data as StartShiftInput;
        const logContext: any = { courierId, boxId: data?.boxId, startCash: data?.startCashSmallestUnit };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.boxId || typeof data.boxId !== 'string' ||
            typeof data.startCashSmallestUnit !== 'number' || !Number.isInteger(data.startCashSmallestUnit) || data.startCashSmallestUnit < 0)
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structureOrCash", errorCode: ErrorCode.InvalidArgument };
        }
        const { boxId, startCashSmallestUnit } = data;

        // --- Firestore References ---
        const courierRef = db.collection('users').doc(courierId);
        const boxRef = db.collection('boxes').doc(boxId);
        const shiftsCollectionRef = db.collection('shifts');

        try {
            // Fetch Courier User Data Once for Role Check
            const courierSnapInitial = await courierRef.get();
            if (!courierSnapInitial.exists) throw new HttpsError('not-found', `error.user.notFound::${courierId}`, { errorCode: ErrorCode.UserNotFound });
            const courierDataInitial = courierSnapInitial.data() as User;
            const courierRole = courierDataInitial.role;
            logContext.courierRole = courierRole;

            // 3. Permission Check (Using REAL helper)
            // Define permission: 'courier:shift:start'
            const hasPermission = await checkPermission(courierId, courierRole, 'courier:shift:start', logContext);
            if (!hasPermission) {
                // Check if it's because they are not a courier or lack specific permission
                const specificErrorCode = courierRole !== 'Courier' ? ErrorCode.NotCourier : ErrorCode.PermissionDenied;
                const errorMessage = courierRole !== 'Courier' ? "error.startShift.notCourier" : "error.permissionDenied.startShift";
                logger.warn(`${functionName} Permission denied for user ${courierId} (Role: ${courierRole}) to start shift.`, logContext);
                return { success: false, error: errorMessage, errorCode: specificErrorCode };
            }

            // 4. Firestore Transaction
            logger.info(`${functionName} Starting Firestore transaction...`, logContext);
            const newShiftId = shiftsCollectionRef.doc().id; // Pre-generate shift ID

            await db.runTransaction(async (transaction) => {
                // Read courier and box data within the transaction
                // Courier data is re-read to ensure shiftStatus hasn't changed
                const [courierSnap, boxSnap] = await Promise.all([
                    transaction.get(courierRef),
                    transaction.get(boxRef)
                ]);

                // --- Validate Courier State ---
                if (!courierSnap.exists) throw new Error(`TX_ERR::${ErrorCode.UserNotFound}`); // Should not happen if initial check passed
                const courierData = courierSnap.data() as User;
                // Role check already done, but double-check shift status
                if (courierData.shiftStatus === ShiftStatus.OnDuty) {
                    throw new Error(`TX_ERR::${ErrorCode.AlreadyOnShift}`);
                }
                // Check if courier is assigned to this box (V5 schema)
                if (!courierData.assignedBoxIds?.includes(boxId)) {
                     throw new Error(`TX_ERR::${ErrorCode.BoxNotAssignedToCourier}`);
                }

                // --- Validate Box State ---
                if (!boxSnap.exists) {
                    throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}`);
                }
                const boxData = boxSnap.data() as Box;
                if (!boxData.isActive) {
                    throw new Error(`TX_ERR::${ErrorCode.BoxInactive}`);
                }
                if (boxData.assignedCourierId && boxData.assignedCourierId !== courierId) {
                    logger.warn(`${functionName} TX Check: Box ${boxId} is already assigned to courier ${boxData.assignedCourierId}.`, logContext);
                    throw new Error(`TX_ERR::${ErrorCode.BoxAlreadyAssigned}`);
                }

                // --- All checks passed, perform writes ---
                const now = Timestamp.now();

                // 1. Create new Shift document
                const newShiftData: Shift = {
                    shiftId: newShiftId,
                    courierId: courierId,
                    boxId: boxId,
                    startTime: now,
                    endTime: null,
                    startCashSmallestUnit: startCashSmallestUnit,
                    endCashSmallestUnit: null,
                    expectedEndCashSmallestUnit: null,
                    cashDifferenceSmallestUnit: null,
                    isConfirmedByAdmin: false,
                    confirmationTimestamp: null,
                    confirmingAdminId: null,
                    notes: null,
                    createdAt: now,
                    updatedAt: now,
                };
                transaction.set(shiftsCollectionRef.doc(newShiftId), newShiftData);

                // 2. Update Courier document
                transaction.update(courierRef, {
                    shiftStatus: ShiftStatus.OnDuty,
                    currentShiftId: newShiftId,
                    currentBoxId: boxId,
                    updatedAt: now,
                });

                // 3. Update Box document
                transaction.update(boxRef, {
                    assignedCourierId: courierId,
                    updatedAt: now,
                });

            }); // End Transaction
            logger.info(`${functionName} Transaction successful. Shift ${newShiftId} started for courier ${courierId} at box ${boxId}.`, logContext);


            // 5. Log User Activity (Async)
            logUserActivity("StartShift", { boxId, shiftId: newShiftId, startCash: startCashSmallestUnit }, courierId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 6. Return Success
            return { success: true, shiftId: newShiftId };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (error.message?.startsWith("TX_ERR::")) {
                 const txErrCode = error.message.split('::')[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.startShift.${finalErrorCode.toLowerCase()}`;
            } else if (isHttpsError) { // Handle errors from initial user fetch
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.startShift.generic`;
            }

            logUserActivity("StartShiftFailed", { boxId, error: error.message }, courierId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
