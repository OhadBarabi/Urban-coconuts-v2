/**
 * notifications.ts
 *
 * Helper module for sending push notifications to users.
 *
 * Prerequisites for Real Implementation (using FCM):
 * 1. Ensure Firebase Admin SDK is initialized (done in index.ts).
 * 2. Users need to grant permission for notifications in the client app (Flutter).
 * 3. The client app needs to obtain the FCM registration token for the device.
 * 4. The FCM token needs to be stored securely, typically associated with the user's document in Firestore
 * (e.g., in a subcollection 'fcmTokens' or an array field 'fcmTokens' on the user document).
 *
 * TODO: Replace MOCK implementation with actual FCM sending logic using `admin.messaging()`.
 */

import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin"; // Needed for potential FCM implementation

// --- Configuration ---
const MOCK_NOTIFICATION_DELAY_MS = 200; // Simulate short delay

// --- Interfaces ---

// Defines the structure for sending a notification
export interface NotificationPayload {
    userId: string; // Target user ID (to potentially fetch their FCM token(s))
    type: string; // Internal type for logging or client-side routing (e.g., "OrderUpdate", "TipReceived", "EventReminder")
    titleKey: string; // i18n key for the notification title
    messageKey: string; // i18n key for the notification body
    messageParams?: { [key: string]: any }; // Parameters for localizing the message body
    // Optional data payload for the client app to handle clicks/actions
    payload?: { [key: string]: string }; // e.g., { screen: 'orderDetails', orderId: '123' }
    // Optional: Direct FCM token if known (e.g., for testing)
    fcmToken?: string | null;
}

// ============================================================================
// === Send Push Notification =================================================
// ============================================================================
/**
 * Sends a push notification to a specific user.
 *
 * TODO: Replace MOCK with actual FCM implementation.
 * This involves:
 * 1. Fetching the user's FCM registration token(s) from Firestore based on userId.
 * 2. Constructing the FCM message payload (notification title/body, data payload).
 * 3. Using `admin.messaging().sendToDevice()` or `sendMulticast()` to send the message.
 * 4. Handling potential errors (e.g., invalid tokens, unregistered tokens).
 * 5. Implementing logic to remove invalid/unregistered tokens from Firestore.
 *
 * @param notification - The notification details.
 * @returns Promise<void>
 */
export async function sendPushNotification(notification: NotificationPayload): Promise<void> {
    const operation = "sendPushNotification";
    const logContext = { userId: notification.userId, type: notification.type, titleKey: notification.titleKey };
    logger.info(`[${operation}] Called (MOCK)`, logContext);

    if (!notification.userId) {
        logger.error(`[${operation}] Missing userId in notification payload.`, notification);
        return; // Cannot send without a target user
    }

    // --- MOCK IMPLEMENTATION ---
    logger.warn(`[${operation}] Using MOCK implementation. No real notification sent to user ${notification.userId}.`);
    await new Promise(res => setTimeout(res, MOCK_NOTIFICATION_DELAY_MS));
    logger.info(`[${operation}] Mock notification details:`, {
        titleKey: notification.titleKey,
        messageKey: notification.messageKey,
        params: notification.messageParams,
        payload: notification.payload,
        targetToken: notification.fcmToken // Log if a specific token was provided for testing
    });
    // Simulate success for now
    // In a real implementation, handle errors from admin.messaging()
    // --- END MOCK ---


    /*
    // --- EXAMPLE REAL IMPLEMENTATION (Conceptual - FCM) ---
    try {
        // 1. Fetch User's FCM Tokens
        const userRef = admin.firestore().collection('users').doc(notification.userId);
        // Assuming tokens are stored in an array field 'fcmTokens' on the user doc
        // Or in a subcollection 'fcmTokens'
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
            logger.error(`[${operation}] User ${notification.userId} not found. Cannot send notification.`);
            return;
        }
        const userData = userSnap.data();
        const tokens: string[] = userData?.fcmTokens || []; // Get tokens from user document

        // Or fetch from subcollection:
        // const tokensSnap = await userRef.collection('fcmTokens').get();
        // const tokens = tokensSnap.docs.map(doc => doc.id); // Assuming token is the doc ID

        if (!tokens || tokens.length === 0) {
            logger.warn(`[${operation}] No FCM tokens found for user ${notification.userId}. Cannot send notification.`);
            return;
        }

        // 2. Construct FCM Message Payload
        // TODO: Implement localization based on titleKey, messageKey, messageParams and user's preferred language
        const localizedTitle = `[${notification.titleKey}]`; // Replace with actual localization
        const localizedBody = `[${notification.messageKey}]`; // Replace with actual localization

        const message: admin.messaging.MulticastMessage = {
            notification: {
                title: localizedTitle,
                body: localizedBody,
                // imageUrl: '...', // Optional image
            },
            data: notification.payload || {}, // Custom data payload for client app
            tokens: tokens, // Target the user's registered device tokens
            // Optional: Android/APNS specific config
            // android: { notification: { sound: 'default', channelId: '...' } },
            // apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        };

        // 3. Send the Message using Admin SDK
        logger.info(`[${operation}] Sending FCM notification to ${tokens.length} tokens for user ${notification.userId}...`, logContext);
        const response = await admin.messaging().sendEachForMulticast(message); // Use sendEachForMulticast for multiple tokens

        // 4. Process Responses and Handle Errors/Cleanup
        const tokensToRemove: string[] = [];
        response.responses.forEach((resp, idx) => {
            const token = tokens[idx];
            if (!resp.success) {
                logger.error(`[${operation}] Failed to send notification to token ${token} for user ${notification.userId}.`, { error: resp.error });
                // Check for errors indicating the token is invalid or unregistered
                if (resp.error.code === 'messaging/invalid-registration-token' ||
                    resp.error.code === 'messaging/registration-token-not-registered') {
                    tokensToRemove.push(token);
                }
            } else {
                 logger.info(`[${operation}] Successfully sent notification to token ${token}. Message ID: ${resp.messageId}`);
            }
        });

        // 5. Remove Invalid Tokens from Firestore (Important for efficiency)
        if (tokensToRemove.length > 0) {
            logger.warn(`[${operation}] Removing ${tokensToRemove.length} invalid FCM tokens for user ${notification.userId}.`, { tokens: tokensToRemove });
            // Update the user document (or delete from subcollection)
            await userRef.update({
                fcmTokens: FieldValue.arrayRemove(...tokensToRemove)
            });
            // Or delete from subcollection:
            // const batch = admin.firestore().batch();
            // tokensToRemove.forEach(token => batch.delete(userRef.collection('fcmTokens').doc(token)));
            // await batch.commit();
        }

    } catch (error: any) {
        logger.error(`[${operation}] General error sending push notification for user ${notification.userId}.`, { ...logContext, error: error.message });
    }
    // --- END REAL IMPLEMENTATION EXAMPLE ---
    */
}
