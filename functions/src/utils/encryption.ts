/**
 * encryption.ts
 *
 * Helper module for handling encryption and decryption tasks using Google Cloud KMS.
 * Focuses on MFA secrets.
 *
 * Prerequisites:
 * 1. Enable Cloud KMS API in your Google Cloud project.
 * 2. Create a Key Ring in KMS (e.g., 'Urban-coconuts-keys').
 * 3. Create a CryptoKey within the Key Ring with purpose 'Symmetric encrypt/decrypt' (e.g., 'mfa-secret-key').
 * 4. Grant the Cloud Functions service account (e.g., 'urbancoconuts-v2@appspot.gserviceaccount.com')
 * the 'Cloud KMS CryptoKey Encrypter/Decrypter' role on the created CryptoKey or Key Ring.
 * 5. Install the KMS client library: `npm install @google-cloud/kms`
 * 6. Ensure KMS configuration below matches your setup or use environment variables.
 */

import * as functions from "firebase-functions/v2"; // Needed for logger if used outside functions
import * as logger from "firebase-functions/logger";
import { KeyManagementServiceClient } from '@google-cloud/kms'; // Import KMS client

// --- Configuration ---
// Uses details provided by the user, but ideally use environment variables for deployment.
// Example using environment variables (set these in your Cloud Functions deployment)
const KMS_PROJECT_ID = process.env.GCLOUD_PROJECT || 'urbancoconuts-v2'; // Default to GCP project if available
const KMS_LOCATION_ID = process.env.KMS_LOCATION_ID || 'global'; // User specified 'global'
const KMS_KEY_RING_ID = process.env.KMS_KEY_RING_ID || 'Urban-coconuts-keys'; // User specified 'Urban-coconuts-keys'
const KMS_CRYPTO_KEY_ID = process.env.KMS_CRYPTO_KEY_ID || 'mfa-secret-key'; // User specified 'mfa-secret-key'

// --- Initialize KMS Client ---
let kmsClient: KeyManagementServiceClient | null = null;
let keyName = '';

try {
    // Validate configuration before initializing client
    if (!KMS_PROJECT_ID || !KMS_LOCATION_ID || !KMS_KEY_RING_ID || !KMS_CRYPTO_KEY_ID) {
        logger.error("KMS Configuration is incomplete. Check environment variables or constants in encryption.ts.");
        // Optionally throw an error to prevent function deployment/initialization if config is missing
        // throw new Error("KMS Configuration incomplete.");
    } else {
        kmsClient = new KeyManagementServiceClient();
        keyName = kmsClient.cryptoKeyPath(
            KMS_PROJECT_ID,
            KMS_LOCATION_ID,
            KMS_KEY_RING_ID,
            KMS_CRYPTO_KEY_ID
        );
        logger.info(`KMS Client initialized for key: ${keyName}`);
    }
} catch (error: any) {
    logger.error("Failed to initialize KMS Client.", { error: error.message, keyName });
    kmsClient = null; // Ensure client is null if initialization fails
}


// --- Interfaces ---
interface EncryptionResult {
    success: boolean;
    encryptedData?: string; // Base64 encoded encrypted data
    error?: string;
}

interface DecryptionResult {
    success: boolean;
    decryptedData?: string; // Plaintext data
    error?: string;
}

// ============================================================================
// === Encrypt MFA Secret =====================================================
// ============================================================================
/**
 * Encrypts the provided MFA secret using Google Cloud KMS.
 *
 * @param plaintextSecret - The plaintext MFA secret (usually base32 encoded).
 * @param userId - The user ID associated with the secret (used as Additional Authenticated Data (AAD)).
 * @returns Promise<EncryptionResult>
 */
export async function encryptMfaSecret(plaintextSecret: string, userId: string): Promise<EncryptionResult> {
    const operation = "encryptMfaSecret (KMS)";
    logger.info(`[${operation}] Called for user ${userId}. Length: ${plaintextSecret.length}`);

    if (!kmsClient || !keyName) {
        logger.error(`[${operation}] KMS client not initialized or keyName is invalid. Check configuration and initialization logs.`);
        return { success: false, error: "KMS client not initialized." };
    }
    if (!plaintextSecret) {
        logger.error(`[${operation}] Plaintext secret is empty or null for user ${userId}.`);
        return { success: false, error: "Plaintext secret cannot be empty." };
    }
     if (!userId) {
         logger.error(`[${operation}] User ID (AAD) is empty or null.`);
         return { success: false, error: "User ID (AAD) cannot be empty." };
     }


    try {
        const [result] = await kmsClient.encrypt({
            name: keyName,
            plaintext: Buffer.from(plaintextSecret, 'utf-8'), // Ensure consistent encoding
            // Use userId as Additional Authenticated Data (AAD) for context binding.
            // This ensures the ciphertext can only be decrypted with the same userId.
            additionalAuthenticatedData: Buffer.from(userId, 'utf-8'),
        });

        if (!result.ciphertext) {
            // This case should ideally not happen if the API call succeeds without error
            logger.error(`[${operation}] KMS encryption returned no ciphertext for user ${userId}.`);
            throw new Error("KMS encryption returned no ciphertext.");
        }

        // The ciphertext is returned as a Buffer. Encode it to Base64 for storage.
        const encryptedData = Buffer.from(result.ciphertext).toString('base64');
        logger.info(`[${operation}] Secret encrypted successfully for user ${userId}.`);
        return { success: true, encryptedData };

    } catch (error: any) {
        logger.error(`[${operation}] Cloud KMS encryption failed for user ${userId}. Check KMS key permissions for service account.`, { error: error.message, code: error.code, keyName });
        // Avoid leaking detailed KMS errors to the client if possible
        return { success: false, error: "KMS encryption failed." };
    }
}

// ============================================================================
// === Decrypt MFA Secret =====================================================
// ============================================================================
/**
 * Decrypts the provided encrypted MFA secret using Google Cloud KMS.
 *
 * @param encryptedSecretBase64 - The Base64 encoded encrypted MFA secret stored in Firestore.
 * @param userId - The user ID associated with the secret (must match the AAD used during encryption).
 * @returns Promise<DecryptionResult>
 */
export async function decryptMfaSecret(encryptedSecretBase64: string, userId: string): Promise<DecryptionResult> {
    const operation = "decryptMfaSecret (KMS)";
    logger.info(`[${operation}] Called for user ${userId}.`);

     if (!kmsClient || !keyName) {
         logger.error(`[${operation}] KMS client not initialized or keyName is invalid. Check configuration and initialization logs.`);
         return { success: false, error: "KMS client not initialized." };
     }
     if (!encryptedSecretBase64) {
         logger.error(`[${operation}] Encrypted secret is empty or null for user ${userId}.`);
         return { success: false, error: "Encrypted secret cannot be empty." };
     }
      if (!userId) {
          logger.error(`[${operation}] User ID (AAD) is empty or null.`);
          return { success: false, error: "User ID (AAD) cannot be empty." };
      }

    try {
        const [result] = await kmsClient.decrypt({
            name: keyName,
            ciphertext: Buffer.from(encryptedSecretBase64, 'base64'),
            // Provide the *exact same* AAD (userId) used during encryption.
            // If this doesn't match, KMS will return an error.
            additionalAuthenticatedData: Buffer.from(userId, 'utf-8'),
        });

        if (!result.plaintext) {
            // This might happen if decryption fails validation (e.g., AAD mismatch)
            logger.error(`[${operation}] KMS decryption returned no plaintext for user ${userId}. Possible AAD mismatch or corrupted data?`);
            throw new Error("KMS decryption returned no plaintext.");
        }

        // Convert the plaintext Buffer back to a string.
        const decryptedData = Buffer.from(result.plaintext).toString('utf-8');
        logger.info(`[${operation}] Secret decrypted successfully for user ${userId}.`);
        return { success: true, decryptedData };

    } catch (error: any) {
        // Handle potential errors like invalid ciphertext, AAD mismatch, permission issues
        logger.error(`[${operation}] Cloud KMS decryption failed for user ${userId}. Check KMS key permissions and AAD.`, { error: error.message, code: error.code, keyName });
        // Avoid leaking detailed error messages that could help attackers
        return { success: false, error: "KMS decryption failed or invalid secret." };
    }
}

// Add other encryption/decryption functions as needed
