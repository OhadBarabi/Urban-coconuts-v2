import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { v4 as uuidv4 } from 'uuid';

// --- Import Models ---
import {
    User, Menu, Product, EventBooking, EventBookingStatus, EventItemType, EventBookingItem,
    PaymentStatus, AppConfigEventSettings, AddressInput, GeoPointJson // Added AddressInput, GeoPointJson
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { fetchEventSettings } from '../config/config_helpers';
// import { calculateEventPrice } from '../utils/event_calculations'; // Helper to calculate item/total price
// import { checkEventAvailability } from './checkEventAvailability'; // Re-use availability logic? Or assume client checked?
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`); return userId != null; }
interface EventSettings { timeZone?: string; requiresAdminApproval?: boolean; minOrderValueSmallestUnit?: { [key: string]: number }; /* Add other settings */ }
async function fetchEventSettings(): Promise<EventSettings | null> { logger.info(`[Mock Config] Fetching event settings`); return { timeZone: 'Asia/Jerusalem', requiresAdminApproval: true, minOrderValueSmallestUnit: { 'ILS': 50000 } }; } // Example: 500 ILS min
interface PriceCalculationResult { lineItems: EventBookingItem[]; totalAmountSmallestUnit: number; error?: string; }
async function calculateEventPrice(items: any[], menuId: string | null, currency: string, durationMinutes: number): Promise<PriceCalculationResult> {
    logger.info(`[Mock Calc] Calculating event price...`);
    let total = 0;
    const lineItems: EventBookingItem[] = items.map((item, index) => {
        const price = (item.quantity ?? 1) * 10000; // Mock price: 100 currency units per item/hour
        total += price;
        return {
            ...item, // Keep original input fields
            bookingItemId: uuidv4(), // Generate unique ID
            productName: `Mock Item ${index + 1}`, // Mock name
            calculatedPriceSmallestUnit: price,
            appliedUnitPriceSmallestUnit: 10000, // Mock unit price
        };
    });
    return { lineItems, totalAmountSmallestUnit: total };
}
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { Timestamp, GeoPoint } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Settings, User, Menu, Product not found
    FailedPrecondition = "FAILED_PRECONDITION", // Availability check failed, Min order not met
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    InvalidDateRange = "INVALID_DATE_RANGE",
    InvalidLocation = "INVALID_LOCATION",
    InvalidItems = "INVALID_ITEMS",
    AvailabilityCheckFailed = "AVAILABILITY_CHECK_FAILED", // If we re-check availability here
    CalculationError = "CALCULATION_ERROR",
    MinOrderValueNotMet = "MIN_ORDER_VALUE_NOT_MET",
}

// --- Interfaces ---
interface SelectedEventItemInput { // Input from client
    itemId: string; // ID of Product, Package, Service, RentalItem
    itemType: EventItemType | string;
    quantity?: number | null; // For products/packages
    durationHours?: number | null; // For services/rentals
}
interface CreateEventBookingInput {
    // eventDate: string; // ISO String (or just use startTime?) - Let's use startTime/endTime
    startTime: string; // ISO 8601 string
    endTime: string;   // ISO 8601 string
    location: AddressInput; // Use the defined AddressInput interface
    eventMenuId?: string | null; // Optional menu selection
    selectedItems: SelectedEventItemInput[];
    notes?: string | null;
    // Optional: currencyCode if client knows it, otherwise default from settings/user
    currencyCode?: string | null;
}

// --- The Cloud Function ---
export const createEventBooking = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for potential calculations, reads
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true; bookingId: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createEventBooking V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const customerId = request.auth.uid;
        const data = request.data as CreateEventBookingInput;
        const logContext: any = { customerId, startTime: data?.startTime, endTime: data?.endTime, itemCount: data?.selectedItems?.length };

        logger.info(`${functionName} Invoked.`, logContext);

        // Basic Permission Check
        const hasPermission = await checkPermission(customerId, 'event:create');
        if (!hasPermission) {
            logger.warn(`${functionName} Permission denied for user ${customerId}.`, logContext);
            return { success: false, error: "error.permissionDenied.createEvent", errorCode: ErrorCode.PermissionDenied };
        }

        // 2. Input Validation
        let startTime: Date;
        let endTime: Date;
        let durationMinutes: number;
        let locationGeoPoint: admin.firestore.GeoPoint | null = null;
        try {
            if (!data?.startTime || !data.endTime || !data.location || !Array.isArray(data.selectedItems) || data.selectedItems.length === 0) {
                throw new Error("Missing required fields: startTime, endTime, location, selectedItems");
            }
            startTime = new Date(data.startTime);
            endTime = new Date(data.endTime);
            if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
                throw new Error("Invalid date format for startTime or endTime");
            }
            if (endTime <= startTime) {
                throw new Error("End time must be after start time");
            }
            durationMinutes = Math.round((endTime.getTime() - startTime.getTime()) / (60 * 1000));

            // Validate location structure
            if (typeof data.location !== 'object' || (!data.location.address && !data.location.coordinates)) {
                 throw new Error("Invalid location structure: requires address or coordinates");
            }
            if (data.location.coordinates) {
                 if (typeof data.location.coordinates.latitude !== 'number' || typeof data.location.coordinates.longitude !== 'number') {
                     throw new Error("Invalid coordinates format");
                 }
                 locationGeoPoint = new GeoPoint(data.location.coordinates.latitude, data.location.coordinates.longitude);
            }

            // Validate selected items structure (basic)
            if (data.selectedItems.some(item => !item.itemId || !item.itemType || (!item.quantity && !item.durationHours))) {
                 throw new Error("Invalid selectedItems structure: requires itemId, itemType, and quantity or durationHours");
            }
            if (data.selectedItems.some(item => (item.quantity != null && (typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0)) ||
                                               (item.durationHours != null && typeof item.durationHours !== 'number' || item.durationHours <= 0))) {
                 throw new Error("Invalid quantity or durationHours in selectedItems");
            }

        } catch (validationError: any) {
            logger.error(`${functionName} Invalid input data.`, { ...logContext, error: validationError.message });
            return { success: false, error: `error.invalidInput::${validationError.message}`, errorCode: ErrorCode.InvalidArgument };
        }

        // --- Variables ---
        let eventSettings: EventSettings | null;
        let userData: User;
        let requiresAdminApproval: boolean;
        let initialStatus: EventBookingStatus;
        let currencyCode: string;

        try {
            // 3. Fetch Settings & User Data Concurrently
            const settingsPromise = fetchEventSettings();
            const userSnapPromise = db.collection('users').doc(customerId).get();

            [eventSettings, userData] = await Promise.all([
                settingsPromise, userSnapPromise.then(snap => {
                    if (!snap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
                    return snap.data() as User;
                })
            ]);

            requiresAdminApproval = eventSettings?.requiresAdminApproval ?? true; // Default to requiring approval
            initialStatus = requiresAdminApproval ? EventBookingStatus.PendingAdminApproval : EventBookingStatus.PendingCustomerAgreement;
            currencyCode = data.currencyCode ?? userData.preferredCurrency ?? eventSettings?.defaultCurrency ?? 'ILS'; // Determine currency
            logContext.requiresAdminApproval = requiresAdminApproval;
            logContext.initialStatus = initialStatus;
            logContext.currencyCode = currencyCode;

            // 4. Optional: Re-check Availability (more robust, but adds latency)
            // We might trust the client's previous checkAvailability call for speed.
            // If re-checking:
            // const availabilityResult = await checkEventAvailabilityInternal(startTime, endTime, data.location, data.requiredResourceTypes ?? []);
            // if (!availabilityResult.isAvailable) {
            //     logger.warn(`${functionName} Availability re-check failed.`, { ...logContext, reason: availabilityResult.reason });
            //     return { success: false, error: availabilityResult.reason ?? "error.event.unavailable", errorCode: ErrorCode.AvailabilityCheckFailed };
            // }

            // 5. Calculate Price & Format Line Items
            // This needs access to Product/Service/RentalItem data based on selectedItems
            // For now, using a mock calculation helper. Replace with real logic.
            logger.info(`${functionName} Calculating event price...`, logContext);
            const calculationResult = await calculateEventPrice(data.selectedItems, data.eventMenuId ?? null, currencyCode, durationMinutes);
            if (calculationResult.error) {
                logger.error(`${functionName} Price calculation failed.`, { ...logContext, error: calculationResult.error });
                throw new HttpsError('internal', `error.internal.calculation::${calculationResult.error}`, { errorCode: ErrorCode.CalculationError });
            }
            const { lineItems: calculatedLineItems, totalAmountSmallestUnit } = calculationResult;
            logContext.totalAmount = totalAmountSmallestUnit;

            // 6. Check Minimum Order Value
            const minOrderValue = eventSettings?.minOrderValueSmallestUnit?.[currencyCode] ?? 0;
            if (totalAmountSmallestUnit < minOrderValue) {
                 logger.warn(`${functionName} Total amount ${totalAmountSmallestUnit} is below minimum order value ${minOrderValue} ${currencyCode}.`, logContext);
                 return { success: false, error: `error.event.minOrderValueNotMet::${minOrderValue} ${currencyCode}`, errorCode: ErrorCode.MinOrderValueNotMet };
            }

            // 7. Create Event Booking Document in Firestore
            logger.info(`${functionName} Creating event booking document...`, logContext);
            const newBookingId = db.collection('eventBookings').doc().id;
            const bookingRef = db.collection('eventBookings').doc(newBookingId);
            const now = Timestamp.now();

            const newBookingData: EventBooking = {
                customerId: customerId,
                eventDate: Timestamp.fromDate(new Date(startTime.getFullYear(), startTime.getMonth(), startTime.getDate())), // Store date part for querying
                startTime: Timestamp.fromDate(startTime),
                endTime: Timestamp.fromDate(endTime),
                durationMinutes: durationMinutes,
                location: { // Store validated location data
                    address: data.location.address ?? '',
                    coordinates: locationGeoPoint,
                    zoneId: data.location.zoneId ?? null,
                    notes: data.location.notes ?? null,
                },
                eventMenuId: data.eventMenuId ?? null,
                selectedItems: calculatedLineItems, // Use items processed by calculation helper
                totalAmountSmallestUnit: totalAmountSmallestUnit,
                currencyCode: currencyCode,
                minOrderRequirementMet: totalAmountSmallestUnit >= minOrderValue,
                bookingStatus: initialStatus,
                // statusChangeHistory: [{ status: initialStatus, timestamp: now, userId: customerId, role: 'Customer' }], // Add initial history?
                // adminApprovalDetails: null,
                // agreementSentTimestamp: null,
                // agreementConfirmedTimestamp: null,
                paymentStatus: PaymentStatus.Pending, // Payment happens after agreement
                // paymentDetails: null,
                // cancellationFeeAppliedSmallestUnit: null,
                // cancellationTimestamp: null,
                // cancelledBy: null,
                // cancellationReason: null,
                // assignedResources: null,
                // assignedLeadCourierId: null,
                // actualStartTime: null,
                // actualEndTime: null,
                // lastDelayReason: null,
                // customerFeedbackId: null,
                // googleCalendarEventId: null,
                // needsManualGcalCheck: false, // Set to true if GCal check failed earlier
                // needsManualGcalDelete: false,
                // processingError: null,
                createdAt: now,
                updatedAt: now,
            };

            await bookingRef.set(newBookingData);
            logger.info(`${functionName} Event booking ${newBookingId} created successfully with status ${initialStatus}.`, logContext);

            // 8. Trigger Notifications (Async)
            const notificationPromises: Promise<void>[] = [];
             // Notify Customer
             notificationPromises.push(sendPushNotification({
                 userId: customerId, type: "EventBookingCreated", langPref: userData.preferredLanguage,
                 titleKey: "notification.eventCreated.title", messageKey: "notification.eventCreated.message",
                 messageParams: { bookingIdShort: newBookingId.substring(0, 6), status: initialStatus },
                 payload: { bookingId: newBookingId, screen: 'EventDetails' }
             }).catch(err => logger.error("Failed sending customer event created notification", { err })) );
             // Notify Admin if approval is needed
             if (requiresAdminApproval) {
                 notificationPromises.push(sendPushNotification({
                     topic: "admin-event-requests", // Or target specific admin users
                     type: "AdminEventApprovalNeeded",
                     titleKey: "notification.adminEventApproval.title", messageKey: "notification.adminEventApproval.message",
                     messageParams: { bookingId: newBookingId, customerName: userData.displayName ?? customerId },
                     payload: { bookingId: newBookingId, screen: 'AdminEventApproval' }
                 }).catch(err => logger.error("Failed sending admin event approval notification", { err })) );
             }
            Promise.allSettled(notificationPromises);


            // 9. Log User Activity (Async)
            logUserActivity("CreateEventBooking", { bookingId: newBookingId, startTime: data.startTime, endTime: data.endTime, itemCount: data.selectedItems.length, totalAmount: totalAmountSmallestUnit, initialStatus }, customerId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 10. Return Success
            return { success: true, bookingId: newBookingId };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            const code = isHttpsError ? error.code : 'UNKNOWN';
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.createEvent.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
