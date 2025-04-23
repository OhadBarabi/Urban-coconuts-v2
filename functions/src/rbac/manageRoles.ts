import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Role } from '../models'; // Adjust path if needed

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
    NotFound = "NOT_FOUND", // Role or User not found
    AlreadyExists = "ALREADY_EXISTS", // Role ID already exists on create
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    RoleNotFound = "ROLE_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND", // Admin user not found
    InvalidPermissionsArray = "INVALID_PERMISSIONS_ARRAY",
}

// --- Interfaces ---
interface CreateRoleInput {
    roleId: string; // The unique identifier for the role (e.g., "CustomerServiceLead")
    roleName: string; // Human-readable name
    description?: string | null;
    permissions: string[]; // Array of permission strings (e.g., "order:cancel:any", "user:list")
}

interface UpdateRoleInput {
    roleId: string; // ID of the role to update
    roleName?: string | null;
    description?: string | null;
    permissions?: string[] | null; // Allow updating permissions
}

interface DeleteRoleInput {
    roleId: string; // ID of the role to delete (or mark inactive)
}

interface ListRolesInput {
    pageSize?: number;
    pageToken?: string; // Use roleId as page token
}

interface RoleOutput extends Omit<Role, 'createdAt' | 'updatedAt'> {
    // Convert Timestamps to ISO strings for client if needed
    createdAt?: string | null;
    updatedAt?: string | null;
    // Add roleId explicitly if not part of Role model by default
    roleId: string;
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
        const functionName = "[createRole V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as CreateRoleInput;
        const logContext: any = { adminUserId, roleId: data?.roleId, roleName: data?.roleName };

        logger.info(`${functionName} Invoked.`, logContext);

        // Fetch admin user role for permission check
        let adminUserRole: string | null = null;
        try {
            const adminUserSnap = await db.collection('users').doc(adminUserId).get();
            if (!adminUserSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (adminUserSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check (Using REAL helper) - Define permission: 'admin:role:create'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:role:create', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to create role.`, logContext);
                return { success: false, error: "error.permissionDenied.createRole", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             // Distinguish between HttpsError and other errors if needed
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.roleId || typeof data.roleId !== 'string' || data.roleId.trim().length === 0 || data.roleId.includes('/') ||
            !data?.roleName || typeof data.roleName !== 'string' || data.roleName.trim().length === 0 ||
            !Array.isArray(data.permissions) || data.permissions.some(p => typeof p !== 'string' || p.trim().length === 0) ||
            (data.description != null && typeof data.description !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            let errorCode = ErrorCode.InvalidArgument;
            if (!Array.isArray(data.permissions) || data.permissions.some(p => typeof p !== 'string' || p.trim().length === 0)) {
                 errorCode = ErrorCode.InvalidPermissionsArray;
            }
            return { success: false, error: "error.invalidInput.roleData", errorCode: errorCode };
        }
        const { roleId, roleName, description, permissions } = data;
        const cleanRoleId = roleId.trim(); // Use trimmed ID

        // 3. Create Role Document
        const roleRef = db.collection('roles').doc(cleanRoleId);
        try {
            const newRoleData: Role = {
                roleName: roleName.trim(),
                description: description?.trim() ?? null,
                permissions: [...new Set(permissions.map(p => p.trim()))], // Store unique, trimmed permissions
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
                // isActive: true, // Add if roles can be deactivated
            };

            await roleRef.create(newRoleData); // create() fails if document already exists
            logger.info(`${functionName} Role '${cleanRoleId}' created successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("CreateRole", { roleId: cleanRoleId, data: newRoleData, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true, roleId: cleanRoleId };

        } catch (error: any) {
            if (error.code === 6) { // Firestore ALREADY_EXISTS code
                logger.warn(`${functionName} Role ID '${cleanRoleId}' already exists.`, logContext);
                return { success: false, error: "error.role.alreadyExists", errorCode: ErrorCode.AlreadyExists };
            }
            logger.error(`${functionName} Failed to create role '${cleanRoleId}'.`, { ...logContext, error: error.message });
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
        const functionName = "[updateRole V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as UpdateRoleInput;
        const logContext: any = { adminUserId, roleId: data?.roleId };

        logger.info(`${functionName} Invoked.`, logContext);

        // Fetch admin user role for permission check
        let adminUserRole: string | null = null;
        try {
            const adminUserSnap = await db.collection('users').doc(adminUserId).get();
            if (!adminUserSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (adminUserSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check (Using REAL helper) - Define permission: 'admin:role:update'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:role:update', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to update role.`, logContext);
                return { success: false, error: "error.permissionDenied.updateRole", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.roleId || typeof data.roleId !== 'string' || data.roleId.trim().length === 0) {
            return { success: false, error: "error.invalidInput.missingRoleId", errorCode: ErrorCode.InvalidArgument };
        }
        const roleId = data.roleId.trim();
        logContext.roleId = roleId; // Update log context with trimmed ID

        const updatePayload: { [key: string]: any } = {};
        let changesDetected = false;

        if (data.roleName !== undefined) {
            if (data.roleName === null || (typeof data.roleName === 'string' && data.roleName.trim().length > 0)) {
                 updatePayload.roleName = data.roleName === null ? null : data.roleName.trim(); changesDetected = true;
            } else return { success: false, error: "error.invalidInput.roleName", errorCode: ErrorCode.InvalidArgument };
        }
        if (data.description !== undefined) {
             if (data.description === null || typeof data.description === 'string') {
                  updatePayload.description = data.description === null ? null : data.description.trim(); changesDetected = true;
             } else return { success: false, error: "error.invalidInput.description", errorCode: ErrorCode.InvalidArgument };
        }
        if (data.permissions !== undefined) {
             if (data.permissions === null || (Array.isArray(data.permissions) && data.permissions.every(p => typeof p === 'string' && p.trim().length > 0))) {
                 updatePayload.permissions = data.permissions === null ? null : [...new Set(data.permissions.map(p => p.trim()))]; changesDetected = true;
             } else {
                  logger.error(`${functionName} Invalid permissions array format.`, logContext);
                  return { success: false, error: "error.invalidInput.permissions", errorCode: ErrorCode.InvalidPermissionsArray };
             }
        }
        // Add isActive toggle if needed:
        // if (data.isActive !== undefined) { if(typeof data.isActive !== 'boolean') return { ... }; updatePayload.isActive = data.isActive; changesDetected = true; }


        if (!changesDetected) {
            logger.info(`${functionName} No changes detected for role '${roleId}'.`, logContext);
            return { success: true }; // No update needed
        }

        updatePayload.updatedAt = FieldValue.serverTimestamp(); // Add timestamp

        // 3. Update Role Document
        const roleRef = db.collection('roles').doc(roleId);
        try {
            await roleRef.update(updatePayload); // update() fails if document doesn't exist
            logger.info(`${functionName} Role '${roleId}' updated successfully.`, logContext);

            // Clear cache for this role
            roleCache.delete(roleId);

            // 4. Log Admin Action (Async)
            logAdminAction("UpdateRole", { roleId, changes: Object.keys(updatePayload).filter(k => k !== 'updatedAt'), triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            if (error.code === 5) { // Firestore NOT_FOUND code
                logger.warn(`${functionName} Role '${roleId}' not found for update.`, logContext);
                return { success: false, error: "error.role.notFound", errorCode: ErrorCode.RoleNotFound };
            }
            logger.error(`${functionName} Failed to update role '${roleId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Delete Role Function ===================================================
// ============================================================================
// Note: Consider marking as inactive instead of hard deleting, especially if users have this role assigned.
// This implementation performs a hard delete. Add inactive logic if preferred.
export const deleteRole = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[deleteRole V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as DeleteRoleInput;
        const logContext: any = { adminUserId, roleId: data?.roleId };

        logger.info(`${functionName} Invoked.`, logContext);

         // Fetch admin user role for permission check
         let adminUserRole: string | null = null;
         try {
             const adminUserSnap = await db.collection('users').doc(adminUserId).get();
             if (!adminUserSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
             adminUserRole = (adminUserSnap.data() as User)?.role;
             logContext.adminUserRole = adminUserRole;

             // Permission Check (Using REAL helper) - Define permission: 'admin:role:delete'
             const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:role:delete', logContext);
             if (!hasPermission) {
                 logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to delete role.`, logContext);
                 return { success: false, error: "error.permissionDenied.deleteRole", errorCode: ErrorCode.PermissionDenied };
             }
         } catch (e: any) {
              logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
              const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
              const msg = e instanceof HttpsError ? e.message : "error.internalServer";
              return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
         }

        // 2. Input Validation
        if (!data?.roleId || typeof data.roleId !== 'string' || data.roleId.trim().length === 0) {
            return { success: false, error: "error.invalidInput.missingRoleId", errorCode: ErrorCode.InvalidArgument };
        }
        const roleId = data.roleId.trim();
        logContext.roleId = roleId;

        // TODO: Add check: Is this role assigned to any users? Prevent deletion if assigned?
        // const usersWithRole = await db.collection('users').where('role', '==', roleId).limit(1).get();
        // if (!usersWithRole.empty) {
        //     logger.warn(`${functionName} Cannot delete role '${roleId}' as it is assigned to users.`, logContext);
        //     return { success: false, error: "error.role.inUse", errorCode: ErrorCode.FailedPrecondition };
        // }

        // 3. Delete Role Document
        const roleRef = db.collection('roles').doc(roleId);
        try {
            // Check if exists before deleting to provide better error message
            const roleSnap = await roleRef.get();
            if (!roleSnap.exists) {
                 logger.warn(`${functionName} Role '${roleId}' not found for deletion.`, logContext);
                 return { success: false, error: "error.role.notFound", errorCode: ErrorCode.RoleNotFound };
            }

            await roleRef.delete();
            logger.info(`${functionName} Role '${roleId}' deleted successfully.`, logContext);

             // Clear cache for this role
             roleCache.delete(roleId);

            // 4. Log Admin Action (Async)
            logAdminAction("DeleteRole", { roleId, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            // delete() doesn't throw specific error if doc doesn't exist after check, but handle others
            logger.error(`${functionName} Failed to delete role '${roleId}'.`, { ...logContext, error: error.message });
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
        const functionName = "[listRoles V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as ListRolesInput; // Input might be empty
        const logContext: any = { adminUserId, pageSize: data?.pageSize, pageToken: data?.pageToken };

        logger.info(`${functionName} Invoked.`, logContext);

         // Fetch admin user role for permission check
         let adminUserRole: string | null = null;
         try {
             const adminUserSnap = await db.collection('users').doc(adminUserId).get();
             if (!adminUserSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
             adminUserRole = (adminUserSnap.data() as User)?.role;
             logContext.adminUserRole = adminUserRole;

             // Permission Check (Using REAL helper) - Define permission: 'admin:role:list'
             const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:role:list', logContext);
             if (!hasPermission) {
                 logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to list roles.`, logContext);
                 return { success: false, error: "error.permissionDenied.listRoles", errorCode: ErrorCode.PermissionDenied };
             }
         } catch (e: any) {
              logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
              const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
              const msg = e instanceof HttpsError ? e.message : "error.internalServer";
              return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
         }

        // 2. Prepare Query
        const pageSize = (typeof data?.pageSize === 'number' && data.pageSize > 0 && data.pageSize <= 100) ? data.pageSize : 20;
        let query: admin.firestore.Query<admin.firestore.DocumentData> = db.collection('roles');

        // Add ordering and pagination (using roleId / document ID for pagination token)
        query = query.orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
        if (data?.pageToken && typeof data.pageToken === 'string') {
            try {
                // Fetch the document snapshot for the page token to use in startAfter
                // const pageTokenDoc = await db.collection('roles').doc(data.pageToken).get();
                // if (pageTokenDoc.exists) {
                //     query = query.startAfter(pageTokenDoc);
                // } else {
                //      logger.warn("Page token document not found, ignoring token.", { pageToken: data.pageToken });
                // }
                 // Simpler: Use document ID directly if that's the token
                 query = query.startAfter(data.pageToken);

            } catch (e) {
                logger.warn("Invalid page token provided or query failed.", { pageToken: data.pageToken, error: e });
                // Proceed without pagination if token is bad
            }
        }

        // 3. Execute Query
        try {
            const snapshot = await query.get();
            const roles: RoleOutput[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as Role;
                // Convert Timestamps to ISO strings if needed by client
                const outputData: RoleOutput = {
                    roleId: doc.id, // Add the document ID as roleId
                    roleName: data.roleName,
                    description: data.description,
                    permissions: data.permissions,
                    // createdAt: data.createdAt?.toDate().toISOString() ?? null,
                    // updatedAt: data.updatedAt?.toDate().toISOString() ?? null,
                };
                roles.push(outputData);
            });

            // Determine next page token
            let nextPageToken: string | null = null;
            if (snapshot.docs.length === pageSize) {
                nextPageToken = snapshot.docs[snapshot.docs.length - 1].id; // Use roleId (doc ID) as token
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
