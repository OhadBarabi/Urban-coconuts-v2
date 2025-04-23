import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Box, Shift, ShiftStatus } from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions'; // Might not be needed if only courier role check is done
// import { logUserActivity } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null && userRole === 'Courier'; }
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
        const functionName = "[startShift V1]";
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
            // 3. Firestore Transaction
            logger.info(`${functionName} Starting Firestore transaction...`, logContext);
            const newShiftId = shiftsCollectionRef.doc().id; // Pre-generate shift ID for use in updates

            await db.runTransaction(async (transaction) => {
                // Read courier and box data within the transaction
                const [courierSnap, boxSnap] = await Promise.all([
                    transaction.get(courierRef),
                    transaction.get(boxRef)
                ]);

                // --- Validate Courier ---
                if (!courierSnap.exists) {
                    throw new Error(`TX_ERR::${ErrorCode.UserNotFound}`);
                }
                const courierData = courierSnap.data() as User;
                if (courierData.role !== 'Courier') {
                    throw new Error(`TX_ERR::${ErrorCode.NotCourier}`);
                }
                if (courierData.shiftStatus === ShiftStatus.OnDuty) {
                    throw new Error(`TX_ERR::${ErrorCode.AlreadyOnShift}`);
                }
                // Check if courier is assigned to this box (V5 schema)
                if (!courierData.assignedBoxIds?.includes(boxId)) {
                     throw new Error(`TX_ERR::${ErrorCode.BoxNotAssignedToCourier}`);
                }

                // --- Validate Box ---
                if (!boxSnap.exists) {
                    throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}`);
                }
                const boxData = boxSnap.data() as Box;
                if (!boxData.isActive) {
                    throw new Error(`TX_ERR::${ErrorCode.BoxInactive}`);
                }
                // Check if the box is already assigned to another ACTIVE courier
                // This requires checking the assignedCourierId AND potentially their shift status if needed,
                // but checking assignedCourierId should be sufficient if endShift clears it.
                if (boxData.assignedCourierId && boxData.assignedCourierId !== courierId) {
                    // We might need an extra read here to confirm the other courier is *really* on duty,
                    // but let's assume assignedCourierId is reliable for now.
                    logger.warn(`${functionName} TX Check: Box ${boxId} is already assigned to courier ${boxData.assignedCourierId}.`, logContext);
                    throw new Error(`TX_ERR::${ErrorCode.BoxAlreadyAssigned}`);
                }

                // --- All checks passed, perform writes ---
                const now = Timestamp.now();

                // 1. Create new Shift document
                const newShiftData: Shift = {
                    shiftId: newShiftId, // Store the ID in the document as well
                    courierId: courierId,
                    boxId: boxId,
                    startTime: now, // Use server timestamp? 'now' is safer in TX
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
                    updatedAt: now, // Update courier timestamp
                });

                // 3. Update Box document
                transaction.update(boxRef, {
                    assignedCourierId: courierId,
                    updatedAt: now, // Update box timestamp
                });

            }); // End Transaction
            logger.info(`${functionName} Transaction successful. Shift ${newShiftId} started for courier ${courierId} at box ${boxId}.`, logContext);


            // 4. Log User Activity (Async)
            logUserActivity("StartShift", { boxId, shiftId: newShiftId, startCash: startCashSmallestUnit }, courierId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 5. Return Success
            return { success: true, shiftId: newShiftId };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError; // Should not happen with TX errors
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (error.message?.startsWith("TX_ERR::")) {
                 const txErrCode = error.message.split('::')[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.startShift.${finalErrorCode.toLowerCase()}`;
            } else if (isHttpsError) { // Should not happen here but handle defensively
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.startShift.generic`;
            }

            // Log failure activity?
            logUserActivity("StartShiftFailed", { boxId, error: error.message }, courierId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
