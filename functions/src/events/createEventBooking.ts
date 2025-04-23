import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { v4 as uuidv4 } from 'uuid';

// --- Import Models ---
import {
    User, EventBooking, EventBookingStatus, EventItemType, SelectedEventItemInput,
    AppConfigEventSettings, Menu, Product, RentalItem, Address // Assuming Address is defined in models
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions'; // <-- Import REAL helper
// import { checkEventAvailability } from './checkEventAvailability'; // Assuming this exists and works
// import { calculateEventTotal } from '../utils/event_calculations'; // Using mock below
// import { logUserActivity } from '../utils/logging'; // Using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
// Mock for checkEventAvailability (replace with actual call if available)
interface AvailabilityResult { isAvailable: boolean; reason?: string; reasonCode?: string; }
async function checkEventAvailabilityMock(startTime: Timestamp, endTime: Timestamp, location: Address, requiredResources?: string[]): Promise<AvailabilityResult> {
    logger.info(`[Mock Availability Check] Checking for ${startTime.toDate()} to ${endTime.toDate()}`);
    await new Promise(res => setTimeout(res, 300)); // Simulate check time
    // Simple mock: Always available unless end time is before start time
    if (endTime <= startTime) return { isAvailable: false, reason: "End time before start time", reasonCode: "INVALID_DATE_RANGE" };
    return { isAvailable: true };
}
// Mock for calculateEventTotal
interface EventTotalResult { totalAmount: number; error?: string; minOrderRequirementMet?: boolean; currencyCode?: string; }
function calculateEventTotal(items: SelectedEventItemInput[], menu?: Menu | null, settings?: AppConfigEventSettings | null): EventTotalResult {
    logger.info(`[Mock Event Calc] Calculating total for ${items.length} items...`);
    let total = 0;
    items.forEach((item, index) => { total += (item.quantity ?? 1) * (1500 + index * 100); }); // Mock calculation
    const minOrderValue = settings?.minOrderValueSmallestUnit ?? 0;
    const currency = menu?.currencyCode ?? settings?.defaultCurrencyCode ?? 'ILS'; // Determine currency
    return { totalAmount: total, minOrderRequirementMet: total >= minOrderValue, currencyCode: currency };
}
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User, Menu, Item not found
    FailedPrecondition = "FAILED_PRECONDITION", // Slot unavailable, Min order not met, Invalid item type
    Aborted = "ABORTED", // Transaction failed (less likely here)
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND",
    MenuNotFound = "MENU_NOT_FOUND", // If menuId is provided
    ItemNotFound = "ITEM_NOT_FOUND", // Product/Package/Service/Rental not found
    InvalidItemType = "INVALID_ITEM_TYPE",
    SlotUnavailable = "SLOT_UNAVAILABLE",
    MinOrderNotMet = "MIN_ORDER_NOT_MET",
    InvalidDateRange = "INVALID_DATE_RANGE", // Start time after end time
    CalculationError = "CALCULATION_ERROR",
    ConfigNotFound = "CONFIG_NOT_FOUND", // Event settings missing
}

// --- Interfaces ---
// SelectedEventItemInput defined in models

interface CreateEventBookingInput {
    startTime: string; // ISO Date string
    endTime: string; // ISO Date string
    location: Address; // Address object
    eventMenuId?: string | null; // Optional menu selection
    selectedItems: SelectedEventItemInput[]; // List of items requested
    notes?: string | null;
    // currencyCode?: string | null; // Currency might be determined by menu/config
}

// --- The Cloud Function ---
export const createEventBooking = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for multiple reads/calculations
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true; bookingId: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createEventBooking V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const customerId = request.auth.uid;
        const data = request.data as CreateEventBookingInput;
        const logContext: any = { customerId, startTime: data?.startTime, endTime: data?.endTime, itemCount: data?.selectedItems?.length };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.startTime || typeof data.startTime !== 'string' ||
            !data?.endTime || typeof data.endTime !== 'string' ||
            !data?.location || typeof data.location !== 'object' || // Basic check for location object
            !Array.isArray(data.selectedItems) || data.selectedItems.length === 0 ||
            data.selectedItems.some(item => !item.itemId || !item.itemType || !Object.values(EventItemType).includes(item.itemType)) || // Validate item structure
            (data.eventMenuId != null && typeof data.eventMenuId !== 'string') ||
            (data.notes != null && typeof data.notes !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { startTime: startTimeStr, endTime: endTimeStr, location, eventMenuId, selectedItems, notes } = data;

        // --- Variables ---
        let userData: User;
        let userRole: string | null; // Fetch role
        let eventSettings: AppConfigEventSettings | null = null;
        let menuData: Menu | null = null;
        let calculationResult: EventTotalResult;
        const bookingId = db.collection('eventBookings').doc().id; // Pre-generate booking ID

        try {
            // Parse Dates
            let startTimeTs: Timestamp;
            let endTimeTs: Timestamp;
            try {
                startTimeTs = Timestamp.fromDate(new Date(startTimeStr));
                endTimeTs = Timestamp.fromDate(new Date(endTimeStr));
                if (endTimeTs <= startTimeTs) {
                    throw new Error("End time must be after start time.");
                }
            } catch (e: any) {
                 logger.error(`${functionName} Invalid date format or range.`, { ...logContext, startTimeStr, endTimeStr, error: e.message });
                 return { success: false, error: "error.invalidInput.dateRange", errorCode: ErrorCode.InvalidDateRange };
            }
            const durationMinutes = Math.round((endTimeTs.toMillis() - startTimeTs.toMillis()) / (60 * 1000));
            logContext.durationMinutes = durationMinutes;

            // 3. Fetch User, Event Settings, and Optional Menu Data
            const userRef = db.collection('users').doc(customerId);
            const settingsRef = db.collection('appConfig').doc('eventSettings');
            const menuRef = eventMenuId ? db.collection('menus').doc(eventMenuId) : null;

            logger.info(`${functionName} Fetching user, settings, and menu (if provided)...`, logContext);
            const [userSnap, settingsSnap, menuSnap] = await Promise.all([
                userRef.get(),
                settingsRef.get(),
                menuRef ? menuRef.get() : Promise.resolve(null) // Fetch menu only if ID provided
            ]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            userRole = userData.role; // Get role
            logContext.userRole = userRole;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });

            // Validate Event Settings
            if (!settingsSnap.exists) throw new HttpsError('internal', "Event settings configuration not found.", { errorCode: ErrorCode.ConfigNotFound });
            eventSettings = settingsSnap.data() as AppConfigEventSettings;

            // Validate Menu if provided
            if (eventMenuId) {
                if (!menuSnap || !menuSnap.exists) throw new HttpsError('not-found', `error.menu.notFound::${eventMenuId}`, { errorCode: ErrorCode.MenuNotFound });
                menuData = menuSnap.data() as Menu;
                if (!menuData.isEventMenu) throw new HttpsError('failed-precondition', `Menu ${eventMenuId} is not an event menu.`);
                // TODO: Validate selectedItems against menu's availableProducts?
            }

            // 4. Permission Check (Using REAL helper)
            // Pass fetched role to checkPermission
            const hasPermission = await checkPermission(customerId, userRole, 'event:create', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${customerId} (Role: ${userRole}) to create event booking.`, logContext);
                return { success: false, error: "error.permissionDenied.createEvent", errorCode: ErrorCode.PermissionDenied };
            }

            // 5. Check Event Availability (Using Mock for now)
            // TODO: Replace with actual call to checkEventAvailability helper/function if implemented separately
            logger.info(`${functionName} Checking event availability...`, logContext);
            const availability = await checkEventAvailabilityMock(startTimeTs, endTimeTs, location);
            if (!availability.isAvailable) {
                 logger.warn(`${functionName} Event slot is unavailable.`, { ...logContext, reason: availability.reason, reasonCode: availability.reasonCode });
                 return { success: false, error: `error.event.slotUnavailable::${availability.reasonCode || 'Unknown'}`, errorCode: ErrorCode.SlotUnavailable };
            }
            logger.info(`${functionName} Event slot available.`, logContext);

            // 6. Validate Selected Items Exist (Basic check - more detailed validation needed)
            // This is complex as items can be Products, Packages, Services, Rentals
            // For now, assume items are valid. Real implementation needs to fetch each item.
            logger.warn(`${functionName} Skipping detailed validation of selected items existence and type matching.`, logContext);
            // TODO: Implement fetching and validation for each item in selectedItems based on itemType.

            // 7. Calculate Event Total and Check Minimum Order
            logger.info(`${functionName} Calculating event total...`, logContext);
            calculationResult = calculateEventTotal(selectedItems, menuData, eventSettings);
            if (calculationResult.error) {
                throw new HttpsError('internal', `error.internal.calculation::${calculationResult.error}`, { errorCode: ErrorCode.CalculationError });
            }
            const { totalAmount, minOrderRequirementMet, currencyCode } = calculationResult;
            logContext.totalAmount = totalAmount;
            logContext.minOrderMet = minOrderRequirementMet;
            logContext.currencyCode = currencyCode;

            if (!minOrderRequirementMet) {
                logger.warn(`${functionName} Minimum order requirement not met. Required: ${eventSettings?.minOrderValueSmallestUnit}, Calculated: ${totalAmount}`, logContext);
                return { success: false, error: "error.event.minOrderNotMet", errorCode: ErrorCode.MinOrderNotMet };
            }
            if (!currencyCode) {
                 throw new HttpsError('internal', "Could not determine currency code for the event booking.");
            }

            // 8. Create EventBooking Document in Firestore
            logger.info(`${functionName} Creating event booking document ${bookingId}...`, logContext);
            const now = Timestamp.now();
            const initialStatus = EventBookingStatus.PendingAdminApproval; // Or PendingCustomerConfirmation? Depends on flow.

            const newBookingData: EventBooking = {
                bookingId: bookingId, // Store generated ID
                customerId: customerId,
                eventDate: startTimeTs, // Use start time as the primary date?
                startTime: startTimeTs,
                endTime: endTimeTs,
                durationMinutes: durationMinutes,
                location: location,
                eventMenuId: eventMenuId ?? null,
                selectedItems: selectedItems.map(item => ({ ...item, bookingItemId: uuidv4() })), // Add unique IDs to booked items
                totalAmountSmallestUnit: totalAmount,
                currencyCode: currencyCode,
                minOrderRequirementMet: minOrderRequirementMet ?? false,
                bookingStatus: initialStatus,
                statusChangeHistory: [{ from: null, to: initialStatus, timestamp: now, userId: customerId, role: userRole ?? 'Customer', reason: "Booking created" }],
                adminApprovalDetails: null,
                agreementSentTimestamp: null,
                agreementConfirmedTimestamp: null,
                paymentStatus: PaymentStatus.Pending, // Payment handled after approval/confirmation
                paymentDetails: null,
                cancellationFeeAppliedSmallestUnit: null,
                cancellationTimestamp: null,
                cancelledBy: null,
                cancellationReason: null,
                assignedResources: null,
                assignedLeadCourierId: null,
                actualStartTime: null,
                actualEndTime: null,
                lastDelayReason: null,
                customerFeedbackId: null,
                googleCalendarEventId: null, // Handled by background function later
                needsManualGcalCheck: false,
                needsManualGcalDelete: false,
                processingError: null,
                createdAt: now,
                updatedAt: now,
                notes: notes ?? null,
            };

            const bookingRef = db.collection('eventBookings').doc(bookingId);
            await bookingRef.set(newBookingData);
            logger.info(`${functionName} Event booking ${bookingId} created successfully with status ${initialStatus}.`, logContext);

            // 9. Log User Activity (Async)
            logUserActivity("CreateEventBooking", { bookingId, startTime: startTimeStr, endTime: endTimeStr, itemCount: selectedItems.length, totalAmount }, customerId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 10. Return Success
            return { success: true, bookingId: bookingId };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.createEvent.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            }
            // No transaction errors expected here unless DB fails

            logUserActivity("CreateEventBookingFailed", { startTime: startTimeStr, endTime: endTimeStr, error: error.message }, customerId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
