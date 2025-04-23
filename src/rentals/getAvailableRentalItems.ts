import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import * as geofirestore from 'geofirestore';

// --- Import Models ---
import {
    RentalItem, Box, User // Assuming these are defined in models
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { calculateDistanceKm } from '../utils/geo_utils';
// import { checkOperatingHours } from '../utils/time_utils';
// import { fetchMatRentalSettings } from '../config/config_helpers';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`); return userId != null; }
function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number | null { /* Haversine Implementation */ if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) return null; const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI / 180; const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2); const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); const d = R * c; return d; }
interface OperatingHours { /* Define structure */ }
function checkOperatingHours(operatingHours: OperatingHours | undefined | null, checkTime: Date, timeZone?: string): boolean { logger.info(`[Mock Time Check] Checking operating hours (Mock: always true)`); return true; }
interface MatRentalSettings { allowedPickupRadiusKm?: number; maxPickupResults?: number; }
async function fetchMatRentalSettings(): Promise<MatRentalSettings | null> { logger.info(`[Mock Config] Fetching mat rental settings`); return { allowedPickupRadiusKm: 5, maxPickupResults: 10 }; }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { GeoPoint } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const DEFAULT_PICKUP_RADIUS_KM = 5;
const DEFAULT_MAX_PICKUP_RESULTS = 10;

// Initialize GeoFirestore
const geoFirestore = geofirestore.initializeApp(db);
const boxesGeoCollection = geoFirestore.collection('boxes'); // Assuming 'location' field is geohashed

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Settings or User not found
    InternalError = "INTERNAL_ERROR",
}

// --- Interfaces ---
interface LocationInput { latitude: number; longitude: number; }
interface GetAvailableRentalItemsInput { location: LocationInput; radiusKm?: number | null; }
interface AvailableRentalItemInfo { // Structure for the items array in the response
    itemId: string; // e.g., "mat_standard"
    itemName: string; // Translated
    imageUrl?: string | null;
    rentalFeeSmallestUnit: number;
    depositSmallestUnit: number;
    currencyCode: string; // Currency for this item type (maybe global?)
    availableAtBoxes: AvailableBoxInfo[]; // List of boxes where this item type is available
}
interface AvailableBoxInfo { // Structure for the boxes array within each item
    boxId: string;
    boxNumber: string; // V5
    distanceKm: number;
    address?: string | null;
    pickupTimeBufferMinutes: number; // V5
    // Add operating hours string for today?
}

// --- The Cloud Function ---
export const getAvailableRentalItems = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for geo-query and processing
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true; availableItems: AvailableRentalItemInfo[] } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[getAvailableRentalItems V1]";
        const startTime = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const userId = request.auth.uid;
        const data = request.data as GetAvailableRentalItemsInput;
        const logContext: any = { userId, location: data?.location, requestedRadius: data?.radiusKm };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.location || typeof data.location.latitude !== 'number' || typeof data.location.longitude !== 'number') {
            return { success: false, error: "error.invalidInput.location", errorCode: ErrorCode.InvalidArgument };
        }
        const userLocation = data.location;
        const centerGeoPoint = new GeoPoint(userLocation.latitude, userLocation.longitude);

        // --- Variables ---
        let radiusKm: number;
        let maxResults: number;
        let defaultPickupTimeBufferMinutes: number; // V5 addition
        let userPreferredLanguage: string | undefined;

        try {
            // Fetch User Language & Settings Concurrently
            const userSnapPromise = db.collection('users').doc(userId).get();
            const settingsPromise = fetchMatRentalSettings(); // Fetch rental specific settings
            const generalSettingsPromise = fetchGeneralSettings(); // Fetch general settings for default buffer
            const hasPermissionPromise = checkPermission(userId, 'rental:view_available');

            const [userSnap, settings, generalSettings, hasPermission] = await Promise.all([
                userSnapPromise, settingsPromise, generalSettingsPromise, hasPermissionPromise
            ]);

            if (!hasPermission) { throw new HttpsError('permission-denied', "error.permissionDenied.viewRentals", { errorCode: ErrorCode.PermissionDenied }); }
            userPreferredLanguage = userSnap.exists ? (userSnap.data() as User)?.preferredLanguage : undefined;
            radiusKm = data.radiusKm ?? settings?.allowedPickupRadiusKm ?? DEFAULT_PICKUP_RADIUS_KM;
            radiusKm = Math.min(MAX_SEARCH_RADIUS_KM, Math.max(1, radiusKm)); // Clamp radius
            maxResults = settings?.maxPickupResults ?? DEFAULT_MAX_PICKUP_RESULTS;
            defaultPickupTimeBufferMinutes = generalSettings?.defaultPickupTimeBufferMinutes ?? 15; // V5 default buffer
            logContext.radiusKm = radiusKm;
            logContext.maxResults = maxResults;

            // 3. Fetch all active Rental Item Types (Master List)
            // Assuming a collection 'rentalItems' holds the types of items available for rent
            const rentalItemTypesSnap = await db.collection('rentalItems').where('isActive', '==', true).get();
            if (rentalItemTypesSnap.empty) {
                logger.info(`${functionName} No active rental item types found.`);
                return { success: true, availableItems: [] };
            }
            const activeRentalItems = new Map<string, RentalItem>();
            rentalItemTypesSnap.forEach(doc => {
                activeRentalItems.set(doc.id, doc.data() as RentalItem);
            });
            logger.info(`${functionName} Found ${activeRentalItems.size} active rental item types.`);

            // 4. Geo-query for nearby, active, visible Boxes
            logger.info(`${functionName} Geo-querying boxes within ${radiusKm}km...`, logContext);
            const boxQuery = boxesGeoCollection.near({ center: centerGeoPoint, radius: radiusKm })
                .limit(maxResults * 2); // Fetch more to account for filtering

            const nearbyBoxesResult = await boxQuery.get();
            logger.info(`${functionName} Geo-query returned ${nearbyBoxesResult.docs.length} potential boxes.`);

            // 5. Filter Boxes & Check Availability
            const availableBoxesMap = new Map<string, Box & { distanceKm: number, pickupTimeBufferMinutes: number }>(); // Store boxes that are open and staffed
            const courierFetchPromises = new Map<string, Promise<admin.firestore.DocumentSnapshot>>();
            const now = new Date();

            for (const doc of nearbyBoxesResult.docs) {
                const boxData = { id: doc.id, ...doc.data() } as Box & { distance?: number };
                const boxLogContext = { ...logContext, boxId: boxData.id };

                if (boxData.isActive !== true || boxData.isCustomerVisible !== true) continue;

                // Check Operating Hours
                if (!checkOperatingHours(boxData.operatingHours, now)) {
                    logger.debug(`${functionName} Box ${boxData.id} skipped: Currently closed.`);
                    continue;
                }

                // Check Assigned Courier Status (V5 Logic)
                const courierId = boxData.assignedCourierId;
                if (!courierId) {
                    logger.debug(`${functionName} Box ${boxData.id} skipped: No courier assigned.`);
                    continue;
                }

                try {
                    if (!courierFetchPromises.has(courierId)) {
                        courierFetchPromises.set(courierId, db.collection('couriers').doc(courierId).get());
                    }
                    const courierSnap = await courierFetchPromises.get(courierId)!;

                    if (!courierSnap.exists) {
                        logger.warn(`${functionName} Box ${boxData.id} skipped: Assigned courier ${courierId} not found.`, boxLogContext);
                        continue;
                    }
                    const courierData = courierSnap.data() as User; // Assuming courier data is in User doc
                    if (courierData.isActive !== true || courierData.shiftStatus !== CourierShiftStatus.OnDuty) {
                        logger.debug(`${functionName} Box ${boxData.id} skipped: Courier ${courierId} inactive or not OnDuty.`, boxLogContext);
                        continue;
                    }

                    // Determine Pickup Buffer Time
                    const pickupTimeBufferMinutes = (courierData.pickupTimeBufferMinutes != null && courierData.pickupTimeBufferMinutes >= 0)
                        ? courierData.pickupTimeBufferMinutes
                        : defaultPickupTimeBufferMinutes;

                    // Calculate Distance
                    const distanceKm = boxData.distance ?? calculateDistanceKm(
                        userLocation.latitude, userLocation.longitude,
                        boxData.location.latitude, boxData.location.longitude
                    );
                    if (distanceKm === null) {
                        logger.warn(`${functionName} Box ${boxData.id} skipped: Could not calculate distance.`, boxLogContext);
                        continue;
                    }

                    // Box is open and staffed - add to map
                    availableBoxesMap.set(boxData.id!, { ...boxData, distanceKm, pickupTimeBufferMinutes });

                } catch (courierError: any) {
                    logger.error(`${functionName} Failed to fetch/process courier ${courierId} for box ${boxData.id}. Skipping box.`, { ...boxLogContext, error: courierError.message });
                }
            } // End box loop

            if (availableBoxesMap.size === 0) {
                logger.info(`${functionName} No open and staffed boxes found nearby.`);
                return { success: true, availableItems: [] };
            }
            logger.info(`${functionName} Found ${availableBoxesMap.size} open/staffed boxes.`);

            // 6. Aggregate Availability by Item Type
            const resultsMap = new Map<string, AvailableRentalItemInfo>();

            activeRentalItems.forEach((itemTypeData, itemTypeId) => {
                const availableAtBoxesForItem: AvailableBoxInfo[] = [];

                availableBoxesMap.forEach((box) => {
                    // Check if the box *currently* has this item type available (using inventory or a dedicated field)
                    // **ASSUMPTION:** Using `box.availableRentalItemIds` array (needs schema update)
                    if (Array.isArray(box.availableRentalItemIds) && box.availableRentalItemIds.includes(itemTypeId)) {
                        availableAtBoxesForItem.push({
                            boxId: box.id!,
                            boxNumber: box.boxNumber ?? "N/A", // V5
                            distanceKm: parseFloat(box.distanceKm.toFixed(2)),
                            address: box.address ?? null,
                            pickupTimeBufferMinutes: box.pickupTimeBufferMinutes, // V5
                        });
                    }
                });

                // Only add item type if it's available in at least one nearby box
                if (availableAtBoxesForItem.length > 0) {
                    // Sort boxes by distance for this item
                    availableAtBoxesForItem.sort((a, b) => a.distanceKm - b.distanceKm);

                    resultsMap.set(itemTypeId, {
                        itemId: itemTypeId,
                        // Use helper for translation
                        itemName: getLocalizedString(itemTypeData.itemName_i18n, userPreferredLanguage) ?? 'Rental Item',
                        imageUrl: itemTypeData.imageUrl ?? null,
                        rentalFeeSmallestUnit: itemTypeData.rentalFeeSmallestUnit,
                        depositSmallestUnit: itemTypeData.depositSmallestUnit,
                        currencyCode: itemTypeData.currencyCode ?? 'ILS', // Use item's currency or default
                        availableAtBoxes: availableAtBoxesForItem.slice(0, maxResults), // Apply max results per item type
                    });
                }
            });

            // 7. Format and Return
            const finalAvailableItems = Array.from(resultsMap.values());
            // Optional: Sort the final list of item types (e.g., alphabetically by name)
            // finalAvailableItems.sort((a, b) => a.itemName.localeCompare(b.itemName));

            logger.info(`${functionName} Returning ${finalAvailableItems.length} available rental item types. Duration: ${Date.now() - startTime}ms`);
            return { success: true, availableItems: finalAvailableItems };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            const code = isHttpsError ? error.code : 'UNKNOWN';
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.getAvailableRentals.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        }
    }
);
