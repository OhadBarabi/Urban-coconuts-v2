import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { google } from 'googleapis'; // For Google Calendar API

// --- Import Models ---
import {
    User, EventBooking, EventResource, AppConfigEventSettings, GeoPointJson, AddressInput // Added AddressInput
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { fetchEventSettings } from '../config/config_helpers';
// import { getGoogleAuthClient } from '../utils/google_auth'; // Helper to get authenticated Google API client

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`); return userId != null; }
interface EventSettings { timeZone?: string; targetCalendarIds?: { [key: string]: string }; googleCalendarIntegrationEnabled?: boolean; minBookingLeadTimeDays?: number; maxBookingLeadTimeDays?: number; /* Add other settings */ }
async function fetchEventSettings(): Promise<EventSettings | null> { logger.info(`[Mock Config] Fetching event settings`); return { timeZone: 'Asia/Jerusalem', targetCalendarIds: { default: 'primary' }, googleCalendarIntegrationEnabled: true, minBookingLeadTimeDays: 2, maxBookingLeadTimeDays: 90 }; }
async function getGoogleAuthClient(): Promise<any> { logger.info(`[Mock Google Auth] Getting authenticated client`); /* Simulate auth */ return google.calendar({ version: 'v3', auth: 'mock-auth-client' }); } // Return a mock client
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Settings or User not found
    FailedPrecondition = "FAILED_PRECONDITION", // Date range invalid, GCal disabled
    Unavailable = "UNAVAILABLE", // Slot conflict in GCal or resource unavailable
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    InvalidDateRange = "INVALID_DATE_RANGE",
    DateRangeTooSoon = "DATE_RANGE_TOO_SOON",
    DateRangeTooFar = "DATE_RANGE_TOO_FAR",
    GoogleCalendarError = "GOOGLE_CALENDAR_ERROR",
    ResourceUnavailable = "RESOURCE_UNAVAILABLE",
}

// --- Interfaces ---
// Re-using AddressInput from models for location
interface CheckEventAvailabilityInput {
    startTime: string; // ISO 8601 string
    endTime: string;   // ISO 8601 string
    location: AddressInput; // Use the defined AddressInput interface
    requiredResourceTypes?: string[] | null; // e.g., ["Team", "Vehicle"]
}

interface CheckAvailabilityResult {
    isAvailable: boolean;
    reason?: string | null; // Key for i18n reason if not available
    reasonCode?: ErrorCode | null;
}

// --- The Cloud Function ---
export const checkEventAvailability = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow memory for GCal API calls
        timeoutSeconds: 60,
        // secrets: ["GOOGLE_API_CREDENTIALS"], // If using service account credentials for GCal
    },
    async (request): Promise<{ success: true; availability: CheckAvailabilityResult } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[checkEventAvailability V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const userId = request.auth.uid;
        const data = request.data as CheckEventAvailabilityInput;
        const logContext: any = { userId, startTime: data?.startTime, endTime: data?.endTime, location: data?.location, requiredResources: data?.requiredResourceTypes };

        logger.info(`${functionName} Invoked.`, logContext);

        // Basic Permission Check
        const hasPermission = await checkPermission(userId, 'event:check_availability');
        if (!hasPermission) {
            logger.warn(`${functionName} Permission denied for user ${userId}.`, logContext);
            return { success: false, error: "error.permissionDenied.checkAvailability", errorCode: ErrorCode.PermissionDenied };
        }

        // 2. Input Validation
        let startTime: Date;
        let endTime: Date;
        try {
            if (!data?.startTime || !data.endTime || !data.location) {
                throw new Error("Missing required fields: startTime, endTime, location");
            }
            startTime = new Date(data.startTime);
            endTime = new Date(data.endTime);
            if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
                throw new Error("Invalid date format for startTime or endTime");
            }
            if (endTime <= startTime) {
                throw new Error("End time must be after start time");
            }
            // Validate location structure (basic check)
            if (typeof data.location !== 'object' || (!data.location.address && !data.location.coordinates)) {
                 throw new Error("Invalid location structure");
            }
            if (data.location.coordinates && (typeof data.location.coordinates.latitude !== 'number' || typeof data.location.coordinates.longitude !== 'number')) {
                throw new Error("Invalid coordinates format");
            }
            // Validate resource types if provided
            if (data.requiredResourceTypes != null && !Array.isArray(data.requiredResourceTypes)) {
                throw new Error("requiredResourceTypes must be an array or null");
            }

        } catch (validationError: any) {
            logger.error(`${functionName} Invalid input data.`, { ...logContext, error: validationError.message });
            return { success: false, error: `error.invalidInput::${validationError.message}`, errorCode: ErrorCode.InvalidArgument };
        }

        // --- Variables ---
        let eventSettings: EventSettings | null;

        try {
            // 3. Fetch Event Settings
            eventSettings = await fetchEventSettings();
            const timeZone = eventSettings?.timeZone ?? 'UTC'; // Default to UTC if not set
            logContext.timeZone = timeZone;

            // 4. Validate Date Range against Settings
            const now = new Date();
            const minLeadTimeDays = eventSettings?.minBookingLeadTimeDays ?? 0;
            const maxLeadTimeDays = eventSettings?.maxBookingLeadTimeDays ?? 365; // Default to 1 year

            const minBookingDate = new Date(now.getTime() + minLeadTimeDays * 24 * 60 * 60 * 1000);
            const maxBookingDate = new Date(now.getTime() + maxLeadTimeDays * 24 * 60 * 60 * 1000);

            if (startTime < minBookingDate) {
                logger.warn(`${functionName} Start time ${startTime} is too soon (min lead time: ${minLeadTimeDays} days).`, logContext);
                return { success: true, availability: { isAvailable: false, reason: "error.event.tooSoon", reasonCode: ErrorCode.DateRangeTooSoon } };
            }
            if (startTime > maxBookingDate) {
                logger.warn(`${functionName} Start time ${startTime} is too far in the future (max lead time: ${maxLeadTimeDays} days).`, logContext);
                return { success: true, availability: { isAvailable: false, reason: "error.event.tooFar", reasonCode: ErrorCode.DateRangeTooFar } };
            }

            // 5. Check Google Calendar Availability (if enabled)
            if (eventSettings?.googleCalendarIntegrationEnabled && eventSettings.targetCalendarIds) {
                logger.info(`${functionName} Checking Google Calendar availability...`, logContext);
                try {
                    const calendar = await getGoogleAuthClient(); // Get authenticated client
                    const calendarId = eventSettings.targetCalendarIds.default ?? 'primary'; // Use default or primary

                    const freeBusyResponse = await calendar.freebusy.query({
                        requestBody: {
                            timeMin: startTime.toISOString(),
                            timeMax: endTime.toISOString(),
                            timeZone: timeZone,
                            items: [{ id: calendarId }],
                        },
                    });

                    const busySlots = freeBusyResponse?.data?.calendars?.[calendarId]?.busy;
                    if (busySlots && busySlots.length > 0) {
                        logger.warn(`${functionName} Conflict found in Google Calendar ${calendarId} for the requested time slot.`, { ...logContext, busySlots });
                        return { success: true, availability: { isAvailable: false, reason: "error.event.calendarConflict", reasonCode: ErrorCode.Unavailable } };
                    }
                    logger.info(`${functionName} Google Calendar slot is free.`, logContext);

                } catch (gcalError: any) {
                    logger.error(`${functionName} Error checking Google Calendar.`, { ...logContext, error: gcalError.message, code: gcalError.code });
                    // Decide whether to block or allow booking if GCal check fails
                    // Option 1: Block booking
                    // return { success: false, error: "error.google.calendarError", errorCode: ErrorCode.GoogleCalendarError };
                    // Option 2: Allow booking but flag for manual check (more resilient)
                    logger.warn(`${functionName} Proceeding despite Google Calendar check error. Manual check might be needed later.`);
                    // Potentially add a flag to the booking later if created
                }
            } else {
                logger.info(`${functionName} Google Calendar integration disabled or no target calendar configured. Skipping GCal check.`, logContext);
            }

            // 6. Check Internal Resource Availability (if required)
            const requiredResources = data.requiredResourceTypes ?? [];
            if (requiredResources.length > 0) {
                logger.info(`${functionName} Checking internal resource availability for types: ${requiredResources.join(', ')}...`, logContext);

                // Query existing *confirmed* event bookings that overlap the requested time
                const overlappingBookingsQuery = db.collection('eventBookings')
                    .where('bookingStatus', '==', 'Confirmed') // Only check against confirmed bookings
                    .where('endTime', '>', startTime) // Booking ends after requested start
                    .where('startTime', '<', endTime); // Booking starts before requested end

                const overlappingSnaps = await overlappingBookingsQuery.get();
                const busyResourceIds = new Set<string>();

                overlappingSnaps.forEach(doc => {
                    const booking = doc.data() as EventBooking;
                    if (booking.assignedResources) {
                        Object.values(booking.assignedResources).flat().forEach(id => busyResourceIds.add(id));
                    }
                });

                // Query available resources of the required types
                const resourcePromises = requiredResources.map(type =>
                    db.collection('eventResources')
                        .where('resourceType', '==', type)
                        .where('isActive', '==', true)
                        .get()
                );

                const resourceSnaps = await Promise.all(resourcePromises);

                // Check if there's at least one *available* resource for each required type
                for (let i = 0; i < requiredResources.length; i++) {
                    const type = requiredResources[i];
                    const availableOfType = resourceSnaps[i].docs.filter(doc => !busyResourceIds.has(doc.id));

                    if (availableOfType.length === 0) {
                        logger.warn(`${functionName} No available resources found for type '${type}' during the requested time.`, { ...logContext, busyResourceIds: Array.from(busyResourceIds) });
                        return { success: true, availability: { isAvailable: false, reason: `error.event.resourceUnavailable::${type}`, reasonCode: ErrorCode.ResourceUnavailable } };
                    }
                }
                logger.info(`${functionName} Required internal resources appear available.`, logContext);
            } else {
                logger.info(`${functionName} No specific internal resources required. Skipping internal check.`, logContext);
            }

            // 7. Check Location Zone/Validity (Optional)
            // if (eventSettings?.validLocationZones && data.location.zoneId) {
            //     if (!eventSettings.validLocationZones.includes(data.location.zoneId)) {
            //          logger.warn(`${functionName} Location zone '${data.location.zoneId}' is not valid.`, logContext);
            //          return { success: true, availability: { isAvailable: false, reason: "error.event.invalidZone", reasonCode: ErrorCode.Unavailable } };
            //     }
            // }

            // 8. If all checks passed, the slot is available
            logger.info(`${functionName} Availability check successful. Slot is available. Duration: ${Date.now() - startTimeFunc}ms`);
            return { success: true, availability: { isAvailable: true } };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            const code = isHttpsError ? error.code : 'UNKNOWN';
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.checkAvailability.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        }
    }
);
