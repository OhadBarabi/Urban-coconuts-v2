import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { v4 as uuidv4 } from 'uuid';

// --- Import Models ---
import {
    User, Order, OrderStatus, OrderItem, Product, Box, PaymentMethod, PaymentStatus, PaymentDetails
} from '../models'; // Adjust path if needed

// --- Import Helpers ---
import { checkPermission } from '../utils/permissions';
import { initiateAuthorization, extractPaymentDetailsFromResult } from '../utils/payment_helpers';
import { logUserActivity } from '../utils/logging'; // Using mock below

// --- Mocks for other required helper functions (Replace with actual implementations) ---
interface CalculationResult { totalAmount: number; itemsTotal: number; couponDiscount: number; ucCoinDiscount: number; finalAmount: number; error?: string; }
function calculateOrderTotal(items: Array<{ productId: string; quantity: number; unitPrice: number }>, coupon?: any | null, ucCoinsToUse?: number | null, userCoinBalance?: number, tipAmount?: number): CalculationResult { logger.info(`[Mock Calc] Calculating total...`); const itemsTotal = items.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0); const couponDiscount = coupon ? 500 : 0; const ucCoinDiscount = Math.min(ucCoinsToUse ?? 0, userCoinBalance ?? 0); const finalAmount = itemsTotal - couponDiscount - ucCoinDiscount + (tipAmount ?? 0); return { totalAmount: itemsTotal, itemsTotal, couponDiscount, ucCoinDiscount, finalAmount }; }
// async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); } // Imported
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // User, Box, or Product not found
    FailedPrecondition = "FAILED_PRECONDITION", // Box inactive, Product inactive
    Aborted = "ABORTED", // Transaction or Payment failed
    ResourceExhausted = "RESOURCE_EXHAUSTED", // Inventory unavailable
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    UserNotFound = "USER_NOT_FOUND",
    BoxNotFound = "BOX_NOT_FOUND",
    BoxInactive = "BOX_INACTIVE",
    ProductNotFound = "PRODUCT_NOT_FOUND",
    ProductInactive = "PRODUCT_INACTIVE",
    InventoryUnavailable = "INVENTORY_UNAVAILABLE",
    CalculationError = "CALCULATION_ERROR",
    PaymentAuthFailed = "PAYMENT_AUTH_FAILED", // Specific payment error
    PaymentActionRequired = "PAYMENT_ACTION_REQUIRED", // e.g., 3DS
    TransactionFailed = "TRANSACTION_FAILED",
}

// --- Interfaces ---
interface CartItemInput {
    productId: string;
    quantity: number; // Integer > 0
}
interface CartDataInput {
    boxId: string;
    items: CartItemInput[];
    notes?: string | null;
}
interface CreateOrderInput {
    cartData: CartDataInput;
    paymentMethod: PaymentMethod; // Enum: CreditCardApp, BitApp, UC_Coins_Only, CashOnDelivery, CreditOnDelivery
    couponCode?: string | null;
    ucCoinsToUse?: number | null; // Integer >= 0
    paymentMethodToken?: string | null; // Token from client-side payment SDK (e.g., Stripe, Google Pay)
}

// --- The Cloud Function ---
export const createOrder = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for multiple reads/writes/transaction/payment
        timeoutSeconds: 120, // Increase timeout for payment processing
        // secrets: ["PAYMENT_GATEWAY_SECRET"], // Uncomment if payment helper needs secrets
    },
    async (request): Promise<{ success: true; orderId: string; requiresAction?: boolean; actionUrl?: string } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[createOrder V3 - Permissions]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const customerId = request.auth.uid;
        const data = request.data as CreateOrderInput;
        const logContext: any = { customerId, boxId: data?.cartData?.boxId, itemCount: data?.cartData?.items?.length, paymentMethod: data?.paymentMethod };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.cartData?.boxId || !Array.isArray(data.cartData.items) || data.cartData.items.length === 0 ||
            data.cartData.items.some(item => !item.productId || typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0) ||
            !data.paymentMethod || !Object.values(PaymentMethod).includes(data.paymentMethod) ||
            (data.couponCode != null && typeof data.couponCode !== 'string') ||
            (data.ucCoinsToUse != null && (typeof data.ucCoinsToUse !== 'number' || !Number.isInteger(data.ucCoinsToUse) || data.ucCoinsToUse < 0)) ||
            (data.paymentMethodToken != null && typeof data.paymentMethodToken !== 'string'))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { cartData, paymentMethod, couponCode, ucCoinsToUse, paymentMethodToken } = data;
        const { boxId, items: cartItems, notes } = cartData;

        // --- Variables ---
        let userData: User;
        let userRole: string | null;
        let boxData: Box;
        let fetchedProducts = new Map<string, Product>();
        let orderItems: OrderItem[] = [];
        let calculationResult: CalculationResult;
        let authorizationResult: Awaited<ReturnType<typeof initiateAuthorization>> | null = null;
        let paymentStatus: PaymentStatus;
        let authDetails: PaymentDetails | null = null;
        const orderId = db.collection('orders').doc().id;

        try {
            // 3. Fetch User, Box, and Product Data Concurrently
            const userRef = db.collection('users').doc(customerId);
            const boxRef = db.collection('boxes').doc(boxId);
            const productIds = cartItems.map(item => item.productId);
            const productRefs = productIds.map(id => db.collection('products').doc(id));

            logger.info(`${functionName} Fetching user, box, and ${productIds.length} products...`, logContext);
            const [userSnap, boxSnap, ...productDocs] = await Promise.all([
                userRef.get(),
                boxRef.get(),
                ...productRefs.map(ref => ref.get())
            ]);

            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${customerId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            userRole = userData.role;
            logContext.userRole = userRole;
            if (!userData.isActive) throw new HttpsError('permission-denied', "error.user.inactive", { errorCode: ErrorCode.PermissionDenied });

            if (!boxSnap.exists) throw new HttpsError('not-found', `error.box.notFound::${boxId}`, { errorCode: ErrorCode.BoxNotFound });
            boxData = boxSnap.data() as Box;
            logContext.currencyCode = boxData.currencyCode;
            if (!boxData.isActive) throw new HttpsError('failed-precondition', `error.box.inactive::${boxId}`, { errorCode: ErrorCode.BoxInactive });

            productDocs.forEach((doc, index) => {
                const productId = productIds[index];
                if (!doc.exists) throw new HttpsError('not-found', `error.product.notFound::${productId}`, { errorCode: ErrorCode.ProductNotFound });
                const product = doc.data() as Product;
                if (!product.isActive) throw new HttpsError('failed-precondition', `error.product.inactive::${productId}`, { errorCode: ErrorCode.ProductInactive });
                fetchedProducts.set(productId, product);

                const cartItem = cartItems.find(item => item.productId === productId);
                if (!cartItem) throw new HttpsError('internal', `Logic error: Cart item not found for product ${productId}`);

                orderItems.push({
                    orderItemId: uuidv4(),
                    productId: productId,
                    productName: product.productName_i18n?.[userData.preferredLanguage || 'en'] ?? product.productName_i18n?.['en'] ?? 'Unknown Product',
                    quantity: cartItem.quantity,
                    unitPrice: product.priceSmallestUnit,
                });
            });

            // 4. Permission Check
            const hasPermission = await checkPermission(customerId, userRole, 'order:create', logContext);
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${customerId} (Role: ${userRole}) to create order.`, logContext);
                return { success: false, error: "error.permissionDenied.createOrder", errorCode: ErrorCode.PermissionDenied };
            }

            // 5. Calculate Order Totals
            logger.info(`${functionName} Calculating order totals...`, logContext);
            calculationResult = calculateOrderTotal(
                orderItems, couponCode ? { couponCode } : null, ucCoinsToUse, userData.ucCoinBalance
            );
            if (calculationResult.error) {
                throw new HttpsError('internal', `error.internal.calculation::${calculationResult.error}`, { errorCode: ErrorCode.CalculationError });
            }
            const { totalAmount, finalAmount, couponDiscount, ucCoinDiscount } = calculationResult;
            logContext.totalAmount = totalAmount;
            logContext.finalAmount = finalAmount;
            if (finalAmount < 0) {
                 throw new HttpsError('internal', "Calculation resulted in negative final amount.");
            }

            // 6. Handle Payment Authorization
            paymentStatus = PaymentStatus.Pending;
            if (paymentMethod === PaymentMethod.CreditCardApp || paymentMethod === PaymentMethod.BitApp) {
                if (finalAmount > 0) {
                    logger.info(`${functionName} Initiating payment authorization for ${finalAmount} ${boxData.currencyCode}...`, logContext);
                    paymentStatus = PaymentStatus.AuthorizationPending;
                    authorizationResult = await initiateAuthorization(
                        customerId, finalAmount, boxData.currencyCode, `Order ${orderId} - Urban Coconuts`,
                        paymentMethodToken, userData.paymentGatewayCustomerId, orderId
                    );
                    authDetails = extractPaymentDetailsFromResult(authorizationResult);

                    if (!authorizationResult.success) {
                        paymentStatus = PaymentStatus.AuthorizationFailed;
                        logger.error(`${functionName} Payment authorization failed.`, { ...logContext, error: authorizationResult.errorMessage, code: authorizationResult.errorCode });
                        if (authorizationResult.requiresAction) {
                             return { success: false, error: "error.payment.actionRequired", errorCode: ErrorCode.PaymentActionRequired, requiresAction: true, actionUrl: authorizationResult.actionUrl };
                        } else {
                             return { success: false, error: `error.payment.authFailed::${authorizationResult.errorCode || 'Unknown'}`, errorCode: ErrorCode.PaymentAuthFailed };
                        }
                    }
                    paymentStatus = PaymentStatus.Authorized;
                    logger.info(`${functionName} Payment authorization successful. AuthID: ${authorizationResult.authorizationId}`, logContext);
                     if (authorizationResult.requiresAction) {
                         paymentStatus = PaymentStatus.AuthorizationActionRequired;
                         logger.warn(`${functionName} Payment authorization requires further action (e.g., 3DS).`, logContext);
                     }
                } else {
                    paymentStatus = PaymentStatus.Paid;
                    logger.info(`${functionName} Final amount is 0, skipping payment authorization.`, logContext);
                }
            } else if (paymentMethod === PaymentMethod.UC_Coins_Only) {
                 if (finalAmount > 0) {
                     throw new HttpsError('failed-precondition', "UC_Coins_Only selected but final amount is greater than 0.");
                 }
                 paymentStatus = PaymentStatus.Paid;
            }
            logContext.paymentStatus = paymentStatus;

            // 7. Firestore Transaction
            logger.info(`${functionName} Starting Firestore transaction...`, logContext);
            await db.runTransaction(async (transaction) => {
                const boxTxSnap = await transaction.get(boxRef);
                const userTxSnap = await transaction.get(userRef);
                if (!boxTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}`);
                if (!userTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.UserNotFound}`);
                const boxTxData = boxTxSnap.data() as Box;
                const userTxData = userTxSnap.data() as User;

                const inventoryUpdates: { [key: string]: admin.firestore.FieldValue } = {};
                const currentInventory = boxTxData.inventory ?? {};
                for (const item of orderItems) {
                    const currentStock = currentInventory[item.productId] ?? 0;
                    if (currentStock < item.quantity) {
                        throw new Error(`TX_ERR::${ErrorCode.InventoryUnavailable}::${item.productId}`);
                    }
                    inventoryUpdates[`inventory.${item.productId}`] = FieldValue.increment(-item.quantity);
                }

                let userUpdateData: { [key: string]: any } = {};
                if (ucCoinDiscount > 0) {
                    const currentBalance = userTxData.ucCoinBalance ?? 0;
                    if (currentBalance < ucCoinDiscount) {
                        throw new Error(`TX_ERR::${ErrorCode.ResourceExhausted}::UC Coins`);
                    }
                    userUpdateData.ucCoinBalance = FieldValue.increment(-ucCoinDiscount);
                }

                const now = Timestamp.now();
                const initialStatus = OrderStatus.Red;
                const newOrderData: Order = {
                    orderId: orderId, orderNumber: `UC-${orderId.substring(0, 6).toUpperCase()}`, customerId: customerId,
                    courierId: null, boxId: boxId, items: orderItems, status: initialStatus,
                    statusHistory: [{ status: initialStatus, timestamp: now, userId: customerId, role: userRole ?? 'Customer', reason: "Order created" }],
                    paymentMethod: paymentMethod, paymentStatus: paymentStatus, currencyCode: boxData.currencyCode,
                    authDetails: authDetails, paymentDetails: null, totalAmount: totalAmount,
                    ucCoinsUsed: ucCoinDiscount > 0 ? ucCoinDiscount : null, couponCodeUsed: couponCode || null,
                    couponDiscountValue: couponDiscount, tipAmountSmallestUnit: null, finalAmount: finalAmount,
                    orderTimestamp: now, deliveredTimestamp: null, pickupTimeWindow: null, notes: notes || null,
                    issueReported: false, issueDetails: null, orderQrCodeData: `UCO:${orderId}`,
                    cancellationSideEffectsProcessed: false, createdAt: now, updatedAt: now,
                };
                const orderRef = db.collection('orders').doc(orderId);
                transaction.set(orderRef, newOrderData);
                transaction.update(boxRef, inventoryUpdates);
                if (Object.keys(userUpdateData).length > 0) {
                    transaction.update(userRef, userUpdateData);
                }
            });
            logger.info(`${functionName} Transaction successful. Order ${orderId} created.`, logContext);

            // 8. Log User Activity (Async)
            logUserActivity("CreateOrder", { orderId, boxId, itemCount: orderItems.length, finalAmount, paymentMethod, paymentStatus }, customerId)
                .catch(err => logger.error("Failed logging CreateOrder user activity", { err }));

            // 9. Return Success
            const successResponse: { success: true; orderId: string; requiresAction?: boolean; actionUrl?: string } = {
                 success: true, orderId: orderId
            };
            if (paymentStatus === PaymentStatus.AuthorizationActionRequired && authorizationResult?.requiresAction) {
                 successResponse.requiresAction = true;
                 successResponse.actionUrl = authorizationResult.actionUrl ?? undefined;
            }
            return successResponse;

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.createOrder.generic`;
                 if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            } else if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            }

            logUserActivity("CreateOrderFailed", { boxId, itemCount: cartItems.length, paymentMethod, error: error.message }, customerId)
                .catch(err => logger.error("Failed logging CreateOrderFailed user activity", { err }));

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
