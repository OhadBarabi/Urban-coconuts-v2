import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, Product } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { logAdminAction } from '../utils/logging'; // Using mock from manageRoles for now

// --- Configuration ---
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Product or User not found
    AlreadyExists = "ALREADY_EXISTS", // Product ID/SKU might need to be unique on create? Using auto-ID for now.
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    ProductNotFound = "PRODUCT_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND",
    InvalidI18nMap = "INVALID_I18N_MAP",
}

// --- Interfaces ---

// Input for creating a product
interface CreateProductInput {
    productName_i18n: { [key: string]: string }; // Required, map of lang code -> name
    description_i18n?: { [key: string]: string } | null;
    imageUrl?: string | null;
    category?: string | null;
    priceSmallestUnit: number; // Required, integer >= 0
    tags?: string[] | null;
    priority?: number | null; // Default priority could be 0 or handled client-side
    isActive?: boolean; // Default to true?
    allergens?: string[] | null;
    nutritionalInfo?: { [key: string]: any } | null; // Flexible map
}

// Input for updating a product
interface UpdateProductInput {
    productId: string; // Required ID of the product to update
    productName_i18n?: { [key: string]: string }; // Optional updates
    description_i18n?: { [key: string]: string } | null;
    imageUrl?: string | null;
    category?: string | null;
    priceSmallestUnit?: number; // Integer >= 0
    tags?: string[] | null;
    priority?: number | null;
    isActive?: boolean;
    allergens?: string[] | null;
    nutritionalInfo?: { [key: string]: any } | null;
}

// Input for setting active status
interface SetProductActiveStatusInput {
    productId: string;
    isActive: boolean;
}

// Input for listing products
interface ListProductsInput {
    pageSize?: number;
    pageToken?: string; // Use productId as page token
    filterCategory?: string | null;
    filterActive?: boolean | null;
    // Add more filters? e.g., filter by tag
}

// Output format for a single product
interface ProductOutput extends Omit<Product, 'createdAt' | 'updatedAt'> {
    productId: string; // Include the document ID
    createdAt?: string | null; // Optional: Convert timestamp to ISO string
    updatedAt?: string | null; // Optional: Convert timestamp to ISO string
}

// Output format for list response
interface ListProductsOutput {
    products: ProductOutput[];
    nextPageToken?: string | null;
}

// Helper to validate i18n map (at least one entry required)
function validateI18nMap(map: any): boolean {
    return map && typeof map === 'object' && Object.keys(map).length > 0 && Object.values(map).every(val => typeof val === 'string');
}


// ============================================================================
// === Create Product Function ================================================
// ============================================================================
export const createProduct = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "256MiB" },
    async (request): Promise<{ success: true; productId: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createProduct V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as CreateProductInput;
        const logContext: any = { adminUserId, productName: data?.productName_i18n?.['en'] /* Log english name if exists */ };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check - Define permission: 'admin:product:create'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:product:create', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to create product.`, logContext);
                return { success: false, error: "error.permissionDenied.createProduct", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!validateI18nMap(data?.productName_i18n) ||
            typeof data.priceSmallestUnit !== 'number' || !Number.isInteger(data.priceSmallestUnit) || data.priceSmallestUnit < 0 ||
            (data.description_i18n != null && !validateI18nMap(data.description_i18n)) || // Allow null/undefined description
            (data.imageUrl != null && typeof data.imageUrl !== 'string') ||
            (data.category != null && typeof data.category !== 'string') ||
            (data.tags != null && (!Array.isArray(data.tags) || data.tags.some(t => typeof t !== 'string'))) ||
            (data.priority != null && typeof data.priority !== 'number') ||
            (data.isActive != null && typeof data.isActive !== 'boolean') ||
            (data.allergens != null && (!Array.isArray(data.allergens) || data.allergens.some(a => typeof a !== 'string'))) ||
            (data.nutritionalInfo != null && typeof data.nutritionalInfo !== 'object')
           )
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            let errorCode = ErrorCode.InvalidArgument;
            if (!validateI18nMap(data?.productName_i18n)) errorCode = ErrorCode.InvalidI18nMap;
            return { success: false, error: "error.invalidInput.productData", errorCode: errorCode };
        }

        // 3. Create Product Document
        const productsCollectionRef = db.collection('products');
        try {
            const now = Timestamp.now();
            const newProductData: Product = {
                productName_i18n: data.productName_i18n,
                description_i18n: data.description_i18n ?? null,
                imageUrl: data.imageUrl ?? null,
                category: data.category?.trim() ?? null,
                priceSmallestUnit: data.priceSmallestUnit,
                tags: data.tags?.map(t => t.trim()).filter(t => t) ?? null, // Trim and filter empty tags
                priority: data.priority ?? 0, // Default priority
                isActive: data.isActive ?? true, // Default to active
                allergens: data.allergens?.map(a => a.trim()).filter(a => a) ?? null,
                nutritionalInfo: data.nutritionalInfo ?? null,
                createdAt: now, // Use server timestamp if possible? FieldValue not available directly here
                updatedAt: now,
            };

            const newProductRef = await productsCollectionRef.add(newProductData);
            const newProductId = newProductRef.id;
            logContext.productId = newProductId;
            logger.info(`${functionName} Product '${newProductId}' created successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("CreateProduct", { productId: newProductId, data: newProductData, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true, productId: newProductId };

        } catch (error: any) {
            logger.error(`${functionName} Failed to create product.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Update Product Function ================================================
// ============================================================================
export const updateProduct = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "256MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[updateProduct V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as UpdateProductInput;
        const logContext: any = { adminUserId, productId: data?.productId };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check - Define permission: 'admin:product:update'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:product:update', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to update product.`, logContext);
                return { success: false, error: "error.permissionDenied.updateProduct", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.productId || typeof data.productId !== 'string') {
            return { success: false, error: "error.invalidInput.missingProductId", errorCode: ErrorCode.InvalidArgument };
        }
        const productId = data.productId;

        const updatePayload: { [key: string]: any } = {};
        let changesDetected = false;

        // Validate and add fields to payload if they exist in input data
        if (data.productName_i18n !== undefined) { if(!validateI18nMap(data.productName_i18n)) return {success: false, error:"Invalid productName_i18n", errorCode: ErrorCode.InvalidI18nMap}; updatePayload.productName_i18n = data.productName_i18n; changesDetected = true; }
        if (data.description_i18n !== undefined) { if(data.description_i18n !== null && !validateI18nMap(data.description_i18n)) return {success: false, error:"Invalid description_i18n", errorCode: ErrorCode.InvalidI18nMap}; updatePayload.description_i18n = data.description_i18n; changesDetected = true; }
        if (data.imageUrl !== undefined) { if(data.imageUrl !== null && typeof data.imageUrl !== 'string') return {success: false, error:"Invalid imageUrl", errorCode: ErrorCode.InvalidArgument}; updatePayload.imageUrl = data.imageUrl; changesDetected = true; }
        if (data.category !== undefined) { if(data.category !== null && typeof data.category !== 'string') return {success: false, error:"Invalid category", errorCode: ErrorCode.InvalidArgument}; updatePayload.category = data.category === null ? null : data.category.trim(); changesDetected = true; }
        if (data.priceSmallestUnit !== undefined) { if(typeof data.priceSmallestUnit !== 'number' || !Number.isInteger(data.priceSmallestUnit) || data.priceSmallestUnit < 0) return {success: false, error:"Invalid price", errorCode: ErrorCode.InvalidArgument}; updatePayload.priceSmallestUnit = data.priceSmallestUnit; changesDetected = true; }
        if (data.tags !== undefined) { if(data.tags !== null && (!Array.isArray(data.tags) || data.tags.some(t => typeof t !== 'string'))) return {success: false, error:"Invalid tags", errorCode: ErrorCode.InvalidArgument}; updatePayload.tags = data.tags === null ? null : data.tags.map(t => t.trim()).filter(t => t); changesDetected = true; }
        if (data.priority !== undefined) { if(data.priority !== null && typeof data.priority !== 'number') return {success: false, error:"Invalid priority", errorCode: ErrorCode.InvalidArgument}; updatePayload.priority = data.priority; changesDetected = true; }
        if (data.isActive !== undefined) { if(typeof data.isActive !== 'boolean') return {success: false, error:"Invalid isActive", errorCode: ErrorCode.InvalidArgument}; updatePayload.isActive = data.isActive; changesDetected = true; }
        if (data.allergens !== undefined) { if(data.allergens !== null && (!Array.isArray(data.allergens) || data.allergens.some(a => typeof a !== 'string'))) return {success: false, error:"Invalid allergens", errorCode: ErrorCode.InvalidArgument}; updatePayload.allergens = data.allergens === null ? null : data.allergens.map(a => a.trim()).filter(a => a); changesDetected = true; }
        if (data.nutritionalInfo !== undefined) { if(data.nutritionalInfo !== null && typeof data.nutritionalInfo !== 'object') return {success: false, error:"Invalid nutritionalInfo", errorCode: ErrorCode.InvalidArgument}; updatePayload.nutritionalInfo = data.nutritionalInfo; changesDetected = true; }


        if (!changesDetected) {
            logger.info(`${functionName} No changes detected for product '${productId}'.`, logContext);
            return { success: true }; // No update needed
        }

        updatePayload.updatedAt = FieldValue.serverTimestamp(); // Add timestamp

        // 3. Update Product Document
        const productRef = db.collection('products').doc(productId);
        try {
            await productRef.update(updatePayload); // update() fails if document doesn't exist
            logger.info(`${functionName} Product '${productId}' updated successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("UpdateProduct", { productId, changes: Object.keys(updatePayload).filter(k => k !== 'updatedAt'), triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            if (error.code === 5) { // Firestore NOT_FOUND code
                logger.warn(`${functionName} Product '${productId}' not found for update.`, logContext);
                return { success: false, error: "error.product.notFound", errorCode: ErrorCode.ProductNotFound };
            }
            logger.error(`${functionName} Failed to update product '${productId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Set Product Active Status Function =====================================
// ============================================================================
export const setProductActiveStatus = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[setProductActiveStatus V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as SetProductActiveStatusInput;
        const logContext: any = { adminUserId, productId: data?.productId, targetStatus: data?.isActive };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check - Reuse 'admin:product:update' or create 'admin:product:setActiveStatus'? Let's reuse update.
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:product:update', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to set product active status.`, logContext);
                return { success: false, error: "error.permissionDenied.setProductActive", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.productId || typeof data.productId !== 'string' || typeof data.isActive !== 'boolean') {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.productIdOrStatus", errorCode: ErrorCode.InvalidArgument };
        }
        const { productId, isActive: targetIsActive } = data;

        // 3. Update Product Document
        const productRef = db.collection('products').doc(productId);
        try {
            await productRef.update({
                isActive: targetIsActive,
                updatedAt: FieldValue.serverTimestamp()
            });
            logger.info(`${functionName} Active status for product '${productId}' set to ${targetIsActive}.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("SetProductActiveStatus", { productId, targetIsActive, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            if (error.code === 5) { // Firestore NOT_FOUND code
                logger.warn(`${functionName} Product '${productId}' not found for status update.`, logContext);
                return { success: false, error: "error.product.notFound", errorCode: ErrorCode.ProductNotFound };
            }
            logger.error(`${functionName} Failed to set active status for product '${productId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === List Products Function =================================================
// ============================================================================
export const listProducts = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "256MiB" },
    async (request): Promise<{ success: true; data: ListProductsOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[listProducts V1]";
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions (Allow any authenticated user? Or specific role?)
        // Let's require admin permission for now, can be adjusted.
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid; // Assuming admin access needed
        const data = request.data as ListProductsInput; // Input might be empty
        const logContext: any = { userId: adminUserId, pageSize: data?.pageSize, pageToken: data?.pageToken, filterCategory: data?.filterCategory, filterActive: data?.filterActive };
        logger.info(`${functionName} Invoked.`, logContext);

        let userRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `User ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            userRole = (userSnap.data() as User)?.role;
            logContext.userRole = userRole;

            // Permission Check - Define permission: 'admin:product:list' or maybe 'product:list' if customers can also list?
            const hasPermission = await checkPermission(adminUserId, userRole, 'admin:product:list', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${adminUserId} (Role: ${userRole}) to list products.`, logContext);
                return { success: false, error: "error.permissionDenied.listProducts", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Prepare Query
        const pageSize = (typeof data?.pageSize === 'number' && data.pageSize > 0 && data.pageSize <= 100) ? data.pageSize : 30;
        let query: admin.firestore.Query<admin.firestore.DocumentData> = db.collection('products');

        // Add filters
        if (data?.filterCategory && typeof data.filterCategory === 'string') {
            query = query.where('category', '==', data.filterCategory);
        }
        if (data?.filterActive === true) {
            query = query.where('isActive', '==', true);
        } else if (data?.filterActive === false) {
             query = query.where('isActive', '==', false);
        }
        // TODO: Add filter by tags? Requires 'array-contains' query

        // Add ordering (e.g., by priority then name?) and pagination
        query = query.orderBy('priority', 'desc').orderBy('productName_i18n.en'); // Example order, assumes 'en' exists
        query = query.limit(pageSize);

        if (data?.pageToken && typeof data.pageToken === 'string') {
            try {
                 // For complex ordering, use startAfter with the document snapshot of the last item
                 const pageTokenDoc = await db.collection('products').doc(data.pageToken).get();
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
            const products: ProductOutput[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as Product;
                const outputData: ProductOutput = {
                    productId: doc.id,
                    productName_i18n: data.productName_i18n,
                    description_i18n: data.description_i18n,
                    imageUrl: data.imageUrl,
                    category: data.category,
                    priceSmallestUnit: data.priceSmallestUnit,
                    tags: data.tags,
                    priority: data.priority,
                    isActive: data.isActive,
                    allergens: data.allergens,
                    nutritionalInfo: data.nutritionalInfo,
                    // Optional: Convert timestamps
                    // createdAt: data.createdAt?.toDate().toISOString() ?? null,
                    // updatedAt: data.updatedAt?.toDate().toISOString() ?? null,
                };
                products.push(outputData);
            });

            // Determine next page token
            let nextPageToken: string | null = null;
            if (snapshot.docs.length === pageSize) {
                nextPageToken = snapshot.docs[snapshot.docs.length - 1].id; // Use productId as token
            }

            logger.info(`${functionName} Found ${products.length} products. Next page token: ${nextPageToken}`, logContext);

            // 4. Return Results
            return { success: true, data: { products, nextPageToken } };

        } catch (error: any) {
            logger.error(`${functionName} Failed to list products.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
