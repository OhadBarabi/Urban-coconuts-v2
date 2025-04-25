import * as functions from 'firebase-functions';
import * as logger from "firebase-functions/logger";
import * as admin from 'firebase-admin';
const db = admin.firestore();
import { User, UserRole } from '../models';

/**
 * This function is triggered when a new user is created using the v1 `functions.auth.user().onCreate` trigger.
 */
export const onUserCreate = functions.region('europe-west3').auth.user().onCreate((user: functions.auth.UserRecord) => {
  const uid = user.uid;
  const email = user.email || '';

  logger.info(`New user created: ${uid}`);

  const newUserProfile: User = {
    userId: uid,
    email: email,
    firstName: '',
    lastName: '',
    role: UserRole.Customer,
    isActive: true,
    mfaEnabled: false,
    paymentGatewayCustomerId: undefined,
    vipTier: undefined,
    createdAt: admin.firestore.FieldValue.serverTimestamp() as admin.firestore.Timestamp,
    updatedAt: admin.firestore.FieldValue.serverTimestamp() as admin.firestore.Timestamp,
  };

  const userRef = db.collection('users').doc(uid);
  return userRef.set(newUserProfile)
    .then(() => {
      logger.info(`User profile created successfully for user: ${uid}`);
    })
    .catch((error) => {
      logger.error(`Error creating user profile for user: ${uid}`, error);
    });
});