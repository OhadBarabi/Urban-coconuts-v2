import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
// Import Twilio client library if using Twilio Verify V2
// import twilio from 'twilio';

// --- Import Models ---
import { User, Role } from '../models'; // Assuming Role enum is defined

// --- Assuming helper functions are imported or defined elsewhere ---
// import { logUserActivity } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function logUserActivity(actionType: string, details: object, userId?: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId ?? 'Anonymous'}, Action: ${actionType}`, details); }

// Mock Twilio Verify V2 Check Call
interface TwilioCheckResult { success: boolean; status?: 'approved' | 'pending' | 'canceled'; error?: any; }
async function checkTwilioVerification(phoneNumberE164: string, code: string): Promise<TwilioCheckResult> {
    logger.info(`[Mock Twilio Verify] Checking code '${code}' for ${phoneNumberE164}...`);
    await new Promise(res => setTimeout(res, 900));
    // Simulate potential errors/statuses
    if (code === '000000') { // Simulate wrong code
        logger.warn("[Mock Twilio Verify] Check FAILED - Incorrect code.");
        return { success: false, status: 'pending', error: { code: 60202, message: 'Verification check failed' } };
    }
    if (code === '111111') { // Simulate expired code
        logger.warn("[Mock Twilio Verify] Check FAILED - Expired code.");
        return { success: false, status: 'canceled', error: { code: 60203, message: 'Verification check failed - expired' } }; // Made up error code
    }
    if (Math.random() < 0.01) {
        logger.error("[Mock Twilio Verify] Check FAILED - Simulated API error.");
        return { success: false, error: { code: 20001, message: 'Internal error' } };
    }
    logger.info(`[Mock Twilio Verify] Verification check successful. Status: approved`);
    return { success: true, status: 'approved' };
}
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const auth = admin.auth(); // Needed for creating/getting user and custom token
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// Twilio Configuration (Get from environment variables/secrets)
// const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
// const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
// const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

// Initialize Twilio Client (only if using Twilio)
// let twilioClient: twilio.Twilio | null = null;
// if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
//     twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
// } else {
//     logger.warn("Twilio credentials not found. OTP verification will be mocked/fail.");
// }

// --- Enums ---
enum ErrorCode {
    InvalidArgument = "INVALID_ARGUMENT",
    ThirdPartyServiceError = "THIRD_PARTY_SERVICE_ERROR", // Error from Twilio/SMS provider
    FirebaseAuthError = "FIREBASE_AUTH_ERROR", // Error creating user or token
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    InvalidPhoneNumber = "INVALID_PHONE_NUMBER",
    InvalidOtpCode = "INVALID_OTP_CODE", // Incorrect or expired code
    OtpCheckFailed = "OTP_CHECK_FAILED", // General failure from provider
    MissingConfiguration = "MISSING_CONFIGURATION",
    UserCreationFailed = "USER_CREATION_FAILED",
    UserUpdateFailed = "USER_UPDATE_FAILED",
    TokenCreationFailed = "TOKEN_CREATION_FAILED",
    UserDisabled = "USER_DISABLED", // If existing user is disabled
}

// --- Interfaces ---
interface VerifyOtpInput {
    phoneNumber: string; // Expecting E.164 format
    code: string; // The OTP code entered by the user
}

interface VerifyOtpOutput {
    customToken: string; // Firebase Custom Auth Token
    isNewUser: boolean; // Indicates if a new user was created
    userId: string; // The Firebase UID of the user
}

// --- The Cloud Function ---
export const verifyOtp = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "256MiB", // Allow memory for Auth/DB interactions
        timeoutSeconds: 45,
        // secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID"], // Add secrets if using Twilio
    },
    async (request): Promise<{ success: true; data: VerifyOtpOutput } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[verifyOtp V1]";
        const startTimeFunc = Date.now();

        // Note: Also likely called before user is authenticated
        const data = request.data as VerifyOtpInput;
        const logContext: any = { phoneNumber: data?.phoneNumber, codeProvided: !!data?.code };

        logger.info(`${functionName} Invoked.`, logContext);

        // 1. Input Validation
        if (!data?.phoneNumber || typeof data.phoneNumber !== 'string' ||
            !data.code || typeof data.code !== 'string' || data.code.length < 4) // Basic code length check
        {
            logger.error(`${functionName} Invalid input: Missing or invalid phoneNumber/code.`, logContext);
            return { success: false, error: "error.invalidInput.phoneNumberOrCode", errorCode: ErrorCode.InvalidArgument };
        }
        if (!/^\+[1-9]\d{1,14}$/.test(data.phoneNumber)) {
             logger.error(`${functionName} Invalid phone number format. Expected E.164.`, logContext);
             return { success: false, error: "error.invalidInput.invalidPhoneNumberFormat", errorCode: ErrorCode.InvalidPhoneNumber };
        }
        const { phoneNumber: phoneNumberE164, code } = data;

        // 2. Check Configuration (e.g., Twilio credentials)
        // if (!twilioClient || !TWILIO_VERIFY_SERVICE_SID) {
        //     logger.error(`${functionName} Twilio configuration missing. Cannot verify OTP.`, logContext);
        //     return { success: false, error: "error.config.missingOtpProvider", errorCode: ErrorCode.MissingConfiguration };
        // }

        // 3. Verify OTP Code via Third-Party Service
        try {
            logger.info(`${functionName} Attempting to verify OTP code '${code}' for ${phoneNumberE164}...`, logContext);

            // --- Replace with actual Twilio Verify V2 SDK call ---
            // const check = await twilioClient.verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
            //     .verificationChecks
            //     .create({ to: phoneNumberE164, code: code });
            // logger.info(`${functionName} Twilio verification check result for ${phoneNumberE164}. Status: ${check.status}`, logContext);
            // if (check.status !== 'approved') {
            //      logger.warn(`${functionName} OTP verification failed for ${phoneNumberE164}. Status: ${check.status}`, logContext);
            //      return { success: false, error: "error.otp.invalidCode", errorCode: ErrorCode.InvalidOtpCode };
            // }
            // --- End Twilio Call ---

            // --- Using Mock Function ---
            const checkResult = await checkTwilioVerification(phoneNumberE164, code);
            if (!checkResult.success || checkResult.status !== 'approved') {
                 logger.warn(`${functionName} OTP verification failed for ${phoneNumberE164}. Status: ${checkResult.status}`, { ...logContext, error: checkResult.error });
                 return { success: false, error: "error.otp.invalidCode", errorCode: ErrorCode.InvalidOtpCode };
            }
            // --- End Mock Function Usage ---

            logger.info(`${functionName} OTP verified successfully for ${phoneNumberE164}.`, logContext);

            // 4. Get or Create Firebase Auth User
            let userRecord: admin.auth.UserRecord;
            let isNewUser = false;
            let userId: string;

            try {
                logger.info(`${functionName} Checking for existing user with phone number ${phoneNumberE164}...`, logContext);
                userRecord = await auth.getUserByPhoneNumber(phoneNumberE164);
                userId = userRecord.uid;
                logger.info(`${functionName} Found existing user: ${userId}`, logContext);

                // Check if existing user is disabled
                if (userRecord.disabled) {
                     logger.warn(`${functionName} Attempted login for disabled user: ${userId}`, logContext);
                     await logUserActivity("VerifyOtpFailedDisabled", { phoneNumber: phoneNumberE164 }, userId).catch(err => logger.error("Failed logging activity", { err }));
                     return { success: false, error: "error.auth.userDisabled", errorCode: ErrorCode.UserDisabled };
                }

                // Update last login time (optional, can be done client-side too)
                await db.collection('users').doc(userId).update({
                    lastLoginTimestamp: FieldValue.serverTimestamp(),
                    updatedAt: FieldValue.serverTimestamp() // Also update general timestamp
                }).catch(err => logger.error(`Failed to update lastLogin for user ${userId}`, {err}));


            } catch (error: any) {
                if (error.code === 'auth/user-not-found') {
                    logger.info(`${functionName} No existing user found for ${phoneNumberE164}. Creating new user...`, logContext);
                    isNewUser = true;
                    try {
                        userRecord = await auth.createUser({
                            phoneNumber: phoneNumberE164,
                            // Optionally set display name, photo URL etc. here if available
                            // displayName: 'New User',
                        });
                        userId = userRecord.uid;
                        logger.info(`${functionName} Created new Firebase Auth user: ${userId}`, logContext);

                        // Create corresponding user document in Firestore
                        const newUserDoc: User = {
                            uid: userId,
                            phoneNumber: phoneNumberE164,
                            role: Role.Customer, // Default role
                            isActive: true,
                            createdAt: Timestamp.now(),
                            // Initialize other fields as needed
                            ucCoinBalance: 0,
                        };
                        await db.collection('users').doc(userId).set(newUserDoc);
                        logger.info(`${functionName} Created Firestore user document for ${userId}.`, logContext);

                    } catch (creationError: any) {
                        logger.error(`${functionName} Failed to create Firebase Auth user or Firestore doc for ${phoneNumberE164}.`, { ...logContext, error: creationError.message, code: creationError.code });
                        await logUserActivity("VerifyOtpFailedUserCreation", { phoneNumber: phoneNumberE164, error: creationError.message }, 'system').catch(err => logger.error("Failed logging activity", { err }));
                        return { success: false, error: "error.auth.userCreationFailed", errorCode: ErrorCode.UserCreationFailed };
                    }
                } else {
                    // Handle other Firebase Auth errors during lookup
                    logger.error(`${functionName} Firebase Auth error looking up user ${phoneNumberE164}.`, { ...logContext, error: error.message, code: error.code });
                    await logUserActivity("VerifyOtpFailedAuthLookup", { phoneNumber: phoneNumberE164, error: error.message }, 'system').catch(err => logger.error("Failed logging activity", { err }));
                    return { success: false, error: "error.auth.lookupFailed", errorCode: ErrorCode.FirebaseAuthError };
                }
            }

            // 5. Generate Custom Token
            try {
                logger.info(`${functionName} Generating custom token for user ${userId}...`, logContext);
                // Add custom claims if needed (e.g., role, although role is usually set later by admin)
                // const additionalClaims = { role: Role.Customer }; // Example
                const customToken = await auth.createCustomToken(userId /*, additionalClaims */);
                logger.info(`${functionName} Custom token generated successfully for ${userId}.`, logContext);

                // 6. Log Success Activity
                await logUserActivity("VerifyOtpSuccess", { phoneNumber: phoneNumberE164, isNewUser }, userId).catch(err => logger.error("Failed logging activity", { err }));

                // 7. Return Custom Token and User Info
                const resultData: VerifyOtpOutput = {
                    customToken: customToken,
                    isNewUser: isNewUser,
                    userId: userId,
                };
                return { success: true, data: resultData };

            } catch (tokenError: any) {
                logger.error(`${functionName} Failed to create custom token for user ${userId}.`, { ...logContext, error: tokenError.message, code: tokenError.code });
                await logUserActivity("VerifyOtpFailedToken", { phoneNumber: phoneNumberE164, error: tokenError.message }, userId).catch(err => logger.error("Failed logging activity", { err }));
                return { success: false, error: "error.auth.tokenCreationFailed", errorCode: ErrorCode.TokenCreationFailed };
            }

        } catch (error: any) {
            // Handle unexpected errors
            logger.error(`${functionName} Unexpected error verifying OTP.`, { ...logContext, error: error.message });
            await logUserActivity("VerifyOtpFailedInternal", { phoneNumber: phoneNumberE164, error: error.message }, 'system').catch(err => logger.error("Failed logging activity", { err }));
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
