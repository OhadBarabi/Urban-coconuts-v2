import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, PermissionDoc, RoleDoc } from '../models'; // Adjust path if needed

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
const auth = admin.auth(); // For setting custom claims
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User, Role, or Permission not found
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND",
    RoleNotFound = "ROLE_NOT_FOUND",
    FirebaseAuthError = "FIREBASE_AUTH_ERROR",
}

// --- Interfaces ---
interface ListPermissionsInput {
    // Optional pagination/filtering parameters
    pageSize?: number;
    pageToken?: string;
    category?: string; // Filter by category
}

interface PermissionOutput {
    permissionId: string;
    description?: string | null;
    category?: string | null;
}

interface ListPermissionsOutput {
    permissions: PermissionOutput[];
    nextPageToken?: string | null;
}

interface AssignRoleToUserInput {
    userId: string; // UID of the target user
    roleId: string; // ID of the role to assign
}


// ============================================================================
// === List Permissions Function ==============================================
// ============================================================================
export const listPermissions = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true; data: ListPermissionsOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[listPermissions V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as ListPermissionsInput; // Input might be empty
        const logContext: any = { adminUserId, pageSize: data?.pageSize, pageToken: data?.pageToken, category: data?.category };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (userSnap.exists) adminUserRole = (userSnap.data() as User)?.role;
            // Allow any authenticated user to list permissions? Or restrict to admin? Let's restrict.
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'rbac:permission:list');
            if (!hasPermission) { return { success: false, error: "error.permissionDenied.listPermissions", errorCode: ErrorCode.PermissionDenied }; }
        } catch (e: any) { logger.error("Auth/Permission check failed", e); return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError }; }

        // 2. Prepare Query
        const pageSize = (typeof data?.pageSize === 'number' && data.pageSize > 0 && data.pageSize <= 100) ? data.pageSize : 50; // Default 50
        let query: admin.firestore.Query<admin.firestore.DocumentData> = db.collection('permissions');

        // Add category filter if provided
        if (data?.category && typeof data.category === 'string') {
            query = query.where('category', '==', data.category);
        }

        // Add ordering and pagination
        query = query.orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
        if (data?.pageToken && typeof data.pageToken === 'string') {
            try {
                query = query.startAfter(data.pageToken);
            } catch (e) {
                logger.warn("Invalid page token provided", { pageToken: data.pageToken });
            }
        }

        // 3. Execute Query
        try {
            const snapshot = await query.get();
            const permissions: PermissionOutput[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as PermissionDoc;
                permissions.push({
                    permissionId: doc.id,
                    description: data.description,
                    category: data.category,
                });
            });

            // Determine next page token
            let nextPageToken: string | null = null;
            if (snapshot.docs.length === pageSize) {
                nextPageToken = snapshot.docs[snapshot.docs.length - 1].id;
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
// === Assign Role To User Function ===========================================
// ============================================================================
export const assignRoleToUser = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "256MiB" }, // Slightly more memory for multiple reads/writes
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[assignRoleToUser V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as AssignRoleToUserInput;
        const logContext: any = { adminUserId, targetUserId: data?.userId, roleId: data?.roleId };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (userSnap.exists) adminUserRole = (userSnap.data() as User)?.role;
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'rbac:user:assign_role');
            if (!hasPermission) { return { success: false, error: "error.permissionDenied.assignRole", errorCode: ErrorCode.PermissionDenied }; }
        } catch (e: any) { logger.error("Auth/Permission check failed", e); return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError }; }

        // 2. Input Validation
        if (!data?.userId || typeof data.userId !== 'string' ||
            !data.roleId || typeof data.roleId !== 'string')
        {
            logger.error(`${functionName} Invalid input: Missing userId or roleId.`, logContext);
            return { success: false, error: "error.invalidInput.userIdOrRoleId", errorCode: ErrorCode.InvalidArgument };
        }
        const { userId: targetUserId, roleId } = data;

        // 3. Fetch Target User & Role (Concurrent)
        const targetUserRef = db.collection('users').doc(targetUserId);
        const roleRef = db.collection('roles').doc(roleId);

        try {
            const [targetUserSnap, roleSnap] = await Promise.all([targetUserRef.get(), roleRef.get()]);

            // Validate Target User
            if (!targetUserSnap.exists) {
                logger.warn(`${functionName} Target user '${targetUserId}' not found.`, logContext);
                return { success: false, error: "error.user.notFound", errorCode: ErrorCode.UserNotFound };
            }
            const targetUserData = targetUserSnap.data() as User;
            logContext.targetUserCurrentRole = targetUserData.role;

            // Validate Role
            if (!roleSnap.exists) {
                logger.warn(`${functionName} Role '${roleId}' not found.`, logContext);
                return { success: false, error: "error.role.notFound", errorCode: ErrorCode.RoleNotFound };
            }
            // const roleData = roleSnap.data() as RoleDoc; // Not strictly needed here

             // Prevent self-assignment change? Or assigning higher roles? Add checks if needed.

             // Idempotency: Check if user already has this role
             if (targetUserData.role === roleId) {
                 logger.info(`${functionName} User '${targetUserId}' already has role '${roleId}'. No update needed.`, logContext);
                 return { success: true };
             }

            // 4. Update Firestore User Document
            logger.info(`${functionName} Updating Firestore role for user '${targetUserId}' to '${roleId}'.`, logContext);
            await targetUserRef.update({
                role: roleId,
                updatedAt: FieldValue.serverTimestamp(),
            });

            // 5. Set Custom Claim in Firebase Auth
            // This is crucial for enforcing rules based on role in Firestore/Storage/Functions
            logger.info(`${functionName} Setting custom claim 'role=${roleId}' for user '${targetUserId}'.`, logContext);
            await auth.setCustomUserClaims(targetUserId, { role: roleId });
            // Note: Client needs to refresh ID token to get the new claim (e.g., user.getIdToken(true))

            logger.info(`${functionName} Role '${roleId}' assigned successfully to user '${targetUserId}'.`, logContext);

            // 6. Log Admin Action (Async)
            logAdminAction("AssignRoleToUser", { targetUserId, oldRole: targetUserData.role, newRole: roleId, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 7. Return Success
            return { success: true };

        } catch (error: any) {
            if (error instanceof HttpsError) throw error; // Re-throw HttpsErrors

            if ((error as any)?.code === 5) { // Firestore NOT_FOUND (should be caught above, but defensive)
                 logger.error(`${functionName} User or Role not found during assignment.`, { ...logContext, error: error.message });
                 return { success: false, error: "error.notFound", errorCode: ErrorCode.NotFound };
            }
            if ((error as any)?.code?.startsWith('auth/')) { // Firebase Auth errors
                logger.error(`${functionName} Firebase Auth error setting custom claim for user '${targetUserId}'.`, { ...logContext, error: error.message, code: (error as any).code });
                 // Should we revert the Firestore update? Complex. Log critical error for now.
                 logAdminAction("AssignRoleFailedAuth", { targetUserId, roleId, reason: error.message, code: (error as any).code, triggerUserId: adminUserId }).catch(...);
                 return { success: false, error: "error.auth.setClaimsFailed", errorCode: ErrorCode.FirebaseAuthError };
            }

            logger.error(`${functionName} Failed to assign role '${roleId}' to user '${targetUserId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
