import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import * as speakeasy from 'speakeasy'; // Library for TOTP secret generation
import * as QRCode from 'qrcode'; // Library to generate QR code data URL

// --- Import Models ---
import { User } from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { logUserActivity } from '../utils/logging';
// import { encryptSecret, decryptSecret } from '../utils/encryption'; // CRITICAL: For storing the secret securely

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null; } // Allow any logged-in user for setup? Or restrict? Let's allow for now.
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
// CRITICAL MOCK: Replace with REAL encryption/decryption using Cloud KMS or similar
async function encryptSecret(plainText: string): Promise<string> { logger.warn("[Mock Encrypt] Using mock encryption (Base64). REPLACE WITH KMS!"); return Buffer.from(plainText).toString('base64'); }
// async function decryptSecret(cipherText: string): Promise<string> { logger.warn("[Mock Decrypt] Using mock decryption (Base64). REPLACE WITH KMS!"); return Buffer.from(cipherText, 'base64').toString('utf8'); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const MFA_ISSUER_NAME = "Urban Coconuts V2"; // Name shown in authenticator app

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User not found
    FailedPrecondition = "FAILED_PRECONDITION", // MFA already enabled
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND",
    MfaAlreadyEnabled = "MFA_ALREADY_ENABLED",
    SecretGenerationFailed = "SECRET_GENERATION_FAILED",
    EncryptionFailed = "ENCRYPTION_FAILED", // Critical error
    QrCodeGenerationFailed = "QR_CODE_GENERATION_FAILED",
}

// --- Interfaces ---
// No input needed for generateMfaSetup, it uses the caller's UID
interface GenerateMfaSetupOutput {
    secret: string; // The BASE32 encoded secret for manual entry
    otpAuthUrl: string; // The otpauth:// URL for QR code generation
    qrCodeDataUrl: string; // A base64 encoded PNG data URL for the QR code
}

// ============================================================================
// === Generate MFA Setup Function ============================================
// ============================================================================
export const generateMfaSetup = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "256MiB", // Needs some memory for crypto and QR generation
        timeoutSeconds: 30,
        // secrets: ["ENCRYPTION_KEY"], // Add secret for your encryption key (e.g., KMS key name)
    },
    async (request): Promise<{ success: true; data: GenerateMfaSetupOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[generateMfaSetup V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid; // User initiating MFA setup for themselves
        const logContext: any = { userId };
        logger.info(`${functionName} Invoked.`, logContext);

        let userRole: string | null = null;
        let userEmail: string | undefined; // Get email for otpauth URL label

        try {
            // Fetch user data (needed for email and checking if MFA already enabled)
            const userRef = db.collection('users').doc(userId);
            const userSnap = await userRef.get();
            if (!userSnap.exists) {
                logger.error(`${functionName} User document not found for authenticated user ${userId}.`, logContext);
                // This case should ideally not happen if auth succeeded
                return { success: false, error: "error.user.notFound", errorCode: ErrorCode.UserNotFound };
            }
            const userData = userSnap.data() as User;
            userRole = userData.role;
            userEmail = userData.email ?? userId; // Use email or UID if email is missing
            logContext.userRole = userRole;

            // Permission Check (Allow any logged-in user? Or specific roles?)
            // Let's assume any user can *initiate* setup for now. Verification step will be separate.
            // const hasPermission = await checkPermission(userId, userRole, 'mfa:setup:generate');
            // if (!hasPermission) { return { success: false, error: "error.permissionDenied.generateMfa", errorCode: ErrorCode.PermissionDenied }; }

            // Check if MFA is already enabled and verified
            if (userData.isMfaEnabled === true) {
                logger.warn(`${functionName} MFA is already enabled for user ${userId}.`, logContext);
                return { success: false, error: "error.mfa.alreadyEnabled", errorCode: ErrorCode.MfaAlreadyEnabled };
            }

            // 2. Generate TOTP Secret using Speakeasy
            logger.info(`${functionName} Generating new TOTP secret for user ${userId}...`, logContext);
            let secret: speakeasy.GeneratedSecret;
            try {
                secret = speakeasy.generateSecret({
                    length: 20, // Standard length
                    name: `${MFA_ISSUER_NAME} (${userEmail})`, // Label shown in authenticator app
                    issuer: MFA_ISSUER_NAME,
                });
                if (!secret || !secret.base32 || !secret.otpauth_url) {
                    throw new Error("Speakeasy did not return a valid secret object.");
                }
            } catch (genError: any) {
                logger.error(`${functionName} Failed to generate Speakeasy secret.`, { ...logContext, error: genError.message });
                return { success: false, error: "error.mfa.secretGenerationFailed", errorCode: ErrorCode.SecretGenerationFailed };
            }
            const plainTextSecret = secret.base32; // The secret the user needs to save/scan

            // 3. CRITICAL: Encrypt the Secret before storing
            logger.info(`${functionName} Encrypting generated secret...`, logContext);
            let encryptedSecret: string;
            try {
                // Replace mock with call to your actual KMS/encryption helper
                encryptedSecret = await encryptSecret(plainTextSecret);
                if (!encryptedSecret) throw new Error("Encryption returned empty value.");
            } catch (encError: any) {
                logger.error(`${functionName} CRITICAL: Failed to encrypt MFA secret for user ${userId}. Aborting setup.`, { ...logContext, error: encError.message });
                // DO NOT proceed if encryption fails.
                return { success: false, error: "error.mfa.encryptionFailed", errorCode: ErrorCode.EncryptionFailed };
            }

            // 4. Store the *encrypted* secret temporarily in the user document
            // This secret is pending verification by the user in the next step.
            // We might store it in a temporary field like 'mfaSetupSecret' or directly
            // in 'mfaSecret' but keep 'isMfaEnabled' as false until verified.
            // Let's use a temporary field approach for clarity.
            logger.info(`${functionName} Storing encrypted pending secret for user ${userId}...`, logContext);
            await userRef.update({
                mfaPendingSecret: encryptedSecret, // Store encrypted secret here
                mfaPendingTimestamp: FieldValue.serverTimestamp(), // Timestamp for expiry?
                isMfaEnabled: false, // Ensure it's still false
                mfaSecret: null, // Clear any old *verified* secret if re-doing setup
                updatedAt: FieldValue.serverTimestamp(),
            });

            // 5. Generate QR Code Data URL
            logger.info(`${functionName} Generating QR code data URL...`, logContext);
            let qrCodeDataUrl: string;
            try {
                qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);
                if (!qrCodeDataUrl) throw new Error("QR Code generation returned empty value.");
            } catch (qrError: any) {
                 logger.error(`${functionName} Failed to generate QR code data URL.`, { ...logContext, error: qrError.message });
                 // Don't fail the whole process, user can still enter manually
                 // Maybe return success but without the QR code? Or return error?
                 // Let's return an error as the QR code is a primary part of the setup UX.
                 // Clean up the pending secret we just stored? Maybe not, allow retry?
                 return { success: false, error: "error.mfa.qrCodeGenerationFailed", errorCode: ErrorCode.QrCodeGenerationFailed };
            }

            // 6. Prepare Response Data (DO NOT return the encrypted secret)
            const responseData: GenerateMfaSetupOutput = {
                secret: plainTextSecret, // Return the PLAIN TEXT secret for manual entry
                otpAuthUrl: secret.otpauth_url, // Return the URL for QR code generation
                qrCodeDataUrl: qrCodeDataUrl, // Return the generated QR code image data
            };

            // 7. Log Activity (Async)
            logUserActivity("GenerateMfaSetup", { success: true }, userId).catch(err => logger.error("Failed logging activity", { err }));

            // 8. Return Success with Setup Data
            logger.info(`${functionName} MFA setup generated successfully for user ${userId}.`, logContext);
            return { success: true, data: responseData };

        } catch (error: any) {
            // Handle unexpected errors
            logger.error(`${functionName} Unexpected error generating MFA setup.`, { ...logContext, error: error.message });
            logUserActivity("GenerateMfaSetup", { success: false, error: error.message }, userId).catch(err => logger.error("Failed logging activity", { err }));

            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.mfa.setupGeneric`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);

// Add other MFA functions (verifyMfaSetup, disableMfa, verifyMfaLogin) in this file later...
