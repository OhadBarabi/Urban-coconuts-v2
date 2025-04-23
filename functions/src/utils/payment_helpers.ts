/**
 * payment_helpers.ts
 *
 * This module centralizes interactions with the payment gateway provider.
 *
 * IMPORTANT: All functions currently use MOCKS and need to be replaced
 * with actual integrations using the chosen payment provider's SDK/API.
 *
 * Key concepts:
 * - Authorization (Auth): Reserve funds on the customer's card without charging immediately.
 * - Capture: Finalize an authorized transaction, actually charging the customer.
 * - Void: Cancel an authorization *before* it's captured.
 * - Refund: Return funds to the customer *after* a transaction has been captured.
 * - Charge: A direct charge without prior authorization (e.g., for tips).
 * - Payment Method Token: A token representing the customer's payment details (e.g., from Stripe Elements, Google Pay).
 * - Payment Gateway Customer ID: An ID representing the customer within the payment gateway's system, often used for saved cards.
 */

import * as logger from "firebase-functions/logger";
import { Timestamp } from "firebase-admin/firestore";
import { PaymentDetails } from "../models"; // Assuming PaymentDetails model exists

// --- Configuration (Replace with actual secrets/config) ---
// const PAYMENT_GATEWAY_API_KEY = functions.config().payments?.key || process.env.PAYMENT_GATEWAY_SECRET;
const MOCK_GATEWAY_NAME = "MockPaymentProvider";
const MOCK_PROCESSING_DELAY_MS = 1500; // Simulate network/processing time
const MOCK_FAILURE_RATE = 0.05; // 5% chance of simulated failure

// --- Interfaces for Function Results ---

interface AuthorizationResult {
    success: boolean;
    authorizationId?: string | null; // ID from the gateway for this auth
    gatewayName?: string;
    timestamp?: Timestamp;
    errorCode?: string | null; // e.g., 'card_declined', 'insufficient_funds'
    errorMessage?: string | null;
    requiresAction?: boolean; // e.g., 3D Secure needed
    actionUrl?: string | null;
    paymentMethodType?: string; // e.g., 'visa', 'mastercard'
    last4?: string; // Last 4 digits of card
}

interface CaptureResult {
    success: boolean;
    transactionId?: string | null; // ID for the captured transaction
    gatewayName?: string;
    timestamp?: Timestamp;
    errorCode?: string | null;
    errorMessage?: string | null;
    amountCaptured?: number;
}

interface VoidResult {
    success: boolean;
    gatewayName?: string;
    timestamp?: Timestamp;
    errorCode?: string | null;
    errorMessage?: string | null;
}

interface RefundResult {
    success: boolean;
    refundId?: string | null; // ID for the refund transaction
    gatewayName?: string;
    timestamp?: Timestamp;
    errorCode?: string | null;
    errorMessage?: string | null;
    amountRefunded?: number;
}

interface ChargeResult {
    success: boolean;
    transactionId?: string | null; // ID for the charge transaction
    gatewayName?: string;
    timestamp?: Timestamp;
    errorCode?: string | null;
    errorMessage?: string | null;
    amountCharged?: number;
    requiresAction?: boolean;
    actionUrl?: string | null;
    paymentMethodType?: string;
    last4?: string;
}

// --- Mock Helper Function ---
async function simulatePaymentProcess<T extends { success: boolean; gatewayName?: string; timestamp?: Timestamp; errorCode?: string | null; errorMessage?: string | null }>(
    operation: string,
    successResult: Partial<T>,
    failureResult?: Partial<T>
): Promise<T> {
    logger.info(`[Mock Payment Helper] Simulating ${operation}...`);
    await new Promise(res => setTimeout(res, MOCK_PROCESSING_DELAY_MS));

    const isSuccess = Math.random() > MOCK_FAILURE_RATE;
    const now = Timestamp.now();

    if (isSuccess) {
        logger.info(`[Mock Payment Helper] ${operation} simulation SUCCEEDED.`);
        return {
            success: true,
            gatewayName: MOCK_GATEWAY_NAME,
            timestamp: now,
            ...successResult,
        } as T;
    } else {
        logger.warn(`[Mock Payment Helper] ${operation} simulation FAILED.`);
        const errorCodes = ['card_declined', 'insufficient_funds', 'processor_error', 'expired_card', 'suspected_fraud'];
        const randomErrorCode = errorCodes[Math.floor(Math.random() * errorCodes.length)];
        return {
            success: false,
            gatewayName: MOCK_GATEWAY_NAME,
            timestamp: now,
            errorCode: randomErrorCode,
            errorMessage: `Mock Error: ${randomErrorCode}`,
            ...failureResult,
        } as T;
    }
}


// ============================================================================
// === Initiate Authorization =================================================
// ============================================================================
/**
 * Initiates an authorization hold on the customer's payment method.
 * This reserves the funds but does not charge them immediately.
 * Used for initial order placement and rental deposits.
 *
 * TODO: Replace with actual payment provider integration.
 * Needs to handle payment method tokens, customer IDs, amounts, currency,
 * potential 3D Secure challenges, and error handling.
 *
 * @param customerId - Firestore User ID (for logging/reference).
 * @param amountSmallestUnit - Amount to authorize in the smallest currency unit.
 * @param currencyCode - ISO currency code (e.g., "ILS", "USD").
 * @param description - Description for the transaction statement.
 * @param paymentMethodToken - Token representing the payment method (e.g., Stripe token, Google Pay token). Required if paymentGatewayCustomerId is not used or for a new card.
 * @param paymentGatewayCustomerId - ID of the customer in the payment gateway system (for using saved cards).
 * @param orderId - Associated order/booking ID (for reference).
 * @returns Promise<AuthorizationResult> - Result of the authorization attempt.
 */
export async function initiateAuthorization(
    customerId: string,
    amountSmallestUnit: number,
    currencyCode: string,
    description: string,
    paymentMethodToken?: string | null,
    paymentGatewayCustomerId?: string | null,
    orderId?: string
): Promise<AuthorizationResult> {
    const operation = "initiateAuthorization";
    logger.info(`[${operation}] Called`, { customerId, amountSmallestUnit, currencyCode, description, hasToken: !!paymentMethodToken, gatewayCustomerId: paymentGatewayCustomerId, orderId });

    if (!paymentMethodToken && !paymentGatewayCustomerId) {
        logger.error(`[${operation}] Missing payment method token or gateway customer ID.`);
        return { success: false, errorCode: 'missing_payment_method', errorMessage: "Payment method required." };
    }

    // --- MOCK IMPLEMENTATION ---
    const mockAuthId = `AUTH_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const mockLast4 = Math.floor(1000 + Math.random() * 9000).toString();
    const mockCardType = ['visa', 'mastercard'][Math.floor(Math.random() * 2)];

    return simulatePaymentProcess<AuthorizationResult>(operation,
        // Success data
        {
            authorizationId: mockAuthId,
            paymentMethodType: mockCardType,
            last4: mockLast4,
            requiresAction: false, // Simulate no 3DS needed for mock
        },
        // Failure data (optional specific fields for failure)
        {}
    );
    // --- END MOCK ---

    /*
    // --- EXAMPLE REAL IMPLEMENTATION (Conceptual - Stripe) ---
    try {
        // const stripe = require('stripe')(PAYMENT_GATEWAY_API_KEY);
        // const paymentIntentParams: any = {
        //     amount: amountSmallestUnit,
        //     currency: currencyCode.toLowerCase(),
        //     capture_method: 'manual', // IMPORTANT: For authorization only
        //     description: description,
        //     confirm: false, // We might confirm later or handle client-side confirmation
        //     metadata: { customerId, orderId },
        // };
        // if (paymentMethodToken) {
        //     paymentIntentParams.payment_method = paymentMethodToken; // Assumes token is a PaymentMethod ID
        //     paymentIntentParams.confirm = true; // Confirm immediately if using a token directly
        // } else if (paymentGatewayCustomerId) {
        //     paymentIntentParams.customer = paymentGatewayCustomerId;
        //     // Need to specify a saved payment method for the customer or let Stripe choose default
        //     // paymentIntentParams.payment_method = 'pm_xxxx'; // Example saved card
        //     // paymentIntentParams.confirm = true;
        // } else {
        //     throw new Error("Missing payment details");
        // }

        // // If handling confirmation server-side:
        // const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);

        // if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'requires_source_action') {
        //     // Handle 3D Secure
        //     return { success: true, authorizationId: paymentIntent.id, requiresAction: true, actionUrl: paymentIntent.next_action?.redirect_to_url?.url };
        // } else if (paymentIntent.status === 'requires_capture') {
        //     // Authorization successful
        //     const charge = paymentIntent.charges.data[0]; // Get charge details if needed
        //     return { success: true, authorizationId: paymentIntent.id, paymentMethodType: charge?.payment_method_details?.card?.brand, last4: charge?.payment_method_details?.card?.last4 };
        // } else {
        //     // Failed
        //     return { success: false, errorCode: paymentIntent.last_payment_error?.code || 'auth_failed', errorMessage: paymentIntent.last_payment_error?.message || 'Authorization failed' };
        // }
    } catch (error: any) {
        logger.error(`[${operation}] Actual payment gateway error.`, { error: error.message });
        return { success: false, errorCode: error.code || 'gateway_error', errorMessage: error.message };
    }
    // --- END REAL IMPLEMENTATION EXAMPLE ---
    */
}


// ============================================================================
// === Process Payment Capture ================================================
// ============================================================================
/**
 * Captures a previously authorized amount.
 * This actually charges the customer's card for the specified amount (up to the authorized amount).
 * Used when an order is confirmed/shipped or a rental deposit needs to be partially/fully captured.
 *
 * TODO: Replace with actual payment provider integration.
 * Needs the authorization ID from the initial step.
 *
 * @param authorizationId - The ID of the authorization to capture.
 * @param amountToCaptureSmallestUnit - The amount to capture (can be less than or equal to the authorized amount).
 * @param currencyCode - ISO currency code (must match authorization).
 * @returns Promise<CaptureResult> - Result of the capture attempt.
 */
export async function processPaymentCapture(
    authorizationId: string,
    amountToCaptureSmallestUnit: number,
    currencyCode: string
): Promise<CaptureResult> {
    const operation = "processPaymentCapture";
    logger.info(`[${operation}] Called`, { authorizationId, amountToCaptureSmallestUnit, currencyCode });

    // --- MOCK IMPLEMENTATION ---
    const mockTxId = `CAP_${Date.now()}_${authorizationId.substring(5)}`;
    return simulatePaymentProcess<CaptureResult>(operation,
        // Success data
        {
            transactionId: mockTxId,
            amountCaptured: amountToCaptureSmallestUnit,
        },
        // Failure data
        {}
    );
    // --- END MOCK ---

    /*
    // --- EXAMPLE REAL IMPLEMENTATION (Conceptual - Stripe) ---
    try {
        // const stripe = require('stripe')(PAYMENT_GATEWAY_API_KEY);
        // // Stripe uses PaymentIntent ID as the authorizationId
        // const paymentIntent = await stripe.paymentIntents.capture(authorizationId, {
        //     amount_to_capture: amountToCaptureSmallestUnit,
        // });

        // if (paymentIntent.status === 'succeeded') {
        //     const charge = paymentIntent.charges.data[0]; // Get the actual charge object
        //     return { success: true, transactionId: charge?.id, amountCaptured: charge?.amount_captured };
        // } else {
        //     // Handle other statuses if needed (e.g., requires_payment_method)
        //     return { success: false, errorCode: 'capture_failed', errorMessage: `Capture failed with status: ${paymentIntent.status}` };
        // }
    } catch (error: any) {
        logger.error(`[${operation}] Actual payment gateway error.`, { error: error.message });
        // Handle specific Stripe errors (e.g., payment_intent_unexpected_state if already captured/canceled)
        return { success: false, errorCode: error.code || 'gateway_error', errorMessage: error.message };
    }
    // --- END REAL IMPLEMENTATION EXAMPLE ---
    */
}


// ============================================================================
// === Void Authorization =====================================================
// ============================================================================
/**
 * Voids/cancels a previously authorized amount *before* it has been captured.
 * Releases the hold on the customer's funds.
 * Used when an order is cancelled before processing or a rental deposit is fully returned.
 *
 * TODO: Replace with actual payment provider integration.
 * Needs the authorization ID.
 *
 * @param authorizationId - The ID of the authorization to void.
 * @returns Promise<VoidResult> - Result of the void attempt.
 */
export async function voidAuthorization(
    authorizationId: string
): Promise<VoidResult> {
    const operation = "voidAuthorization";
    logger.info(`[${operation}] Called`, { authorizationId });

    // --- MOCK IMPLEMENTATION ---
    return simulatePaymentProcess<VoidResult>(operation,
        // Success data
        {},
        // Failure data
        {}
    );
    // --- END MOCK ---

    /*
    // --- EXAMPLE REAL IMPLEMENTATION (Conceptual - Stripe) ---
    try {
        // const stripe = require('stripe')(PAYMENT_GATEWAY_API_KEY);
        // // Stripe uses PaymentIntent ID as the authorizationId
        // // Use cancel instead of void for PaymentIntents
        // const paymentIntent = await stripe.paymentIntents.cancel(authorizationId, {
        //     cancellation_reason: 'requested_by_customer', // Or other appropriate reason
        // });

        // if (paymentIntent.status === 'canceled') {
        //     return { success: true };
        // } else {
        //     // Handle cases where it might not be possible to cancel (e.g., already captured)
        //     return { success: false, errorCode: 'void_failed', errorMessage: `Could not cancel PaymentIntent, status: ${paymentIntent.status}` };
        // }
    } catch (error: any) {
        logger.error(`[${operation}] Actual payment gateway error.`, { error: error.message });
        // Handle specific Stripe errors (e.g., if already captured)
        return { success: false, errorCode: error.code || 'gateway_error', errorMessage: error.message };
    }
    // --- END REAL IMPLEMENTATION EXAMPLE ---
    */
}


// ============================================================================
// === Process Refund =========================================================
// ============================================================================
/**
 * Processes a refund for a transaction that has already been captured.
 * Used when an order is cancelled *after* payment capture.
 *
 * TODO: Replace with actual payment provider integration.
 * Needs the original transaction ID (from capture) or sometimes the authorization ID.
 * Needs amount and reason.
 *
 * @param transactionId - The ID of the captured transaction to refund.
 * @param amountToRefundSmallestUnit - The amount to refund.
 * @param currencyCode - ISO currency code.
 * @param reason - Reason for the refund (e.g., "customer_request", "product_unavailable").
 * @param orderId - Associated order/booking ID (for reference).
 * @returns Promise<RefundResult> - Result of the refund attempt.
 */
export async function processRefund(
    transactionId: string, // Usually the ID from the *capture*
    amountToRefundSmallestUnit: number,
    currencyCode: string,
    reason?: string | null,
    orderId?: string
): Promise<RefundResult> {
    const operation = "processRefund";
    logger.info(`[${operation}] Called`, { transactionId, amountToRefundSmallestUnit, currencyCode, reason, orderId });

    // --- MOCK IMPLEMENTATION ---
    const mockRefundId = `REF_${Date.now()}_${transactionId.substring(4)}`;
    return simulatePaymentProcess<RefundResult>(operation,
        // Success data
        {
            refundId: mockRefundId,
            amountRefunded: amountToRefundSmallestUnit,
        },
        // Failure data
        {}
    );
    // --- END MOCK ---

    /*
    // --- EXAMPLE REAL IMPLEMENTATION (Conceptual - Stripe) ---
    try {
        // const stripe = require('stripe')(PAYMENT_GATEWAY_API_KEY);
        // // Stripe refunds are created against the *charge* ID
        // const refund = await stripe.refunds.create({
        //     charge: transactionId, // Use the Charge ID from the capture result
        //     amount: amountToRefundSmallestUnit,
        //     reason: reason || undefined, // 'duplicate', 'fraudulent', 'requested_by_customer'
        //     metadata: { orderId },
        // });

        // if (refund.status === 'succeeded' || refund.status === 'pending') { // Pending is also OK
        //     return { success: true, refundId: refund.id, amountRefunded: refund.amount };
        // } else {
        //     return { success: false, errorCode: 'refund_failed', errorMessage: `Refund failed with status: ${refund.status}` };
        // }
    } catch (error: any) {
        logger.error(`[${operation}] Actual payment gateway error.`, { error: error.message });
        // Handle specific Stripe errors (e.g., charge already refunded)
        return { success: false, errorCode: error.code || 'gateway_error', errorMessage: error.message };
    }
    // --- END REAL IMPLEMENTATION EXAMPLE ---
    */
}


// ============================================================================
// === Charge Payment Method ==================================================
// ============================================================================
/**
 * Performs a direct charge (authorize and capture in one step).
 * Used for things like adding a tip after the order is complete.
 *
 * TODO: Replace with actual payment provider integration.
 * Similar requirements to initiateAuthorization regarding payment methods.
 *
 * @param customerId - Firestore User ID.
 * @param amountSmallestUnit - Amount to charge.
 * @param currencyCode - ISO currency code.
 * @param description - Description for the transaction statement.
 * @param paymentMethodToken - Token for the payment method (required if not using saved method).
 * @param paymentGatewayCustomerId - Gateway customer ID (for saved methods).
 * @param orderId - Associated order/booking ID (for reference).
 * @returns Promise<ChargeResult> - Result of the charge attempt.
 */
export async function chargePaymentMethod(
    customerId: string,
    amountSmallestUnit: number,
    currencyCode: string,
    description: string,
    paymentMethodToken?: string | null,
    paymentGatewayCustomerId?: string | null,
    orderId?: string
): Promise<ChargeResult> {
    const operation = "chargePaymentMethod";
    logger.info(`[${operation}] Called`, { customerId, amountSmallestUnit, currencyCode, description, hasToken: !!paymentMethodToken, gatewayCustomerId: paymentGatewayCustomerId, orderId });

    if (!paymentMethodToken && !paymentGatewayCustomerId) {
        logger.error(`[${operation}] Missing payment method token or gateway customer ID.`);
        return { success: false, errorCode: 'missing_payment_method', errorMessage: "Payment method required." };
    }

    // --- MOCK IMPLEMENTATION ---
    const mockTxId = `CHG_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const mockLast4 = Math.floor(1000 + Math.random() * 9000).toString();
    const mockCardType = ['visa', 'mastercard'][Math.floor(Math.random() * 2)];

    return simulatePaymentProcess<ChargeResult>(operation,
        // Success data
        {
            transactionId: mockTxId,
            amountCharged: amountSmallestUnit,
            paymentMethodType: mockCardType,
            last4: mockLast4,
            requiresAction: false,
        },
        // Failure data
        {}
    );
    // --- END MOCK ---

    /*
    // --- EXAMPLE REAL IMPLEMENTATION (Conceptual - Stripe) ---
    try {
        // const stripe = require('stripe')(PAYMENT_GATEWAY_API_KEY);
        // // Use PaymentIntents with capture_method: 'automatic' (default)
        // const paymentIntentParams: any = {
        //     amount: amountSmallestUnit,
        //     currency: currencyCode.toLowerCase(),
        //     description: description,
        //     confirm: true, // Attempt to confirm immediately
        //     metadata: { customerId, orderId },
        //     // Off-session usage might be needed for tips added later
        //     // off_session: true, // Requires setup intent and customer agreement
        // };
        // if (paymentMethodToken) {
        //     paymentIntentParams.payment_method = paymentMethodToken;
        // } else if (paymentGatewayCustomerId) {
        //     paymentIntentParams.customer = paymentGatewayCustomerId;
        //     // Need to specify a saved payment method or default
        //     // paymentIntentParams.payment_method = 'pm_xxxx';
        // } else {
        //     throw new Error("Missing payment details");
        // }

        // const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);

        // if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'requires_source_action') {
        //     // Handle 3D Secure - might be tricky for off-session charges like tips
        //     return { success: true, transactionId: paymentIntent.id, requiresAction: true, actionUrl: paymentIntent.next_action?.redirect_to_url?.url };
        // } else if (paymentIntent.status === 'succeeded') {
        //     const charge = paymentIntent.charges.data[0];
        //     return { success: true, transactionId: charge?.id, amountCharged: charge?.amount, paymentMethodType: charge?.payment_method_details?.card?.brand, last4: charge?.payment_method_details?.card?.last4 };
        // } else {
        //     return { success: false, errorCode: paymentIntent.last_payment_error?.code || 'charge_failed', errorMessage: paymentIntent.last_payment_error?.message || 'Charge failed' };
        // }
    } catch (error: any) {
        logger.error(`[${operation}] Actual payment gateway error.`, { error: error.message });
        return { success: false, errorCode: error.code || 'gateway_error', errorMessage: error.message };
    }
    // --- END REAL IMPLEMENTATION EXAMPLE ---
    */
}


// ============================================================================
// === Finalize Authorization (Optional/Advanced) =============================
// ============================================================================
/**
 * Handles the result after a customer completes an action (like 3D Secure).
 * This might be needed if initiateAuthorization or chargePaymentMethod return requiresAction: true.
 * Often handled client-side, but can be done server-side.
 *
 * TODO: Replace with actual payment provider integration if needed.
 * Needs the authorization/payment intent ID.
 *
 * @param authorizationId - The ID of the authorization/payment intent that required action.
 * @returns Promise<AuthorizationResult | ChargeResult> - The final result after the action.
 */
export async function finalizeAuthorization(
    authorizationId: string
): Promise<AuthorizationResult | ChargeResult> {
     const operation = "finalizeAuthorization";
     logger.info(`[${operation}] Called`, { authorizationId });

     // --- MOCK IMPLEMENTATION ---
     // Simulate retrieving the final status after action
     logger.info(`[Mock Payment Helper] Simulating finalizeAuthorization for ${authorizationId}...`);
     await new Promise(res => setTimeout(res, 500)); // Short delay

     // Randomly decide if the action succeeded or failed
     const isSuccess = Math.random() > 0.1; // Higher success rate after action

     if (isSuccess) {
         logger.info(`[Mock Payment Helper] Finalization simulation SUCCEEDED for ${authorizationId}.`);
         // Return a result similar to a successful initial call, but maybe mark as finalized
         const mockLast4 = Math.floor(1000 + Math.random() * 9000).toString();
         const mockCardType = ['visa', 'mastercard'][Math.floor(Math.random() * 2)];
         // Determine if it was an auth or charge based on ID prefix? Hacky for mock.
         if (authorizationId.startsWith('AUTH_')) {
             return {
                 success: true,
                 authorizationId: authorizationId,
                 gatewayName: MOCK_GATEWAY_NAME,
                 timestamp: Timestamp.now(),
                 requiresAction: false, // Action completed
                 paymentMethodType: mockCardType,
                 last4: mockLast4,
             };
         } else { // Assume charge
             return {
                 success: true,
                 transactionId: authorizationId, // Use same ID for simplicity in mock
                 gatewayName: MOCK_GATEWAY_NAME,
                 timestamp: Timestamp.now(),
                 requiresAction: false, // Action completed
                 paymentMethodType: mockCardType,
                 last4: mockLast4,
                 amountCharged: 1000, // Placeholder amount
             };
         }
     } else {
         logger.warn(`[Mock Payment Helper] Finalization simulation FAILED for ${authorizationId}.`);
         return {
             success: false,
             gatewayName: MOCK_GATEWAY_NAME,
             timestamp: Timestamp.now(),
             errorCode: 'action_failed',
             errorMessage: 'Mock Error: Customer failed authentication/action.',
             requiresAction: false, // Action attempted but failed
         };
     }
     // --- END MOCK ---

     /*
     // --- EXAMPLE REAL IMPLEMENTATION (Conceptual - Stripe) ---
     try {
         // const stripe = require('stripe')(PAYMENT_GATEWAY_API_KEY);
         // // Retrieve the PaymentIntent to check its final status
         // const paymentIntent = await stripe.paymentIntents.retrieve(authorizationId);

         // // Check status after client-side action
         // if (paymentIntent.status === 'succeeded') { // For charge
         //     const charge = paymentIntent.charges.data[0];
         //     return { success: true, transactionId: charge?.id, amountCharged: charge?.amount, ... };
         // } else if (paymentIntent.status === 'requires_capture') { // For auth
         //     const charge = paymentIntent.charges.data[0];
         //     return { success: true, authorizationId: paymentIntent.id, ... };
         // } else {
         //     // Failed after action
         //     return { success: false, errorCode: paymentIntent.last_payment_error?.code || 'finalize_failed', errorMessage: paymentIntent.last_payment_error?.message || 'Finalization failed' };
         // }
     } catch (error: any) {
         logger.error(`[${operation}] Actual payment gateway error.`, { error: error.message });
         return { success: false, errorCode: error.code || 'gateway_error', errorMessage: error.message };
     }
     // --- END REAL IMPLEMENTATION EXAMPLE ---
     */
}

// --- Helper to extract PaymentDetails from results ---
// This can be used to store consistent payment info in Firestore orders/bookings
export function extractPaymentDetailsFromResult(
    result: AuthorizationResult | CaptureResult | ChargeResult | RefundResult
): PaymentDetails | null {
    if (!result.success) return null;

    const details: PaymentDetails = {
        gatewayName: result.gatewayName,
        timestamp: result.timestamp,
    };

    if ('authorizationId' in result && result.authorizationId) details.authorizationId = result.authorizationId;
    if ('transactionId' in result && result.transactionId) details.transactionId = result.transactionId;
    if ('refundId' in result && result.refundId) details.refundId = result.refundId;
    if ('amountCaptured' in result && result.amountCaptured) details.chargeAmountSmallestUnit = result.amountCaptured;
    if ('amountCharged' in result && result.amountCharged) details.chargeAmountSmallestUnit = result.amountCharged;
    if ('amountRefunded' in result && result.amountRefunded) details.refundAmountSmallestUnit = result.amountRefunded;
    if ('paymentMethodType' in result && result.paymentMethodType) details.paymentMethodType = result.paymentMethodType;
    if ('last4' in result && result.last4) details.paymentMethodLast4 = result.last4;
    // We might need separate fields for auth/capture/charge/refund details in the model
    // For now, this is a basic extraction.

    return details;
}
