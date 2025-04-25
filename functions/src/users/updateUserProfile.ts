import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from "firebase-functions/logger";
import * as admin from 'firebase-admin';
import { User, PermissionKey, Role } from '../models';

const db = admin.firestore();

interface UpdateUserProfilePayload {
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
}
// --- Copied checkPermission function ---
/**
 * Checks if a user has a specific permission.
 * @param userId The ID of the user to check.
 * @param requiredPermission The permission key required for the action.
 * @returns A promise that resolves to true if the user has the permission, false otherwise.
 */
const checkPermission = async (userId: string, requiredPermission: PermissionKey): Promise<boolean> => {
  // Need to re-import dependencies used within this function if not already present
  // (Assuming logger, db, User, Role, PermissionKey are available from top-level imports)
  logger.info(`Checking permission ${requiredPermission} for user ${userId}`);
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists || !userDoc.data()?.isActive) {
      logger.warn(`checkPermission: User ${userId} not found or not active`);
      return false;
    }
    const user = userDoc.data() as User; // Need User type import
    const userRole = user.role;
    const roleDoc = await db.collection('roles').doc(userRole).get();
    if (!roleDoc.exists) {
      logger.warn(`checkPermission: Role definition not found for role: ${userRole}`);
      return false;
    }
    const role = roleDoc.data() as Role; // Need Role type import
    const rolePermissions = role.permissions;
    const hasPermission = rolePermissions.includes(requiredPermission);
    return hasPermission;
  } catch (error) {
    logger.error('checkPermission: Error checking permission', error);
    return false;
  }
};
// --- End of copied checkPermission function ---

/**
 * Updates the profile of the calling user.
 * Requires the user to be authenticated and have the 'user:update' permission.
 */
export const updateUserProfile = onCall({ region: 'europe-west3' }, async (request) => {
  // 1. Authentication Check
  if (!request.auth) {
    logger.error("updateUserProfile: Unauthenticated call.");
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  const uid = request.auth.uid;

  // 2. Permission Check
  const hasPermission = await checkPermission(uid, PermissionKey.UserUpdate);
  if (!hasPermission) {
    logger.error(`updateUserProfile: User ${uid} does not have permission to update user profile.`);
    throw new HttpsError('permission-denied', 'You do not have permission to update user profiles.');
  }

  // 3. Get Input Data
  const data = request.data as UpdateUserProfilePayload;

  logger.info('Updating profile for UID:', uid, { fields: Object.keys(data) });

  // 4. Input Validation
  if (!data || Object.keys(data).length === 0) {
    logger.warn(`updateUserProfile: Invalid or empty update data received for user ${uid}.`);
    throw new HttpsError('invalid-argument', 'Invalid or empty update data.');
  }

  // 5. Prepare Update Data
  const updateData: Partial<User> = {};
  if (data.firstName !== undefined) {
    updateData.firstName = data.firstName;
  }
  if (data.lastName !== undefined) {
    updateData.lastName = data.lastName;
  }
  if (data.phoneNumber !== undefined) {
    updateData.phoneNumber = data.phoneNumber;
  }
  updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp() as admin.firestore.Timestamp;

    const filteredData = { ...updateData };
    delete filteredData.updatedAt;

  if (Object.keys(filteredData).length === 0) {
        logger.warn(`updateUserProfile: No valid fields provided for update for user ${uid}.`);
        throw new HttpsError('invalid-argument', 'No valid fields provided for update.');
  }

  // 6. Update Document
  const userRef = db.collection('users').doc(uid);
  try {
    await userRef.update(updateData);
    logger.info(`updateUserProfile: User profile updated successfully for user ${uid}.`);
    return { success: true };
  } catch (error: any) {
    logger.error(`updateUserProfile: Error updating profile for user ${uid}.`, error);
    if (error instanceof HttpsError) {
        throw error
    }
    throw new HttpsError('internal', 'An unexpected error occurred while updating the user profile.');
  }
});