/**
 * google_calendar_helpers.ts
 *
 * Helper module for interacting with the Google Calendar API.
 * Uses Application Default Credentials (ADC) via the google-auth-library
 * and the googleapis client library.
 *
 * Prerequisites:
 * 1. Enable Google Calendar API in your Google Cloud project.
 * 2. Create a Google Calendar for events (recommended).
 * 3. Share the calendar with the Cloud Functions service account
 * (e.g., urbancoconuts-v2@appspot.gserviceaccount.com) with
 * 'Make changes to events' permission.
 * 4. Install the Google APIs client library: `npm install googleapis`
 * 5. Ensure the TARGET_CALENDAR_ID below is correctly set.
 */

import * as logger from "firebase-functions/logger";
import { Timestamp } from "firebase-admin/firestore";
import { google, calendar_v3 } from 'googleapis'; // Import googleapis library
import { auth } from 'google-auth-library'; // For authentication

// --- Configuration ---
// Uses the Calendar ID provided by the user. Consider environment variables for production.
const TARGET_CALENDAR_ID = process.env.GCAL_TARGET_CALENDAR_ID || 'b396b59e3a9bf15bee19457094e121f914e66006c8403df02edd790c6d22e938@group.calendar.google.com'; // <<<--- User Provided ID
const DEFAULT_TIME_ZONE = 'Asia/Jerusalem'; // Default timezone for events

// --- Interfaces ---
interface CalendarEventInput {
    summary: string; // Event title
    description?: string | null; // Event description
    startTime: Timestamp;
    endTime: Timestamp;
    attendees?: string[] | null; // List of attendee emails (optional)
    location?: string | null; // Event location string
    timeZone?: string | null; // e.g., 'Asia/Jerusalem'
    bookingId?: string | null; // Store booking ID in event for reference? (use extendedProperties)
}

interface CreateEventResult {
    success: boolean;
    eventId?: string | null; // The ID of the created Google Calendar event
    error?: string | null;
    errorCode?: string | null;
}

interface DeleteEventResult {
    success: boolean;
    error?: string | null;
    errorCode?: string | null;
}

interface UpdateAttendeesResult {
    success: boolean;
    eventId?: string | null;
    error?: string | null;
    errorCode?: string | null;
}

// --- Authentication ---
let googleAuthClient: any = null; // Cache the auth client

/**
 * Gets an authenticated Google API client using Application Default Credentials.
 * Caches the client for efficiency.
 * @returns Authenticated Google Auth Client
 */
async function getGoogleAuthClient() {
    if (googleAuthClient) {
        return googleAuthClient;
    }
    try {
        logger.info("Initializing Google Auth Client using ADC...");
        // Use Application Default Credentials (ADC) which works well with Service Accounts in GCP
        const credentials = await auth.getApplicationDefault();
        const scopes = ['https://www.googleapis.com/auth/calendar.events'];
        const client = await auth.getClient({ credentials, scopes });
        googleAuthClient = client; // Cache the client
        logger.info("Google Auth Client initialized successfully.");
        return googleAuthClient;
    } catch (error: any) {
        logger.error("Failed to get Google Auth Client.", { error: error.message });
        throw new Error("Could not initialize Google Auth Client.");
    }
}

// ============================================================================
// === Create Google Calendar Event ===========================================
// ============================================================================
/**
 * Creates a new event in the target Google Calendar using the googleapis library.
 *
 * @param eventData - Details of the event to create.
 * @returns Promise<CreateEventResult>
 */
export async function createGoogleCalendarEvent(eventData: CalendarEventInput): Promise<CreateEventResult> {
    const operation = "createGoogleCalendarEvent (Real)";
    logger.info(`[${operation}] Called`, { summary: eventData.summary, start: eventData.startTime.toDate(), end: eventData.endTime.toDate() });

    if (!TARGET_CALENDAR_ID || TARGET_CALENDAR_ID.includes('YOUR_CALENDAR_ID')) { // Basic check
        logger.error(`[${operation}] TARGET_CALENDAR_ID is not configured correctly.`);
        return { success: false, error: "Calendar ID not configured", errorCode: "CONFIG_ERROR" };
    }

    try {
        const authClient = await getGoogleAuthClient();
        const calendar = google.calendar({ version: 'v3', auth: authClient });

        const eventResource: calendar_v3.Schema$Event = {
            summary: eventData.summary,
            description: eventData.description || undefined,
            location: eventData.location || undefined,
            start: {
                dateTime: eventData.startTime.toDate().toISOString(),
                timeZone: eventData.timeZone || DEFAULT_TIME_ZONE,
            },
            end: {
                dateTime: eventData.endTime.toDate().toISOString(),
                timeZone: eventData.timeZone || DEFAULT_TIME_ZONE,
            },
            attendees: eventData.attendees?.map(email => ({ email })) || undefined,
            extendedProperties: {
                private: { // Use private properties to store internal IDs
                    bookingId: eventData.bookingId || undefined,
                }
            },
            // Add other properties like reminders, colorId etc. if needed
            // Example: Set a specific color
            // colorId: '5' // Google Calendar color IDs (1-11)
        };

        const response = await calendar.events.insert({
            calendarId: TARGET_CALENDAR_ID,
            requestBody: eventResource,
            sendNotifications: false, // Typically false for service account actions unless needed
        });

        if (response.status === 200 && response.data.id) {
            logger.info(`[${operation}] Google Calendar event created successfully. Event ID: ${response.data.id}`);
            return { success: true, eventId: response.data.id };
        } else {
            // This case might indicate partial success or unexpected response format
            logger.error(`[${operation}] Google Calendar API returned status ${response.status} but potentially failed.`, { responseData: response.data });
            return { success: false, error: `GCal API error: Status ${response.status}`, errorCode: `GCAL_API_${response.status}` };
        }
    } catch (error: any) {
        logger.error(`[${operation}] Failed to create Google Calendar event. Check service account permissions for the calendar.`, { error: error.message, code: error.code, calendarId: TARGET_CALENDAR_ID });
        return { success: false, error: `GCal API request failed: ${error.message}`, errorCode: "GCAL_REQUEST_FAILED" };
    }
}

// ============================================================================
// === Delete Google Calendar Event ===========================================
// ============================================================================
/**
 * Deletes an event from the target Google Calendar using its event ID.
 *
 * @param eventId - The ID of the Google Calendar event to delete.
 * @returns Promise<DeleteEventResult>
 */
export async function deleteGoogleCalendarEvent(eventId: string): Promise<DeleteEventResult> {
    const operation = "deleteGoogleCalendarEvent (Real)";
    logger.info(`[${operation}] Called`, { eventId });

    if (!TARGET_CALENDAR_ID || TARGET_CALENDAR_ID.includes('YOUR_CALENDAR_ID')) {
        logger.error(`[${operation}] TARGET_CALENDAR_ID is not configured correctly.`);
        return { success: false, error: "Calendar ID not configured", errorCode: "CONFIG_ERROR" };
    }
    if (!eventId) {
        logger.error(`[${operation}] Invalid eventId provided.`);
        return { success: false, error: "Invalid eventId", errorCode: "INVALID_ARGUMENT" };
    }
     if (eventId.startsWith('mock_gcal_')) {
          logger.warn(`[${operation}] Attempting to delete a mock event ID: ${eventId}. Skipping actual API call.`);
          return { success: true }; // Treat mock delete as success
     }

    try {
        const authClient = await getGoogleAuthClient();
        const calendar = google.calendar({ version: 'v3', auth: authClient });

        const response = await calendar.events.delete({
            calendarId: TARGET_CALENDAR_ID,
            eventId: eventId,
            sendNotifications: false, // Notify attendees of cancellation? Usually false for backend actions.
        });

        // Status 204 indicates successful deletion with no content returned
        if (response.status === 204) {
            logger.info(`[${operation}] Google Calendar event ${eventId} deleted successfully.`);
            return { success: true };
        } else {
             // Handle potential errors like 404 Not Found or 410 Gone - these might mean it's already deleted
             if (response.status === 404 || response.status === 410) {
                 logger.warn(`[${operation}] Google Calendar event ${eventId} not found or already deleted (Status: ${response.status}). Assuming success.`);
                 return { success: true }; // Treat as success if already gone
             }
             logger.error(`[${operation}] Google Calendar API returned status ${response.status} for deleting event ${eventId}.`, { responseData: response.data });
             return { success: false, error: `GCal API error: Status ${response.status}`, errorCode: `GCAL_API_${response.status}` };
        }
    } catch (error: any) {
        // Handle cases where the event might already be deleted (often a 404 or 410 caught above)
         if (error.code === 404 || error.code === 410) {
             logger.warn(`[${operation}] Google Calendar event ${eventId} not found or already deleted (Error Code: ${error.code}). Assuming success.`);
             return { success: true }; // Treat as success if already gone
         }
        logger.error(`[${operation}] Failed to delete Google Calendar event ${eventId}. Check service account permissions.`, { error: error.message, code: error.code, calendarId: TARGET_CALENDAR_ID });
        return { success: false, error: `GCal API request failed: ${error.message}`, errorCode: "GCAL_REQUEST_FAILED" };
    }
}

// ============================================================================
// === Update Google Calendar Event Attendees (Example) =======================
// ============================================================================
/**
 * Updates the attendee list for an existing Google Calendar event using patch.
 *
 * @param eventId - The ID of the Google Calendar event to update.
 * @param attendees - The new list of attendee emails. Use empty array to clear.
 * @returns Promise<UpdateAttendeesResult>
 */
export async function updateGoogleCalendarEventAttendees(eventId: string, attendees: string[]): Promise<UpdateAttendeesResult> {
    const operation = "updateGoogleCalendarEventAttendees (Real)";
    logger.info(`[${operation}] Called`, { eventId, attendeeCount: attendees?.length });

     if (!TARGET_CALENDAR_ID || TARGET_CALENDAR_ID.includes('YOUR_CALENDAR_ID')) {
         logger.error(`[${operation}] TARGET_CALENDAR_ID is not configured correctly.`);
         return { success: false, error: "Calendar ID not configured", errorCode: "CONFIG_ERROR" };
     }
     if (!eventId) {
         logger.error(`[${operation}] Invalid eventId provided.`);
         return { success: false, error: "Invalid eventId", errorCode: "INVALID_ARGUMENT" };
     }
      if (eventId.startsWith('mock_gcal_')) {
           logger.warn(`[${operation}] Attempting to update a mock event ID: ${eventId}. Skipping actual API call.`);
           return { success: true, eventId: eventId };
      }
      if (!Array.isArray(attendees)) {
           logger.error(`[${operation}] Invalid attendees list provided.`);
           return { success: false, error: "Invalid attendees list", errorCode: "INVALID_ARGUMENT" };
      }

    try {
        const authClient = await getGoogleAuthClient();
        const calendar = google.calendar({ version: 'v3', auth: authClient });

        // Prepare the patch request body
        const eventPatch: calendar_v3.Schema$Event = {
            attendees: attendees.map(email => ({ email })), // Set new list
        };

        const response = await calendar.events.patch({
            calendarId: TARGET_CALENDAR_ID,
            eventId: eventId,
            requestBody: eventPatch,
            sendNotifications: false, // Notify attendees of changes? Usually false for backend.
        });

        if (response.status === 200 && response.data.id) {
            logger.info(`[${operation}] Google Calendar event ${eventId} attendees updated successfully.`);
            return { success: true, eventId: response.data.id };
        } else {
            logger.error(`[${operation}] Google Calendar API returned status ${response.status} for updating event ${eventId}.`, { responseData: response.data });
            const errorCode = response.status === 404 ? "GCAL_EVENT_NOT_FOUND" : `GCAL_API_${response.status}`;
            return { success: false, eventId: eventId, error: `GCal API error: Status ${response.status}`, errorCode: errorCode };
        }
    } catch (error: any) {
         if (error.code === 404) {
             logger.error(`[${operation}] Google Calendar event ${eventId} not found for update.`);
             return { success: false, eventId: eventId, error: "Event not found", errorCode: "GCAL_EVENT_NOT_FOUND" };
         }
        logger.error(`[${operation}] Failed to update attendees for Google Calendar event ${eventId}. Check permissions.`, { error: error.message, code: error.code, calendarId: TARGET_CALENDAR_ID });
        return { success: false, eventId: eventId, error: `GCal API request failed: ${error.message}`, errorCode: "GCAL_REQUEST_FAILED" };
    }
}
