import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Box } from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { logAdminAction } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null && (userRole === 'Admin' || userRole === 'SuperAdmin'); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const auth = admin.auth(); // Needed for disabling auth user
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User or Box not found
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND",
    BoxNotFound = "BOX_NOT_FOUND",
    FirebaseAuthError = "FIREBASE_AUTH_ERROR",
    InvalidInventoryAdjustment = "INVALID_INVENTORY_ADJUSTMENT",
}

// --- Interfaces ---
interface SetUserActiveStatusInput {
    userId: string; // UID of the target user
    isActive: boolean; // The desired status
}

interface InventoryAdjustment {
    productId: string;
    change: number; // Positive to add, negative to remove (integer)
}
interface AdjustBoxInventoryInput {
    boxId: string;
    adjustments: InventoryAdjustment[];
    reason: string; // Reason for adjustment (e.g., "Stock Count Correction", "Spoilage")
}


// ============================================================================
// === Set User Active Status Function ========================================
// ============================================================================
export const setUserActiveStatus = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[setUserActiveStatus V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as SetUserActiveStatusInput;
        const logContext: any = { adminUserId, targetUserId: data?.userId, isActive: data?.isActive };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (userSnap.exists) adminUserRole = (userSnap.data() as User)?.role;
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:user:set_active');
            if (!hasPermission) { return { success: false, error: "error.permissionDenied.setActiveStatus", errorCode: ErrorCode.PermissionDenied }; }
        } catch (e: any) { logger.error("Auth/Permission check failed", e); return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError }; }

        // 2. Input Validation
        if (!data?.userId || typeof data.userId !== 'string' || typeof data.isActive !== 'boolean') {
            logger.error(`${functionName} Invalid input: Missing userId or isActive flag.`, logContext);
            return { success: false, error: "error.invalidInput.userIdOrActiveFlag", errorCode: ErrorCode.InvalidArgument };
        }
        const { userId: targetUserId, isActive } = data;

        // Prevent admin from disabling themselves? Optional check.
        // if (adminUserId === targetUserId && !isActive) {
        //     return { success: false, error: "error.admin.cannotDisableSelf", errorCode: ErrorCode.PermissionDenied };
        // }

        // 3. Update Firestore and Firebase Auth
        const targetUserRef = db.collection('users').doc(targetUserId);
        try {
            // Check if user exists in Firestore first
            const targetUserSnap = await targetUserRef.get();
            if (!targetUserSnap.exists) {
                logger.warn(`${functionName} Target user '${targetUserId}' not found in Firestore.`, logContext);
                return { success: false, error: "error.user.notFound", errorCode: ErrorCode.UserNotFound };
            }

            // Update Firestore document
            logger.info(`${functionName} Updating Firestore 'isActive' for user '${targetUserId}' to ${isActive}.`, logContext);
            await targetUserRef.update({
                isActive: isActive,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // Update Firebase Auth user disabled status
            logger.info(`${functionName} Updating Firebase Auth 'disabled' status for user '${targetUserId}' to ${!isActive}.`, logContext);
            await auth.updateUser(targetUserId, { disabled: !isActive });

            logger.info(`${functionName} User '${targetUserId}' active status set to ${isActive} successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("SetUserActiveStatus", { targetUserId, isActive, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            if ((error as any)?.code === 5) { // Firestore NOT_FOUND (should be caught above)
                 logger.error(`${functionName} Target user '${targetUserId}' not found during update.`, { ...logContext, error: error.message });
                 return { success: false, error: "error.user.notFound", errorCode: ErrorCode.UserNotFound };
            }
            if ((error as any)?.code?.startsWith('auth/')) { // Firebase Auth errors
                logger.error(`${functionName} Firebase Auth error updating user '${targetUserId}'.`, { ...logContext, error: error.message, code: (error as any).code });
                 // Should we revert the Firestore update? Maybe log critical error.
                 logAdminAction("SetUserActiveStatusFailedAuth", { targetUserId, isActive, reason: error.message, code: (error as any).code, triggerUserId: adminUserId }).catch(...);
                 return { success: false, error: "error.auth.updateUserFailed", errorCode: ErrorCode.FirebaseAuthError };
            }
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
    { region: FUNCTION_REGION, memory: "256MiB" }, // More memory for potential transaction
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[adjustBoxInventory V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as AdjustBoxInventoryInput;
        const logContext: any = { adminUserId, boxId: data?.boxId, reason: data?.reason, adjustmentCount: data?.adjustments?.length };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (userSnap.exists) adminUserRole = (userSnap.data() as User)?.role;
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:inventory:adjust');
            if (!hasPermission) { return { success: false, error: "error.permissionDenied.adjustInventory", errorCode: ErrorCode.PermissionDenied }; }
        } catch (e: any) { logger.error("Auth/Permission check failed", e); return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError }; }

        // 2. Input Validation
        if (!data?.boxId || typeof data.boxId !== 'string' ||
            !data.reason || typeof data.reason !== 'string' || data.reason.trim().length === 0 ||
            !Array.isArray(data.adjustments) || data.adjustments.length === 0 ||
            data.adjustments.some(adj => !adj.productId || typeof adj.productId !== 'string' || typeof adj.change !== 'number' || !Number.isInteger(adj.change)))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.inventoryAdjustment", errorCode: ErrorCode.InvalidArgument };
        }
        const { boxId, adjustments, reason } = data;

        // 3. Perform Transactional Update
        const boxRef = db.collection('boxes').doc(boxId);
        try {
            await db.runTransaction(async (transaction) => {
                const boxSnap = await transaction.get(boxRef);
                if (!boxSnap.exists) {
                    throw new HttpsError('not-found', `Box ${boxId} not found.`, { errorCode: ErrorCode.BoxNotFound });
                }
                const boxData = boxSnap.data() as Box;
                const currentInventory = boxData.inventory ?? {};
                const updates: { [key: string]: admin.firestore.FieldValue } = {};
                const logEntries: any[] = []; // For logging changes

                for (const adj of adjustments) {
                    const currentStock = currentInventory[adj.productId] ?? 0;
                    const newStock = currentStock + adj.change;

                    if (newStock < 0) {
                        // Prevent negative inventory unless explicitly allowed by business logic
                        logger.warn(`${functionName} Adjustment for product ${adj.productId} would result in negative stock (${newStock}). Skipping adjustment.`, logContext);
                        // Option 1: Throw error to fail the whole transaction
                        // throw new HttpsError('failed-precondition', `Adjustment for ${adj.productId} results in negative stock.`, { errorCode: ErrorCode.InvalidInventoryAdjustment });
                        // Option 2: Skip this adjustment and continue with others (log warning)
                        continue;
                    }

                    updates[`inventory.${adj.productId}`] = admin.firestore.FieldValue.increment(adj.change);
                    logEntries.push({ productId: adj.productId, change: adj.change, oldStock: currentStock, newStock });
                }

                if (Object.keys(updates).length === 0) {
                     logger.warn(`${functionName} No valid adjustments to apply after validation.`, logContext);
                     // If all adjustments were skipped (e.g., all would lead to negative stock), maybe throw an error?
                     // Or just return success as nothing needed changing? Let's return success.
                     return; // Exit transaction without writing if no valid updates
                }

                updates.updatedAt = admin.firestore.FieldValue.serverTimestamp(); // Update timestamp
                transaction.update(boxRef, updates);
                logContext.appliedAdjustments = logEntries; // Add applied changes to log context

            }); // End Transaction

            logger.info(`${functionName} Inventory for box '${boxId}' adjusted successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("AdjustBoxInventory", { boxId, reason, adjustments: logContext.appliedAdjustments ?? adjustments, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            if (error instanceof HttpsError) { // Handle errors thrown within the transaction
                 logger.error(`${functionName} Transaction failed for box '${boxId}'.`, { ...logContext, error: error.message, code: error.code, details: error.details });
                 const errorCode = (error.details as any)?.errorCode ?? ErrorCode.InternalError;
                 return { success: false, error: error.message, errorCode: errorCode };
            }
            // Handle other potential errors (e.g., network issues)
            logger.error(`${functionName} Failed to adjust inventory for box '${boxId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
