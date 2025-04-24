import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

// --- Import Models ---
import { EventBooking, EventBookingStatus } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { createGoogleCalendarEvent as createEventInGCal } from '../utils/google_calendar_helpers';
import { logSystemActivity } from '../utils/logging'; // Using mock below

// --- Mocks ---
// async function logSystemActivity(actionType: string, details: object): Promise<void> { logger.info(`[Mock System Log] Action: ${actionType}`, details); } // Imported
// --- End Mocks ---

// --- Configuration ---
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const EVENT_CALENDAR_TOPIC = "create-google-calendar-event"; // Example topic name

// --- The Background Function (Triggered by Pub/Sub) ---
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
                return;
            }

            // 2. Fetch Event Booking Data
            const bookingRef = db.collection('eventBookings').doc(bookingId);
            const bookingSnap = await bookingRef.get();

            if (!bookingSnap.exists) {
                logger.error(`${functionName} Event booking ${bookingId} not found.`, logContext);
                return;
            }
            const bookingData = bookingSnap.data() as EventBooking;
            logContext.currentStatus = bookingData.bookingStatus;

            // 3. State Validation
            const validStatuses = [EventBookingStatus.Confirmed, EventBookingStatus.Scheduled];
            if (!validStatuses.includes(bookingData.bookingStatus)) {
                 logger.warn(`${functionName} Booking ${bookingId} is not in a valid status for GCal creation (current: ${bookingData.bookingStatus}). Skipping.`, logContext);
                 return;
            }
            if (bookingData.googleCalendarEventId) {
                logger.warn(`${functionName} Booking ${bookingId} already has a Google Calendar Event ID (${bookingData.googleCalendarEventId}). Skipping creation.`, logContext);
                return;
            }

            // 4. Prepare Event Data
             const eventInput = {
                 summary: `Event: ${bookingData.eventMenuId || 'Custom'} - ${bookingId.substring(0,6)}`,
                 description: `Customer: ${bookingData.customerId}\nBooking ID: ${bookingId}\nNotes: ${bookingData.notes || 'N/A'}\nStatus: ${bookingData.bookingStatus}`,
                 startTime: bookingData.startTime,
                 endTime: bookingData.endTime,
                 location: bookingData.location?.address || undefined,
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
             logSystemActivity("CreateGCalEventAttempt", { bookingId, success: result.success, eventId: result.eventId, error: result.error })
                .catch(err => logger.error("Failed logging CreateGCalEventAttempt system activity", { err })); // Fixed catch


        } catch (error: any) {
            logger.error(`${functionName} Unhandled error processing booking ${bookingId}.`, { ...logContext, error: error.message, stack: error.stack });
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

