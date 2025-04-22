import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https"; // Import if needed for calling other functions

// --- Import Models ---
import { Order, OrderStatus, PromoCode, AppConfigGeneral, ActivityLog } from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { updateOrderStatusInternal } from '../core/updateOrderStatus'; // Internal helper or call the callable function?
// import { logAdminAction } from '../utils/logging';
// import { fetchGeneralSettings } from '../config/config_helpers';

// --- Mocks for required helper functions (Replace with actual implementations) ---
// Mock for internal status update (avoids circular dependency if calling the callable function)
async function updateOrderStatusInternal(orderId: string, newStatus: OrderStatus, reason: string, triggerUserId: string = "system_scheduled"): Promise<{ success: boolean; error?: string }> {
    logger.info(`[Mock Internal Update] Updating order ${orderId} status to ${newStatus}. Reason: ${reason}. Triggered by: ${triggerUserId}`);
    // Simulate potential failure
    if (orderId.includes("fail_update")) {
        logger.error(`[Mock Internal Update] Failed to update status for ${orderId}`);
        return { success: false, error: "Mock internal update failed" };
    }
    // In reality, this would perform the Firestore update and potentially payment void/side effects
    await db.collection('orders').doc(orderId).update({
        status: newStatus,
        cancellationReason: reason, // Add reason if cancelling
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // Add status history entry?
    }).catch(err => { logger.error(`Mock DB update failed for ${orderId}`, err); throw err; });
    return { success: true };
}
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
interface GeneralSettings { logRetentionDays?: number; orderCancellationBufferMinutes?: number; } // Add relevant settings
async function fetchGeneralSettings(): Promise<GeneralSettings | null> { logger.info(`[Mock Config] Fetching general settings`); return { logRetentionDays: 30, orderCancellationBufferMinutes: 15 }; } // Example values
// --- End Mocks ---


// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const SCHEDULE_TIMEZONE = "Asia/Jerusalem"; // Set your desired timezone
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_ORDER_CANCELLATION_BUFFER_MINUTES = 15; // Minutes after pickup end time to cancel

const functionConfig = {
    region: FUNCTION_REGION,
    memory: "256MiB" as const, // Usually sufficient for scheduled tasks
    timeoutSeconds: 540, // Max timeout for scheduled functions
    schedule: "every 15 minutes", // Default schedule, adjust per function
    timeZone: SCHEDULE_TIMEZONE,
};

// ============================================================================
// === Auto Cancel Expired Orders =============================================
// ============================================================================
export const autoCancelExpiredOrders = functions.scheduler.onSchedule(
    {
        ...functionConfig,
        schedule: "every 15 minutes", // Check frequently
    },
    async (event) => {
        const functionName = "[autoCancelExpiredOrders V1]";
        const executionTime = Timestamp.fromDate(new Date(event.timestamp)); // Use event timestamp
        const logContext: any = { executionTime: executionTime.toDate().toISOString() };
        logger.info(`${functionName} Starting execution.`, logContext);

        let cancelledCount = 0;
        let failedCount = 0;

        try {
            // Fetch settings to get the buffer time
            const settings = await fetchGeneralSettings();
            const bufferMinutes = settings?.orderCancellationBufferMinutes ?? DEFAULT_ORDER_CANCELLATION_BUFFER_MINUTES;
            const cancellationTime = Timestamp.fromMillis(executionTime.toMillis() - bufferMinutes * 60 * 1000);
            logContext.cancellationTime = cancellationTime.toDate().toISOString();
            logContext.bufferMinutes = bufferMinutes;

            // Query for orders that are still in 'Green' status (Ready/En Route)
            // AND whose pickup time window has ended more than 'bufferMinutes' ago.
            const expiredOrdersQuery = db.collection('orders')
                .where('status', '==', OrderStatus.Green) // Only check orders ready/en route
                .where('pickupTimeWindow.end', '<=', cancellationTime); // Pickup window ended before the cancellation threshold

            const snapshot = await expiredOrdersQuery.get();

            if (snapshot.empty) {
                logger.info(`${functionName} No expired orders found in 'Green' status past the cancellation time.`, logContext);
                return;
            }

            logger.info(`${functionName} Found ${snapshot.size} potentially expired orders. Processing...`, logContext);
            const cancellationPromises: Promise<void>[] = [];

            snapshot.forEach(doc => {
                const orderId = doc.id;
                const orderData = doc.data() as Order;
                const reason = `Order automatically cancelled: Pickup window ended at ${orderData.pickupTimeWindow?.end.toDate().toISOString()} and exceeded buffer of ${bufferMinutes} minutes.`;

                // Call internal update function or the callable function
                const promise = updateOrderStatusInternal(orderId, OrderStatus.Cancelled, reason)
                    .then(result => {
                        if (result.success) {
                            cancelledCount++;
                            logger.info(`${functionName} Successfully cancelled order ${orderId}.`, { ...logContext, orderId });
                        } else {
                            failedCount++;
                            logger.error(`${functionName} Failed to cancel order ${orderId}.`, { ...logContext, orderId, error: result.error });
                        }
                    })
                    .catch(error => {
                        failedCount++;
                        logger.error(`${functionName} Error processing cancellation for order ${orderId}.`, { ...logContext, orderId, error: error.message });
                    });
                cancellationPromises.push(promise);
            });

            await Promise.allSettled(cancellationPromises);

            logger.info(`${functionName} Finished processing. Cancelled: ${cancelledCount}, Failed: ${failedCount}.`, logContext);
            if (failedCount > 0) {
                 logAdminAction("AutoCancelOrdersPartialFailure", { cancelledCount, failedCount, executionTime: executionTime.toDate().toISOString() }).catch(...);
            }

        } catch (error: any) {
            logger.error(`${functionName} Unhandled error during execution.`, { ...logContext, error: error.message });
            logAdminAction("AutoCancelOrdersFailed", { reason: error.message, executionTime: executionTime.toDate().toISOString() }).catch(...);
            // Do not throw error to prevent Pub/Sub retries for general failures unless desired
        }
    }
);


// ============================================================================
// === Deactivate Expired Promotions ==========================================
// ============================================================================
export const deactivateExpiredPromotions = functions.scheduler.onSchedule(
    {
        ...functionConfig,
        schedule: "every 1 hours", // Check less frequently than orders
    },
    async (event) => {
        const functionName = "[deactivateExpiredPromotions V1]";
        const executionTime = Timestamp.fromDate(new Date(event.timestamp));
        const logContext: any = { executionTime: executionTime.toDate().toISOString() };
        logger.info(`${functionName} Starting execution.`, logContext);

        let deactivatedCount = 0;

        try {
            // Query for active promo codes whose 'validUntil' timestamp is in the past
            const expiredPromosQuery = db.collection('promoCodes')
                .where('isActive', '==', true)
                .where('validUntil', '<=', executionTime);

            const snapshot = await expiredPromosQuery.get();

            if (snapshot.empty) {
                logger.info(`${functionName} No active promotions found with past expiry dates.`, logContext);
                return;
            }

            logger.info(`${functionName} Found ${snapshot.size} expired promotions to deactivate. Processing...`, logContext);
            const batch = db.batch();

            snapshot.forEach(doc => {
                const promoId = doc.id;
                logger.info(`${functionName} Deactivating promo code ${promoId}.`, { ...logContext, promoId });
                const promoRef = db.collection('promoCodes').doc(promoId);
                batch.update(promoRef, { isActive: false, updatedAt: FieldValue.serverTimestamp() });
                deactivatedCount++;
            });

            await batch.commit();
            logger.info(`${functionName} Successfully deactivated ${deactivatedCount} promotions.`, logContext);
            if (deactivatedCount > 0) {
                 logAdminAction("DeactivateExpiredPromotions", { count: deactivatedCount, executionTime: executionTime.toDate().toISOString() }).catch(...);
            }

        } catch (error: any) {
            logger.error(`${functionName} Error deactivating promotions.`, { ...logContext, error: error.message });
            logAdminAction("DeactivatePromotionsFailed", { reason: error.message, executionTime: executionTime.toDate().toISOString() }).catch(...);
        }
    }
);


// ============================================================================
// === Cleanup Old Logs =======================================================
// ============================================================================
export const cleanupOldLogs = functions.scheduler.onSchedule(
    {
        ...functionConfig,
        schedule: "0 3 * * *", // Run once daily at 3 AM
    },
    async (event) => {
        const functionName = "[cleanupOldLogs V1]";
        const executionTime = Timestamp.fromDate(new Date(event.timestamp));
        const logContext: any = { executionTime: executionTime.toDate().toISOString() };
        logger.info(`${functionName} Starting execution.`, logContext);

        let deletedAdminLogs = 0;
        let deletedActivityLogs = 0;
        const batchSize = 400; // Firestore batch limit is 500 writes

        try {
            // Fetch log retention settings
            const settings = await fetchGeneralSettings();
            const retentionDays = settings?.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
            const cutoffTime = Timestamp.fromMillis(executionTime.toMillis() - retentionDays * 24 * 60 * 60 * 1000);
            logContext.retentionDays = retentionDays;
            logContext.cutoffTime = cutoffTime.toDate().toISOString();

            logger.info(`${functionName} Cleaning logs older than ${retentionDays} days (Cutoff: ${logContext.cutoffTime}).`);

            // --- Cleanup Admin Logs ---
            const adminLogsQuery = db.collection('adminLogs') // Adjust collection name if different
                .where('timestamp', '<', cutoffTime)
                .limit(batchSize); // Process in batches

            let adminSnapshot = await adminLogsQuery.get();
            while (!adminSnapshot.empty) {
                const batch = db.batch();
                adminSnapshot.docs.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
                deletedAdminLogs += adminSnapshot.size;
                logger.info(`Deleted ${adminSnapshot.size} admin logs batch.`);
                if (adminSnapshot.size < batchSize) break; // Last batch
                // Fetch next batch
                const lastVisible = adminSnapshot.docs[adminSnapshot.docs.length - 1];
                adminSnapshot = await adminLogsQuery.startAfter(lastVisible).get();
            }
            logger.info(`Finished cleaning admin logs. Total deleted: ${deletedAdminLogs}`);


            // --- Cleanup User Activity Logs ---
            const activityLogsQuery = db.collection('userActivityLogs') // Adjust collection name if different
                .where('timestamp', '<', cutoffTime)
                .limit(batchSize);

            let activitySnapshot = await activityLogsQuery.get();
            while (!activitySnapshot.empty) {
                const batch = db.batch();
                activitySnapshot.docs.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
                deletedActivityLogs += activitySnapshot.size;
                logger.info(`Deleted ${activitySnapshot.size} user activity logs batch.`);
                if (activitySnapshot.size < batchSize) break; // Last batch
                const lastVisible = activitySnapshot.docs[activitySnapshot.docs.length - 1];
                activitySnapshot = await activityLogsQuery.startAfter(lastVisible).get();
            }
            logger.info(`Finished cleaning user activity logs. Total deleted: ${deletedActivityLogs}`);


            logger.info(`${functionName} Cleanup finished. Deleted Admin: ${deletedAdminLogs}, Activity: ${deletedActivityLogs}.`, logContext);
            if (deletedAdminLogs > 0 || deletedActivityLogs > 0) {
                 logAdminAction("CleanupOldLogs", { deletedAdminLogs, deletedActivityLogs, retentionDays, executionTime: executionTime.toDate().toISOString() }).catch(...);
            }

        } catch (error: any) {
            logger.error(`${functionName} Error cleaning logs.`, { ...logContext, error: error.message });
            logAdminAction("CleanupLogsFailed", { reason: error.message, executionTime: executionTime.toDate().toISOString() }).catch(...);
        }
    }
);
