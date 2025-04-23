/**
 * permissions.ts
 *
 * Helper module for checking user permissions based on roles and specific user overrides.
 */

import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { User, Role } from '../models'; // Adjust path if needed

// --- Configuration ---
const db = admin.firestore();

// --- Cache for Roles (Optional Optimization) ---
// Simple in-memory cache to reduce Firestore reads for role definitions.
// Consider using a more robust caching mechanism (like Redis or MemoryStore) for high-load scenarios.
interface RoleCacheEntry {
    permissions: Set<string>;
    timestamp: number;
}
const roleCache = new Map<string, RoleCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // Cache roles for 5 minutes

/**
 * Fetches role permissions, utilizing an in-memory cache.
 * @param roleId - The ID/name of the role to fetch.
 * @returns A Set of permission strings for the role, or null if not found/error.
 */
async function getRolePermissions(roleId: string): Promise<Set<string> | null> {
    const functionName = "[getRolePermissions]";
    const cachedEntry = roleCache.get(roleId);
    const now = Date.now();

    // Check cache validity
    if (cachedEntry && (now - cachedEntry.timestamp < CACHE_TTL_MS)) {
        // logger.debug(`${functionName} Cache hit for role: ${roleId}`);
        return cachedEntry.permissions;
    }

    // logger.debug(`${functionName} Cache miss or expired for role: ${roleId}. Fetching from Firestore...`);
    try {
        const roleRef = db.collection('roles').doc(roleId);
        const roleSnap = await roleRef.get();

        if (!roleSnap.exists) {
            logger.warn(`${functionName} Role document not found: ${roleId}`);
            return null; // Role doesn't exist
        }

        const roleData = roleSnap.data() as Role;
        const permissions = new Set(roleData.permissions || []); // Ensure permissions is an array

        // Update cache
        roleCache.set(roleId, { permissions, timestamp: now });
        // logger.debug(`${functionName} Role ${roleId} fetched and cached with ${permissions.size} permissions.`);

        return permissions;
    } catch (error: any) {
        logger.error(`${functionName} Failed to fetch role ${roleId} from Firestore.`, { error: error.message });
        return null; // Error fetching role
    }
}

// ============================================================================
// === Check Permission =======================================================
// ============================================================================
/**
 * Checks if a user has a specific permission.
 * Verifies against direct user permissions first, then checks the user's role permissions.
 *
 * @param userId - The ID of the user to check. Can be null for unauthenticated checks.
 * @param userRole - The role of the user (optional, will be fetched if not provided).
 * @param permissionId - The specific permission string to check for (e.g., 'order:create', 'admin:user:list').
 * @param context - Optional context object for logging.
 * @returns Promise<boolean> - True if the user has the permission, false otherwise.
 */
export async function checkPermission(
    userId: string | null,
    userRole: string | null | undefined, // Allow undefined for flexibility
    permissionId: string,
    context?: any
): Promise<boolean> {
    const functionName = "[checkPermission]";
    const logContext = { userId, permissionId, providedRole: userRole, ...(context || {}) };

    // 1. Handle Unauthenticated Users
    if (!userId) {
        // logger.debug(`${functionName} Permission check failed: No user ID provided (unauthenticated).`, logContext);
        return false; // Unauthenticated users generally have no permissions
    }

    // 2. Fetch User Data if Role not provided or to check specific permissions
    let userData: User | null = null;
    let fetchedRole = userRole; // Use provided role initially

    try {
        const userRef = db.collection('users').doc(userId);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
            logger.warn(`${functionName} Permission check failed: User document not found: ${userId}`, logContext);
            return false; // User doesn't exist
        }
        userData = userSnap.data() as User;

        // Check if user is active
        if (!userData.isActive) {
            // logger.debug(`${functionName} Permission check failed: User ${userId} is inactive.`, logContext);
            return false;
        }

        // Use fetched role if none was provided
        if (!fetchedRole) {
            fetchedRole = userData.role;
            // logger.debug(`${functionName} Fetched role '${fetchedRole}' for user ${userId}.`, logContext);
        } else if (fetchedRole !== userData.role) {
             logger.warn(`${functionName} Provided role '${userRole}' mismatches fetched role '${userData.role}' for user ${userId}. Using fetched role.`, logContext);
             fetchedRole = userData.role; // Trust the database record
        }

        // 3. Check Direct User Permissions (Overrides Role)
        if (userData.permissions && Array.isArray(userData.permissions) && userData.permissions.includes(permissionId)) {
            // logger.debug(`${functionName} Permission '${permissionId}' granted via direct user assignment for user ${userId}.`, logContext);
            return true; // Permission granted via direct assignment
        }

        // 4. Check Role Permissions
        if (!fetchedRole) {
            // logger.debug(`${functionName} Permission check failed: User ${userId} has no assigned role.`, logContext);
            return false; // No role assigned
        }

        const rolePermissions = await getRolePermissions(fetchedRole);

        if (rolePermissions === null) {
            // Error fetching role or role doesn't exist
            logger.warn(`${functionName} Could not retrieve permissions for role '${fetchedRole}'. Denying permission '${permissionId}' for user ${userId}.`, logContext);
            return false;
        }

        if (rolePermissions.has(permissionId)) {
            // logger.debug(`${functionName} Permission '${permissionId}' granted via role '${fetchedRole}' for user ${userId}.`, logContext);
            return true; // Permission granted via role
        }

        // 5. Permission Denied
        // logger.debug(`${functionName} Permission '${permissionId}' denied for user ${userId} (Role: ${fetchedRole}).`, logContext);
        return false;

    } catch (error: any) {
        logger.error(`${functionName} An error occurred during permission check for user ${userId}, permission ${permissionId}.`, { ...logContext, error: error.message });
        return false; // Deny permission on error
    }
}

// Example of a higher-order function to wrap Cloud Functions with permission checks
// (Consider placing this elsewhere or adapting as needed)
/*
export function requirePermission(permissionId: string) {
    return (handler: functions.https.CallableHandler) => {
        return async (request: functions.https.CallableRequest) => {
            if (!request.auth?.uid) {
                throw new HttpsError('unauthenticated', 'Authentication required.');
            }
            const hasPerm = await checkPermission(request.auth.uid, null, permissionId); // Fetches role internally
            if (!hasPerm) {
                 logger.warn(`[Permission Wrapper] User ${request.auth.uid} denied access to function requiring '${permissionId}'.`);
                throw new HttpsError('permission-denied', `Permission denied: ${permissionId}`);
            }
            // If permission granted, proceed with the original handler
            return handler(request);
        };
    };
}
*/
