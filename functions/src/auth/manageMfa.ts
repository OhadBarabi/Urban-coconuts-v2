import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';

// --- Import Models ---
import { User } from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { encryptMfaSecret, decryptMfaSecret } from '../utils/encryption'; // <-- Import from new helper
// import { checkPermission } from '../utils/permissions'; // Still using mock below
// import { logUserActivity, logAdminAction } from '../utils/logging'; // Using mocks below

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null; } // Basic check for now
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const MFA_ISSUER_NAME = "Urban Coconuts V2"; // Name shown in authenticator apps

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User not found
    FailedPrecondition = "FAILED_PRECONDITION", // MFA already enabled/disabled
    Aborted = "ABORTED", // Encryption/Decryption/Verification failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND",
    MfaAlreadyEnabled = "MFA_ALREADY_ENABLED",
    MfaNotEnabled = "MFA_NOT_ENABLED",
    InvalidMfaToken = "INVALID_MFA_TOKEN",
    EncryptionFailed = "ENCRYPTION_FAILED",
    DecryptionFailed = "DECRYPTION_FAILED",
    QrCodeGenerationFailed = "QR_CODE_GENERATION_FAILED",
}

// --- Interfaces ---
interface GenerateMfaSetupOutput {
    secret: string; // The raw base32 secret (show to user for manual entry)
    otpAuthUrl: string; // otpauth:// URL for easy setup
    qrCodeDataUrl: string; // Data URL (base64) of the QR code image
}

interface VerifyMfaInput {
    token: string; // The 6-digit code from the authenticator app
}

// ============================================================================
// === Generate MFA Setup =====================================================
// ============================================================================
export const generateMfaSetup = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "256MiB" },
    async (request): Promise<{ success: true; data: GenerateMfaSetupOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[generateMfaSetup V2 - Refactored]";
        const startTimeFunc = Date.now();

        // 1. Authentication
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid;
        const logContext: any = { userId };
        logger.info(`${functionName} Invoked.`, logContext);

        // Optional: Check if MFA is already enabled for the user?
        // const userRef = db.collection('users').doc(userId);
        // const userSnap = await userRef.get();
        // if (userSnap.exists && userSnap.data()?.isMfaEnabled) {
        //     logger.warn(`${functionName} User ${userId} attempted to generate setup but MFA is already enabled.`, logContext);
        //     // Decide: Allow regenerating? Or return error? Let's allow regenerating for now.
        //     // return { success: false, error: "error.mfa.alreadyEnabled", errorCode: ErrorCode.MfaAlreadyEnabled };
        // }

        try {
            // 2. Generate Speakeasy Secret
            const secret = speakeasy.generateSecret({
                length: 20, // Standard length
                name: `${MFA_ISSUER_NAME} (${userId})` // Include user ID or email in issuer name shown in app
            });
            logContext.secretGenerated = true;

            // 3. Generate QR Code Data URL
            if (!secret.otpauth_url) {
                throw new Error("Speakeasy failed to generate otpauth_url.");
            }
            const qrCodeDataUrl = await qrcode.toDataURL(secret.otpauth_url);
            logContext.qrCodeGenerated = true;

            // 4. Return Setup Data (DO NOT SAVE SECRET YET - only after verification)
            const resultData: GenerateMfaSetupOutput = {
                secret: secret.base32, // Raw secret for manual entry
                otpAuthUrl: secret.otpauth_url,
                qrCodeDataUrl: qrCodeDataUrl,
            };

            logger.info(`${functionName} MFA setup data generated successfully for user ${userId}.`, logContext);
            return { success: true, data: resultData };

        } catch (error: any) {
            logger.error(`${functionName} Failed to generate MFA setup data for user ${userId}.`, { ...logContext, error: error.message });
            let errorCode = ErrorCode.InternalError;
            if (error.message.includes("QR Code")) {
                errorCode = ErrorCode.QrCodeGenerationFailed;
            }
            return { success: false, error: "error.mfa.setupGenerationFailed", errorCode: errorCode };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Verify MFA Setup =======================================================
// ============================================================================
/**
 * Verifies the TOTP token provided by the user during setup and saves the
 * encrypted secret if verification is successful.
 */
export const verifyMfaSetup = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "512MiB" }, // Increased memory for encryption call
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[verifyMfaSetup V2 - Refactored]";
        const startTimeFunc = Date.now();

        // 1. Authentication
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid;
        const data = request.data as VerifyMfaInput & { secret: string }; // Expect token AND the secret generated previously
        const logContext: any = { userId };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.token || typeof data.token !== 'string' || data.token.length !== 6 || !/^\d{6}$/.test(data.token) ||
            !data?.secret || typeof data.secret !== 'string')
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, hasToken: !!data?.token, hasSecret: !!data?.secret });
            return { success: false, error: "error.invalidInput.mfaTokenOrSecret", errorCode: ErrorCode.InvalidArgument };
        }
        const { token, secret } = data; // The BASE32 secret generated in the previous step

        try {
            // 3. Verify Token against the provided Secret
            const verified = speakeasy.totp.verify({
                secret: secret, // Use the BASE32 secret provided by the client
                encoding: 'base32',
                token: token,
                window: 1 // Allow a 30-second window variance (1 step before or after)
            });

            if (!verified) {
                logger.warn(`${functionName} MFA setup verification failed for user ${userId}. Invalid token.`, logContext);
                return { success: false, error: "error.mfa.invalidToken", errorCode: ErrorCode.InvalidMfaToken };
            }
            logContext.tokenVerified = true;

            // 4. Encrypt the Secret using the helper
            logger.info(`${functionName} Encrypting MFA secret for user ${userId}...`, logContext);
            const encryptionResult = await encryptMfaSecret(secret, userId); // Pass userId as AAD context

            if (!encryptionResult.success || !encryptionResult.encryptedData) {
                logger.error(`${functionName} Failed to encrypt MFA secret for user ${userId}.`, { ...logContext, error: encryptionResult.error });
                throw new HttpsError('internal', "Failed to encrypt secret", { errorCode: ErrorCode.EncryptionFailed });
            }
            const encryptedSecret = encryptionResult.encryptedData;
            logContext.secretEncrypted = true;

            // 5. Update User Document in Firestore
            const userRef = db.collection('users').doc(userId);
            await userRef.update({
                isMfaEnabled: true,
                mfaSecret: encryptedSecret, // Store the ENCRYPTED secret
                updatedAt: FieldValue.serverTimestamp()
            });

            logger.info(`${functionName} MFA setup verified and enabled successfully for user ${userId}.`, logContext);

            // 6. Log User Activity (Async)
            logUserActivity("EnableMfaSuccess", { method: "TOTP" }, userId).catch(err => logger.error("Failed logging user activity", { err }));

            return { success: true };

        } catch (error: any) {
            logger.error(`${functionName} Failed to verify/enable MFA for user ${userId}.`, { ...logContext, error: error?.message, details: error?.details });
            let finalErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey = "error.mfa.enableFailed";

            if (error instanceof HttpsError && error.details?.errorCode) {
                 finalErrorCode = error.details.errorCode as ErrorCode;
                 if (finalErrorCode === ErrorCode.EncryptionFailed) finalErrorMessageKey = "error.mfa.encryptionFailed";
            } else if (error.message.includes("verify")) { // Basic check
                 finalErrorCode = ErrorCode.InvalidMfaToken;
                 finalErrorMessageKey = "error.mfa.invalidToken";
            }

            logUserActivity("EnableMfaFailed", { method: "TOTP", error: error.message }, userId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Disable MFA ============================================================
// ============================================================================
export const disableMfa = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "128MiB" },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[disableMfa V2 - Refactored]";
        const startTimeFunc = Date.now();

        // 1. Authentication
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid;
        const logContext: any = { userId };
        logger.info(`${functionName} Invoked.`, logContext);

        try {
            // 2. Fetch User Data to check current status
            const userRef = db.collection('users').doc(userId);
            const userSnap = await userRef.get();

            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
            if (!userSnap.data()?.isMfaEnabled) {
                logger.warn(`${functionName} User ${userId} attempted to disable MFA but it's not enabled.`, logContext);
                return { success: false, error: "error.mfa.notEnabled", errorCode: ErrorCode.MfaNotEnabled };
            }

            // 3. Update User Document
            await userRef.update({
                isMfaEnabled: false,
                mfaSecret: FieldValue.delete(), // Remove the encrypted secret
                updatedAt: FieldValue.serverTimestamp()
            });

            logger.info(`${functionName} MFA disabled successfully for user ${userId}.`, logContext);

            // 4. Log User Activity (Async)
            logUserActivity("DisableMfaSuccess", {}, userId).catch(err => logger.error("Failed logging user activity", { err }));

            return { success: true };

        } catch (error: any) {
            logger.error(`${functionName} Failed to disable MFA for user ${userId}.`, { ...logContext, error: error?.message, details: error?.details });
            let finalErrorCode = ErrorCode.InternalError;
            if (error instanceof HttpsError && error.details?.errorCode) {
                 finalErrorCode = error.details.errorCode as ErrorCode;
            }
            logUserActivity("DisableMfaFailed", { error: error.message }, userId).catch(...)
            return { success: false, error: "error.mfa.disableFailed", errorCode: finalErrorCode };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Verify MFA Login =======================================================
// ============================================================================
/**
 * Verifies the TOTP token provided by the user during login (after primary auth).
 */
export const verifyMfaLogin = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "512MiB" }, // Increased memory for decryption call
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[verifyMfaLogin V2 - Refactored]";
        const startTimeFunc = Date.now();

        // 1. Authentication (User should already be authenticated via primary method)
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid;
        const data = request.data as VerifyMfaInput;
        const logContext: any = { userId };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.token || typeof data.token !== 'string' || data.token.length !== 6 || !/^\d{6}$/.test(data.token)) {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, hasToken: !!data?.token });
            return { success: false, error: "error.invalidInput.mfaToken", errorCode: ErrorCode.InvalidArgument };
        }
        const { token } = data;

        try {
            // 3. Fetch User Data (including encrypted secret)
            const userRef = db.collection('users').doc(userId);
            const userSnap = await userRef.get();

            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
            const userData = userSnap.data() as User;

            if (!userData.isMfaEnabled || !userData.mfaSecret) {
                logger.error(`${functionName} MFA verification requested for user ${userId}, but MFA is not enabled or secret is missing.`, logContext);
                // This should ideally be caught client-side, but handle defensively.
                return { success: false, error: "error.mfa.notEnabled", errorCode: ErrorCode.MfaNotEnabled };
            }
            const encryptedSecret = userData.mfaSecret;
            logContext.mfaEnabled = true;

            // 4. Decrypt the Secret using the helper
            logger.info(`${functionName} Decrypting MFA secret for user ${userId}...`, logContext);
            const decryptionResult = await decryptMfaSecret(encryptedSecret, userId); // Pass userId as AAD context

            if (!decryptionResult.success || !decryptionResult.decryptedData) {
                logger.error(`${functionName} Failed to decrypt MFA secret for user ${userId}. Potential tampering or key issue?`, { ...logContext, error: decryptionResult.error });
                // Log critical security event?
                throw new HttpsError('internal', "Failed to decrypt secret", { errorCode: ErrorCode.DecryptionFailed });
            }
            const decryptedSecret = decryptionResult.decryptedData;
            logContext.secretDecrypted = true;

            // 5. Verify Token against the Decrypted Secret
            const verified = speakeasy.totp.verify({
                secret: decryptedSecret, // Use the decrypted BASE32 secret
                encoding: 'base32',
                token: token,
                window: 1 // Allow a 30-second window variance
            });

            if (!verified) {
                logger.warn(`${functionName} MFA login verification failed for user ${userId}. Invalid token.`, logContext);
                 // Log failed login attempt?
                 logUserActivity("MfaLoginFailed", { reason: "Invalid Token" }, userId).catch(...)
                return { success: false, error: "error.mfa.invalidToken", errorCode: ErrorCode.InvalidMfaToken };
            }
            logContext.tokenVerified = true;

            // 6. MFA Verification Successful - Update last login timestamp? (Optional)
            // await userRef.update({ lastLoginTimestamp: FieldValue.serverTimestamp() }); // Consider if this belongs here or after client confirms login

            logger.info(`${functionName} MFA login verification successful for user ${userId}.`, logContext);

            // 7. Log successful MFA step (optional)
            logUserActivity("MfaLoginSuccess", {}, userId).catch(err => logger.error("Failed logging user activity", { err }));

            return { success: true }; // Indicate MFA step passed

        } catch (error: any) {
            logger.error(`${functionName} Failed to verify MFA login for user ${userId}.`, { ...logContext, error: error?.message, details: error?.details });
            let finalErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey = "error.mfa.verificationFailed";

             if (error instanceof HttpsError && error.details?.errorCode) {
                 finalErrorCode = error.details.errorCode as ErrorCode;
                 if (finalErrorCode === ErrorCode.DecryptionFailed) finalErrorMessageKey = "error.mfa.decryptionFailed";
             }

            logUserActivity("MfaLoginFailed", { error: error.message }, userId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
            logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
