import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import * as GeoFirestoreTypes from 'geofirestore-core'; // Types for GeoPoint if using GeoFirestore library later

// --- Import Models ---
import { User, Box, Menu } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { logAdminAction } from '../utils/logging'; // Using mock from previous steps

// --- Configuration ---
const db = admin.firestore();
const { FieldValue, Timestamp, GeoPoint } = admin.firestore; // Import GeoPoint
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Box, User, Menu, or Courier not found
    AlreadyExists = "ALREADY_EXISTS", // Box number might need to be unique?
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BoxNotFound = "BOX_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    MenuNotFound = "MENU_NOT_FOUND",
    CourierNotFound = "COURIER_NOT_FOUND", // If validating assignedCourierId
    InvalidGeoPoint = "INVALID_GEO_POINT",
    InvalidI18nMap = "INVALID_I18N_MAP",
    InvalidMenusArray = "INVALID_MENUS_ARRAY",
    BoxNumberExists = "BOX_NUMBER_EXISTS",
}

// --- Interfaces ---

// Input for creating a box
interface CreateBoxInput {
    boxNumber: string; // Required, unique?
    boxName_i18n?: { [key: string]: string } | null;
    location: { latitude: number; longitude: number; }; // Required GeoPoint structure
    isActive?: boolean; // Default to true?
    isCustomerVisible?: boolean; // Default to true?
    priority?: number | null; // Default priority
    colorCode?: string | null;
    currencyCode: string; // Required (e.g., "ILS")
    countryCode: string; // Required (e.g., "IL")
    address?: string | null;
    assignedMenuIds?: string[] | null; // Array of Menu IDs
    // assignedCourierId?: string | null; // Assign courier separately?
    // operatingHours?: { [key: string]: any } | null; // Complex structure
    // initialInventory?: { [productId: string]: number } | null; // Handle inventory separately
    // initialRentalInventory?: { [rentalItemId: string]: number } | null; // Handle inventory separately
}

// Input for updating a box
interface UpdateBoxInput {
    boxId: string; // Required ID of the box to update
    boxNumber?: string; // Allow updating box number? Check for uniqueness.
    boxName_i18n?: { [key: string]: string } | null;
    location?: { latitude: number; longitude: number; }; // GeoPoint structure
    isActive?: boolean;
    isCustomerVisible?: boolean;
    priority?: number | null;
    colorCode?: string | null;
    currencyCode?: string;
    countryCode?: string;
    address?: string | null;
    assignedMenuIds?: string[] | null; // Replace entire list
    assignedCourierId?: string | null; // Allow updating assigned courier
    // operatingHours?: { [key: string]: any } | null;
    // Note: Inventory adjustments handled by adjustBoxInventory function
}

// Input for setting active/visible status (could be combined or separate)
interface SetBoxStatusInput {
    boxId: string;
    isActive?: boolean;
    isCustomerVisible?: boolean;
}

// Input for listing boxes
interface ListBoxesInput {
    pageSize?: number;
    pageToken?: string; // Use boxId as page token
    filterIsActive?: boolean | null;
    filterIsVisible?: boolean | null;
    // Add more filters? e.g., by countryCode, assigned courier?
}

// Output format for a single box
interface BoxOutput extends Omit<Box, 'createdAt' | 'updatedAt' | 'location'> {
    boxId: string; // Include the document ID
    location: { latitude: number; longitude: number; }; // Simple lat/lon structure for client
    createdAt?: string | null; // Optional: Convert timestamp to ISO string
    updatedAt?: string | null; // Optional: Convert timestamp to ISO string
}

// Output format for list response
interface ListBoxesOutput {
    boxes: BoxOutput[];
    nextPageToken?: string | null;
}

// Helper to validate i18n map
function validateI18nMap(map: any): boolean {
    // Allow null/undefined or valid map
    return map == null || (typeof map === 'object' && Object.keys(map).length > 0 && Object.values(map).every(val => typeof val === 'string'));
}

// Helper function to validate menu IDs exist
async function validateMenuIds(menuIds: string[]): Promise<boolean> {
    if (menuIds.length === 0) return true; // Empty array is valid
    try {
        const menuRefs = menuIds.map(id => db.collection('menus').doc(id));
        const menuDocs = await db.getAll(...menuRefs);
        return menuDocs.every(doc => doc.exists); // Check if all documents existed
    } catch (error) {
        logger.error("Error validating menu IDs", { error });
        return false;
    }
}

// Helper function to check if boxNumber already exists (excluding self during update)
async function checkBoxNumberExists(boxNumber: string, excludeBoxId?: string): Promise<boolean> {
    try {
        let query = db.collection('boxes').where('boxNumber', '==', boxNumber).limit(1);
        const snapshot = await query.get();
        if (snapshot.empty) {
            return false; // Doesn't exist
        }
        // If found, check if it's the same box we are excluding (during update)
        if (excludeBoxId && snapshot.docs[0].id === excludeBoxId) {
            return false; // It's the same box, so technically doesn't "exist" elsewhere
        }
        return true; // Exists (and it's not the excluded box)
    } catch (error) {
        logger.error("Error checking box number existence", { boxNumber, error });
        throw error; // Re-throw to indicate a check failure
    }
}


// ============================================================================
// === Create Box Function ====================================================
// ============================================================================
export const createBox = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "512MiB" }, // Memory for potential validations
    async (request): Promise<{ success: true; boxId: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createBox V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as CreateBoxInput;
        const logContext: any = { adminUserId, boxNumber: data?.boxNumber };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check - Define permission: 'admin:box:create'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:box:create', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to create box.`, logContext);
                return { success: false, error: "error.permissionDenied.createBox", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.boxNumber || typeof data.boxNumber !== 'string' || data.boxNumber.trim().length === 0 ||
            !data?.location || typeof data.location.latitude !== 'number' || typeof data.location.longitude !== 'number' ||
            !data?.currencyCode || typeof data.currencyCode !== 'string' || data.currencyCode.trim().length === 0 ||
            !data?.countryCode || typeof data.countryCode !== 'string' || data.countryCode.trim().length === 0 ||
            !validateI18nMap(data.boxName_i18n) || // Allow null/undefined name map
            (data.isActive != null && typeof data.isActive !== 'boolean') ||
            (data.isCustomerVisible != null && typeof data.isCustomerVisible !== 'boolean') ||
            (data.priority != null && typeof data.priority !== 'number') ||
            (data.colorCode != null && typeof data.colorCode !== 'string') ||
            (data.address != null && typeof data.address !== 'string') ||
            (data.assignedMenuIds != null && (!Array.isArray(data.assignedMenuIds) || data.assignedMenuIds.some(id => typeof id !== 'string')))
           )
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            let errorCode = ErrorCode.InvalidArgument;
            if (data?.location && (typeof data.location.latitude !== 'number' || typeof data.location.longitude !== 'number')) errorCode = ErrorCode.InvalidGeoPoint;
            if (!validateI18nMap(data.boxName_i18n)) errorCode = ErrorCode.InvalidI18nMap;
            if (data.assignedMenuIds != null && (!Array.isArray(data.assignedMenuIds) || data.assignedMenuIds.some(id => typeof id !== 'string'))) errorCode = ErrorCode.InvalidMenusArray;
            return { success: false, error: "error.invalidInput.boxData", errorCode: errorCode };
        }
        const boxNumber = data.boxNumber.trim();

        // 3. Validate Uniqueness (Box Number) and Foreign Keys (Menus)
        try {
            const numberExists = await checkBoxNumberExists(boxNumber);
            if (numberExists) {
                 logger.warn(`${functionName} Box number '${boxNumber}' already exists.`, logContext);
                 return { success: false, error: "error.box.numberExists", errorCode: ErrorCode.BoxNumberExists };
            }

            const menuIds = data.assignedMenuIds?.map(id => id.trim()).filter(id => id) ?? [];
            if (menuIds.length > 0) {
                const menusValid = await validateMenuIds(menuIds);
                if (!menusValid) {
                     logger.error(`${functionName} One or more provided menu IDs are invalid or do not exist.`, { ...logContext, menuIds });
                     return { success: false, error: "error.invalidInput.invalidMenuIds", errorCode: ErrorCode.MenuNotFound };
                }
            }
        } catch (validationError: any) {
             logger.error(`${functionName} Failed during validation checks.`, { ...logContext, error: validationError.message });
             return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        }


        // 4. Create Box Document
        const boxesCollectionRef = db.collection('boxes');
        try {
            const now = Timestamp.now();
            const geoPoint = new GeoPoint(data.location.latitude, data.location.longitude);
            const menuIds = data.assignedMenuIds?.map(id => id.trim()).filter(id => id) ?? [];

            const newBoxData: Box = {
                boxNumber: boxNumber,
                boxName_i18n: data.boxName_i18n ?? null,
                location: geoPoint, // Store as Firestore GeoPoint
                isActive: data.isActive ?? true,
                isCustomerVisible: data.isCustomerVisible ?? true,
                priority: data.priority ?? 0,
                colorCode: data.colorCode ?? null,
                currencyCode: data.currencyCode.toUpperCase(),
                countryCode: data.countryCode.toUpperCase(),
                address: data.address?.trim() ?? null,
                assignedCourierId: null, // Not assigned on creation
                assignedMenuIds: menuIds.length > 0 ? [...new Set(menuIds)] : null,
                // hiddenProductIds: null, // Initialize if needed
                // operatingHours: data.operatingHours ?? null,
                inventory: {}, // Initialize empty inventory
                rentalInventory: {}, // Initialize empty rental inventory
                createdAt: now,
                updatedAt: now,
            };

            const newBoxRef = await boxesCollectionRef.add(newBoxData);
            const newBoxId = newBoxRef.id;
            logContext.boxId = newBoxId;
            logger.info(`${functionName} Box '${newBoxId}' (Number: ${boxNumber}) created successfully.`, logContext);

            // 5. Log Admin Action (Async)
            logAdminAction("CreateBox", { boxId: newBoxId, data: newBoxData, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 6. Return Success
            return { success: true, boxId: newBoxId };

        } catch (error: any) {
            logger.error(`${functionName} Failed to create box.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Update Box Function ====================================================
// ============================================================================
export const updateBox = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "512MiB" }, // Memory for potential validations
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[updateBox V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as UpdateBoxInput;
        const logContext: any = { adminUserId, boxId: data?.boxId };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check - Define permission: 'admin:box:update'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:box:update', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to update box.`, logContext);
                return { success: false, error: "error.permissionDenied.updateBox", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.boxId || typeof data.boxId !== 'string') {
            return { success: false, error: "error.invalidInput.missingBoxId", errorCode: ErrorCode.InvalidArgument };
        }
        const boxId = data.boxId;

        const updatePayload: { [key: string]: any } = {};
        let changesDetected = false;
        let menuIdsToValidate: string[] | null = null;
        let newBoxNumber: string | null = null;

        // Validate and add fields to payload
        if (data.boxNumber !== undefined) { if(typeof data.boxNumber !== 'string' || data.boxNumber.trim().length === 0) return {success: false, error:"Invalid boxNumber", errorCode: ErrorCode.InvalidArgument}; newBoxNumber = data.boxNumber.trim(); updatePayload.boxNumber = newBoxNumber; changesDetected = true; }
        if (data.boxName_i18n !== undefined) { if(!validateI18nMap(data.boxName_i18n)) return {success: false, error:"Invalid boxName_i18n", errorCode: ErrorCode.InvalidI18nMap}; updatePayload.boxName_i18n = data.boxName_i18n; changesDetected = true; }
        if (data.location !== undefined) { if(!data.location || typeof data.location.latitude !== 'number' || typeof data.location.longitude !== 'number') return {success: false, error:"Invalid location", errorCode: ErrorCode.InvalidGeoPoint}; updatePayload.location = new GeoPoint(data.location.latitude, data.location.longitude); changesDetected = true; }
        if (data.isActive !== undefined) { if(typeof data.isActive !== 'boolean') return {success: false, error:"Invalid isActive", errorCode: ErrorCode.InvalidArgument}; updatePayload.isActive = data.isActive; changesDetected = true; }
        if (data.isCustomerVisible !== undefined) { if(typeof data.isCustomerVisible !== 'boolean') return {success: false, error:"Invalid isCustomerVisible", errorCode: ErrorCode.InvalidArgument}; updatePayload.isCustomerVisible = data.isCustomerVisible; changesDetected = true; }
        if (data.priority !== undefined) { if(data.priority !== null && typeof data.priority !== 'number') return {success: false, error:"Invalid priority", errorCode: ErrorCode.InvalidArgument}; updatePayload.priority = data.priority; changesDetected = true; }
        if (data.colorCode !== undefined) { if(data.colorCode !== null && typeof data.colorCode !== 'string') return {success: false, error:"Invalid colorCode", errorCode: ErrorCode.InvalidArgument}; updatePayload.colorCode = data.colorCode; changesDetected = true; }
        if (data.currencyCode !== undefined) { if(typeof data.currencyCode !== 'string' || data.currencyCode.trim().length === 0) return {success: false, error:"Invalid currencyCode", errorCode: ErrorCode.InvalidArgument}; updatePayload.currencyCode = data.currencyCode.toUpperCase(); changesDetected = true; }
        if (data.countryCode !== undefined) { if(typeof data.countryCode !== 'string' || data.countryCode.trim().length === 0) return {success: false, error:"Invalid countryCode", errorCode: ErrorCode.InvalidArgument}; updatePayload.countryCode = data.countryCode.toUpperCase(); changesDetected = true; }
        if (data.address !== undefined) { if(data.address !== null && typeof data.address !== 'string') return {success: false, error:"Invalid address", errorCode: ErrorCode.InvalidArgument}; updatePayload.address = data.address === null ? null : data.address.trim(); changesDetected = true; }
        if (data.assignedMenuIds !== undefined) {
            if(data.assignedMenuIds !== null && (!Array.isArray(data.assignedMenuIds) || data.assignedMenuIds.some(id => typeof id !== 'string'))) return {success: false, error:"Invalid assignedMenuIds", errorCode: ErrorCode.InvalidMenusArray};
            menuIdsToValidate = data.assignedMenuIds === null ? [] : data.assignedMenuIds.map(id => id.trim()).filter(id => id);
            updatePayload.assignedMenuIds = menuIdsToValidate.length > 0 ? [...new Set(menuIdsToValidate)] : null;
            changesDetected = true;
        }
         if (data.assignedCourierId !== undefined) { // Allow setting courier to null or a string ID
             if(data.assignedCourierId !== null && typeof data.assignedCourierId !== 'string') return {success: false, error:"Invalid assignedCourierId", errorCode: ErrorCode.InvalidArgument};
             // TODO: Validate courier ID exists if not null?
             updatePayload.assignedCourierId = data.assignedCourierId; changesDetected = true;
         }
        // Add operatingHours update logic if needed

        if (!changesDetected) {
            logger.info(`${functionName} No changes detected for box '${boxId}'.`, logContext);
            return { success: true }; // No update needed
        }

        // 3. Validate Uniqueness (Box Number) and Foreign Keys (Menus, Courier)
        try {
            if (newBoxNumber !== null) {
                const numberExists = await checkBoxNumberExists(newBoxNumber, boxId); // Exclude self
                if (numberExists) {
                     logger.warn(`${functionName} Box number '${newBoxNumber}' already exists for another box.`, logContext);
                     return { success: false, error: "error.box.numberExists", errorCode: ErrorCode.BoxNumberExists };
                }
            }
            if (menuIdsToValidate !== null && menuIdsToValidate.length > 0) {
                const menusValid = await validateMenuIds(menuIdsToValidate);
                if (!menusValid) {
                     logger.error(`${functionName} One or more provided menu IDs for update are invalid or do not exist.`, { ...logContext, menuIds: menuIdsToValidate });
                     return { success: false, error: "error.invalidInput.invalidMenuIds", errorCode: ErrorCode.MenuNotFound };
                }
            }
            // Optional: Validate assignedCourierId exists
            if (updatePayload.assignedCourierId) {
                 const courierSnap = await db.collection('users').doc(updatePayload.assignedCourierId).get();
                 if (!courierSnap.exists || courierSnap.data()?.role !== 'Courier') {
                      logger.error(`${functionName} Assigned courier ID ${updatePayload.assignedCourierId} not found or is not a courier.`, logContext);
                      return { success: false, error: "error.invalidInput.invalidCourierId", errorCode: ErrorCode.CourierNotFound };
                 }
            }
        } catch (validationError: any) {
             logger.error(`${functionName} Failed during validation checks.`, { ...logContext, error: validationError.message });
             return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        }


        updatePayload.updatedAt = FieldValue.serverTimestamp(); // Add timestamp

        // 4. Update Box Document
        const boxRef = db.collection('boxes').doc(boxId);
        try {
            await boxRef.update(updatePayload); // update() fails if document doesn't exist
            logger.info(`${functionName} Box '${boxId}' updated successfully.`, logContext);

            // 5. Log Admin Action (Async)
            logAdminAction("UpdateBox", { boxId, changes: Object.keys(updatePayload).filter(k => k !== 'updatedAt'), triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 6. Return Success
            return { success: true };

        } catch (error: any) {
            if (error.code === 5) { // Firestore NOT_FOUND code
                logger.warn(`${functionName} Box '${boxId}' not found for update.`, logContext);
                return { success: false, error: "error.box.notFound", errorCode: ErrorCode.BoxNotFound };
            }
            logger.error(`${functionName} Failed to update box '${boxId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Set Box Status Function (Active/Visible) ===============================
// ============================================================================
export const setBoxStatus = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[setBoxStatus V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as SetBoxStatusInput;
        const logContext: any = { adminUserId, boxId: data?.boxId, isActive: data?.isActive, isVisible: data?.isCustomerVisible };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check - Reuse 'admin:box:update'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:box:update', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to set box status.`, logContext);
                return { success: false, error: "error.permissionDenied.setBoxStatus", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.boxId || typeof data.boxId !== 'string' ||
            (data.isActive === undefined && data.isCustomerVisible === undefined) || // Must provide at least one status
            (data.isActive !== undefined && typeof data.isActive !== 'boolean') ||
            (data.isCustomerVisible !== undefined && typeof data.isCustomerVisible !== 'boolean') )
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.boxIdOrStatus", errorCode: ErrorCode.InvalidArgument };
        }
        const { boxId, isActive, isCustomerVisible } = data;

        // 3. Prepare Update Payload
        const updatePayload: { [key: string]: any } = {
             updatedAt: FieldValue.serverTimestamp()
        };
        if (isActive !== undefined) updatePayload.isActive = isActive;
        if (isCustomerVisible !== undefined) updatePayload.isCustomerVisible = isCustomerVisible;

        // 4. Update Box Document
        const boxRef = db.collection('boxes').doc(boxId);
        try {
            await boxRef.update(updatePayload);
            logger.info(`${functionName} Status updated for box '${boxId}'.`, { ...logContext, updatePayload });

            // 5. Log Admin Action (Async)
            logAdminAction("SetBoxStatus", { boxId, ...updatePayload, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 6. Return Success
            return { success: true };

        } catch (error: any) {
            if (error.code === 5) { // Firestore NOT_FOUND code
                logger.warn(`${functionName} Box '${boxId}' not found for status update.`, logContext);
                return { success: false, error: "error.box.notFound", errorCode: ErrorCode.BoxNotFound };
            }
            logger.error(`${functionName} Failed to set status for box '${boxId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === List Boxes Function ====================================================
// ============================================================================
export const listBoxes = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "256MiB" },
    async (request): Promise<{ success: true; data: ListBoxesOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[listBoxes V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions (Allow any authenticated user? Or specific role?)
        // Let's require admin permission for now.
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as ListBoxesInput; // Input might be empty
        const logContext: any = { userId: adminUserId, pageSize: data?.pageSize, pageToken: data?.pageToken, filterIsActive: data?.filterIsActive, filterIsVisible: data?.filterIsVisible };
        logger.info(`${functionName} Invoked.`, logContext);

        let userRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `User ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            userRole = (userSnap.data() as User)?.role;
            logContext.userRole = userRole;

            // Permission Check - Define permission: 'admin:box:list' or maybe 'box:list'?
            const hasPermission = await checkPermission(adminUserId, userRole, 'admin:box:list', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${adminUserId} (Role: ${userRole}) to list boxes.`, logContext);
                return { success: false, error: "error.permissionDenied.listBoxes", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Prepare Query
        const pageSize = (typeof data?.pageSize === 'number' && data.pageSize > 0 && data.pageSize <= 100) ? data.pageSize : 30;
        let query: admin.firestore.Query<admin.firestore.DocumentData> = db.collection('boxes');

        // Add filters
        if (data?.filterIsActive === true) {
            query = query.where('isActive', '==', true);
        } else if (data?.filterIsActive === false) {
             query = query.where('isActive', '==', false);
        }
        if (data?.filterIsVisible === true) {
            query = query.where('isCustomerVisible', '==', true);
        } else if (data?.filterIsVisible === false) {
             query = query.where('isCustomerVisible', '==', false);
        }
        // TODO: Add other filters like countryCode if needed

        // Add ordering (e.g., by priority then box number?) and pagination
        query = query.orderBy('priority', 'desc').orderBy('boxNumber');
        query = query.limit(pageSize);

        if (data?.pageToken && typeof data.pageToken === 'string') {
            try {
                 const pageTokenDoc = await db.collection('boxes').doc(data.pageToken).get();
                 if (pageTokenDoc.exists) {
                     query = query.startAfter(pageTokenDoc);
                 } else {
                      logger.warn("Page token document not found, ignoring token.", { pageToken: data.pageToken });
                 }
            } catch (e) {
                logger.warn("Invalid page token provided or query failed.", { pageToken: data.pageToken, error: e });
            }
        }

        // 3. Execute Query
        try {
            const snapshot = await query.get();
            const boxes: BoxOutput[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as Box;
                // Convert Firestore GeoPoint to simple lat/lon object for client
                const locationOutput = data.location ? { latitude: data.location.latitude, longitude: data.location.longitude } : { latitude: 0, longitude: 0 }; // Default if missing?

                const outputData: BoxOutput = {
                    boxId: doc.id,
                    boxNumber: data.boxNumber,
                    boxName_i18n: data.boxName_i18n,
                    location: locationOutput,
                    isActive: data.isActive,
                    isCustomerVisible: data.isCustomerVisible,
                    priority: data.priority,
                    colorCode: data.colorCode,
                    currencyCode: data.currencyCode,
                    countryCode: data.countryCode,
                    address: data.address,
                    assignedCourierId: data.assignedCourierId,
                    assignedMenuIds: data.assignedMenuIds,
                    inventory: data.inventory, // Include inventory? Might be large. Consider separate endpoint?
                    rentalInventory: data.rentalInventory, // Include rental inventory?
                    // Optional: Convert timestamps
                    // createdAt: data.createdAt?.toDate().toISOString() ?? null,
                    // updatedAt: data.updatedAt?.toDate().toISOString() ?? null,
                };
                boxes.push(outputData);
            });

            // Determine next page token
            let nextPageToken: string | null = null;
            if (snapshot.docs.length === pageSize) {
                nextPageToken = snapshot.docs[snapshot.docs.length - 1].id; // Use boxId as token
            }

            logger.info(`${functionName} Found ${boxes.length} boxes. Next page token: ${nextPageToken}`, logContext);

            // 4. Return Results
            return { success: true, data: { boxes, nextPageToken } };

        } catch (error: any) {
            logger.error(`${functionName} Failed to list boxes.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
