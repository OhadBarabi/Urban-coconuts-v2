import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { Order, OrderStatus, PromoCode } from '../models'; // Adjust path if needed
import { AppConfigGeneral, AppConfigAlertRules } from "../models/appConfig"; // Import specific config types

// --- Import Helpers ---
// import { cancelOrder } from '../core/cancelOrder'; // Assuming cancelOrder handles its own logic including side effects trigger
import { logAdminAction, logSystemActivity } from '../utils/logging'; // Using mocks
// import { sendAlert } from '../utils/alerting'; // Mock below

// --- Mocks ---
// async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); } // Imported
// async function logSystemActivity(actionType: string, details: object): Promise<void> { logger.info(`[Mock System Log] Action: ${actionType}`, details); } // Imported
async function sendAlert(ruleId: string, details: object): Promise<void> { logger.warn(`[Mock Alert] Alert triggered for rule ${ruleId}`, details); }
// --- End Mocks ---

// --- Configuration ---
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const BATCH_SIZE = 400; // Firestore batch limit is 500 writes

// --- Helper to get App Config ---
async function getAppConfig<T>(docId: string): Promise<T | null> {
    try {
        const docSnap = await db.collection('appConfig').doc(docId).get();
        if (docSnap.exists) {
            return docSnap.data() as T;
        }
        logger.warn(`App config document 'appConfig/${docId}' not found.`);
        return null;
    } catch (error) {
        logger.error(`Failed to fetch app config 'appConfig/${docId}'.`, { error });
        return null;
    }
}


// ============================================================================
// === Auto Cancel Expired Orders =============================================
// ============================================================================
// Schedule: e.g., Run every 15 minutes
export const autoCancelExpiredOrders = functions.scheduler.onSchedule(
    {
        schedule: "every 15 minutes", // Adjust frequency as needed
        timeZone: "Asia/Jerusalem", // Use your operational timezone
        region: FUNCTION_REGION,
        memory: "512MiB",
        timeoutSeconds: 300, // 5 minutes
    },
    async (context) => {
        const functionName = "[autoCancelExpiredOrders V1]";
        const startTimeFunc = Date.now();
        const logContext = { functionName, trigger: "Scheduler", eventId: context.eventId };
        logger.info(`${functionName} Execution started.`, logContext);

        // TODO: Get expiration time from config? Defaulting to 1 hour for now.
        const expirationMinutes = 60;
        const now = Timestamp.now();
        const expirationThreshold = Timestamp.fromMillis(now.toMillis() - expirationMinutes * 60 * 1000);

        let ordersCancelled = 0;
        let errors = 0;

        try {
            // Query for orders in 'Red' status created before the expiration threshold
            const expiredOrdersQuery = db.collection('orders')
                .where('status', '==', OrderStatus.Red)
                .where('orderTimestamp', '<=', expirationThreshold); // Find orders older than threshold

            const snapshot = await expiredOrdersQuery.get();

            if (snapshot.empty) {
                logger.info(`${functionName} No expired orders found to cancel.`, logContext);
                return;
            }

            logger.info(`${functionName} Found ${snapshot.size} potentially expired orders. Processing...`, logContext);

            // Use batched writes for efficiency if many orders might expire simultaneously
            let batch = db.batch();
            let batchCounter = 0;

            for (const doc of snapshot.docs) {
                const orderId = doc.id;
                const orderData = doc.data() as Order;
                const orderLogContext = { ...logContext, orderId };

                // Double check status just in case (though query should handle it)
                if (orderData.status !== OrderStatus.Red) {
                    logger.warn(`${functionName} Order ${orderId} status is not 'Red' (${orderData.status}). Skipping.`, orderLogContext);
                    continue;
                }

                logger.info(`${functionName} Cancelling expired order ${orderId}...`, orderLogContext);

                // Update order status to Cancelled
                // Note: This will trigger the 'handleOrderCancellationSideEffects' function
                // which should handle inventory restoration and payment voiding.
                batch.update(doc.ref, {
                    status: OrderStatus.Cancelled,
                    updatedAt: FieldValue.serverTimestamp(),
                    statusHistory: FieldValue.arrayUnion({
                        status: OrderStatus.Cancelled,
                        timestamp: now, // Use consistent timestamp for batch
                        userId: 'SYSTEM', // Indicate system action
                        role: 'System',
                        reason: `Auto-cancelled due to expiration (> ${expirationMinutes} mins)`
                    })
                });
                ordersCancelled++;
                batchCounter++;

                if (batchCounter >= BATCH_SIZE) {
                    logger.info(`${functionName} Committing batch of ${batchCounter} cancellations...`, logContext);
                    await batch.commit();
                    batch = db.batch(); // Start new batch
                    batchCounter = 0;
                }
            }

            // Commit remaining batch
            if (batchCounter > 0) {
                logger.info(`${functionName} Committing final batch of ${batchCounter} cancellations...`, logContext);
                await batch.commit();
            }

            logger.info(`${functionName} Finished processing. Orders cancelled: ${ordersCancelled}.`, logContext);

        } catch (error: any) {
            logger.error(`${functionName} An error occurred during processing.`, { ...logContext, error: error.message });
            errors++;
            logSystemActivity("AutoCancelOrdersFailed", { reason: error.message })
                .catch(err => logger.error("Failed logging AutoCancelOrdersFailed system activity", { err })); // Fixed catch
        } finally {
            const duration = Date.now() - startTimeFunc;
            logger.info(`${functionName} Execution finished. Duration: ${duration}ms. Cancelled: ${ordersCancelled}, Errors: ${errors}`);
        }
    }
);


// ============================================================================
// === Deactivate Expired Promotions ==========================================
// ============================================================================
// Schedule: e.g., Run daily shortly after midnight
export const deactivateExpiredPromotions = functions.scheduler.onSchedule(
    {
        schedule: "every day 00:05", // Adjust schedule as needed
        timeZone: "Asia/Jerusalem",
        region: FUNCTION_REGION,
        memory: "256MiB",
        timeoutSeconds: 300,
    },
    async (context) => {
        const functionName = "[deactivateExpiredPromotions V1]";
        const startTimeFunc = Date.now();
        const logContext = { functionName, trigger: "Scheduler", eventId: context.eventId };
        logger.info(`${functionName} Execution started.`, logContext);

        const now = Timestamp.now();
        let promosDeactivated = 0;
        let errors = 0;

        try {
            // Query for active promo codes where validUntil is in the past
            const expiredPromosQuery = db.collection('promoCodes')
                .where('isActive', '==', true)
                .where('validUntil', '<=', now); // validUntil is less than or equal to now

            const snapshot = await expiredPromosQuery.get();

            if (snapshot.empty) {
                logger.info(`${functionName} No expired promotions found to deactivate.`, logContext);
                return;
            }

            logger.info(`${functionName} Found ${snapshot.size} expired promotions. Deactivating...`, logContext);

            let batch = db.batch();
            let batchCounter = 0;

            for (const doc of snapshot.docs) {
                const promoId = doc.id;
                logger.info(`${functionName} Deactivating promo code ${promoId}...`, { ...logContext, promoId });

                batch.update(doc.ref, {
                    isActive: false,
                    updatedAt: FieldValue.serverTimestamp()
                });
                promosDeactivated++;
                batchCounter++;

                if (batchCounter >= BATCH_SIZE) {
                    logger.info(`${functionName} Committing batch of ${batchCounter} deactivations...`, logContext);
                    await batch.commit();
                    batch = db.batch();
                    batchCounter = 0;
                }
            }

            if (batchCounter > 0) {
                logger.info(`${functionName} Committing final batch of ${batchCounter} deactivations...`, logContext);
                await batch.commit();
            }

            logger.info(`${functionName} Finished processing. Promotions deactivated: ${promosDeactivated}.`, logContext);
            logSystemActivity("DeactivatePromosSuccess", { count: promosDeactivated })
                 .catch(err => logger.error("Failed logging DeactivatePromosSuccess system activity", { err })); // Fixed catch


        } catch (error: any) {
            logger.error(`${functionName} An error occurred during processing.`, { ...logContext, error: error.message });
            errors++;
             logSystemActivity("DeactivatePromosFailed", { reason: error.message })
                 .catch(err => logger.error("Failed logging DeactivatePromosFailed system activity", { err })); // Fixed catch
        } finally {
            const duration = Date.now() - startTimeFunc;
            logger.info(`${functionName} Execution finished. Duration: ${duration}ms. Deactivated: ${promosDeactivated}, Errors: ${errors}`);
        }
    }
);


// ============================================================================
// === Cleanup Old Logs =======================================================
// ============================================================================
// Schedule: e.g., Run weekly or monthly
export const cleanupOldLogs = functions.scheduler.onSchedule(
    {
        schedule: "every monday 03:00", // Adjust schedule as needed
        timeZone: "Asia/Jerusalem",
        region: FUNCTION_REGION,
        memory: "512MiB", // Might need more memory for large delete operations
        timeoutSeconds: 540,
    },
    async (context) => {
        const functionName = "[cleanupOldLogs V1]";
        const startTimeFunc = Date.now();
        const logContext = { functionName, trigger: "Scheduler", eventId: context.eventId };
        logger.info(`${functionName} Execution started.`, logContext);

        const config = await getAppConfig<AppConfigGeneral>('general');
        const logRetentionDays = config?.logRetentionDays ?? 90; // Default to 90 days if not configured
        logContext.logRetentionDays = logRetentionDays;

        if (logRetentionDays <= 0) {
             logger.warn(`${functionName} Log retention days is set to ${logRetentionDays}. Skipping cleanup.`, logContext);
             return;
        }

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - logRetentionDays);
        const cutoffTimestamp = Timestamp.fromDate(cutoffDate);
        logContext.cutoffTimestamp = cutoffTimestamp.toDate().toISOString();
        logger.info(`${functionName} Deleting logs older than ${logRetentionDays} days (before ${logContext.cutoffTimestamp})...`, logContext);

        let totalDeleted = 0;
        const collectionsToClean = ['adminLogs', 'userActivityLogs']; // Add other log collections if needed

        try {
            for (const collectionName of collectionsToClean) {
                logContext.currentCollection = collectionName;
                logger.info(`${functionName} Cleaning collection: ${collectionName}...`, logContext);
                let collectionDeleted = 0;
                // Need to delete in batches
                while (true) {
                    const query = db.collection(collectionName)
                        .where('timestamp', '<', cutoffTimestamp)
                        .limit(BATCH_SIZE); // Limit batch size for query

                    const snapshot = await query.get();
                    if (snapshot.empty) {
                        break; // No more old logs in this collection
                    }

                    const batch = db.batch();
                    snapshot.docs.forEach(doc => batch.delete(doc.ref));
                    await batch.commit();

                    collectionDeleted += snapshot.size;
                    totalDeleted += snapshot.size;
                    logger.info(`${functionName} Deleted ${snapshot.size} logs from ${collectionName}. Total deleted so far: ${totalDeleted}.`, logContext);

                    // Add a small delay to avoid hitting rate limits aggressively
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                logger.info(`${functionName} Finished cleaning ${collectionName}. Deleted ${collectionDeleted} logs.`, logContext);
                delete logContext.currentCollection;
            }

            logger.info(`${functionName} Log cleanup finished successfully. Total logs deleted: ${totalDeleted}.`, logContext);
            logSystemActivity("CleanupLogsSuccess", { retentionDays: logRetentionDays, cutoff: logContext.cutoffTimestamp, totalDeleted })
                 .catch(err => logger.error("Failed logging CleanupLogsSuccess system activity", { err })); // Fixed catch

        } catch (error: any) {
            logger.error(`${functionName} An error occurred during log cleanup.`, { ...logContext, error: error.message });
             logSystemActivity("CleanupLogsFailed", { retentionDays: logRetentionDays, cutoff: logContext.cutoffTimestamp, error: error.message })
                 .catch(err => logger.error("Failed logging CleanupLogsFailed system activity", { err })); // Fixed catch
        } finally {
            const duration = Date.now() - startTimeFunc;
            logger.info(`${functionName} Execution finished. Duration: ${duration}ms. Total deleted: ${totalDeleted}`);
        }
    }
);

// Add other scheduled functions here (e.g., checkAlertRules)
// ...
