import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
// Import Twilio client library if using Twilio Verify V2
// import twilio from 'twilio';

// --- Import Models (if needed, e.g., for User lookup) ---
// import { User } from '../models';

// --- Assuming helper functions are imported or defined elsewhere ---
// import { logUserActivity } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function logUserActivity(actionType: string, details: object, userId?: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId ?? 'Anonymous'}, Action: ${actionType}`, details); }

// Mock Twilio Verify V2 Send Call
interface TwilioVerifyResult { success: boolean; sid?: string; error?: any; }
async function sendTwilioVerification(phoneNumberE164: string, channel: 'sms' | 'call'): Promise<TwilioVerifyResult> {
    logger.info(`[Mock Twilio Verify] Sending ${channel} verification to ${phoneNumberE164}...`);
    await new Promise(res => setTimeout(res, 800));
    // Simulate potential errors
    if (phoneNumberE164.includes('invalid')) {
        logger.error("[Mock Twilio Verify] Send FAILED - Invalid phone number.");
        return { success: false, error: { code: 60200, message: 'Invalid parameter: To' } }; // Example Twilio error
    }
    if (Math.random() < 0.02) {
        logger.error("[Mock Twilio Verify] Send FAILED - Simulated API error.");
        return { success: false, error: { code: 60203, message: 'Max send attempts reached' } };
    }
    const mockSid = `VE${'x'.repeat(32)}`;
    logger.info(`[Mock Twilio Verify] Verification sent successfully. SID: ${mockSid}`);
    return { success: true, sid: mockSid };
}
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
// const db = admin.firestore(); // Needed if looking up user data
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
//     logger.warn("Twilio credentials not found. OTP sending will be mocked/fail.");
// }

// --- Enums ---
enum ErrorCode {
    InvalidArgument = "INVALID_ARGUMENT",
    ThirdPartyServiceError = "THIRD_PARTY_SERVICE_ERROR", // Error from Twilio/SMS provider
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    InvalidPhoneNumber = "INVALID_PHONE_NUMBER",
    OtpSendFailed = "OTP_SEND_FAILED",
    MissingConfiguration = "MISSING_CONFIGURATION", // e.g., Twilio credentials
}

// --- Interfaces ---
interface SendOtpInput {
    phoneNumber: string; // Expecting E.164 format (e.g., +972501234567)
    channel?: 'sms' | 'call'; // Optional, default to 'sms'
}

// --- The Cloud Function ---
export const sendOtp = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "128MiB",
        timeoutSeconds: 30,
        // secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID"], // Add secrets if using Twilio
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[sendOtp V1]";
        const startTimeFunc = Date.now();

        // Note: This function is likely called *before* the user is authenticated (during login/signup)
        // So, request.auth will usually be null.
        const userId = request.auth?.uid ?? null; // Log if available, but don't require
        const data = request.data as SendOtpInput;
        const logContext: any = { userId, phoneNumber: data?.phoneNumber, channel: data?.channel };

        logger.info(`${functionName} Invoked.`, logContext);

        // 1. Input Validation
        if (!data?.phoneNumber || typeof data.phoneNumber !== 'string') {
            logger.error(`${functionName} Invalid input: Missing phoneNumber.`, logContext);
            return { success: false, error: "error.invalidInput.missingPhoneNumber", errorCode: ErrorCode.InvalidArgument };
        }
        // Basic E.164 format check (starts with '+', followed by digits)
        if (!/^\+[1-9]\d{1,14}$/.test(data.phoneNumber)) {
             logger.error(`${functionName} Invalid phone number format. Expected E.164.`, logContext);
             return { success: false, error: "error.invalidInput.invalidPhoneNumberFormat", errorCode: ErrorCode.InvalidPhoneNumber };
        }
        const phoneNumberE164 = data.phoneNumber;
        const channel = data.channel === 'call' ? 'call' : 'sms'; // Default to SMS

        // 2. Check Configuration (e.g., Twilio credentials)
        // if (!twilioClient || !TWILIO_VERIFY_SERVICE_SID) {
        //     logger.error(`${functionName} Twilio configuration missing. Cannot send OTP.`, logContext);
        //     return { success: false, error: "error.config.missingOtpProvider", errorCode: ErrorCode.MissingConfiguration };
        // }

        // 3. Send OTP via Third-Party Service (e.g., Twilio Verify V2)
        try {
            logger.info(`${functionName} Attempting to send OTP via ${channel} to ${phoneNumberE164}...`, logContext);

            // --- Replace with actual Twilio Verify V2 SDK call ---
            // const verification = await twilioClient.verify.v2.services(TWILIO_VERIFY_SERVICE_SID)
            //     .verifications
            //     .create({ to: phoneNumberE164, channel: channel });
            // logger.info(`${functionName} Twilio verification request sent. SID: ${verification.sid}, Status: ${verification.status}`, logContext);
            // if (verification.status !== 'pending') {
            //      // Handle unexpected status from Twilio if needed
            //      throw new Error(`Twilio verification status was not 'pending': ${verification.status}`);
            // }
            // --- End Twilio Call ---

            // --- Using Mock Function ---
            const verificationResult = await sendTwilioVerification(phoneNumberE164, channel);
            if (!verificationResult.success) {
                 // Map Twilio error codes to our internal codes if desired
                 const twilioErrorCode = verificationResult.error?.code;
                 let internalErrorCode = ErrorCode.OtpSendFailed;
                 let errorMessageKey = "error.otp.sendFailed";
                 if (twilioErrorCode === 60200) { // Example: Invalid phone number
                     internalErrorCode = ErrorCode.InvalidPhoneNumber;
                     errorMessageKey = "error.otp.invalidPhoneNumber";
                 } else if (twilioErrorCode === 60203) { // Example: Max attempts
                     internalErrorCode = ErrorCode.OtpSendFailed; // Keep generic or add specific?
                     errorMessageKey = "error.otp.maxAttemptsReached";
                 }
                 logger.error(`${functionName} Failed to send OTP via third-party service.`, { ...logContext, error: verificationResult.error });
                 return { success: false, error: errorMessageKey, errorCode: internalErrorCode };
            }
            // --- End Mock Function Usage ---


            // 4. Log Activity (Optional - might log too much for OTP sends)
            // logUserActivity("SendOtpAttempt", { phoneNumber: phoneNumberE164, channel: channel, success: true }, userId).catch(err => logger.error("Failed logging activity", { err }));

            // 5. Return Success
            // We don't return the SID or verification status to the client usually.
            // The client will proceed to the OTP entry screen.
            logger.info(`${functionName} OTP sent successfully request processed for ${phoneNumberE164}.`, logContext);
            return { success: true };

        } catch (error: any) {
            // Handle unexpected errors during the process
            logger.error(`${functionName} Unexpected error sending OTP.`, { ...logContext, error: error.message });
            // Log failure activity?
            // logUserActivity("SendOtpAttempt", { phoneNumber: phoneNumberE164, channel: channel, success: false, error: error.message }, userId).catch(err => logger.error("Failed logging activity", { err }));
            return { success: false, error: "error.internalServer", errorCode: ErrorCode.InternalError };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
