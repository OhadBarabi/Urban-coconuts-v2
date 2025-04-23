import * as functions from "firebase-functions/v2"; // Although not a cloud function itself, good practice to import types if needed
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

// --- Import Models ---
import { ActivityLog } from '../models'; // Adjust path if needed

// --- Configuration ---
// Ensure Firebase Admin is initialized (usually done in index.ts)
const db = admin.firestore();
const { Timestamp } = admin.firestore;

// --- Enums ---
enum ErrorCode {
    InvalidArgument = "INVALID_ARGUMENT",
    InternalError = "INTERNAL_ERROR",
}

// --- The Helper Function ---
/**
 * Logs a user activity event to the 'userActivityLogs' collection.
 * This is an async helper function, NOT a Cloud Function trigger itself.
 * It's designed to be called from within other Cloud Functions.
 *
 * @param actionType A string identifying the type of action (e.g., "CreateOrder", "LoginAttempt").
 * @param details An object containing relevant context/details about the action.
 * @param userId The UID of the user performing the action (or 'system'/'anonymous').
 * @param userContext Optional additional context like IP address or user agent.
 */
export async function logUserActivity(
    actionType: string,
    details: object,
    userId: string,
    userContext?: { ipAddress?: string | null; userAgent?: string | null }
): Promise<{ success: boolean; logId?: string; error?: string; errorCode?: ErrorCode }> {
    const functionName = "[logUserActivity Helper]";
    const logContext = { actionType, userId, details, userContext };

    // Basic Validation
    if (!actionType || typeof actionType !== 'string' || !details || typeof details !== 'object' || !userId || typeof userId !== 'string') {
        logger.error(`${functionName} Invalid input provided.`, logContext);
        return { success: false, error: "Invalid input for logging.", errorCode: ErrorCode.InvalidArgument };
    }

    try {
        const logEntry: ActivityLog = {
            timestamp: Timestamp.now(),
            userId: userId,
            action: actionType,
            details: details, // Store the provided details object directly
            ipAddress: userContext?.ipAddress ?? null,
            userAgent: userContext?.userAgent ?? null,
            // userRole could be added here if fetched/passed reliably from the calling function
        };

        // Add the log entry to a dedicated collection (e.g., 'userActivityLogs')
        // Using add() automatically generates a document ID.
        const docRef = await db.collection('userActivityLogs').add(logEntry);
        // logger.info(`${functionName} Activity logged successfully. Log ID: ${docRef.id}`, logContext); // Optional: reduce noise?

        return { success: true, logId: docRef.id };

    } catch (error: any) {
        logger.error(`${functionName} Failed to write user activity log.`, { ...logContext, error: error.message });
        return { success: false, error: "Failed to write activity log.", errorCode: ErrorCode.InternalError };
    }
}

// Example of an admin logging function (similar structure)
export async function logAdminAction(
    actionType: string,
    details: object,
    adminUserId?: string | null // Optional: ID of admin performing action
): Promise<{ success: boolean; logId?: string; error?: string; errorCode?: ErrorCode }> {
     const functionName = "[logAdminAction Helper]";
     const logContext = { actionType, details, adminUserId };

     if (!actionType || typeof actionType !== 'string' || !details || typeof details !== 'object') {
         logger.error(`${functionName} Invalid input provided.`, logContext);
         return { success: false, error: "Invalid input for logging.", errorCode: ErrorCode.InvalidArgument };
     }

     try {
         const logEntry = { // Define a specific interface if needed, e.g., AdminLog
             timestamp: Timestamp.now(),
             adminUserId: adminUserId ?? 'system', // Default to system if no admin ID provided
             action: actionType,
             details: details,
         };
         const docRef = await db.collection('adminLogs').add(logEntry);
         // logger.info(`${functionName} Admin action logged successfully. Log ID: ${docRef.id}`, logContext);
         return { success: true, logId: docRef.id };
     } catch (error: any) {
         logger.error(`${functionName} Failed to write admin action log.`, { ...logContext, error: error.message });
         return { success: false, error: "Failed to write admin log.", errorCode: ErrorCode.InternalError };
     }
}
