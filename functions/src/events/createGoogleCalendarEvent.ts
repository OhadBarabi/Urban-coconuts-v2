import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { google, calendar_v3 } from 'googleapis'; // For Google Calendar API

// --- Import Models ---
import {
    EventBooking, EventBookingStatus, User, AppConfigEventSettings, EventBookingItem // Added EventBookingItem
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { fetchEventSettings } from '../config/config_helpers';
// import { getGoogleAuthClient } from '../utils/google_auth'; // Helper to get authenticated Google API client
// import { sendPushNotification } from '../utils/notifications';
// import { logAdminAction } from '../utils/logging'; // Log critical errors/actions

// --- Mocks for required helper functions (Replace with actual implementations) ---
interface EventSettings { timeZone?: string; targetCalendarIds?: { [key: string]: string }; googleCalendarIntegrationEnabled?: boolean; /* Add other settings */ }
async function fetchEventSettings(): Promise<EventSettings | null> { logger.info(`[Mock Config] Fetching event settings`); return { timeZone: 'Asia/Jerusalem', targetCalendarIds: { default: 'primary' }, googleCalendarIntegrationEnabled: true }; }
async function getGoogleAuthClient(): Promise<any> { logger.info(`[Mock Google Auth] Getting authenticated client`); /* Simulate auth */ return google.calendar({ version: 'v3', auth: 'mock-auth-client' }); } // Return a mock client
interface AdminAlertParams { subject: string; body: string; bookingId?: string; severity: "critical" | "warning" | "info"; }
async function sendPushNotification(params: AdminAlertParams): Promise<void> { logger.info(`[Mock Notification] Sending ADMIN ALERT (${params.severity})`, params); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

const functionConfig = {
    region: FUNCTION_REGION,
    memory: "512MiB" as const, // Allow memory for GCal API calls
    timeoutSeconds: 60,
    // ** IMPORTANT: Configure Pub/Sub retries & DLQ for this topic **
    // secrets: ["GOOGLE_API_CREDENTIALS"], // If using service account credentials for GCal
};

// Ensure this matches the Pub/Sub topic triggered by confirmEventAgreement
const PUBSUB_TOPIC = "create-gcal-event"; // <<<--- CHANGE TO YOUR TOPIC NAME

// --- Enums ---
enum ErrorCode {
    BookingNotFound = "BOOKING_NOT_FOUND",
    InvalidBookingStatus = "INVALID_BOOKING_STATUS", // Not Confirmed
    GCalIntegrationDisabled = "GCAL_INTEGRATION_DISABLED",
    MissingCalendarId = "MISSING_CALENDAR_ID",
    GoogleCalendarError = "GOOGLE_CALENDAR_ERROR", // General GCal API error
    InternalError = "INTERNAL_ERROR",
}

// --- The Cloud Function (Pub/Sub Triggered - V2) ---
export const createGoogleCalendarEvent = functions.pubsub
    .topic(PUBSUB_TOPIC)
    .onMessagePublished(
        {
            ...functionConfig,
            // Ensure Pub/Sub Subscription has retry policy and Dead Letter Topic configured!
        },
        async (message): Promise<void> => {
            const functionName = "[createGoogleCalendarEvent V1]";
            const startTimeFunc = Date.now();
            const messageId = message.id;

            let bookingId: string;
            let bookingRef: admin.firestore.DocumentReference;
            const logContext: any = { messageId };

            try {
                // 1. Extract bookingId & Fetch Booking
                if (!message.json?.bookingId || typeof message.json.bookingId !== 'string') {
                    logger.error(`${functionName} Invalid Pub/Sub payload: Missing/invalid 'bookingId'. ACK.`, { messageData: message.json, messageId });
                    return; // ACK bad format
                }
                bookingId = message.json.bookingId;
                logContext.bookingId = bookingId;
                logger.info(`${functionName} Invoked for booking ${bookingId}`, logContext);

                bookingRef = db.collection('eventBookings').doc(bookingId);
                const bookingSnap = await bookingRef.get();

                if (!bookingSnap.exists) {
                    logger.error(`${functionName} Booking ${bookingId}: Not found. ACK.`, logContext);
                    return; // ACK - booking deleted?
                }
                const bookingData = bookingSnap.data() as EventBooking;
                logContext.currentBookingStatus = bookingData.bookingStatus;
                logContext.customerId = bookingData.customerId;

                // 2. Validate Status & Idempotency
                // Expecting 'Confirmed' status set by confirmEventAgreement
                if (bookingData.bookingStatus !== EventBookingStatus.Confirmed) {
                    logger.warn(`${functionName} Booking ${bookingId}: Invalid status '${bookingData.bookingStatus}'. Expected '${EventBookingStatus.Confirmed}'. ACK.`, logContext);
                    return; // ACK - Booking not confirmed, don't create GCal event
                }
                if (bookingData.googleCalendarEventId) {
                     logger.info(`${functionName} Booking ${bookingId}: Google Calendar event already exists (${bookingData.googleCalendarEventId}). ACK.`, logContext);
                     return; // ACK - Idempotency check
                }

                // 3. Fetch Settings & Customer Data
                const settingsPromise = fetchEventSettings();
                const customerSnapPromise = db.collection('users').doc(bookingData.customerId).get();
                const [settings, customerSnap] = await Promise.all([settingsPromise, customerSnapPromise]);

                if (!settings?.googleCalendarIntegrationEnabled) {
                    logger.info(`${functionName} Booking ${bookingId}: Google Calendar integration is disabled in settings. ACK.`, logContext);
                    // Optionally update booking to indicate GCal was skipped due to settings?
                    // await bookingRef.update({ needsManualGcalCheck: true, processingError: "GCal integration disabled" });
                    return; // ACK
                }

                const calendarId = settings.targetCalendarIds?.default ?? 'primary';
                if (!calendarId) {
                    logger.error(`${functionName} Booking ${bookingId}: Target Google Calendar ID not configured in settings. ACK.`, logContext);
                    await bookingRef.update({ needsManualGcalCheck: true, processingError: "Target GCal ID missing in config" }).catch(err => logger.error("Failed update booking", {err}));
                    sendPushNotification({ subject: `GCal Creation Failed (Config) - Booking ${bookingId}`, body: `Failed to create GCal event for booking ${bookingId}. Target Calendar ID is missing in event settings. Manual creation required.`, bookingId, severity: "critical" }).catch(...);
                    return; // ACK
                }
                logContext.calendarId = calendarId;

                let customerName = `Customer ${bookingData.customerId.substring(0, 6)}`;
                let customerEmail: string | undefined;
                if (customerSnap.exists) {
                    const customerData = customerSnap.data() as User;
                    customerName = customerData.displayName ?? customerName;
                    customerEmail = customerData.email ?? undefined;
                } else {
                    logger.warn(`${functionName} Customer ${bookingData.customerId} not found for booking ${bookingId}. Proceeding without customer details in GCal event.`);
                }
                logContext.customerName = customerName;
                logContext.customerEmail = customerEmail;

                // 4. Prepare Google Calendar Event Data
                const eventStartTime = bookingData.startTime.toDate();
                const eventEndTime = bookingData.endTime.toDate();
                const timeZone = settings.timeZone ?? 'UTC'; // Use configured timezone

                // Construct description
                let description = `Event Booking ID: ${bookingId}\n`;
                description += `Customer: ${customerName} (${bookingData.customerId})\n`;
                if (customerEmail) description += `Email: ${customerEmail}\n`;
                if (bookingData.notes) description += `\nCustomer Notes:\n${bookingData.notes}\n`;
                description += `\nItems:\n`;
                bookingData.selectedItems.forEach((item: EventBookingItem) => {
                    description += `- ${item.productName || item.itemId} (${item.itemType})`;
                    if (item.quantity) description += ` x ${item.quantity}`;
                    if (item.durationHours) description += ` for ${item.durationHours} hours`;
                    description += `\n`;
                });
                // Add total amount?
                description += `\nTotal: ${(bookingData.totalAmountSmallestUnit / 100).toFixed(2)} ${bookingData.currencyCode}`;


                const gcalEvent: calendar_v3.Schema$Event = {
                    summary: `Urban Coconuts Event: ${customerName}`,
                    description: description,
                    start: {
                        dateTime: eventStartTime.toISOString(),
                        timeZone: timeZone,
                    },
                    end: {
                        dateTime: eventEndTime.toISOString(),
                        timeZone: timeZone,
                    },
                    location: bookingData.location?.address ?? 'Location TBD',
                    // Add attendees? (Customer, relevant internal staff/resources if emails are available)
                    attendees: customerEmail ? [{ email: customerEmail, displayName: customerName }] : [],
                    // Add reminders?
                    reminders: {
                        useDefault: false,
                        overrides: [
                            { method: 'popup', minutes: 60 }, // 1 hour before
                            { method: 'popup', minutes: 24 * 60 }, // 1 day before
                        ],
                    },
                    // Link back to the booking in your system? Use extendedProperties
                    extendedProperties: {
                        private: { // Private properties not visible to attendees
                            urbanCoconutsBookingId: bookingId,
                            urbanCoconutsCustomerId: bookingData.customerId,
                        }
                    },
                    // Set color, status etc. if desired
                    // colorId: '5', // Example: Yellow
                    status: 'confirmed', // Mark as confirmed in GCal
                };

                // 5. Insert Event into Google Calendar
                logger.info(`${functionName} Inserting event into Google Calendar ${calendarId}...`, logContext);
                const calendar = await getGoogleAuthClient(); // Get authenticated client
                let createdEvent: calendar_v3.Schema$Event | null = null;

                try {
                    const response = await calendar.events.insert({
                        calendarId: calendarId,
                        requestBody: gcalEvent,
                        // sendNotifications: true, // Send GCal invitations to attendees?
                    });
                    createdEvent = response.data;
                    if (!createdEvent?.id) {
                        throw new Error("Google Calendar API did not return an event ID.");
                    }
                    logger.info(`${functionName} Google Calendar event created successfully. Event ID: ${createdEvent.id}`, logContext);
                } catch (gcalError: any) {
                    logger.error(`${functionName} Error inserting event into Google Calendar.`, { ...logContext, error: gcalError.message, code: gcalError.code, errors: gcalError.errors });
                    // Update booking status to indicate failure and need for manual check
                    await bookingRef.update({ needsManualGcalCheck: true, processingError: `GCal Error: ${gcalError.message}` }).catch(err => logger.error("Failed update booking", {err}));
                    sendPushNotification({ subject: `GCal Creation FAILED - Booking ${bookingId}`, body: `Failed to create GCal event for booking ${bookingId}. Reason: ${gcalError.message}. Manual creation required.`, bookingId, severity: "critical" }).catch(...);
                    // Rethrow to potentially trigger Pub/Sub retry? Or ACK? Let's ACK to avoid loops on persistent GCal errors.
                    // throw new HttpsError('internal', `Google Calendar API error: ${gcalError.message}`, { errorCode: ErrorCode.GoogleCalendarError });
                    return; // ACK
                }

                // 6. Update Booking with GCal Event ID
                logger.info(`${functionName} Updating booking ${bookingId} with GCal Event ID ${createdEvent.id}...`, logContext);
                await bookingRef.update({
                    googleCalendarEventId: createdEvent.id,
                    needsManualGcalCheck: false, // Clear flag if previously set
                    processingError: null, // Clear previous errors
                    updatedAt: FieldValue.serverTimestamp(),
                });

                logAdminAction("CreateGoogleCalendarEventSuccess", { bookingId, gcalEventId: createdEvent.id, calendarId });


            } catch (error: any) {
                // 7. Handle Internal Function Errors
                const errorMessage = error.message || "An unknown internal error occurred.";
                const errorCode = Object.values(ErrorCode).includes(errorMessage as ErrorCode) ? errorMessage as ErrorCode : ErrorCode.InternalError;
                logger.error(`${functionName} Booking ${bookingId}: Unhandled internal error. Error Code: ${errorCode}`, { error: errorMessage, messageId });

                // Attempt to update booking status to indicate failure
                try {
                     if (bookingId) { // Ensure bookingId is defined
                         await db.collection('eventBookings').doc(bookingId).update({
                             needsManualGcalCheck: true,
                             processingError: `Internal GCal function error (${errorCode}): ${errorMessage.substring(0, 200)}`,
                             updatedAt: FieldValue.serverTimestamp()
                         });
                     }
                } catch (updateError: any) {
                    logger.error(`${functionName} Booking ${bookingId}: FAILED to update booking status after internal error.`, { updateError });
                }
                logAdminAction("CreateGoogleCalendarEventFailedInternal", { bookingId: bookingId || 'Unknown', messageId: messageId, errorMessage: errorMessage, errorCode: errorCode }).catch(...);
                // Throw the original error to trigger Pub/Sub retries for internal errors
                throw error;
            }
            // Successful completion implicitly ACKs the message
             logger.info(`${functionName} Execution finished for booking ${bookingId}. Duration: ${Date.now() - startTimeFunc}ms`, { messageId });

        }); // End onMessagePublished
