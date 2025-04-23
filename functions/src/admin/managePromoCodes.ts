import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import { User, PromoCode } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions'; // <-- Import REAL helper
// import { logAdminAction } from '../utils/logging'; // Using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Promo code or User not found
    AlreadyExists = "ALREADY_EXISTS", // Promo code ID/couponCode already exists on create
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    PromoCodeNotFound = "PROMO_CODE_NOT_FOUND",
    UserNotFound = "USER_NOT_FOUND", // Added
    InvalidDiscountDetails = "INVALID_DISCOUNT_DETAILS",
    InvalidDateRange = "INVALID_DATE_RANGE",
}

// --- Interfaces ---
// Input for creating a promo code. ID will be auto-generated or use couponCode? Let's use couponCode as ID for simplicity.
interface CreatePromoCodeInput {
    couponCode: string; // Unique code, will be used as document ID
    description?: string | null;
    isActive: boolean;
    validFrom?: string | null; // ISO Date string
    validUntil?: string | null; // ISO Date string
    maxTotalUses?: number | null; // Integer >= 0
    maxUsesPerUser?: number | null; // Integer >= 0
    // targetAudienceRules?: { [key: string]: any }; // Complex, skip for V1
    allowCombining?: boolean; // Default false?
    discountDetails: {
        type: "percentage" | "fixedAmount";
        percentageValue?: number | null; // e.g., 10 for 10%
        fixedAmountSmallestUnit?: number | null; // Integer
    };
    minOrderValueSmallestUnit?: number | null; // Integer >= 0
}

// Input for updating a promo code. All fields optional except couponCode (ID).
interface UpdatePromoCodeInput {
    couponCode: string; // Document ID
    description?: string | null;
    isActive?: boolean;
    validFrom?: string | null; // ISO Date string or null to clear
    validUntil?: string | null; // ISO Date string or null to clear
    maxTotalUses?: number | null; // Integer >= 0 or null to clear
    maxUsesPerUser?: number | null; // Integer >= 0 or null to clear
    // targetAudienceRules?: { [key: string]: any };
    allowCombining?: boolean;
    discountDetails?: { // Allow updating discount
        type: "percentage" | "fixedAmount";
        percentageValue?: number | null;
        fixedAmountSmallestUnit?: number | null;
    };
    minOrderValueSmallestUnit?: number | null; // Integer >= 0 or null to clear
}

interface DeletePromoCodeInput {
    couponCode: string; // Document ID
}

interface ListPromoCodesInput {
    // Optional filtering/pagination
    pageSize?: number;
    pageToken?: string; // Use couponCode as page token
    filterActive?: boolean | null; // Filter by isActive status
}

interface PromoCodeOutput extends Omit<PromoCode, 'createdAt' | 'updatedAt' | 'validFrom' | 'validUntil'> {
    // Convert Timestamps to ISO strings for client
    createdAt?: string | null;
    updatedAt?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    // Add couponCode explicitly if not part of PromoCode model by default
    couponCode: string;
}

interface ListPromoCodesOutput {
    promoCodes: PromoCodeOutput[];
    nextPageToken?: string | null;
}

// Helper to validate discount details
function validateDiscountDetails(details: any): boolean {
    if (!details || typeof details !== 'object') return false;
    if (details.type === 'percentage') {
        return typeof details.percentageValue === 'number' && details.percentageValue > 0 && details.percentageValue <= 100;
    } else if (details.type === 'fixedAmount') {
        return typeof details.fixedAmountSmallestUnit === 'number' && details.fixedAmountSmallestUnit > 0 && Number.isInteger(details.fixedAmountSmallestUnit);
    }
    return false;
}

// Helper to parse ISO date string to Timestamp or null
function parseOptionalTimestamp(dateString: string | null | undefined): Timestamp | null {
    if (!dateString) return null;
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return null;
        return Timestamp.fromDate(date);
    } catch (e) {
        return null;
    }
}


// ============================================================================
// === Create Promo Code Function =============================================
// ============================================================================
export const createPromoCode = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true; couponCode: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createPromoCode V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as CreatePromoCodeInput;
        const logContext: any = { adminUserId, couponCode: data?.couponCode };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check (Using REAL helper) - Define permission: 'admin:promocode:create'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:promocode:create', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to create promo code.`, logContext);
                return { success: false, error: "error.permissionDenied.createPromo", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.couponCode || typeof data.couponCode !== 'string' || data.couponCode.trim().length === 0 || data.couponCode.includes('/') ||
            typeof data.isActive !== 'boolean' ||
            !validateDiscountDetails(data.discountDetails) ||
            (data.maxTotalUses != null && (typeof data.maxTotalUses !== 'number' || !Number.isInteger(data.maxTotalUses) || data.maxTotalUses < 0)) ||
            (data.maxUsesPerUser != null && (typeof data.maxUsesPerUser !== 'number' || !Number.isInteger(data.maxUsesPerUser) || data.maxUsesPerUser < 0)) ||
            (data.minOrderValueSmallestUnit != null && (typeof data.minOrderValueSmallestUnit !== 'number' || !Number.isInteger(data.minOrderValueSmallestUnit) || data.minOrderValueSmallestUnit < 0))
           )
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.promoData", errorCode: ErrorCode.InvalidArgument };
        }

        const validFromTs = parseOptionalTimestamp(data.validFrom);
        const validUntilTs = parseOptionalTimestamp(data.validUntil);

        if ((data.validFrom && !validFromTs) || (data.validUntil && !validUntilTs)) {
             return { success: false, error: "error.invalidInput.dateFormat", errorCode: ErrorCode.InvalidArgument };
        }
        if (validFromTs && validUntilTs && validUntilTs <= validFromTs) {
             return { success: false, error: "error.invalidInput.dateRange", errorCode: ErrorCode.InvalidDateRange };
        }

        const couponCodeId = data.couponCode.trim().toUpperCase(); // Use uppercase code as ID? Standardize it.
        logContext.couponCodeId = couponCodeId;

        // 3. Create Promo Code Document
        const promoRef = db.collection('promoCodes').doc(couponCodeId);
        try {
            const newPromoData: PromoCode = {
                couponCode: couponCodeId, // Store the standardized code also in the doc
                description: data.description?.trim() ?? null,
                isActive: data.isActive,
                validFrom: validFromTs,
                validUntil: validUntilTs,
                maxTotalUses: data.maxTotalUses ?? null,
                currentTotalUses: 0, // Initialize usage count
                maxUsesPerUser: data.maxUsesPerUser ?? null,
                // targetAudienceRules: data.targetAudienceRules ?? null,
                allowCombining: data.allowCombining ?? false,
                discountDetails: data.discountDetails, // Assumes validated structure
                minOrderValueSmallestUnit: data.minOrderValueSmallestUnit ?? null,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            };

            await promoRef.create(newPromoData);
            logger.info(`${functionName} Promo code '${couponCodeId}' created successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("CreatePromoCode", { couponCodeId, data: newPromoData, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true, couponCode: couponCodeId };

        } catch (error: any) {
            if (error.code === 6) { // Firestore ALREADY_EXISTS code
                logger.warn(`${functionName} Promo code '${couponCodeId}' already exists.`, logContext);
                return { success: false, error: "error.promo.alreadyExists", errorCode: ErrorCode.AlreadyExists };
            }
            logger.error(`${functionName} Failed to create promo code '${couponCodeId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Update Promo Code Function =============================================
// ============================================================================
export const updatePromoCode = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[updatePromoCode V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as UpdatePromoCodeInput;
        const logContext: any = { adminUserId, couponCode: data?.couponCode };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check (Using REAL helper) - Define permission: 'admin:promocode:update'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:promocode:update', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to update promo code.`, logContext);
                return { success: false, error: "error.permissionDenied.updatePromo", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.couponCode || typeof data.couponCode !== 'string' || data.couponCode.trim().length === 0) {
            return { success: false, error: "error.invalidInput.missingCouponCode", errorCode: ErrorCode.InvalidArgument };
        }
        const couponCodeId = data.couponCode.trim().toUpperCase(); // Use standardized ID
        logContext.couponCodeId = couponCodeId;

        const updatePayload: { [key: string]: any } = {}; // Use generic object for flexibility
        let changesDetected = false;

        // Validate and add fields to payload if they exist in input data
        if (data.description !== undefined) { updatePayload.description = data.description === null ? null : data.description?.trim(); changesDetected = true; }
        if (data.isActive !== undefined) { if(typeof data.isActive !== 'boolean') return {success: false, error:"Invalid isActive", errorCode: ErrorCode.InvalidArgument}; updatePayload.isActive = data.isActive; changesDetected = true; }
        if (data.validFrom !== undefined) { const ts = parseOptionalTimestamp(data.validFrom); if(data.validFrom && !ts) return {success: false, error:"Invalid validFrom", errorCode: ErrorCode.InvalidArgument}; updatePayload.validFrom = ts; changesDetected = true; }
        if (data.validUntil !== undefined) { const ts = parseOptionalTimestamp(data.validUntil); if(data.validUntil && !ts) return {success: false, error:"Invalid validUntil", errorCode: ErrorCode.InvalidArgument}; updatePayload.validUntil = ts; changesDetected = true; }
        if (data.maxTotalUses !== undefined) { if(data.maxTotalUses !== null && (typeof data.maxTotalUses !== 'number' || !Number.isInteger(data.maxTotalUses) || data.maxTotalUses < 0)) return {success: false, error:"Invalid maxTotalUses", errorCode: ErrorCode.InvalidArgument}; updatePayload.maxTotalUses = data.maxTotalUses; changesDetected = true; }
        if (data.maxUsesPerUser !== undefined) { if(data.maxUsesPerUser !== null && (typeof data.maxUsesPerUser !== 'number' || !Number.isInteger(data.maxUsesPerUser) || data.maxUsesPerUser < 0)) return {success: false, error:"Invalid maxUsesPerUser", errorCode: ErrorCode.InvalidArgument}; updatePayload.maxUsesPerUser = data.maxUsesPerUser; changesDetected = true; }
        if (data.allowCombining !== undefined) { if(typeof data.allowCombining !== 'boolean') return {success: false, error:"Invalid allowCombining", errorCode: ErrorCode.InvalidArgument}; updatePayload.allowCombining = data.allowCombining; changesDetected = true; }
        if (data.discountDetails !== undefined) { if(!validateDiscountDetails(data.discountDetails)) return {success: false, error:"Invalid discountDetails", errorCode: ErrorCode.InvalidDiscountDetails}; updatePayload.discountDetails = data.discountDetails; changesDetected = true; }
        if (data.minOrderValueSmallestUnit !== undefined) { if(data.minOrderValueSmallestUnit !== null && (typeof data.minOrderValueSmallestUnit !== 'number' || !Number.isInteger(data.minOrderValueSmallestUnit) || data.minOrderValueSmallestUnit < 0)) return {success: false, error:"Invalid minOrderValue", errorCode: ErrorCode.InvalidArgument}; updatePayload.minOrderValueSmallestUnit = data.minOrderValueSmallestUnit; changesDetected = true; }

        // Validate date range consistency if both are being updated or one is updated and the other exists
        let finalValidFromTs: Timestamp | null = null;
        let finalValidUntilTs: Timestamp | null = null;
        const promoRef = db.collection('promoCodes').doc(couponCodeId); // Define here for reuse

        try {
            const currentSnap = await promoRef.get();
            if (!currentSnap.exists && changesDetected) { // Only error if trying to update non-existent and there are changes
                 logger.warn(`${functionName} Promo code '${couponCodeId}' not found for update.`, logContext);
                 return { success: false, error: "error.promo.notFound", errorCode: ErrorCode.PromoCodeNotFound };
            }
            const currentData = currentSnap.data();

            finalValidFromTs = updatePayload.validFrom !== undefined ? updatePayload.validFrom : (currentData?.validFrom ?? null);
            finalValidUntilTs = updatePayload.validUntil !== undefined ? updatePayload.validUntil : (currentData?.validUntil ?? null);

            if (finalValidFromTs && finalValidUntilTs && finalValidUntilTs <= finalValidFromTs) {
                return { success: false, error: "error.invalidInput.dateRange", errorCode: ErrorCode.InvalidDateRange };
            }
        } catch (fetchError: any) {
             logger.error(`${functionName} Failed to fetch current promo code data for validation.`, { ...logContext, error: fetchError.message });
             return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        }


        if (!changesDetected) {
            logger.info(`${functionName} No changes detected for promo code '${couponCodeId}'.`, logContext);
            return { success: true }; // No update needed
        }

        updatePayload.updatedAt = FieldValue.serverTimestamp(); // Add timestamp

        // 3. Update Promo Code Document
        try {
            await promoRef.update(updatePayload); // update() throws if doc doesn't exist
            logger.info(`${functionName} Promo code '${couponCodeId}' updated successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("UpdatePromoCode", { couponCodeId, changes: Object.keys(updatePayload).filter(k => k !== 'updatedAt'), triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
            // Error code 5 is NOT_FOUND, should have been caught above if trying to update non-existent.
            // If it occurs here, it might be a race condition or other issue.
            if (error.code === 5) {
                 logger.error(`${functionName} Promo code '${couponCodeId}' not found during update operation (unexpected).`, logContext);
                 return { success: false, error: "error.promo.notFound", errorCode: ErrorCode.PromoCodeNotFound };
            }
            logger.error(`${functionName} Failed to update promo code '${couponCodeId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Delete Promo Code Function =============================================
// ============================================================================
// Note: Instead of deleting, we often just mark as inactive.
// This implementation marks as inactive.
export const deletePromoCode = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[deletePromoCode (Deactivate) V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as DeletePromoCodeInput;
        const logContext: any = { adminUserId, couponCode: data?.couponCode };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check (Using REAL helper) - Define permission: 'admin:promocode:delete'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:promocode:delete', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to delete/deactivate promo code.`, logContext);
                return { success: false, error: "error.permissionDenied.deletePromo", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Input Validation
        if (!data?.couponCode || typeof data.couponCode !== 'string' || data.couponCode.trim().length === 0) {
            return { success: false, error: "error.invalidInput.missingCouponCode", errorCode: ErrorCode.InvalidArgument };
        }
        const couponCodeId = data.couponCode.trim().toUpperCase();
        logContext.couponCodeId = couponCodeId;

        // 3. Deactivate Promo Code Document
        const promoRef = db.collection('promoCodes').doc(couponCodeId);
        try {
            // Check if exists before updating
            const promoSnap = await promoRef.get();
            if (!promoSnap.exists) {
                 logger.warn(`${functionName} Promo code '${couponCodeId}' not found for deactivation.`, logContext);
                 return { success: false, error: "error.promo.notFound", errorCode: ErrorCode.PromoCodeNotFound };
            }

            await promoRef.update({
                isActive: false,
                updatedAt: FieldValue.serverTimestamp(),
            });
            logger.info(`${functionName} Promo code '${couponCodeId}' deactivated successfully.`, logContext);

            // 4. Log Admin Action (Async)
            logAdminAction("DeactivatePromoCode", { couponCodeId, triggerUserId: adminUserId }).catch(err => logger.error("Failed logging admin action", { err }));

            // 5. Return Success
            return { success: true };

        } catch (error: any) {
             // update() can throw NOT_FOUND if doc deleted between get() and update()
             if (error.code === 5) {
                 logger.warn(`${functionName} Promo code '${couponCodeId}' not found during update (race condition?).`, logContext);
                 return { success: false, error: "error.promo.notFound", errorCode: ErrorCode.PromoCodeNotFound };
             }
            logger.error(`${functionName} Failed to deactivate promo code '${couponCodeId}'.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === List Promo Codes Function ==============================================
// ============================================================================
export const listPromoCodes = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true; data: ListPromoCodesOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[listPromoCodes V2 - Permissions]"; // Updated version name
        const startTimeFunc = Date.now();

        // 1. Auth & Permissions
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const adminUserId = request.auth.uid;
        const data = request.data as ListPromoCodesInput; // Input might be empty
        const logContext: any = { adminUserId, pageSize: data?.pageSize, pageToken: data?.pageToken, filterActive: data?.filterActive };
        logger.info(`${functionName} Invoked.`, logContext);

        let adminUserRole: string | null = null;
        try {
            const userSnap = await db.collection('users').doc(adminUserId).get();
            if (!userSnap.exists) throw new HttpsError('not-found', `Admin user ${adminUserId} not found.`, { errorCode: ErrorCode.UserNotFound });
            adminUserRole = (userSnap.data() as User)?.role;
            logContext.adminUserRole = adminUserRole;

            // Permission Check (Using REAL helper) - Define permission: 'admin:promocode:list'
            const hasPermission = await checkPermission(adminUserId, adminUserRole, 'admin:promocode:list', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for admin ${adminUserId} (Role: ${adminUserRole}) to list promo codes.`, logContext);
                return { success: false, error: "error.permissionDenied.listPromos", errorCode: ErrorCode.PermissionDenied };
            }
        } catch (e: any) {
             logger.error("Auth/Permission check failed", { ...logContext, error: e.message });
             const code = e instanceof HttpsError ? e.details?.errorCode : ErrorCode.InternalError;
             const msg = e instanceof HttpsError ? e.message : "error.internalServer";
             return { success: false, error: msg, errorCode: code || ErrorCode.InternalError };
        }

        // 2. Prepare Query
        const pageSize = (typeof data?.pageSize === 'number' && data.pageSize > 0 && data.pageSize <= 100) ? data.pageSize : 20;
        let query: admin.firestore.Query<admin.firestore.DocumentData> = db.collection('promoCodes');

        // Add filter if provided
        if (data?.filterActive === true) {
            query = query.where('isActive', '==', true);
        } else if (data?.filterActive === false) {
             query = query.where('isActive', '==', false);
        }

        // Add ordering and pagination (using couponCode as ID for pagination token)
        query = query.orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
        if (data?.pageToken && typeof data.pageToken === 'string') {
            try {
                query = query.startAfter(data.pageToken);
            } catch (e) {
                logger.warn("Invalid page token provided or query failed.", { pageToken: data.pageToken, error: e });
            }
        }

        // 3. Execute Query
        try {
            const snapshot = await query.get();
            const promoCodes: PromoCodeOutput[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as PromoCode;
                // Convert Timestamps to ISO strings for client compatibility
                const outputData: PromoCodeOutput = {
                    couponCode: doc.id, // Use doc ID as the couponCode
                    description: data.description,
                    isActive: data.isActive,
                    validFrom: data.validFrom?.toDate().toISOString() ?? null,
                    validUntil: data.validUntil?.toDate().toISOString() ?? null,
                    maxTotalUses: data.maxTotalUses,
                    currentTotalUses: data.currentTotalUses,
                    maxUsesPerUser: data.maxUsesPerUser,
                    allowCombining: data.allowCombining,
                    discountDetails: data.discountDetails,
                    minOrderValueSmallestUnit: data.minOrderValueSmallestUnit,
                    createdAt: data.createdAt?.toDate().toISOString() ?? null,
                    updatedAt: data.updatedAt?.toDate().toISOString() ?? null,
                };
                promoCodes.push(outputData);
            });

            // Determine next page token
            let nextPageToken: string | null = null;
            if (snapshot.docs.length === pageSize) {
                nextPageToken = snapshot.docs[snapshot.docs.length - 1].id; // Use couponCode (doc ID) as token
            }

            logger.info(`${functionName} Found ${promoCodes.length} promo codes. Next page token: ${nextPageToken}`, logContext);

            // 4. Return Results
            return { success: true, data: { promoCodes, nextPageToken } };

        } catch (error: any) {
            logger.error(`${functionName} Failed to list promo codes.`, { ...logContext, error: error.message });
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
