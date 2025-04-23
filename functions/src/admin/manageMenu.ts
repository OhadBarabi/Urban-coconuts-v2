import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Menu, Product } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { logAdminAction } from '../utils/logging'; // Using mock from previous steps

// --- Configuration ---
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Menu, User, or Product not found
    AlreadyExists = "ALREADY_EXISTS", // Less likely with auto-ID, but maybe for name?
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    MenuNotFound = "MENU_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    ProductNotFound = "PRODUCT_NOT_FOUND", // When validating availableProducts
    InvalidI18nMap = "INVALID_I18N_MAP",
    InvalidProductsArray = "INVALID_PRODUCTS_ARRAY",
}

// --- Interfaces ---

// Input for creating a menu
interface CreateMenuInput {
    menuName_i18n: { [key: string]: string }; // Required, map of lang code -> name
    description_i18n?: { [key: string]: string } | null;
    imageUrl?: string | null;
    priority?: number | null; // Default priority
    isActive?: boolean; // Default to true?
    isEventMenu?: boolean; // Default to false?
    availableProducts?: string[] | null; // Array of Product IDs
    // Fields specific to event menus (if isEventMenu is true)
    applicableEventTypes?: string[] | null;
    minOrderValueSmallestUnit?: number | null; // Integer >= 0
    currencyCode?: string | null; // Currency for event menu min order? Should match products?
}

// Input for updating a menu
interface UpdateMenuInput {
    menuId: string; // Required ID of the menu to update
    menuName_i18n?: { [key: string]: string }; // Optional updates
    description_i18n?: { [key: string]: string } | null;
    imageUrl?: string | null;
    priority?: number | null;
    isActive?: boolean;
    isEventMenu?: boolean; // Allow changing type? Might have implications.
    availableProducts?: string[] | null; // Replace entire list or allow adding/removing? Let's replace.
    applicableEventTypes?: string[] | null;
    minOrderValueSmallestUnit?: number | null;
    currencyCode?: string | null;
}

// Input for setting active status
interface SetMenuActiveStatusInput {
    menuId: string;
    isActive: boolean;
}

// Input for listing menus
interface ListMenusInput {
    pageSize?: number;
    pageToken?: string; // Use menuId as page token
    filterIsEventMenu?: boolean | null;
    filterActive?: boolean | null;
}

// Output format for a single menu
interface MenuOutput extends Omit<Menu, 'createdAt' | 'updatedAt'> {
    menuId: string; // Include the document ID
    createdAt?: string | null; // Optional: Convert timestamp to ISO string
    updatedAt?: string | null; // Optional: Convert timestamp to ISO string
}

// Output format for list response
interface ListMenusOutput {
    menus: MenuOutput[];
    nextPageToken?: string | null;
}

// Helper to validate i18n map (at least one entry required)
function validateI18nMap(map: any): boolean {
    return map && typeof map === 'object' && Object.keys(map).length > 0 && Object.values(map).every(val => typeof val === 'string');
}

// Helper function to validate product IDs exist
async function validateProductIds(productIds: string[]): Promise<boolean> {
    if (productIds.length === 0) return true; // Empty array is valid
    try {
        const productRefs = productIds.map(id => db.collection('products').doc(id));
        const productDocs = await db.getAll(...productRefs);
        // Check if all documents existed
        return productDocs.every(doc => doc.exists);
    } catch (error) {
        logger.error("Error validating product IDs", { error });
        return false; // Assume invalid on error
    }
}


// ============================================================================
// === Create Menu Function ===================================================
// ============================================================================
export const createMenu = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "512MiB" }, // Increased memory for product validation
    async (request): Promise<{ success: true; menuId: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createMenu V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as CreateMenuInput;
        const logContext: any = { adminUserId, menuName: data?.menuName_i18n?.['en'] };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check - Define permission: 'admin:menu:create'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:menu:create', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to create menu.`, logContext);
                return { success: false, error: "error.permissionDenied.createMenu", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!validateI18nMap(data?.menuName_i18n) ||
            (data.description_i18n != null && !validateI18nMap(data.description_i18n)) ||
            (data.imageUrl != null && typeof data.imageUrl !== 'string') ||
            (data.priority != null && typeof data.priority !== 'number') ||
            (data.isActive != null && typeof data.isActive !== 'boolean') ||
            (data.isEventMenu != null && typeof data.isEventMenu !== 'boolean') ||
            (data.availableProducts != null && (!Array.isArray(data.availableProducts) || data.availableProducts.some(p => typeof p !== 'string'))) ||
            (data.applicableEventTypes != null && (!Array.isArray(data.applicableEventTypes) || data.applicableEventTypes.some(t => typeof t !== 'string'))) ||
            (data.minOrderValueSmallestUnit != null && (typeof data.minOrderValueSmallestUnit !== 'number' || !Number.isInteger(data.minOrderValueSmallestUnit) || data.minOrderValueSmallestUnit < 0)) ||
            (data.currencyCode != null && typeof data.currencyCode !== 'string')
           )
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            let errorCode = ErrorCode.InvalidArgument;
            if (!validateI18nMap(data?.menuName_i18n)) errorCode = ErrorCode.InvalidI18nMap;
            if (data.availableProducts != null && (!Array.isArray(data.availableProducts) || data.availableProducts.some(p => typeof p !== 'string'))) errorCode = ErrorCode.InvalidProductsArray;
            return { success: false, error: "error.invalidInput.menuData", errorCode: errorCode };
        }

        // 3. Validate Product IDs if provided
        const productIds = data.availableProducts?.map(p => p.trim()).filter(p => p) ?? [];
        if (productIds.length > 0) {
            const productsValid = await validateProductIds(productIds);
            if (!productsValid) {
                 logger.error(`${functionName} One or more provided product IDs are invalid or do not exist.`, { ...logContext, productIds });
                 return { success: false, error: "error.invalidInput.invalidProductIds", errorCode: ErrorCode.ProductNotFound };
            }
        }

        // 4. Create Menu Document
        const menusCollectionRef = db.collection('menus');
        try {
            const now = Timestamp.now();
            const newMenuData: Menu = {
                menuName_i18n: data.menuName_i18n,
                description_i18n: data.description_i18n ?? null,
                imageUrl: data.imageUrl ?? null,
                priority: data.priority ?? 0, // Default priority
                isActive: data.isActive ?? true, // Default to active
                isEventMenu: data.isEventMenu ?? false, // Default to not event menu
                availableProducts: productIds.length > 0 ? [...new Set(productIds)] : null, // Store unique product IDs or null
                applicableEventTypes: data.isEventMenu ? (data.applicableEventTypes?.map(t => t.trim()).filter(t => t) ?? null) : null,
                minOrderValueSmallestUnit: data.isEventMenu ? (data.minOrderValueSmallestUnit ?? null) : null,
                currencyCode: data.isEventMenu ? (data.currencyCode?.toUpperCase() ?? null) : null,
                createdAt: now,
                updatedAt: now,
            };

            const newMenuRef = await menusCollectionRef.add(newMenuData);
            const newMenuId = newMenuRef.id;
            logContext.menuId = newMenuId;
            logger.info(`${functionName} Menu '${newMenuId}' created successfully.`, logContext);

            // 5. Log Admin Action (Async)
            logAdminAction("CreateMenu", { menuId: newMenuId, data: newMenuData, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 6. Return Success
            return { success: true, menuId: newMenuId };

        } catch (error: any) {
            logger.error(`${functionName} Failed to create menu.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Update Menu Function ===================================================
// ============================================================================
export const updateMenu = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "512MiB" }, // Increased memory for product validation
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[updateMenu V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as UpdateMenuInput;
        const logContext: any = { adminUserId, menuId: data?.menuId };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check - Define permission: 'admin:menu:update'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:menu:update', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to update menu.`, logContext);
                return { success: false, error: "error.permissionDenied.updateMenu", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.menuId || typeof data.menuId !== 'string') {
            return { success: false, error: "error.invalidInput.missingMenuId", errorCode: ErrorCode.InvalidArgument };
        }
        const menuId = data.menuId;

        const updatePayload: { [key: string]: any } = {};
        let changesDetected = false;
        let productIdsToValidate: string[] | null = null;

        // Validate and add fields to payload
        if (data.menuName_i18n !== undefined) { if(!validateI18nMap(data.menuName_i18n)) return {success: false, error:"Invalid menuName_i18n", errorCode: ErrorCode.InvalidI18nMap}; updatePayload.menuName_i18n = data.menuName_i18n; changesDetected = true; }
        if (data.description_i18n !== undefined) { if(data.description_i18n !== null && !validateI18nMap(data.description_i18n)) return {success: false, error:"Invalid description_i18n", errorCode: ErrorCode.InvalidI18nMap}; updatePayload.description_i18n = data.description_i18n; changesDetected = true; }
        if (data.imageUrl !== undefined) { if(data.imageUrl !== null && typeof data.imageUrl !== 'string') return {success: false, error:"Invalid imageUrl", errorCode: ErrorCode.InvalidArgument}; updatePayload.imageUrl = data.imageUrl; changesDetected = true; }
        if (data.priority !== undefined) { if(data.priority !== null && typeof data.priority !== 'number') return {success: false, error:"Invalid priority", errorCode: ErrorCode.InvalidArgument}; updatePayload.priority = data.priority; changesDetected = true; }
        if (data.isActive !== undefined) { if(typeof data.isActive !== 'boolean') return {success: false, error:"Invalid isActive", errorCode: ErrorCode.InvalidArgument}; updatePayload.isActive = data.isActive; changesDetected = true; }
        if (data.isEventMenu !== undefined) { if(typeof data.isEventMenu !== 'boolean') return {success: false, error:"Invalid isEventMenu", errorCode: ErrorCode.InvalidArgument}; updatePayload.isEventMenu = data.isEventMenu; changesDetected = true; }
        if (data.availableProducts !== undefined) {
            if(data.availableProducts !== null && (!Array.isArray(data.availableProducts) || data.availableProducts.some(p => typeof p !== 'string'))) return {success: false, error:"Invalid availableProducts", errorCode: ErrorCode.InvalidProductsArray};
            productIdsToValidate = data.availableProducts === null ? [] : data.availableProducts.map(p => p.trim()).filter(p => p);
            updatePayload.availableProducts = productIdsToValidate.length > 0 ? [...new Set(productIdsToValidate)] : null;
            changesDetected = true;
        }
        if (data.applicableEventTypes !== undefined) { if(data.applicableEventTypes !== null && (!Array.isArray(data.applicableEventTypes) || data.applicableEventTypes.some(t => typeof t !== 'string'))) return {success: false, error:"Invalid applicableEventTypes", errorCode: ErrorCode.InvalidArgument}; updatePayload.applicableEventTypes = data.applicableEventTypes === null ? null : data.applicableEventTypes.map(t => t.trim()).filter(t => t); changesDetected = true; }
        if (data.minOrderValueSmallestUnit !== undefined) { if(data.minOrderValueSmallestUnit !== null && (typeof data.minOrderValueSmallestUnit !== 'number' || !Number.isInteger(data.minOrderValueSmallestUnit) || data.minOrderValueSmallestUnit < 0)) return {success: false, error:"Invalid minOrderValue", errorCode: ErrorCode.InvalidArgument}; updatePayload.minOrderValueSmallestUnit = data.minOrderValueSmallestUnit; changesDetected = true; }
        if (data.currencyCode !== undefined) { if(data.currencyCode !== null && typeof data.currencyCode !== 'string') return {success: false, error:"Invalid currencyCode", errorCode: ErrorCode.InvalidArgument}; updatePayload.currencyCode = data.currencyCode === null ? null : data.currencyCode.toUpperCase(); changesDetected = true; }


        if (!changesDetected) {
            logger.info(`${functionName} No changes detected for menu '${menuId}'.`, logContext);
            return { success: true }; // No update needed
        }

        // 3. Validate Product IDs if they were updated
        if (productIdsToValidate !== null && productIdsToValidate.length > 0) {
            const productsValid = await validateProductIds(productIdsToValidate);
            if (!productsValid) {
                 logger.error(`${functionName} One or more provided product IDs for update are invalid or do not exist.`, { ...logContext, productIds: productIdsToValidate });
                 return { success: false, error: "error.invalidInput.invalidProductIds", errorCode: ErrorCode.ProductNotFound };
            }
        }

        updatePayload.updatedAt = FieldValue.serverTimestamp(); // Add timestamp

        // 4. Update Menu Document
        const menuRef = db.collection('menus').doc(menuId);
        try {
            await menuRef.update(updatePayload); // update() fails if document doesn't exist
            logger.info(`${functionName} Menu '${menuId}' updated successfully.`, logContext);

            // 5. Log Admin Action (Async)
            logAdminAction("UpdateMenu", { menuId, changes: Object.keys(updatePayload).filter(k => k !== 'updatedAt'), triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 6. Return Success
            return { success: true };

        } catch (error: any) {
            if (error.code === 5) { // Firestore NOT_FOUND code
                logger.warn(`${functionName} Menu '${menuId}' not found for update.`, logContext);
                return { success: false, error: "error.menu.notFound", errorCode: ErrorCode.MenuNotFound };
            }
            logger.error(`${functionName} Failed to update menu '${menuId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Set Menu Active Status Function ========================================
// ============================================================================
export const setMenuActiveStatus = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[setMenuActiveStatus V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as SetMenuActiveStatusInput;
        const logContext: any = { adminUserId, menuId: data?.menuId, targetStatus: data?.isActive };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check - Reuse 'admin:menu:update'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:menu:update', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to set menu active status.`, logContext);
                return { success: false, error: "error.permissionDenied.setMenuActive", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.menuId || typeof data.menuId !== 'string' || typeof data.isActive !== 'boolean') {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.menuIdOrStatus", errorCode: ErrorCode.InvalidArgument };
        }
        const { menuId, isActive: targetIsActive } = data;

        // 3. Update Menu Document
        const menuRef = db.collection('menus').doc(menuId);
        try {
            await menuRef.update({
                isActive: targetIsActive,
                updatedAt: FieldValue.serverTimestamp()
            });
            logger.info(`${functionName} Active status for menu '${menuId}' set to ${targetIsActive}.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("SetMenuActiveStatus", { menuId, targetIsActive, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            if (error.code === 5) { // Firestore NOT_FOUND code
                logger.warn(`${functionName} Menu '${menuId}' not found for status update.`, logContext);
                return { success: false, error: "error.menu.notFound", errorCode: ErrorCode.MenuNotFound };
            }
            logger.error(`${functionName} Failed to set active status for menu '${menuId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === List Menus Function ====================================================
// ============================================================================
export const listMenus = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true; data: ListMenusOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[listMenus V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions (Allow any authenticated user? Or specific role?)
        // Let's require admin permission for now.
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as ListMenusInput; // Input might be empty
        const logContext: any = { userId: adminUserId, pageSize: data?.pageSize, pageToken: data?.pageToken, filterIsEventMenu: data?.filterIsEventMenu, filterActive: data?.filterActive };
        logger.info(`${functionName} Invoked.`, logContext);

        let userRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `User ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            userRole = (userSnap.data() as User)?.role;
            logContext.userRole = userRole;

            // Permission Check - Define permission: 'admin:menu:list' or maybe 'menu:list'?
            const hasPermission = await checkPermission(adminUserId, userRole, 'admin:menu:list', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${adminUserId} (Role: ${userRole}) to list menus.`, logContext);
                return { success: false, error: "error.permissionDenied.listMenus", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Prepare Query
        const pageSize = (typeof data?.pageSize === 'number' && data.pageSize > 0 && data.pageSize <= 100) ? data.pageSize : 30;
        let query: admin.firestore.Query<admin.firestore.DocumentData> = db.collection('menus');

        // Add filters
        if (data?.filterIsEventMenu === true) {
            query = query.where('isEventMenu', '==', true);
        } else if (data?.filterIsEventMenu === false) {
             query = query.where('isEventMenu', '==', false);
        }
        if (data?.filterActive === true) {
            query = query.where('isActive', '==', true);
        } else if (data?.filterActive === false) {
             query = query.where('isActive', '==', false);
        }

        // Add ordering (e.g., by priority then name?) and pagination
        query = query.orderBy('priority', 'desc').orderBy('menuName_i18n.en'); // Example order
        query = query.limit(pageSize);

        if (data?.pageToken && typeof data.pageToken === 'string') {
            try {
                 const pageTokenDoc = await db.collection('menus').doc(data.pageToken).get();
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
            const menus: MenuOutput[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as Menu;
                const outputData: MenuOutput = {
                    menuId: doc.id,
                    menuName_i18n: data.menuName_i18n,
                    description_i18n: data.description_i18n,
                    imageUrl: data.imageUrl,
                    priority: data.priority,
                    isActive: data.isActive,
                    isEventMenu: data.isEventMenu,
                    availableProducts: data.availableProducts,
                    applicableEventTypes: data.applicableEventTypes,
                    minOrderValueSmallestUnit: data.minOrderValueSmallestUnit,
                    currencyCode: data.currencyCode,
                    // Optional: Convert timestamps
                    // createdAt: data.createdAt?.toDate().toISOString() ?? null,
                    // updatedAt: data.updatedAt?.toDate().toISOString() ?? null,
                };
                menus.push(outputData);
            });

            // Determine next page token
            let nextPageToken: string | null = null;
            if (snapshot.docs.length === pageSize) {
                nextPageToken = snapshot.docs[snapshot.docs.length - 1].id; // Use menuId as token
            }

            logger.info(`${functionName} Found ${menus.length} menus. Next page token: ${nextPageToken}`, logContext);

            // 4. Return Results
            return { success: true, data: { menus, nextPageToken } };

        } catch (error: any) {
            logger.error(`${functionName} Failed to list menus.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
