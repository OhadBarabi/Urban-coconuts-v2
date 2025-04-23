import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

// --- Import Models ---
import { EventBooking, EventBookingStatus } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { createGoogleCalendarEvent as createEventInGCal } from '../utils/google_calendar_helpers'; // <-- Import REAL helper
// import { logSystemActivity } from '../utils/logging'; // Using mock below

// --- Mocks ---
async function logSystemActivity(actionType: string, details: object): Promise<void> { logger.info(`[Mock System Log] Action: ${actionType}`, details); }
// --- End Mocks ---

// --- Configuration ---
const db = admin.firestore();
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
// Choose ONE trigger type: Firestore or Pub/Sub

// Option 1: Firestore Trigger (Simpler, but less robust for external API calls)
// Triggered when an event booking's status changes, specifically looking for transition to 'Confirmed'.
/*
export const createGoogleCalendarEvent = functions.firestore
    .document('eventBookings/{bookingId}')
    .region(FUNCTION_REGION)
    .onUpdate(async (change, context): Promise<void> => {
        const functionName = "[createGoogleCalendarEvent - Firestore Trigger V2]";
        const bookingId = context.params.bookingId;
        const beforeData = change.before.data() as EventBooking | undefined;
        const afterData = change.after.data() as EventBooking | undefined;
        const logContext = { functionName, trigger: "Firestore", bookingId };

        if (!afterData) {
            logger.info(`${functionName} Booking ${bookingId} deleted. No action needed.`, logContext);
            return;
        }

        const beforeStatus = beforeData?.bookingStatus;
        const afterStatus = afterData.bookingStatus;
        logContext.beforeStatus = beforeStatus;
        logContext.afterStatus = afterStatus;

        // --- Trigger Condition ---
        // Create event only when status becomes 'Confirmed' (or maybe 'Scheduled' depending on flow)
        // and it wasn't already 'Confirmed'/'Scheduled' before.
        const targetStatus = EventBookingStatus.Confirmed; // Or Scheduled?
        if (afterStatus !== targetStatus || beforeStatus === targetStatus) {
             logger.debug(`${functionName} Status did not transition to ${targetStatus}. No action needed.`, logContext);
             return;
        }
         // Check if event already created to prevent duplicates
         if (afterData.googleCalendarEventId) {
             logger.warn(`${functionName} Booking ${bookingId} already has a Google Calendar Event ID (${afterData.googleCalendarEventId}). Skipping creation.`, logContext);
             return;
         }

        logger.info(`${functionName} Processing confirmed booking ${bookingId} to create GCal event...`, logContext);

        try {
            // --- Prepare Event Data ---
            const eventInput = {
                summary: `Event Booking: ${bookingId}`, // Customize summary
                description: `Customer: ${afterData.customerId}\nNotes: ${afterData.notes || 'N/A'}\nStatus: ${afterData.bookingStatus}`, // Customize description
                startTime: afterData.startTime,
                endTime: afterData.endTime,
                location: afterData.location?.address || undefined, // Use address string if available
                // attendees: [afterData.customerEmail], // Add customer email if available and desired
                bookingId: bookingId, // Pass bookingId for reference
                // timeZone: 'Asia/Jerusalem', // Handled by helper default
            };

            // --- Call Helper to Create Event ---
            const result = await createEventInGCal(eventInput);

            // --- Update Booking with Event ID or Error ---
            const bookingRef = db.collection('eventBookings').doc(bookingId);
            if (result.success && result.eventId) {
                logger.info(`${functionName} GCal event created (${result.eventId}). Updating booking ${bookingId}.`, logContext);
                await bookingRef.update({
                    googleCalendarEventId: result.eventId,
                    needsManualGcalCheck: false, // Clear flag if previously set
                    updatedAt: FieldValue.serverTimestamp(),
                });
            } else {
                logger.error(`${functionName} Failed to create GCal event for booking ${bookingId}. Updating booking with error flag.`, { ...logContext, error: result.error });
                await bookingRef.update({
                    googleCalendarEventId: null, // Ensure it's null
                    needsManualGcalCheck: true, // Flag for manual intervention
                    processingError: `GCal Create Failed: ${result.error || result.errorCode || 'Unknown'}`,
                    updatedAt: FieldValue.serverTimestamp(),
                });
            }
             // Log system activity
             logSystemActivity("CreateGCalEventAttempt", { bookingId, success: result.success, eventId: result.eventId, error: result.error }).catch(...)


        } catch (error: any) {
            logger.error(`${functionName} Unhandled error processing booking ${bookingId}.`, { ...logContext, error: error.message, stack: error.stack });
            // Attempt to mark booking with error flag
             try {
                 await db.collection('eventBookings').doc(bookingId).update({
                     needsManualGcalCheck: true,
                     processingError: `Fatal GCal Create Error: ${error?.message ?? 'Unknown'}`,
                     updatedAt: FieldValue.serverTimestamp(),
                 });
             } catch (updateError) {
                  logger.error(`${functionName} Failed to update booking ${bookingId} with fatal error info.`, { ...logContext, updateError });
             }
        }
    });
*/

// Option 2: Pub/Sub Trigger (More Robust for external APIs)
// Assumes another function (e.g., confirmEventAgreement) publishes the bookingId to this topic.
const EVENT_CALENDAR_TOPIC = "create-google-calendar-event"; // Example topic name

export const createGoogleCalendarEvent = functions.pubsub.topic(EVENT_CALENDAR_TOPIC)
    .region(FUNCTION_REGION)
    .onPublish(async (message): Promise<void> => {
        const functionName = "[createGoogleCalendarEvent - PubSub Trigger V2]";
        const startTimeFunc = Date.now();
        let bookingId: string | null = null;
        let logContext: any = { functionName, trigger: "Pub/Sub", topic: EVENT_CALENDAR_TOPIC };

        try {
            // 1. Parse Message Payload
            let payload: { bookingId: string };
            try {
                payload = message.json as { bookingId: string };
                bookingId = payload.bookingId;
                if (!bookingId) throw new Error("Missing bookingId in Pub/Sub message payload.");
                logContext.bookingId = bookingId;
                logger.info(`${functionName} Received request to create GCal event.`, logContext);
            } catch (e: any) {
                logger.error(`${functionName} Failed to parse Pub/Sub message.`, { error: e.message, data: message.data ? Buffer.from(message.data, 'base64').toString() : null });
                return; // Acknowledge invalid message
            }

            // 2. Fetch Event Booking Data
            const bookingRef = db.collection('eventBookings').doc(bookingId);
            const bookingSnap = await bookingRef.get();

            if (!bookingSnap.exists) {
                logger.error(`${functionName} Event booking ${bookingId} not found.`, logContext);
                return; // Acknowledge - cannot process
            }
            const bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;

            // 3. State Validation (Optional but recommended)
            // Ensure the booking is in a state where calendar creation makes sense
            const validStatuses = [EventBookingStatus.Confirmed, EventBookingStatus.Scheduled]; // Add others if needed
            if (!validStatuses.includes(bookingData.bookingStatus)) {
                 logger.warn(`${functionName} Booking ${bookingId} is not in a valid status for GCal creation (current: ${bookingData.bookingStatus}). Skipping.`, logContext);
                 return; // Acknowledge - wrong state
            }
            // Prevent duplicate creation
            if (bookingData.googleCalendarEventId) {
                logger.warn(`${functionName} Booking ${bookingId} already has a Google Calendar Event ID (${bookingData.googleCalendarEventId}). Skipping creation.`, logContext);
                return; // Acknowledge - already done
            }

            // 4. Prepare Event Data
             const eventInput = {
                 summary: `Event: ${bookingData.eventMenuId || 'Custom'} - ${bookingId.substring(0,6)}`, // Example summary
                 description: `Customer: ${bookingData.customerId}\nBooking ID: ${bookingId}\nNotes: ${bookingData.notes || 'N/A'}\nStatus: ${bookingData.bookingStatus}`,
                 startTime: bookingData.startTime,
                 endTime: bookingData.endTime,
                 location: bookingData.location?.address || undefined,
                 // attendees: [customerEmail], // Fetch customer email if needed
                 bookingId: bookingId,
             };

            // 5. Call Helper to Create Event
            logger.info(`${functionName} Calling GCal helper to create event for booking ${bookingId}...`, logContext);
            const result = await createEventInGCal(eventInput);

            // 6. Update Booking with Event ID or Error
            if (result.success && result.eventId) {
                logger.info(`${functionName} GCal event created (${result.eventId}). Updating booking ${bookingId}.`, logContext);
                await bookingRef.update({
                    googleCalendarEventId: result.eventId,
                    needsManualGcalCheck: false,
                    updatedAt: FieldValue.serverTimestamp(),
                });
            } else {
                logger.error(`${functionName} Failed to create GCal event for booking ${bookingId}. Updating booking with error flag.`, { ...logContext, error: result.error });
                await bookingRef.update({
                    googleCalendarEventId: null,
                    needsManualGcalCheck: true,
                    processingError: `GCal Create Failed: ${result.error || result.errorCode || 'Unknown'}`,
                    updatedAt: FieldValue.serverTimestamp(),
                });
            }
             // Log system activity
             logSystemActivity("CreateGCalEventAttempt", { bookingId, success: result.success, eventId: result.eventId, error: result.error }).catch(...)


        } catch (error: any) {
            logger.error(`${functionName} Unhandled error processing booking ${bookingId}.`, { ...logContext, error: error.message, stack: error.stack });
             // Attempt to mark booking with error flag
              if (bookingId) {
                  try {
                      await db.collection('eventBookings').doc(bookingId).update({
                          needsManualGcalCheck: true,
                          processingError: `Fatal GCal Create Error: ${error?.message ?? 'Unknown'}`,
                          updatedAt: FieldValue.serverTimestamp(),
                      });
                  } catch (updateError) {
                       logger.error(`${functionName} Failed to update booking ${bookingId} with fatal error info.`, { ...logContext, updateError });
                  }
              }
        } finally {
             const duration = Date.now() - startTimeFunc;
             logger.info(`${functionName} Execution finished. Duration: ${duration}ms`, logContext);
        }
    });

