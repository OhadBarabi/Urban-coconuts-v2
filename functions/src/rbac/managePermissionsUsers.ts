import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Permission } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions'; // <-- Import REAL helper
// import { logAdminAction } from '../utils/logging'; // Using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User, Role, or Permission not found
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND", // Target user or Admin user not found
    RoleNotFound = "ROLE_NOT_FOUND", // Role to assign not found
}

// --- Interfaces ---
interface ListPermissionsInput {
    pageSize?: number;
    pageToken?: string; // Use permissionId as page token
    category?: string | null; // Optional filter by category
}

interface PermissionOutput extends Permission {
    permissionId: string; // Add the document ID
}

interface ListPermissionsOutput {
    permissions: PermissionOutput[];
    nextPageToken?: string | null;
}

interface AssignRoleToUserInput {
    userId: string; // ID of the user to assign the role to
    roleId: string; // ID of the role to assign
}

// ============================================================================
// === List Permissions Function ==============================================
// ============================================================================
export const listPermissions = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true; data: ListPermissionsOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[listPermissions V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as ListPermissionsInput; // Input might be empty
        const logContext: any = { adminUserId, pageSize: data?.pageSize, pageToken: data?.pageToken, category: data?.category };

        logger.info(`${functionName} Invoked.`, logContext);

        // Fetch admin user role for permission check
        let adminUserRole: string | null = null;
        try {
            const adminUserSnap = await db.collection('users').doc(adminUserId).get();
            if (!adminUserSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (adminUserSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check (Using REAL helper) - Define permission: 'admin:permission:list'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:permission:list', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to list permissions.`, logContext);
                return { success: false, error: "error.permissionDenied.listPermissions", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Prepare Query
        const pageSize = (typeof data?.pageSize === 'number' && data.pageSize > 0 && data.pageSize <= 100) ? data.pageSize : 50; // Default 50?
        let query: admin.firestore.Query<admin.firestore.DocumentData> = db.collection('permissions');

        // Add category filter if provided
        if (data?.category && typeof data.category === 'string') {
            query = query.where('category', '==', data.category);
            logContext.filterCategory = data.category;
        }

        // Add ordering and pagination (using permissionId / document ID for pagination token)
        query = query.orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
        if (data?.pageToken && typeof data.pageToken === 'string') {
            try {
                query = query.startAfter(data.pageToken);
            } catch (e) {
                logger.warn("Invalid page token provided or query failed.", { pageToken: data.pageToken, error: e });
            }
        }

        // 3. Execute Query
        try {
            const snapshot = await query.get();
            const permissions: PermissionOutput[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as Permission;
                const outputData: PermissionOutput = {
                    permissionId: doc.id, // Add the document ID
                    description: data.description,
                    category: data.category,
                };
                permissions.push(outputData);
            });

            // Determine next page token
            let nextPageToken: string | null = null;
            if (snapshot.docs.length === pageSize) {
                nextPageToken = snapshot.docs[snapshot.docs.length - 1].id; // Use permissionId (doc ID) as token
            }

            logger.info(`${functionName} Found ${permissions.length} permissions. Next page token: ${nextPageToken}`, logContext);

            // 4. Return Results
            return { success: true, data: { permissions, nextPageToken } };

        } catch (error: any) {
            logger.error(`${functionName} Failed to list permissions.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Assign Role to User Function ===========================================
// ============================================================================
export const assignRoleToUser = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[assignRoleToUser V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as AssignRoleToUserInput;
        const logContext: any = { adminUserId, targetUserId: data?.userId, targetRoleId: data?.roleId };

        logger.info(`${functionName} Invoked.`, logContext);

        // Fetch admin user role for permission check
        let adminUserRole: string | null = null;
        try {
            const adminUserSnap = await db.collection('users').doc(adminUserId).get();
            if (!adminUserSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (adminUserSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check (Using REAL helper) - Define permission: 'admin:user:assignRole'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:user:assignRole', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to assign role.`, logContext);
                return { success: false, error: "error.permissionDenied.assignRole", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.userId || typeof data.userId !== 'string' ||
            !data?.roleId || typeof data.roleId !== 'string')
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.userIdOrRoleId", errorCode: ErrorCode.InvalidArgument };
        }
        const { userId: targetUserId, roleId: targetRoleId } = data;

        // 3. Validate Target User and Role Existence Concurrently
        const targetUserRef = db.collection('users').doc(targetUserId);
        const targetRoleRef = db.collection('roles').doc(targetRoleId);

        try {
            const [targetUserSnap, targetRoleSnap] = await Promise.all([
                targetUserRef.get(),
                targetRoleRef.get()
            ]);

            if (!targetUserSnap.exists) {
                logger.warn(`${functionName} Target user ${targetUserId} not found.`, logContext);
                return { success: false, error: "error.assignRole.userNotFound", errorCode: ErrorCode.UserNotFound };
            }
            if (!targetRoleSnap.exists) {
                logger.warn(`${functionName} Target role ${targetRoleId} not found.`, logContext);
                return { success: false, error: "error.assignRole.roleNotFound", errorCode: ErrorCode.RoleNotFound };
            }
            // Optional: Check if target user is active?
            // const targetUserData = targetUserSnap.data() as User;
            // if (!targetUserData.isActive) { ... }

            // 4. Update Target User Document
            logger.info(`${functionName} Assigning role '${targetRoleId}' to user '${targetUserId}'...`, logContext);
            await targetUserRef.update({
                role: targetRoleId,
                updatedAt: FieldValue.serverTimestamp()
                // Consider clearing specific permissions if role changes?
                // permissions: FieldValue.delete()
            });
            logger.info(`${functionName} Role assigned successfully.`, logContext);

            // 5. Log Admin Action (Async)
            logAdminAction("AssignRoleToUser", { targetUserId, targetRoleId, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 6. Return Success
            return { success: true };

        } catch (error: any) {
            logger.error(`${functionName} Failed to assign role '${targetRoleId}' to user '${targetUserId}'.`, { ...logContext, error: error.message });
            // Handle potential update errors
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);

// Potential future function: removeRoleFromUser, assignDirectPermission, removeDirectPermission
