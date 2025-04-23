import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import * as geofirestore from 'geofirestore';

// --- Import Models ---
import {
    Box, User // Assuming these are defined in models
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { calculateDistanceKm } from '../utils/geo_utils';
// import { checkOperatingHours } from '../utils/time_utils';
// import { fetchMatRentalSettings } from '../config/config_helpers';
// import { fetchGeneralSettings } from '../config/config_helpers'; // For default buffer

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`); return userId != null; }
function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number | null { /* Haversine Implementation */ if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) return null; const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI / 180; const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2); const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); const d = R * c; return d; }
interface OperatingHours { /* Define structure */ }
function checkOperatingHours(operatingHours: OperatingHours | undefined | null, checkTime: Date, timeZone?: string): boolean { logger.info(`[Mock Time Check] Checking operating hours (Mock: always true)`); return true; }
interface MatRentalSettings { allowedReturnRadiusKm?: number; maxReturnResults?: number; }
async function fetchMatRentalSettings(): Promise<MatRentalSettings | null> { logger.info(`[Mock Config] Fetching mat rental settings`); return { allowedReturnRadiusKm: 10, maxReturnResults: 5 }; }
interface GeneralSettings { defaultPickupTimeBufferMinutes?: number; }
async function fetchGeneralSettings(): Promise<GeneralSettings | null> { logger.info(`[Mock Config] Fetching general settings`); return { defaultPickupTimeBufferMinutes: 15 }; }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { GeoPoint } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const DEFAULT_RETURN_RADIUS_KM = 10;
const DEFAULT_MAX_RETURN_RESULTS = 5;
const MAX_SEARCH_RADIUS_KM = 50; // Safety limit

// Initialize GeoFirestore
const geoFirestore = geofirestore.initializeApp(db);
const boxesGeoCollection = geoFirestore.collection('boxes');

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Settings or User not found
    InternalError = "INTERNAL_ERROR",
}
enum CourierShiftStatus { OnDuty = "OnDuty" } // Only need OnDuty for check

// --- Interfaces ---
interface LocationInput { latitude: number; longitude: number; }
interface GetAvailableReturnBoxesInput {
    currentLocation: LocationInput; // User's current location
    rentalItemId: string; // The type of item being returned (for potential future capacity checks)
    radiusKm?: number | null;
}
interface AvailableReturnBoxInfo { // Structure for the response
    boxId: string;
    boxNumber: string; // V5
    distanceKm: number;
    address?: string | null;
    pickupTimeBufferMinutes: number; // V5 - Still relevant as proxy for courier presence/activity? Or just use operating hours? Let's keep it.
    // Add operating hours string for today?
}

// --- The Cloud Function ---
export const getAvailableReturnBoxes = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for geo-query and processing
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true; returnBoxes: AvailableReturnBoxInfo[] } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[getAvailableReturnBoxes V1]";
        const startTime = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const userId = request.auth.uid;
        const data = request.data as GetAvailableReturnBoxesInput;
        const logContext: any = { userId, location: data?.currentLocation, rentalItemId: data?.rentalItemId, requestedRadius: data?.radiusKm };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.currentLocation || typeof data.currentLocation.latitude !== 'number' || typeof data.currentLocation.longitude !== 'number' ||
            !data.rentalItemId || typeof data.rentalItemId !== 'string') // Validate rentalItemId is present
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const userLocation = data.currentLocation;
        const centerGeoPoint = new GeoPoint(userLocation.latitude, userLocation.longitude);

        // --- Variables ---
        let radiusKm: number;
        let maxResults: number;
        let defaultPickupTimeBufferMinutes: number; // V5 addition

        try {
            // Fetch Settings & Permission Concurrently
            const settingsPromise = fetchMatRentalSettings(); // Fetch rental specific settings
            const generalSettingsPromise = fetchGeneralSettings(); // Fetch general settings for default buffer
            const hasPermissionPromise = checkPermission(userId, 'rental:view_return_boxes'); // Permission to see return locations

            const [settings, generalSettings, hasPermission] = await Promise.all([
                settingsPromise, generalSettingsPromise, hasPermissionPromise
            ]);

            if (!hasPermission) { throw new HttpsError('permission-denied', "error.permissionDenied.viewReturnBoxes", { errorCode: ErrorCode.PermissionDenied }); }

            radiusKm = data.radiusKm ?? settings?.allowedReturnRadiusKm ?? DEFAULT_RETURN_RADIUS_KM;
            radiusKm = Math.min(MAX_SEARCH_RADIUS_KM, Math.max(1, radiusKm)); // Clamp radius
            maxResults = settings?.maxReturnResults ?? DEFAULT_MAX_RETURN_RESULTS;
            defaultPickupTimeBufferMinutes = generalSettings?.defaultPickupTimeBufferMinutes ?? 15; // V5 default buffer
            logContext.radiusKm = radiusKm;
            logContext.maxResults = maxResults;
            logger.info(`${functionName} Using radius: ${radiusKm}km, max results: ${maxResults}`);

            // 3. Geo-query for nearby, active Boxes (Visibility doesn't matter for return)
            logger.info(`${functionName} Geo-querying boxes within ${radiusKm}km...`, logContext);
            const boxQuery = boxesGeoCollection.near({ center: centerGeoPoint, radius: radiusKm })
                .limit(maxResults * 3); // Fetch more initially

            const nearbyBoxesResult = await boxQuery.get();
            logger.info(`${functionName} Geo-query returned ${nearbyBoxesResult.docs.length} potential boxes.`);

            // 4. Filter Boxes & Check Availability
            const availableReturnBoxes: AvailableReturnBoxInfo[] = [];
            const courierFetchPromises = new Map<string, Promise<admin.firestore.DocumentSnapshot>>();
            const now = new Date();

            for (const doc of nearbyBoxesResult.docs) {
                const boxData = { id: doc.id, ...doc.data() } as Box & { distance?: number };
                const boxLogContext = { ...logContext, boxId: boxData.id };

                // Filter 1: Box must be active (isCustomerVisible doesn't matter for returns)
                if (boxData.isActive !== true) continue;

                // Filter 2: Box must be currently operating
                if (!checkOperatingHours(boxData.operatingHours, now)) {
                    logger.debug(`${functionName} Box ${boxData.id} skipped for return: Currently closed.`);
                    continue;
                }

                // Filter 3: Box must have an assigned courier who is OnDuty (Crucial V5 Logic)
                const courierId = boxData.assignedCourierId;
                if (!courierId) {
                    logger.debug(`${functionName} Box ${boxData.id} skipped for return: No courier assigned.`);
                    continue;
                }

                try {
                    if (!courierFetchPromises.has(courierId)) {
                        courierFetchPromises.set(courierId, db.collection('users').doc(courierId).get()); // Assuming courier data is in users
                    }
                    const courierSnap = await courierFetchPromises.get(courierId)!;

                    if (!courierSnap.exists) {
                        logger.warn(`${functionName} Box ${boxData.id} skipped for return: Assigned courier ${courierId} not found.`, boxLogContext);
                        continue;
                    }
                    const courierData = courierSnap.data() as User;
                    if (courierData.isActive !== true || courierData.shiftStatus !== CourierShiftStatus.OnDuty) {
                        logger.debug(`${functionName} Box ${boxData.id} skipped for return: Courier ${courierId} inactive or not OnDuty.`, boxLogContext);
                        continue;
                    }

                    // Determine Pickup Buffer Time (using it as proxy for courier activity/presence)
                    const pickupTimeBufferMinutes = (courierData.pickupTimeBufferMinutes != null && courierData.pickupTimeBufferMinutes >= 0)
                        ? courierData.pickupTimeBufferMinutes
                        : defaultPickupTimeBufferMinutes;

                    // Calculate Distance
                    const distanceKm = boxData.distance ?? calculateDistanceKm(
                        userLocation.latitude, userLocation.longitude,
                        boxData.location.latitude, boxData.location.longitude
                    );
                    if (distanceKm === null) {
                        logger.warn(`${functionName} Box ${boxData.id} skipped for return: Could not calculate distance.`, boxLogContext);
                        continue;
                    }

                    // Filter 4: Check if box has capacity/allowance for this item type return (Optional Future Enhancement)
                    // e.g., check `box.acceptedReturnItemTypes` or `box.rentalInventoryCapacity`
                    // For now, assume any open, staffed box can accept any return.

                    // Box is suitable for return
                    availableReturnBoxes.push({
                        boxId: boxData.id!,
                        boxNumber: boxData.boxNumber ?? "N/A", // V5
                        distanceKm: parseFloat(distanceKm.toFixed(2)),
                        address: boxData.address ?? null,
                        pickupTimeBufferMinutes: pickupTimeBufferMinutes, // V5
                    });

                    // Apply max results limit
                    if (availableReturnBoxes.length >= maxResults) {
                        logger.info(`${functionName} Reached max return results (${maxResults}). Stopping search.`);
                        break;
                    }

                } catch (courierError: any) {
                    logger.error(`${functionName} Failed to fetch/process courier ${courierId} for box ${boxData.id}. Skipping box for return.`, { ...boxLogContext, error: courierError.message });
                }
            } // End box loop

            // 5. Sort Results by Distance
            availableReturnBoxes.sort((a, b) => a.distanceKm - b.distanceKm);

            // 6. Return Results
            logger.info(`${functionName} Returning ${availableReturnBoxes.length} available return boxes. Duration: ${Date.now() - startTime}ms`);
            return { success: true, returnBoxes: availableReturnBoxes };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            const code = isHttpsError ? error.code : 'UNKNOWN';
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.getReturnBoxes.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        }
    }
);
