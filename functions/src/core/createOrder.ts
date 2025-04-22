import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { v4 as uuidv4 } from 'uuid'; // For unique IDs

// --- Import Models (assuming models are exported from index.ts) ---
import {
    User, Box, Product, Order, OrderItem, OrderStatus, PaymentMethod, PaymentStatus, PaymentDetails,
    PromoCode, AppConfigGeneral, AppConfigTipSettings // Add other needed models/enums
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { initiateAuthorization, voidAuthorization } from '../utils/payment_helpers'; // Payment gateway interaction
// import { calculateOrderTotal, applyCoupon, applyUcCoins } from '../utils/order_calculations';
// import { sendPushNotification } from '../utils/notifications';
// import { logUserActivity } from '../utils/logging';
// import { fetchActivePromoCode, fetchGeneralSettings, fetchTipSettings } from '../config/config_helpers';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, permissionId: string): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId}`); return userId != null; }
interface AuthResult { success: boolean; gatewayTransactionId?: string; error?: string; }
async function initiateAuthorization(amountSmallestUnit: number, currencyCode: string, customerId: string, paymentMethod: string, boxId: string): Promise<AuthResult> { logger.info(`[Mock Payment] Authorizing ${amountSmallestUnit} ${currencyCode} for user ${customerId} via ${paymentMethod} for box ${boxId}`); await new Promise(res => setTimeout(res, 1000)); if (Math.random() < 0.05) { logger.error("[Mock Payment] Auth FAILED."); return { success: false, error: "Mock Auth Declined" }; } return { success: true, gatewayTransactionId: `AUTH_${Date.now()}` }; }
async function voidAuthorization(gatewayTransactionId: string): Promise<{ success: boolean; error?: string }> { logger.info(`[Mock Payment] Voiding Auth ${gatewayTransactionId}`); await new Promise(res => setTimeout(res, 500)); if (gatewayTransactionId.includes("fail_void")) { logger.error("[Mock Payment] Void FAILED."); return { success: false, error: "Mock Void Failed" }; } return { success: true }; }
interface CalculationResult { totalAmount: number; itemsTotal: number; couponDiscount: number; ucCoinDiscount: number; finalAmount: number; error?: string; }
function calculateOrderTotal(items: Array<{ productId: string; quantity: number; unitPrice: number }>, coupon?: PromoCode | null, ucCoinsToUse?: number | null, userCoinBalance?: number, tipAmount?: number): CalculationResult { logger.info(`[Mock Calc] Calculating total...`); const itemsTotal = items.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0); const couponDiscount = coupon ? 500 : 0; const ucCoinDiscount = Math.min(ucCoinsToUse ?? 0, userCoinBalance ?? 0); const finalAmount = itemsTotal - couponDiscount - ucCoinDiscount + (tipAmount ?? 0); return { totalAmount: itemsTotal, itemsTotal, couponDiscount, ucCoinDiscount, finalAmount }; }
async function sendPushNotification(params: any): Promise<void> { logger.info(`[Mock Notification] Sending notification`, params); }
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
async function fetchActivePromoCode(code: string): Promise<PromoCode | null> { logger.info(`[Mock Config] Fetching promo code ${code}`); if (code === 'INVALID') return null; return { couponCode: code, discountDetails: { type: 'fixedAmount', fixedAmountSmallestUnit: 500 }, isActive: true, currentTotalUses: 0, maxTotalUses: 100 }; }
async function fetchGeneralSettings(): Promise<AppConfigGeneral | null> { logger.info(`[Mock Config] Fetching general settings`); return { defaultCurrencyCode: 'ILS' }; }
async function fetchTipSettings(): Promise<AppConfigTipSettings | null> { logger.info(`[Mock Config] Fetching tip settings`); return { tipEnabled: true }; }
// --- End Mocks ---

// --- Configuration ---
// if (admin.apps.length === 0) { admin.initializeApp(); } // Initialize only once
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Box, Product, User, Coupon not found
    ResourceExhausted = "RESOURCE_EXHAUSTED", // Inventory unavailable
    FailedPrecondition = "FAILED_PRECONDITION", // Box inactive, Coupon invalid, etc.
    Aborted = "ABORTED", // Transaction failed or Payment Auth failed
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    BoxNotFound = "BOX_NOT_FOUND", BoxInactive = "BOX_INACTIVE",
    ProductNotFound = "PRODUCT_NOT_FOUND", ProductInactive = "PRODUCT_INACTIVE",
    InventoryUnavailable = "INVENTORY_UNAVAILABLE",
    UserNotFound = "USER_NOT_FOUND", InsufficientUcCoins = "INSUFFICIENT_UC_COINS",
    CouponNotFound = "COUPON_NOT_FOUND", CouponInvalid = "COUPON_INVALID", CouponExpired = "COUPON_EXPIRED", CouponLimitReached = "COUPON_LIMIT_REACHED",
    PaymentAuthFailed = "PAYMENT_AUTH_FAILED", PaymentVoidFailed = "PAYMENT_VOID_FAILED",
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- Interfaces ---
interface CartItemInput { productId: string; quantity: number; } // quantity > 0 integer
interface CartDataInput { boxId: string; items: CartItemInput[]; notes?: string | null; }
interface CreateOrderInput {
    cartData: CartDataInput;
    paymentMethod: PaymentMethod | string;
    couponCode?: string | null;
    ucCoinsToUse?: number | null; // >= 0 integer
    // tipAmountSmallestUnit?: number | null; // Tip added later
}

// --- The Cloud Function ---
export const createOrder = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "512MiB", // Allow more memory for multiple reads/writes/transaction
        timeoutSeconds: 60,
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // Add secrets needed for payment helpers
    },
    async (request): Promise<{ success: true; orderId: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createOrder V2]";
        const startTime = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) {
            logger.warn(`${functionName} Authentication failed: No UID.`);
            return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated };
        }
        const customerId = request.auth.uid;
        const data = request.data as CreateOrderInput;
        const logContext: any = { customerId, boxId: data?.cartData?.boxId, itemCount: data?.cartData?.items?.length, paymentMethod: data?.paymentMethod };

        logger.info(`${functionName} Invoked.`, logContext);

        // Basic Permission Check (Customer creating their own order)
        const hasPermission = await checkPermission(customerId, 'order:create');
        if (!hasPermission) {
            logger.warn(`${functionName} Permission denied for user ${customerId}.`, logContext);
            return { success: false, error: "error.permissionDenied.createOrder", errorCode: ErrorCode.PermissionDenied };
        }

        // 2. Input Validation
        if (!data?.cartData?.boxId || !Array.isArray(data.cartData.items) || data.cartData.items.length === 0 ||
            !data.paymentMethod || !Object.values(PaymentMethod).includes(data.paymentMethod as PaymentMethod) ||
            data.cartData.items.some(item => !item.productId || typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0) ||
            (data.ucCoinsToUse != null && (typeof data.ucCoinsToUse !== 'number' || !Number.isInteger(data.ucCoinsToUse) || data.ucCoinsToUse < 0))
           )
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { cartData, paymentMethod, couponCode, ucCoinsToUse } = data;
        const { boxId, items: cartItems, notes } = cartData;
        logContext.couponCode = couponCode;
        logContext.ucCoinsToUse = ucCoinsToUse;

        // --- Variables ---
        let boxData: Box;
        let userData: User;
        let fetchedProducts = new Map<string, Product>();
        let activeCoupon: PromoCode | null = null;
        let orderItems: OrderItem[] = [];
        let calculationResult: CalculationResult;
        let authResult: AuthResult | null = null; // For app payments
        let finalPaymentStatus: PaymentStatus;
        let orderStatus: OrderStatus = OrderStatus.Red; // Default initial status
        const requiresAuth = paymentMethod === PaymentMethod.CreditCardApp || paymentMethod === PaymentMethod.BitApp;

        try {
            // 3. Pre-Transaction Data Fetching & Validation (Concurrent)
            logger.info(`${functionName} Fetching initial data...`, logContext);
            const boxRef = db.collection('boxes').doc(boxId);
            const userRef = db.collection('users').doc(customerId);
            const productIds = [...new Set(cartItems.map(item => item.productId))]; // Unique product IDs
            const productRefs = productIds.map(id => db.collection('products').doc(id));
            const couponPromise = couponCode ? fetchActivePromoCode(couponCode) : Promise.resolve(null);
            // Fetch settings concurrently if needed for validation/calculation (e.g., currency support)
            // const settingsPromise = fetchGeneralSettings();

            const [boxSnap, userSnap, productDocs, fetchedCoupon] = await Promise.all([
                boxRef.get(),
                userRef.get(),
                productRefs.length > 0 ? db.getAll(...productRefs) : Promise.resolve([]),
                couponPromise,
                // settingsPromise
            ]);

            // Validate Box
            if (!boxSnap.exists) throw new HttpsError('not-found', `error.box.notFound::${boxId}`, { errorCode: ErrorCode.BoxNotFound });
            boxData = boxSnap.data() as Box;
            if (!boxData.isActive || !boxData.isCustomerVisible) throw new HttpsError('failed-precondition', `error.box.inactive::${boxId}`, { errorCode: ErrorCode.BoxInactive });
            const currencyCode = boxData.currencyCode; // Get currency from box
            logContext.currencyCode = currencyCode;

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });

            // Validate Products & Prepare Order Items
            productDocs.forEach(doc => {
                if (doc.exists) {
                    const product = doc.data() as Product;
                    if (product.isActive) {
                        fetchedProducts.set(doc.id, product);
                    } else {
                        logger.warn(`${functionName} Product ${doc.id} is inactive.`, logContext);
                        // Throw error immediately if an inactive product is ordered
                        throw new HttpsError('failed-precondition', `error.product.inactive::${doc.id}`, { errorCode: ErrorCode.ProductInactive });
                    }
                } else {
                     // Throw error immediately if a product ID doesn't exist
                     throw new HttpsError('not-found', `error.product.notFound::${doc.id}`, { errorCode: ErrorCode.ProductNotFound });
                }
            });

            // Validate Coupon (if provided)
            if (couponCode && !fetchedCoupon) {
                 throw new HttpsError('not-found', `error.coupon.notFound::${couponCode}`, { errorCode: ErrorCode.CouponNotFound });
            }
            activeCoupon = fetchedCoupon; // Can be null

            // Validate UC Coins
            if (ucCoinsToUse && ucCoinsToUse > (userData.ucCoinBalance ?? 0)) {
                throw new HttpsError('failed-precondition', "error.user.insufficientUcCoins", { errorCode: ErrorCode.InsufficientUcCoins });
            }

            // Build orderItems array with price snapshots
            orderItems = cartItems.map(cartItem => {
                const product = fetchedProducts.get(cartItem.productId);
                if (!product) throw new HttpsError('internal', `Internal error: Product ${cartItem.productId} not found in fetched map.`); // Should not happen
                return {
                    orderItemId: uuidv4(), // Generate unique ID for this line item
                    productId: cartItem.productId,
                    productName: product.productName_i18n?.['en'] ?? 'Unknown Product', // Snapshot name (use user lang pref?)
                    quantity: cartItem.quantity,
                    unitPrice: product.priceSmallestUnit, // Snapshot price
                    // itemStatus: 'Pending' // Initial status for item?
                };
            });

            // Calculate Totals (using helper function)
            calculationResult = calculateOrderTotal(orderItems, activeCoupon, ucCoinsToUse, userData.ucCoinBalance);
            if (calculationResult.error) { // Handle calculation errors if helper returns them
                throw new HttpsError('internal', `error.internal.calculation::${calculationResult.error}`, { errorCode: ErrorCode.CalculationError });
            }
            const { finalAmount } = calculationResult;
            logContext.finalAmount = finalAmount;
            logger.info(`${functionName} Calculated final amount: ${finalAmount} ${currencyCode}`, logContext);


            // 4. Payment Authorization (if required)
            if (requiresAuth && finalAmount > 0) {
                logger.info(`${functionName} Initiating payment authorization...`, logContext);
                authResult = await initiateAuthorization(finalAmount, currencyCode, customerId, paymentMethod, boxId);
                if (!authResult.success || !authResult.gatewayTransactionId) {
                    logger.error(`${functionName} Payment authorization failed.`, { ...logContext, error: authResult.error });
                    throw new HttpsError('aborted', `error.payment.authFailed::${authResult.error || 'Unknown'}`, { errorCode: ErrorCode.PaymentAuthFailed });
                }
                logger.info(`${functionName} Payment authorization successful. TxID: ${authResult.gatewayTransactionId}`, logContext);
                finalPaymentStatus = PaymentStatus.Authorized;
            } else if (paymentMethod === PaymentMethod.CashOnDelivery || paymentMethod === PaymentMethod.CreditOnDelivery) {
                finalPaymentStatus = PaymentStatus.PendingCourier;
                orderStatus = OrderStatus.Yellow; // Move directly to Yellow if payment is on delivery? Or keep Red? Let's keep Red for now.
            } else if (paymentMethod === PaymentMethod.UC_Coins_Only) {
                if (finalAmount > 0) throw new HttpsError('invalid-argument', "error.payment.ucCoinsOnlyMismatch"); // Cannot use UC_Coins_Only if finalAmount > 0
                finalPaymentStatus = PaymentStatus.Paid; // Consider it paid if 0 amount and UC only
                orderStatus = OrderStatus.Yellow; // Move to Yellow if fully paid by UC
            } else { // Includes finalAmount === 0 case
                finalPaymentStatus = PaymentStatus.Paid; // Consider 0 amount as Paid
                orderStatus = OrderStatus.Yellow; // Move to Yellow if no payment needed
            }


            // 5. Firestore Transaction
            logger.info(`${functionName} Starting Firestore transaction...`, logContext);
            const newOrderId = db.collection('orders').doc().id; // Generate new order ID
            const orderRef = db.collection('orders').doc(newOrderId);
            const now = Timestamp.now();

            await db.runTransaction(async (transaction) => {
                // Read data within transaction for consistency checks
                const boxTxSnap = await transaction.get(boxRef);
                const userTxSnap = await transaction.get(userRef);
                const productTxSnaps = await Promise.all(productRefs.map(ref => transaction.get(ref)));

                if (!boxTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}`);
                const boxTxData = boxTxSnap.data() as Box;
                if (!boxTxData.isActive || !boxTxData.isCustomerVisible) throw new Error(`TX_ERR::${ErrorCode.BoxInactive}`);

                if (!userTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.UserNotFound}`);
                const userTxData = userTxSnap.data() as User;
                if (ucCoinsToUse && ucCoinsToUse > (userTxData.ucCoinBalance ?? 0)) throw new Error(`TX_ERR::${ErrorCode.InsufficientUcCoins}`);

                // Check inventory within transaction
                const inventoryUpdates: { [key: string]: admin.firestore.FieldValue } = {};
                for (let i = 0; i < cartItems.length; i++) {
                    const item = cartItems[i];
                    const productSnap = productTxSnaps[i];
                    if (!productSnap.exists) throw new Error(`TX_ERR::${ErrorCode.ProductNotFound}::${item.productId}`);
                    const productTxData = productSnap.data() as Product;
                    if (!productTxData.isActive) throw new Error(`TX_ERR::${ErrorCode.ProductInactive}::${item.productId}`);

                    const currentStock = boxTxData.inventory?.[item.productId] ?? 0;
                    if (currentStock < item.quantity) {
                        logger.warn(`${functionName} Insufficient inventory for product ${item.productId} in box ${boxId}. Available: ${currentStock}, Requested: ${item.quantity}`, logContext);
                        throw new Error(`TX_ERR::${ErrorCode.InventoryUnavailable}::${item.productId}`);
                    }
                    inventoryUpdates[`inventory.${item.productId}`] = FieldValue.increment(-item.quantity);
                }

                // Check coupon usage within transaction (if applicable)
                let couponUpdateRef: admin.firestore.DocumentReference | null = null;
                let couponUpdateData: any = null;
                if (activeCoupon?.couponCode) {
                    couponUpdateRef = db.collection('promoCodes').doc(activeCoupon.couponCode); // Assuming code is ID
                    const couponTxSnap = await transaction.get(couponUpdateRef);
                    if (!couponTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.CouponNotFound}::${couponCode}`);
                    const couponTxData = couponTxSnap.data() as PromoCode;
                    if (!couponTxData.isActive ||
                        (couponTxData.validUntil && couponTxData.validUntil < now) ||
                        (couponTxData.maxTotalUses != null && (couponTxData.currentTotalUses ?? 0) >= couponTxData.maxTotalUses))
                    {
                        throw new Error(`TX_ERR::${ErrorCode.CouponInvalid}::${couponCode}`);
                    }
                    // Prepare coupon usage increment
                    couponUpdateData = { currentTotalUses: FieldValue.increment(1) };
                    // TODO: Add per-user usage tracking if needed (requires reading/writing a user-specific subcollection or map)
                }

                // Prepare Order Document Data
                const newOrderData: Order = {
                    orderNumber: newOrderId.substring(0, 8).toUpperCase(), // Example order number
                    customerId: customerId,
                    boxId: boxId,
                    items: orderItems,
                    status: orderStatus, // Initial status (Red or Yellow)
                    statusHistory: [{ status: orderStatus, timestamp: now, userId: customerId }],
                    paymentMethod: paymentMethod,
                    paymentStatus: finalPaymentStatus, // Authorized or PendingCourier or Paid (if 0/UC)
                    currencyCode: currencyCode,
                    authDetails: authResult?.success ? { // Store auth details if successful
                        gatewayTransactionId: authResult.gatewayTransactionId,
                        authAmountSmallestUnit: finalAmount,
                        authTimestamp: now,
                        authSuccess: true,
                        currencyCode: currencyCode,
                        // gatewayName: 'MockGateway' // Add gateway name if known
                    } : null,
                    paymentDetails: null, // Final payment details updated later
                    totalAmount: calculationResult.itemsTotal,
                    ucCoinsUsed: ucCoinsToUse ?? null,
                    couponCodeUsed: activeCoupon?.couponCode ?? null,
                    couponDiscountValue: calculationResult.couponDiscount,
                    tipAmountSmallestUnit: null, // Tip added later
                    finalAmount: calculationResult.finalAmount,
                    orderTimestamp: now,
                    // deliveredTimestamp: null, // Set on delivery
                    // pickupTimeWindow: null, // Set later? Or based on order time?
                    notes: notes ?? null,
                    // issueReported: false,
                    // issueDetails: null,
                    // orderQrCodeData: `ORDER:${newOrderId}`, // Example QR data
                    // cancellationSideEffectsProcessed: false,
                    createdAt: now,
                    updatedAt: now, // Set initial updatedAt
                };

                // --- Perform Writes ---
                // 1. Create Order
                transaction.set(orderRef, newOrderData);
                // 2. Update Box Inventory
                transaction.update(boxRef, inventoryUpdates);
                // 3. Update User UC Coin Balance (if used)
                if (ucCoinsToUse && ucCoinsToUse > 0) {
                    transaction.update(userRef, { ucCoinBalance: FieldValue.increment(-ucCoinsToUse) });
                }
                // 4. Update Coupon Usage (if used)
                if (couponUpdateRef && couponUpdateData) {
                    transaction.update(couponUpdateRef, couponUpdateData);
                }

            }); // End Firestore Transaction

            logger.info(`${functionName} Firestore transaction successful for order ${newOrderId}.`, logContext);

            // 6. Trigger Notifications (Async)
            const notificationPromises: Promise<void>[] = [];
            // Notify customer
            notificationPromises.push(sendPushNotification({
                userId: customerId, type: "OrderCreated", titleKey: "notification.orderCreated.title",
                messageKey: "notification.orderCreated.message", messageParams: { orderId: newOrderId.substring(0, 8) },
                payload: { orderId: newOrderId, screen: 'ActiveOrder' }
            }).catch(err => logger.error("Failed sending customer notification", { err })));
            // Notify courier assigned to the box
            if (boxData.assignedCourierId) {
                 notificationPromises.push(sendPushNotification({
                     userId: boxData.assignedCourierId, type: "NewOrderInBox", titleKey: "notification.newOrder.title",
                     messageKey: "notification.newOrder.message", messageParams: { orderId: newOrderId.substring(0, 8), boxNumber: boxData.boxNumber },
                     payload: { orderId: newOrderId, boxId: boxId, screen: 'OrderDetails' }
                 }).catch(err => logger.error("Failed sending courier notification", { err })));
            }
            // Don't await notifications for faster response

            // 7. Log User Activity (Async)
            logUserActivity("CreateOrder", { orderId: newOrderId, boxId, itemCount: cartItems.length, finalAmount, paymentMethod }, customerId)
                .catch(err => logger.error("Failed logging user activity", { err }));

            // 8. Return Success
            return { success: true, orderId: newOrderId };

        } catch (error: any) {
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });

            // --- Error Handling & Cleanup ---
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.order.creationFailed";

            // Handle specific errors thrown by HttpsError or Transaction
            if (error instanceof HttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.order.${finalErrorCode.toLowerCase()}`;
                 // Append details like ID if present
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            } else if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`; // Append detail (e.g., productId)
            }

            // Attempt to void authorization if it succeeded but transaction failed
            if (authResult?.success && authResult.gatewayTransactionId) {
                logger.warn(`${functionName} Transaction failed after successful auth. Attempting to void authorization ${authResult.gatewayTransactionId}...`, logContext);
                try {
                    const voidResult = await voidAuthorization(authResult.gatewayTransactionId);
                    if (!voidResult.success) {
                        logger.error(`${functionName} CRITICAL: Failed to void authorization ${authResult.gatewayTransactionId} after transaction failure. Manual void required.`, { ...logContext, voidError: voidResult.error });
                        // Alert Admin!
                        sendPushNotification({ subject: `Payment Void FAILED - Order Attempt ${logContext.boxId}`, body: `Failed to void auth ${authResult.gatewayTransactionId} for failed order creation attempt. Manual void REQUIRED.`, severity: "critical" }).catch(...);
                        // Update error code/message?
                        finalErrorCode = ErrorCode.PaymentVoidFailed;
                        finalErrorMessageKey = "error.payment.voidFailed";
                    } else {
                        logger.info(`${functionName} Successfully voided authorization ${authResult.gatewayTransactionId}.`, logContext);
                    }
                } catch (voidError: any) {
                    logger.error(`${functionName} CRITICAL: Error during void attempt for ${authResult.gatewayTransactionId}. Manual void likely required.`, { ...logContext, voidError: voidError?.message });
                    finalErrorCode = ErrorCode.PaymentVoidFailed;
                    finalErrorMessageKey = "error.payment.voidFailed";
                }
            }

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTime}ms`, logContext);
        }
    }
);
