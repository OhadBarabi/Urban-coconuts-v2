import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

// --- Import Models ---
import {
    Menu, User // Assuming these are defined in models
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { getLocalizedString } from '../utils/i18n_helpers';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`); return userId != null; }
function getLocalizedString(i18nMap: { [key: string]: string } | undefined | null, langPref?: string, fallbackLang = 'en'): string | undefined { if (!i18nMap) return undefined; return i18nMap[langPref ?? fallbackLang] ?? i18nMap[fallbackLang]; }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User not found
    InternalError = "INTERNAL_ERROR",
}

// --- Interfaces ---
interface GetEventMenusInput {
    // Optional filters can be added here later, e.g.,
    // eventType?: string;
    // budgetMin?: number;
    // budgetMax?: number;
}

interface FormattedEventMenuSummary {
    menuId: string;
    menuName: string; // Translated
    description?: string | null; // Translated
    imageUrl?: string | null;
    priority: number;
    // Add other summary fields if needed, e.g., minOrderValue
    minOrderValueSmallestUnit?: number | null;
}

// --- The Cloud Function ---
export const getEventMenus = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "256MiB",
        timeoutSeconds: 30,
    },
    async (request): Promise<{ success: true; eventMenus: FormattedEventMenuSummary[] } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[getEventMenus V1]";
        const startTime = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const userId = request.auth.uid;
        const data = request.data as GetEventMenusInput; // Input might be empty for now
        const logContext: any = { userId, inputData: data };

        logger.info(`${functionName} Invoked.`, logContext);

        // Basic Permission Check
        const hasPermission = await checkPermission(userId, 'event:view_menus');
        if (!hasPermission) {
            logger.warn(`${functionName} Permission denied for user ${userId}.`, logContext);
            return { success: false, error: "error.permissionDenied.viewEventMenus", errorCode: ErrorCode.PermissionDenied };
        }

        // --- Variables ---
        let userPreferredLanguage: string | undefined;

        try {
            // Fetch User Language (for translations)
            const userSnap = await db.collection('users').doc(userId).get();
            if (userSnap.exists) {
                userPreferredLanguage = (userSnap.data() as User)?.preferredLanguage;
            } else {
                // Should not happen if auth succeeded, but handle defensively
                logger.warn(`${functionName} User ${userId} not found in DB after auth.`, logContext);
                // Proceed without language preference or throw error? Let's proceed.
            }

            // 2. Fetch Active Event Menus
            logger.info(`${functionName} Fetching active event menus...`, logContext);
            const menusQuery = db.collection('menus')
                .where('isActive', '==', true)
                .where('isEventMenu', '==', true) // Filter only event menus
                .orderBy('priority', 'asc') // Order by priority
                .orderBy(admin.firestore.FieldPath.documentId()); // Secondary sort for consistent ordering

            const menusSnap = await menusQuery.get();

            if (menusSnap.empty) {
                logger.info(`${functionName} No active event menus found.`);
                return { success: true, eventMenus: [] };
            }

            // 3. Format Results
            const formattedMenus: FormattedEventMenuSummary[] = [];
            menusSnap.forEach(doc => {
                const menuData = doc.data() as Menu;
                const formattedMenu: FormattedEventMenuSummary = {
                    menuId: doc.id,
                    menuName: getLocalizedString(menuData.menuName_i18n, userPreferredLanguage) ?? `Menu ${doc.id}`,
                    description: getLocalizedString(menuData.description_i18n, userPreferredLanguage) ?? null,
                    imageUrl: menuData.imageUrl ?? null,
                    priority: menuData.priority ?? 999,
                    minOrderValueSmallestUnit: menuData.minOrderValueSmallestUnit ?? null,
                };
                formattedMenus.push(formattedMenu);
            });

            // 4. Return Results
            logger.info(`${functionName} Returning ${formattedMenus.length} event menus. Duration: ${Date.now() - startTime}ms`);
            return { success: true, eventMenus: formattedMenus };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            const code = isHttpsError ? error.code : 'UNKNOWN';
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.getEventMenus.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        }
    }
);
