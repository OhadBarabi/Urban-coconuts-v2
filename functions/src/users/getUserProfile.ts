import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from "firebase-functions/logger";
import * as admin from 'firebase-admin';
import { User } from '../models';

const db = admin.firestore();

/**
 * Fetches the calling user's profile from the 'users' collection.
 * Requires the user to be authenticated.
 */
export const getUserProfile = onCall({ region: 'europe-west3' }, async (request) => {
  // 1. Authentication Check
  if (!request.auth) {
    logger.error("getUserProfile: Unauthenticated call.");
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  const uid = request.auth.uid;

  logger.info(`getUserProfile: Fetching profile for user ${uid}.`);

  try {
    // 2. Get User Document Reference
    const userRef = db.collection('users').doc(uid);

    // 3. Fetch Document
    const userSnap = await userRef.get();

    // 4. Validate Document Existence
    if (!userSnap.exists) {
      logger.warn(`getUserProfile: User profile not found for user ${uid}.`);
      throw new HttpsError('not-found', 'User profile not found.');
    }

    // 5. Get and Return Data
    const userData = userSnap.data() as User;
    logger.info(`getUserProfile: Successfully fetched profile for user ${uid}.`);
    return userData;

  } catch (error: any) {
    // 6. Error Handling
    if (error instanceof HttpsError) {
      // Re-throw HttpsErrors directly
      throw error;
    }
    logger.error(`getUserProfile: Error fetching profile for user ${uid}.`, { error: error?.message || error });
    throw new HttpsError('internal', 'An unexpected error occurred while fetching the user profile.');
  }
});