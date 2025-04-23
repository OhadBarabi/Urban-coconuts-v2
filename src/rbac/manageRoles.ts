import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, RoleDoc } from '../models'; // Adjust path if needed

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
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Role or User not found
    AlreadyExists = "ALREADY_EXISTS", // Role ID already exists on create
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    RoleNotFound = "ROLE_NOT_FOUND",
    InvalidPermissionsArray = "INVALID_PERMISSIONS_ARRAY",
    CannotDeleteAssignedRole = "CANNOT_DELETE_ASSIGNED_ROLE", // Optional: Check if role is assigned before deleting
}

// --- Interfaces ---
interface CreateRoleInput {
    roleId: string; // e.g., "customer_support", "regional_manager"
    roleName: string;
    description?: string | null;
    permissions: string[]; // Array of permission IDs
}

interface UpdateRoleInput {
    roleId: string;
    // Make fields optional for update
    roleName?: string;
    description?: string | null;
    permissions?: string[]; // Allow updating permissions
}

interface DeleteRoleInput {
    roleId: string;
}

interface ListRolesInput {
    // Optional pagination/filtering parameters
    pageSize?: number;
    pageToken?: string;
}

interface RoleOutput {
    roleId: string;
    roleName?: string;
    description?: string | null;
    permissions: string[];
}

interface ListRolesOutput {
    roles: RoleOutput[];
    nextPageToken?: string | null;
}


// ============================================================================
// === Create Role Function ===================================================
// ============================================================================
export const createRole = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true; roleId: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createRole V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as CreateRoleInput;
        const logContext: any = { adminUserId, roleId: data?.roleId, roleName: data?.roleName };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (userSnap.exists) adminUserRole = (userSnap.data() as User)?.role;
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'rbac:role:create');
            if (!hasPermission) { return { success: false, error: "error.permissionDenied.createRole", errorCode: ErrorCode.PermissionDenied }; }
        } catch (e: any) { logger.error("Auth/Permission check failed", e); return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError }; }

        // 2. Input Validation
        if (!data?.roleId || typeof data.roleId !== 'string' || data.roleId.trim().length === 0 || data.roleId.includes('/') ||
            !data.roleName || typeof data.roleName !== 'string' || data.roleName.trim().length === 0 ||
            !Array.isArray(data.permissions) || data.permissions.some(p => typeof p !== 'string' || p.trim().length === 0))
        {
            logger.error(`${functionName} Invalid input data.`, { ...logContext, data });
            return { success: false, error: "error.invalidInput.roleData", errorCode: ErrorCode.InvalidArgument };
        }
        const { roleId, roleName, description, permissions } = data;
        const cleanedRoleId = roleId.trim(); // Use cleaned ID

        // TODO: Optional - Validate that all provided permission IDs actually exist in the 'permissions' collection?

        // 3. Create Role Document
        const roleRef = db.collection('roles').doc(cleanedRoleId);
        try {
            await roleRef.create({
                roleName: roleName.trim(),
                description: description?.trim() ?? null,
                permissions: [...new Set(permissions.map(p => p.trim()))], // Ensure unique permissions
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });
            logger.info(`${functionName} Role '${cleanedRoleId}' created successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("CreateRole", { roleId: cleanedRoleId, roleName, permissionsCount: permissions.length, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true, roleId: cleanedRoleId };

        } catch (error: any) {
            if (error.code === 6) { // Firestore ALREADY_EXISTS code
                logger.warn(`${functionName} Role ID '${cleanedRoleId}' already exists.`, logContext);
                return { success: false, error: "error.role.alreadyExists", errorCode: ErrorCode.AlreadyExists };
            }
            logger.error(`${functionName} Failed to create role '${cleanedRoleId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Update Role Function ===================================================
// ============================================================================
export const updateRole = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[updateRole V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as UpdateRoleInput;
        const logContext: any = { adminUserId, roleId: data?.roleId };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (userSnap.exists) adminUserRole = (userSnap.data() as User)?.role;
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'rbac:role:update');
            if (!hasPermission) { return { success: false, error: "error.permissionDenied.updateRole", errorCode: ErrorCode.PermissionDenied }; }
        } catch (e: any) { logger.error("Auth/Permission check failed", e); return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError }; }

        // 2. Input Validation
        if (!data?.roleId || typeof data.roleId !== 'string' || data.roleId.trim().length === 0) {
            logger.error(`${functionName} Invalid input: Missing roleId.`, logContext);
            return { success: false, error: "error.invalidInput.missingRoleId", errorCode: ErrorCode.InvalidArgument };
        }
        const { roleId, roleName, description, permissions } = data;
        const cleanedRoleId = roleId.trim();
        const updatePayload: Partial<RoleDoc> & { updatedAt: admin.firestore.FieldValue } = {
            updatedAt: FieldValue.serverTimestamp(),
        };
        let changesDetected = false;

        if (roleName !== undefined) {
            if (typeof roleName !== 'string' || roleName.trim().length === 0) return { success: false, error: "error.invalidInput.roleName", errorCode: ErrorCode.InvalidArgument };
            updatePayload.roleName = roleName.trim();
            changesDetected = true;
        }
        if (description !== undefined) {
            if (description !== null && typeof description !== 'string') return { success: false, error: "error.invalidInput.description", errorCode: ErrorCode.InvalidArgument };
            updatePayload.description = description === null ? null : description.trim();
            changesDetected = true;
        }
        if (permissions !== undefined) {
            if (!Array.isArray(permissions) || permissions.some(p => typeof p !== 'string' || p.trim().length === 0)) {
                return { success: false, error: "error.invalidInput.permissions", errorCode: ErrorCode.InvalidPermissionsArray };
            }
            updatePayload.permissions = [...new Set(permissions.map(p => p.trim()))];
            changesDetected = true;
            // TODO: Optional - Validate that all provided permission IDs actually exist?
        }

        if (!changesDetected) {
            logger.info(`${functionName} No changes detected for role '${cleanedRoleId}'.`, logContext);
            return { success: true }; // No update needed
        }

        // 3. Update Role Document
        const roleRef = db.collection('roles').doc(cleanedRoleId);
        try {
            await roleRef.update(updatePayload);
            logger.info(`${functionName} Role '${cleanedRoleId}' updated successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("UpdateRole", { roleId: cleanedRoleId, changes: Object.keys(updatePayload).filter(k => k !== 'updatedAt'), triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            if (error.code === 5) { // Firestore NOT_FOUND code
                logger.warn(`${functionName} Role '${cleanedRoleId}' not found for update.`, logContext);
                return { success: false, error: "error.role.notFound", errorCode: ErrorCode.RoleNotFound };
            }
            logger.error(`${functionName} Failed to update role '${cleanedRoleId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Delete Role Function ===================================================
// ============================================================================
export const deleteRole = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[deleteRole V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as DeleteRoleInput;
        const logContext: any = { adminUserId, roleId: data?.roleId };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (userSnap.exists) adminUserRole = (userSnap.data() as User)?.role;
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'rbac:role:delete');
            if (!hasPermission) { return { success: false, error: "error.permissionDenied.deleteRole", errorCode: ErrorCode.PermissionDenied }; }
        } catch (e: any) { logger.error("Auth/Permission check failed", e); return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError }; }

        // 2. Input Validation
        if (!data?.roleId || typeof data.roleId !== 'string' || data.roleId.trim().length === 0) {
            logger.error(`${functionName} Invalid input: Missing roleId.`, logContext);
            return { success: false, error: "error.invalidInput.missingRoleId", errorCode: ErrorCode.InvalidArgument };
        }
        const cleanedRoleId = data.roleId.trim();

        // 3. Optional: Check if role is assigned to any users before deleting
        // const usersWithRoleQuery = db.collection('users').where('role', '==', cleanedRoleId).limit(1);
        // const usersSnap = await usersWithRoleQuery.get();
        // if (!usersSnap.empty) {
        //     logger.warn(`${functionName} Cannot delete role '${cleanedRoleId}' as it is assigned to users.`, logContext);
        //     return { success: false, error: "error.role.cannotDeleteAssigned", errorCode: ErrorCode.CannotDeleteAssignedRole };
        // }

        // 4. Delete Role Document
        const roleRef = db.collection('roles').doc(cleanedRoleId);
        try {
            // Check if exists before deleting to return correct error
            const roleSnap = await roleRef.get();
            if (!roleSnap.exists) {
                 logger.warn(`${functionName} Role '${cleanedRoleId}' not found for deletion.`, logContext);
                 return { success: false, error: "error.role.notFound", errorCode: ErrorCode.RoleNotFound };
            }

            await roleRef.delete();
            logger.info(`${functionName} Role '${cleanedRoleId}' deleted successfully.`, logContext);

            // 5. Log Admin Action (Async)
            logAdminAction("DeleteRole", { roleId: cleanedRoleId, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 6. Return Success
            return { success: true };

        } catch (error: any) {
            logger.error(`${functionName} Failed to delete role '${cleanedRoleId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === List Roles Function ====================================================
// ============================================================================
export const listRoles = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true; data: ListRolesOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[listRoles V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as ListRolesInput; // Input might be empty
        const logContext: any = { adminUserId, pageSize: data?.pageSize, pageToken: data?.pageToken };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (userSnap.exists) adminUserRole = (userSnap.data() as User)?.role;
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'rbac:role:list');
            if (!hasPermission) { return { success: false, error: "error.permissionDenied.listRoles", errorCode: ErrorCode.PermissionDenied }; }
        } catch (e: any) { logger.error("Auth/Permission check failed", e); return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError }; }

        // 2. Prepare Query
        const pageSize = (typeof data?.pageSize === 'number' && data.pageSize > 0 && data.pageSize <= 100) ? data.pageSize : 20;
        let query: admin.firestore.Query<admin.firestore.DocumentData> = db.collection('roles').orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);

        if (data?.pageToken && typeof data.pageToken === 'string') {
            try {
                // For document ID based pagination, we need the last document ID from the previous page
                query = query.startAfter(data.pageToken);
            } catch (e) {
                logger.warn("Invalid page token provided", { pageToken: data.pageToken });
                // Ignore invalid token and start from beginning
            }
        }

        // 3. Execute Query
        try {
            const snapshot = await query.get();
            const roles: RoleOutput[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as RoleDoc;
                roles.push({
                    roleId: doc.id,
                    roleName: data.roleName,
                    description: data.description,
                    permissions: data.permissions ?? [],
                });
            });

            // Determine next page token (last document ID in this batch)
            let nextPageToken: string | null = null;
            if (snapshot.docs.length === pageSize) {
                nextPageToken = snapshot.docs[snapshot.docs.length - 1].id;
            }

            logger.info(`${functionName} Found ${roles.length} roles. Next page token: ${nextPageToken}`, logContext);

            // 4. Return Results
            return { success: true, data: { roles, nextPageToken } };

        } catch (error: any) {
            logger.error(`${functionName} Failed to list roles.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
