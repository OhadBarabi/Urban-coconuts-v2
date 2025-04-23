import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Box } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { logAdminAction } from '../utils/logging'; // Using mock from manageRoles for now

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Target User or Box not found
    Aborted = "ABORTED", // Transaction failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND", // Target user or Admin user not found
    BoxNotFound = "BOX_NOT_FOUND",
    InvalidAdjustmentFormat = "INVALID_ADJUSTMENT_FORMAT",
    TransactionFailed = "TRANSACTION_FAILED",
    ResourceExhausted = "RESOURCE_EXHAUSTED", // Added for negative stock check
}

// --- Interfaces ---
interface SetUserActiveStatusInput {
    userId: string; // ID of the user to update
    isActive: boolean; // The new active status
}

interface InventoryAdjustment {
    productId: string;
    change: number; // Positive integer to add, negative integer to remove
}
interface AdjustBoxInventoryInput {
    boxId: string;
    adjustments: InventoryAdjustment[]; // Array of adjustments
    reason: string; // Reason for the adjustment (e.g., "Manual Stock Count", "Damaged Goods")
}


// ============================================================================
// === Set User Active Status Function ========================================
// ============================================================================
export const setUserActiveStatus = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[setUserActiveStatus V2 - Permissions]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as SetUserActiveStatusInput;
        const logContext: any = { adminUserId, targetUserId: data?.userId, targetStatus: data?.isActive };

        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const adminUserSnap = await db.collection('users').doc(adminUserId).get();
            if (!adminUserSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (adminUserSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:user:setActiveStatus', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to set user active status.`, logContext);
                return { success: false, error: "error.permissionDenied.setUserActive", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.userId || typeof data.userId !== 'string' || typeof data.isActive !== 'boolean') {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.userIdOrStatus", errorCode: ErrorCode.InvalidArgument };
        }
        const { userId: targetUserId, isActive: targetIsActive } = data;

        if (targetUserId === adminUserId && !targetIsActive) {
             logger.warn(`${functionName} Admin user ${adminUserId} attempted to deactivate themselves. Denied.`, logContext);
             return { success: false, error: "error.setUserActive.cannotDeactivateSelf", errorCode: ErrorCode.PermissionDenied };
        }

        // 3. Update Target User Document
        const targetUserRef = db.collection('users').doc(targetUserId);
        try {
            const targetUserSnap = await targetUserRef.get();
            if (!targetUserSnap.exists) {
                 logger.warn(`${functionName} Target user ${targetUserId} not found.`, logContext);
                 return { success: false, error: "error.setUserActive.userNotFound", errorCode: ErrorCode.UserNotFound };
            }

            await targetUserRef.update({
                isActive: targetIsActive,
                updatedAt: FieldValue.serverTimestamp()
            });
            logger.info(`${functionName} Active status for user '${targetUserId}' set to ${targetIsActive}.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("SetUserActiveStatus", { targetUserId, targetIsActive, triggerUserId: adminUserId })
                .catch(err => logger.error("Failed logging SetUserActiveStatus admin action", { err })); // Fixed catch

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            logger.error(`${functionName} Failed to set active status for user '${targetUserId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Adjust Box Inventory Function ==========================================
// ============================================================================
export const adjustBoxInventory = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "256MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[adjustBoxInventory V2 - Permissions]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as AdjustBoxInventoryInput;
        const logContext: any = { adminUserId, boxId: data?.boxId, adjustmentCount: data?.adjustments?.length, reason: data?.reason };

        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const adminUserSnap = await db.collection('users').doc(adminUserId).get();
            if (!adminUserSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (adminUserSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:inventory:adjust', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to adjust inventory.`, logContext);
                return { success: false, error: "error.permissionDenied.adjustInventory", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.boxId || typeof data.boxId !== 'string' ||
            !Array.isArray(data.adjustments) || data.adjustments.length === 0 ||
            data.adjustments.some(adj => !adj.productId || typeof adj.productId !== 'string' || typeof adj.change !== 'number' || !Number.isInteger(adj.change)) ||
            !data?.reason || typeof data.reason !== 'string' || data.reason.trim().length === 0)
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            let errorCode = ErrorCode.InvalidArgument;
            if (data.adjustments && data.adjustments.some(adj => typeof adj.change !== 'number' || !Number.isInteger(adj.change))) {
                 errorCode = ErrorCode.InvalidAdjustmentFormat;
            }
            return { success: false, error: "error.invalidInput.adjustmentData", errorCode: errorCode };
        }
        const { boxId, adjustments, reason } = data;

        // 3. Firestore Transaction to Update Box Inventory
        const boxRef = db.collection('boxes').doc(boxId);
        try {
            logger.info(`${functionName} Starting Firestore transaction for inventory adjustment...`, logContext);
            await db.runTransaction(async (transaction) => {
                const boxTxSnap = await transaction.get(boxRef);
                if (!boxTxSnap.exists) {
                    throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}`);
                }
                const boxTxData = boxTxSnap.data() as Box;
                const currentInventory = boxTxData.inventory ?? {};

                const inventoryUpdates: { [key: string]: admin.firestore.FieldValue } = {};
                for (const adj of adjustments) {
                    const productId = adj.productId;
                    const change = adj.change;
                    const currentStock = currentInventory[productId] ?? 0;
                    const newStock = currentStock + change;

                    if (newStock < 0) {
                        throw new Error(`TX_ERR::${ErrorCode.ResourceExhausted}::${productId}`);
                    }
                    inventoryUpdates[`inventory.${productId}`] = FieldValue.increment(change);
                }

                inventoryUpdates.updatedAt = FieldValue.serverTimestamp();
                transaction.update(boxRef, inventoryUpdates);
            });
            logger.info(`${functionName} Inventory for box '${boxId}' adjusted successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("AdjustBoxInventory", { boxId, reason, adjustments, triggerUserId: adminUserId })
                .catch(err => logger.error("Failed logging AdjustBoxInventory admin action", { err })); // Fixed catch

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            logger.error(`${functionName} Failed to adjust inventory for box '${boxId}'.`, { ...logContext, error: error.message });
            let finalErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey = "error.internalServer";

            if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            }

            // Log failure action
            logAdminAction("AdjustBoxInventoryFailed", { boxId, reason, adjustments, error: error.message, triggerUserId: adminUserId })
                .catch(err => logger.error("Failed logging AdjustBoxInventoryFailed admin action", { err })); // Fixed catch

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
