import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

// --- Import Models ---
import { User, Order, OrderStatus, AppConfigVipSettings } from '../models'; // Adjust path if needed

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const BATCH_SIZE = 200; // Number of users to process in each Firestore batch write

// --- Helper to get VIP settings from AppConfig ---
async function getVipSettings(): Promise<AppConfigVipSettings | null> {
    try {
        const configSnap = await db.collection('appConfig').doc('vipSettings').get();
        if (configSnap.exists) {
            return configSnap.data() as AppConfigVipSettings;
        }
        logger.warn("VIP settings not found in appConfig/vipSettings.");
        return null;
    } catch (error) {
        logger.error("Failed to fetch VIP settings.", { error });
        return null;
    }
}

// --- Helper to determine VIP tier based on spending ---
function determineTier(totalSpent: number, settings: AppConfigVipSettings): string | null {
    // Sort rules by threshold descending to find the highest applicable tier
    const sortedRules = settings.rules.sort((a, b) => b.minSpendThresholdSmallestUnit - a.minSpendThresholdSmallestUnit);

    for (const rule of sortedRules) {
        if (totalSpent >= rule.minSpendThresholdSmallestUnit) {
            return rule.tierName; // e.g., "Gold", "Silver"
        }
    }
    return null; // No tier met
}

// --- The Scheduled Function ---
// Schedule: e.g., Run daily at 2:00 AM Israel time
export const calculateVipTiers = functions.scheduler.onSchedule(
    {
        schedule: "every day 02:00", // Adjust schedule as needed (e.g., "every sunday 03:00")
        timeZone: "Asia/Jerusalem",
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow more memory for potentially large queries/processing
        timeoutSeconds: 540, // Max timeout for scheduled functions
    },
    async (context) => {
        const functionName = "[calculateVipTiers V1]";
        const startTimeFunc = Date.now();
        logger.info(`${functionName} Execution started. Event ID: ${context.eventId}`);

        // 1. Fetch VIP Settings
        const vipSettings = await getVipSettings();
        if (!vipSettings || !vipSettings.rules || vipSettings.rules.length === 0 || !vipSettings.lookbackDays || vipSettings.lookbackDays <= 0) {
            logger.error(`${functionName} Invalid or missing VIP settings. Aborting.`);
            return; // Exit if settings are invalid
        }
        const lookbackDays = vipSettings.lookbackDays;
        logger.info(`${functionName} Using VIP settings: Lookback ${lookbackDays} days. Rules: ${vipSettings.rules.map(r => `${r.tierName}:${r.minSpendThresholdSmallestUnit}`).join(', ')}`);

        // 2. Calculate Lookback Date
        const lookbackDate = new Date();
        lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);
        const lookbackTimestamp = Timestamp.fromDate(lookbackDate);
        logger.info(`${functionName} Calculating spending since ${lookbackDate.toISOString()}.`);

        // 3. Iterate through all Customers
        // Note: Querying all users might be inefficient for very large user bases.
        // Consider alternative approaches like processing users in batches or triggering updates based on order completion.
        // For now, we'll query all users marked as 'Customer'.
        let usersProcessed = 0;
        let usersUpdated = 0;
        let lastUserId: string | null = null;
        let batch = db.batch();
        let batchCounter = 0;

        try {
            // Loop to handle pagination if user base is very large
            while (true) {
                let query = db.collection('users')
                              .where('role', '==', 'Customer')
                              .orderBy(admin.firestore.FieldPath.documentId()) // Order for pagination
                              .limit(500); // Process users in chunks

                if (lastUserId) {
                    query = query.startAfter(lastUserId);
                }

                const userSnapshot = await query.get();
                if (userSnapshot.empty) {
                    logger.info(`${functionName} No more users to process.`);
                    break; // Exit loop if no more users
                }

                logger.info(`${functionName} Processing batch of ${userSnapshot.size} users...`);

                // Process each user in the current chunk
                for (const userDoc of userSnapshot.docs) {
                    usersProcessed++;
                    lastUserId = userDoc.id; // For pagination in the next loop iteration
                    const userId = userDoc.id;
                    const userData = userDoc.data() as User;
                    const logContextUser = { userId, currentTier: userData.vipTier };

                    // 4. Calculate Total Spending for the User in the Lookback Period
                    let totalSpent = 0;
                    try {
                        const ordersSnapshot = await db.collection('orders')
                            .where('customerId', '==', userId)
                            // Filter by completed orders within the lookback period
                            .where('status', '==', OrderStatus.Black)
                            .where('deliveredTimestamp', '>=', lookbackTimestamp)
                            .get();

                        ordersSnapshot.forEach(orderDoc => {
                            const orderData = orderDoc.data() as Order;
                            // Use finalAmount which includes discounts/tips? Or totalAmount before them?
                            // Let's use finalAmount for simplicity, assuming VIP is based on actual money spent.
                            totalSpent += orderData.finalAmount ?? 0;
                        });
                        // logger.debug(`${functionName} User ${userId} spent ${totalSpent} in the lookback period.`, logContextUser);

                    } catch (orderQueryError) {
                        logger.error(`${functionName} Failed to query orders for user ${userId}. Skipping user.`, { ...logContextUser, error: orderQueryError });
                        continue; // Skip to the next user if order query fails
                    }

                    // 5. Determine New VIP Tier
                    const newTier = determineTier(totalSpent, vipSettings);
                    const currentTier = userData.vipTier ?? null;

                    // 6. Update User Document if Tier Changed
                    if (newTier !== currentTier) {
                        logger.info(`${functionName} User ${userId}: Tier changed from '${currentTier}' to '${newTier}'. Spent: ${totalSpent}`, logContextUser);
                        const userRef = db.collection('users').doc(userId);
                        batch.update(userRef, {
                            vipTier: newTier, // Update to new tier (or null if none met)
                            vipTierLastCalculated: FieldValue.serverTimestamp()
                        });
                        usersUpdated++;
                        batchCounter++;

                        // Commit batch periodically to avoid exceeding limits
                        if (batchCounter >= BATCH_SIZE) {
                            logger.info(`${functionName} Committing batch of ${batchCounter} updates...`);
                            await batch.commit();
                            batch = db.batch(); // Start a new batch
                            batchCounter = 0;
                        }
                    } else {
                        // Optionally update 'vipTierLastCalculated' even if tier didn't change
                        // logger.debug(`${functionName} User ${userId}: Tier remains '${currentTier}'. Spent: ${totalSpent}`, logContextUser);
                        // const userRef = db.collection('users').doc(userId);
                        // batch.update(userRef, { vipTierLastCalculated: FieldValue.serverTimestamp() });
                        // batchCounter++; // Increment if updating timestamp
                        // ... handle batch commit ...
                    }
                } // End of user loop for the current chunk
            } // End of while loop for pagination

            // Commit any remaining updates in the last batch
            if (batchCounter > 0) {
                logger.info(`${functionName} Committing final batch of ${batchCounter} updates...`);
                await batch.commit();
            }

            logger.info(`${functionName} Finished processing. Users processed: ${usersProcessed}. Users updated: ${usersUpdated}.`);

        } catch (error) {
            logger.error(`${functionName} An error occurred during processing.`, { error });
            // Consider adding error reporting/alerting here
        } finally {
            const duration = Date.now() - startTimeFunc;
            logger.info(`${functionName} Execution finished. Duration: ${duration}ms`);
        }
    }
);
