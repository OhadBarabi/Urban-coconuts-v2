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
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null; } // Allow any logged-in user for MFA actions? Or restrict? Let's allow for now.
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
// CRITICAL MOCK: Replace with REAL encryption/decryption using Cloud KMS or similar
async function encryptSecret(plainText: string): Promise<string> { logger.warn("[Mock Encrypt] Using mock encryption (Base64). REPLACE WITH KMS!"); return Buffer.from(plainText).toString('base64'); }
async function decryptSecret(cipherText: string): Promise<string> { logger.warn("[Mock Decrypt] Using mock decryption (Base64). REPLACE WITH KMS!"); return Buffer.from(cipherText, 'base64').toString('utf8'); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const MFA_ISSUER_NAME = "Urban Coconuts V2"; // Name shown in authenticator app

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User not found or pending secret missing
    FailedPrecondition = "FAILED_PRECONDITION", // MFA already enabled/disabled or pending secret expired
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND",
    MfaAlreadyEnabled = "MFA_ALREADY_ENABLED",
    MfaNotEnabled = "MFA_NOT_ENABLED", // Added for disableMfa
    SecretGenerationFailed = "SECRET_GENERATION_FAILED",
    EncryptionFailed = "ENCRYPTION_FAILED", // Critical error
    DecryptionFailed = "DECRYPTION_FAILED", // Critical error
    QrCodeGenerationFailed = "QR_CODE_GENERATION_FAILED",
    MissingPendingSecret = "MISSING_PENDING_SECRET", // No pending secret found to verify against
    InvalidOtpCode = "INVALID_OTP_CODE", // Code doesn't match secret
    OtpVerificationFailed = "OTP_VERIFICATION_FAILED", // General speakeasy failure
}

// --- Interfaces ---
// generateMfaSetup
interface GenerateMfaSetupOutput {
    secret: string; // The BASE32 encoded secret for manual entry
    otpAuthUrl: string; // The otpauth:// URL for QR code generation
    qrCodeDataUrl: string; // A base64 encoded PNG data URL for the QR code
}
// verifyMfaSetup
interface VerifyMfaSetupInput {
    token: string; // The 6-digit OTP code from the authenticator app
}
// disableMfa (No input needed besides auth context)

// ============================================================================
// === Generate MFA Setup Function ============================================
// ============================================================================
export const generateMfaSetup = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "256MiB", timeoutSeconds: 30, /* secrets: ["ENCRYPTION_KEY"] */ },
    async (request): Promise<{ success: true; data: GenerateMfaSetupOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[generateMfaSetup V1]";
        const startTimeFunc = Date.now();
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid;
        const logContext: any = { userId };
        logger.info(`${functionName} Invoked.`, logContext);

        let userRole: string | null = null;
        let userEmail: string | undefined;

        try {
            const userRef = db.collection('users').doc(userId);
            const userSnap = await userRef.get();
            if (!userSnap.exists) { return { success: false, error: "error.user.notFound", errorCode: ErrorCode.UserNotFound }; }
            const userData = userSnap.data() as User;
            userRole = userData.role;
            userEmail = userData.email ?? userId;
            logContext.userRole = userRole;

            if (userData.isMfaEnabled === true) { return { success: false, error: "error.mfa.alreadyEnabled", errorCode: ErrorCode.MfaAlreadyEnabled }; }

            let secret: speakeasy.GeneratedSecret;
            try {
                secret = speakeasy.generateSecret({ length: 20, name: `${MFA_ISSUER_NAME} (${userEmail})`, issuer: MFA_ISSUER_NAME });
                if (!secret?.base32 || !secret.otpauth_url) throw new Error("Invalid secret object");
            } catch (genError: any) { return { success: false, error: "error.mfa.secretGenerationFailed", errorCode: ErrorCode.SecretGenerationFailed }; }
            const plainTextSecret = secret.base32;

            let encryptedSecret: string;
            try {
                encryptedSecret = await encryptSecret(plainTextSecret); // Replace mock
                if (!encryptedSecret) throw new Error("Encryption returned empty");
            } catch (encError: any) { return { success: false, error: "error.mfa.encryptionFailed", errorCode: ErrorCode.EncryptionFailed }; }

            await userRef.update({
                mfaPendingSecret: encryptedSecret,
                mfaPendingTimestamp: FieldValue.serverTimestamp(),
                isMfaEnabled: false,
                mfaSecret: null,
                updatedAt: FieldValue.serverTimestamp(),
            });

            let qrCodeDataUrl: string;
            try {
                qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);
                if (!qrCodeDataUrl) throw new Error("QR Code generation empty");
            } catch (qrError: any) { return { success: false, error: "error.mfa.qrCodeGenerationFailed", errorCode: ErrorCode.QrCodeGenerationFailed }; }

            const responseData: GenerateMfaSetupOutput = { secret: plainTextSecret, otpAuthUrl: secret.otpauth_url, qrCodeDataUrl: qrCodeDataUrl };
            logUserActivity("GenerateMfaSetup", { success: true }, userId).catch();
            logger.info(`${functionName} MFA setup generated successfully for user ${userId}.`, logContext);
            return { success: true, data: responseData };

        } catch (error: any) {
            logger.error(`${functionName} Unexpected error.`, { ...logContext, error: error.message });
            logUserActivity("GenerateMfaSetup", { success: false, error: error.message }, userId).catch();
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";
            if (isHttpsError) { finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError; finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.mfa.setupGeneric`; }
            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Verify MFA Setup Function ==============================================
// ============================================================================
export const verifyMfaSetup = functions.https.onCall(
    { region: FUNCTION_REGION, memory: "256MiB", timeoutSeconds: 30, /* secrets: ["ENCRYPTION_KEY"] */ },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[verifyMfaSetup V1]";
        const startTimeFunc = Date.now();
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid;
        const data = request.data as VerifyMfaSetupInput;
        const logContext: any = { userId };
        logger.info(`${functionName} Invoked.`, logContext);

        if (!data?.token || typeof data.token !== 'string' || !/^\d{6}$/.test(data.token)) {
            return { success: false, error: "error.invalidInput.mfaToken", errorCode: ErrorCode.InvalidArgument };
        }
        const { token } = data;

        let userData: User;
        let encryptedPendingSecret: string | null;

        try {
            const userRef = db.collection('users').doc(userId);
            const userSnap = await userRef.get();
            if (!userSnap.exists) { return { success: false, error: "error.user.notFound", errorCode: ErrorCode.UserNotFound }; }
            userData = userSnap.data() as User;
            encryptedPendingSecret = userData.mfaPendingSecret ?? null;
            logContext.userRole = userData.role;

            if (userData.isMfaEnabled === true) { return { success: false, error: "error.mfa.alreadyEnabled", errorCode: ErrorCode.MfaAlreadyEnabled }; }
            if (!encryptedPendingSecret) { return { success: false, error: "error.mfa.noPendingSecret", errorCode: ErrorCode.MissingPendingSecret }; }

            let plainTextSecret: string;
            try {
                plainTextSecret = await decryptSecret(encryptedPendingSecret); // Replace mock
                if (!plainTextSecret) throw new Error("Decryption returned empty");
            } catch (decError: any) {
                await userRef.update({ mfaPendingSecret: null, mfaPendingTimestamp: null }).catch();
                return { success: false, error: "error.mfa.decryptionFailed", errorCode: ErrorCode.DecryptionFailed };
            }

            let isValidToken: boolean;
            try {
                isValidToken = speakeasy.totp.verify({ secret: plainTextSecret, encoding: 'base32', token: token, window: 1 });
            } catch (verifyError: any) { return { success: false, error: "error.mfa.otpVerificationFailed", errorCode: ErrorCode.OtpVerificationFailed }; }

            if (!isValidToken) {
                logUserActivity("VerifyMfaSetupFailed", { reason: "Invalid token" }, userId).catch();
                return { success: false, error: "error.mfa.invalidCode", errorCode: ErrorCode.InvalidOtpCode };
            }

            await userRef.update({
                isMfaEnabled: true,
                mfaSecret: encryptedPendingSecret, // Move pending to verified
                mfaPendingSecret: null,
                mfaPendingTimestamp: null,
                mfaEnabledTimestamp: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
            });

            logUserActivity("VerifyMfaSetupSuccess", { success: true }, userId).catch();
            logger.info(`${functionName} MFA enabled successfully for user ${userId}.`, logContext);
            return { success: true };

        } catch (error: any) {
            logger.error(`${functionName} Unexpected error.`, { ...logContext, error: error.message });
            logUserActivity("VerifyMfaSetupFailed", { success: false, error: error.message }, userId).catch();
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";
            if (isHttpsError) { finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError; finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.mfa.verifyGeneric`; }
            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);


// ============================================================================
// === Disable MFA Function ===================================================
// ============================================================================
export const disableMfa = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "128MiB",
        timeoutSeconds: 30,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[disableMfa V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid; // User disabling MFA for themselves
        const logContext: any = { userId };
        logger.info(`${functionName} Invoked.`, logContext);

        // --- Variables ---
        let userData: User;

        try {
            // 2. Fetch User Data
            const userRef = db.collection('users').doc(userId);
            const userSnap = await userRef.get();
            if (!userSnap.exists) { return { success: false, error: "error.user.notFound", errorCode: ErrorCode.UserNotFound }; }
            userData = userSnap.data() as User;
            logContext.userRole = userData.role;

            // Permission Check (Allow any logged-in user to disable their own MFA?)
            // const hasPermission = await checkPermission(userId, userRole, 'mfa:disable:own');
            // if (!hasPermission) { return { success: false, error: "error.permissionDenied.disableMfa", errorCode: ErrorCode.PermissionDenied }; }

            // 3. State Validation
            if (userData.isMfaEnabled !== true) {
                logger.warn(`${functionName} MFA is not currently enabled for user ${userId}.`, logContext);
                // Idempotency: If already disabled, return success
                return { success: true };
                // Or return error:
                // return { success: false, error: "error.mfa.notEnabled", errorCode: ErrorCode.MfaNotEnabled };
            }

            // 4. Update User Document
            logger.info(`${functionName} Disabling MFA for user ${userId}...`, logContext);
            await userRef.update({
                isMfaEnabled: false,
                mfaSecret: null, // Remove the verified secret
                mfaPendingSecret: null, // Also clear any pending secret
                mfaPendingTimestamp: null,
                mfaEnabledTimestamp: null, // Clear enabled timestamp
                updatedAt: FieldValue.serverTimestamp(),
            });

            // 5. Log Success Activity (Async)
            logUserActivity("DisableMfaSuccess", { success: true }, userId).catch(err => logger.error("Failed logging activity", { err }));

            // 6. Return Success
            logger.info(`${functionName} MFA disabled successfully for user ${userId}.`, logContext);
            return { success: true };

        } catch (error: any) {
            // Handle unexpected errors
            logger.error(`${functionName} Unexpected error disabling MFA.`, { ...logContext, error: error.message });
            logUserActivity("DisableMfaFailed", { success: false, error: error.message }, userId).catch(err => logger.error("Failed logging activity", { err }));

            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.mfa.disableGeneric`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);

// Add verifyMfaLogin later...
