import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { v4 as uuidv4 } from 'uuid';

// --- Import Models ---
import {
    User, Order, OrderStatus, OrderItem, Product, Box, PaymentStatus
} from '../models'; // Adjust path if needed

// --- Assuming helper functions are imported or defined elsewhere ---
// import { checkPermission } from '../utils/permissions';
// import { calculateOrderTotal } from '../utils/order_calculations'; // Re-use calculation logic
// import { logUserActivity, logAdminAction } from '../utils/logging';

// --- Mocks for required helper functions (Replace with actual implementations) ---
async function checkPermission(userId: string | null, userRole: string | null, permissionId: string, context?: any): Promise<boolean> { logger.info(`[Mock Auth] Check ${permissionId} for ${userId} (${userRole})`, context); return userId != null; }
interface CalculationResult { totalAmount: number; itemsTotal: number; couponDiscount: number; ucCoinDiscount: number; finalAmount: number; error?: string; }
function calculateOrderTotal(items: Array<{ productId: string; quantity: number; unitPrice: number }>, coupon?: any | null, ucCoinsToUse?: number | null, userCoinBalance?: number, tipAmount?: number): CalculationResult { logger.info(`[Mock Calc] Recalculating total for edit...`); const itemsTotal = items.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0); const couponDiscount = coupon ? 500 : 0; const ucCoinDiscount = Math.min(ucCoinsToUse ?? 0, userCoinBalance ?? 0); const finalAmount = itemsTotal - couponDiscount - ucCoinDiscount + (tipAmount ?? 0); return { totalAmount: itemsTotal, itemsTotal, couponDiscount, ucCoinDiscount, finalAmount }; }
async function logUserActivity(actionType: string, details: object, userId: string): Promise<void> { logger.info(`[Mock User Log] User: ${userId}, Action: ${actionType}`, details); }
async function logAdminAction(action: string, details: object): Promise<void> { logger.info(`[Mock Admin Log] Action: ${action}`, details); }
// --- End Mocks ---

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION

// --- Enums ---
enum ErrorCode {
    Unauthenticated = "UNAUTHENTICATED", PermissionDenied = "PERMISSION_DENIED", InvalidArgument = "INVALID_ARGUMENT",
    NotFound = "NOT_FOUND", // Order, User, Box, or Product not found
    FailedPrecondition = "FAILED_PRECONDITION", // Invalid status for editing, Product inactive
    Aborted = "ABORTED", // Transaction failed
    ResourceExhausted = "RESOURCE_EXHAUSTED", // Inventory unavailable
    InternalError = "INTERNAL_ERROR",
    // Specific codes
    OrderNotFound = "ORDER_NOT_FOUND",
    NotOrderOwner = "NOT_ORDER_OWNER", // If only owner can edit
    InvalidOrderStatus = "INVALID_ORDER_STATUS", // Not editable from this state
    ProductNotFound = "PRODUCT_NOT_FOUND",
    ProductInactive = "PRODUCT_INACTIVE",
    InventoryUnavailable = "INVENTORY_UNAVAILABLE",
    CalculationError = "CALCULATION_ERROR",
    TransactionFailed = "TRANSACTION_FAILED",
    BoxNotFound = "BOX_NOT_FOUND",
}

// --- Interfaces ---
interface UpdatedItemInput {
    productId: string;
    quantity: number; // New quantity (integer > 0)
}
interface EditOrderInput {
    orderId: string;
    updatedItems: UpdatedItemInput[]; // The complete new list of items
    updatedNotes?: string | null; // Optional: New notes
}

// --- The Cloud Function ---
export const editOrder = functions.https.onCall(
    {
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for multiple reads/writes/transaction
        timeoutSeconds: 60,
    },
    async (request): Promise<{ success: true } | { success: false; error: string; errorCode: string }> => {
        const functionName = "[editOrder V1]";
        const startTimeFunc = Date.now();

        // 1. Authentication & Authorization
        if (!request.auth?.uid) { return { success: false, error: "error.auth.unauthenticated", errorCode: ErrorCode.Unauthenticated }; }
        const userId = request.auth.uid; // User initiating edit (Customer or Admin)
        const data = request.data as EditOrderInput;
        const logContext: any = { userId, orderId: data?.orderId, updatedItemCount: data?.updatedItems?.length };

        logger.info(`${functionName} Invoked.`, logContext);

        // 2. Input Validation
        if (!data?.orderId || typeof data.orderId !== 'string' ||
            !Array.isArray(data.updatedItems) || data.updatedItems.length === 0 || // Must provide at least one item
            data.updatedItems.some(item => !item.productId || typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity <= 0) ||
            (data.updatedNotes !== undefined && typeof data.updatedNotes !== 'string' && data.updatedNotes !== null))
        {
            logger.error(`${functionName} Invalid input data structure or types.`, { ...logContext, data: JSON.stringify(data).substring(0,500) });
            return { success: false, error: "error.invalidInput.structure", errorCode: ErrorCode.InvalidArgument };
        }
        const { orderId, updatedItems, updatedNotes } = data;

        // --- Variables ---
        let orderData: Order;
        let userData: User; // Needed for recalculation if UC Coins/Coupons involved
        let userRole: string | null;
        let boxData: Box; // Needed for inventory check
        let fetchedProducts = new Map<string, Product>(); // Map product IDs to product data
        let newOrderItems: OrderItem[] = [];
        let calculationResult: CalculationResult;

        try {
            // 3. Fetch User Role, Order, and Box Data Concurrently
            const userRef = db.collection('users').doc(userId);
            const orderRef = db.collection('orders').doc(orderId);

            const [userSnap, orderSnap] = await Promise.all([userRef.get(), orderRef.get()]);

            // Validate User
            if (!userSnap.exists) throw new HttpsError('not-found', `error.user.notFound::${userId}`, { errorCode: ErrorCode.UserNotFound });
            userData = userSnap.data() as User;
            userRole = userData.role;
            logContext.userRole = userRole;

            // Validate Order
            if (!orderSnap.exists) {
                logger.warn(`${functionName} Order ${orderId} not found.`, logContext);
                return { success: false, error: "error.order.notFound", errorCode: ErrorCode.OrderNotFound };
            }
            orderData = orderSnap.data() as Order;
            logContext.currentStatus = orderData.status;
            logContext.orderCustomerId = orderData.customerId;
            logContext.boxId = orderData.boxId;

            // Fetch Box Data (needed for inventory)
            if (!orderData.boxId) throw new HttpsError('internal', `Order ${orderId} is missing boxId.`);
            const boxRef = db.collection('boxes').doc(orderData.boxId);
            const boxSnap = await boxRef.get();
            if (!boxSnap.exists) throw new HttpsError('not-found', `error.box.notFound::${orderData.boxId}`, { errorCode: ErrorCode.BoxNotFound });
            boxData = boxSnap.data() as Box;

            // 4. Permission Check (Allow owner or admin?)
            const isOwner = userId === orderData.customerId;
            // Define permissions needed: e.g., 'order:edit:own', 'order:edit:any'
            const requiredPermission = isOwner ? 'order:edit:own' : 'order:edit:any';
            const hasPermission = await checkPermission(userId, userRole, requiredPermission, { orderId });
            if (!hasPermission) {
                logger.warn(`${functionName} Permission denied for user ${userId} (Role: ${userRole}) to edit order ${orderId}.`, logContext);
                return { success: false, error: "error.permissionDenied.editOrder", errorCode: ErrorCode.PermissionDenied };
            }

            // 5. State Validation (Allow editing only in specific states, e.g., 'Red')
            // More complex logic might allow edits in 'Yellow' before preparation starts.
            const editableStatuses: string[] = [OrderStatus.Red.toString()];
            if (!editableStatuses.includes(orderData.status)) {
                logger.warn(`${functionName} Order ${orderId} cannot be edited from status '${orderData.status}'.`, logContext);
                return { success: false, error: `error.order.invalidStatus.edit::${orderData.status}`, errorCode: ErrorCode.InvalidOrderStatus };
            }
            // Also check payment status - cannot edit if already Paid/Captured/etc.?
            const nonEditablePaymentStatuses: string[] = [PaymentStatus.Paid.toString(), PaymentStatus.Captured.toString(), PaymentStatus.Refunded.toString(), PaymentStatus.PartiallyRefunded.toString()];
            if (nonEditablePaymentStatuses.includes(orderData.paymentStatus)) {
                 logger.warn(`${functionName} Order ${orderId} cannot be edited due to payment status '${orderData.paymentStatus}'.`, logContext);
                 return { success: false, error: `error.order.invalidPaymentStatus.edit::${orderData.paymentStatus}`, errorCode: ErrorCode.InvalidOrderStatus };
            }


            // 6. Fetch Product Data for all involved items (original and new)
            const originalProductIds = orderData.items.map(item => item.productId);
            const updatedProductIds = updatedItems.map(item => item.productId);
            const allProductIds = [...new Set([...originalProductIds, ...updatedProductIds])];
            const productRefs = allProductIds.map(id => db.collection('products').doc(id));

            logger.info(`${functionName} Fetching product data for ${allProductIds.length} products...`, logContext);
            const productDocs = await db.getAll(...productRefs);

            productDocs.forEach(doc => {
                if (doc.exists) {
                    const product = doc.data() as Product;
                    if (!product.isActive) {
                        // If an item being ADDED is inactive, throw error
                        if (updatedProductIds.includes(doc.id)) {
                             logger.error(`${functionName} Cannot add inactive product ${doc.id} to order.`, logContext);
                             throw new HttpsError('failed-precondition', `error.product.inactive::${doc.id}`, { errorCode: ErrorCode.ProductInactive });
                        }
                        // If an item being kept/removed was already inactive, maybe just log a warning?
                        // logger.warn(`${functionName} Product ${doc.id} in order is inactive, but allowing edit.`);
                    }
                    fetchedProducts.set(doc.id, product);
                } else {
                    // If an item being ADDED is not found, throw error
                    if (updatedProductIds.includes(doc.id)) {
                         logger.error(`${functionName} Product ${doc.id} not found. Cannot add to order.`, logContext);
                         throw new HttpsError('not-found', `error.product.notFound::${doc.id}`, { errorCode: ErrorCode.ProductNotFound });
                    }
                    // If an item being removed was not found, log warning but allow edit
                    // logger.warn(`${functionName} Product ${doc.id} from original order not found.`);
                }
            });

            // Build the new list of OrderItems with snapshots
            newOrderItems = updatedItems.map(newItem => {
                const product = fetchedProducts.get(newItem.productId);
                if (!product) throw new HttpsError('internal', `Internal error: Product ${newItem.productId} not found in fetched map during item creation.`);
                return {
                    orderItemId: uuidv4(), // Generate new IDs for all items in the edited order
                    productId: newItem.productId,
                    productName: product.productName_i18n?.['en'] ?? 'Unknown Product', // Snapshot name
                    quantity: newItem.quantity,
                    unitPrice: product.priceSmallestUnit, // Snapshot price
                };
            });

            // 7. Recalculate Order Totals
            // Use the existing coupon/UC coins from the original order for recalculation
            logger.info(`${functionName} Recalculating order totals...`, logContext);
            calculationResult = calculateOrderTotal(
                newOrderItems,
                orderData.couponCodeUsed ? { couponCode: orderData.couponCodeUsed } : null, // Pass minimal coupon info if used
                orderData.ucCoinsUsed,
                userData.ucCoinBalance, // Pass current balance for validation if needed by calculator
                orderData.tipAmountSmallestUnit // Keep existing tip
            );
            if (calculationResult.error) {
                throw new HttpsError('internal', `error.internal.calculation::${calculationResult.error}`, { errorCode: ErrorCode.CalculationError });
            }
            const { itemsTotal: newItemsTotal, finalAmount: newFinalAmount } = calculationResult;
            logContext.newTotalAmount = newItemsTotal;
            logContext.newFinalAmount = newFinalAmount;


            // 8. Firestore Transaction
            logger.info(`${functionName} Starting Firestore transaction for order edit...`, logContext);
            await db.runTransaction(async (transaction) => {
                // Re-read order and box data
                const orderTxSnap = await transaction.get(orderRef);
                const boxTxSnap = await transaction.get(boxRef);

                if (!orderTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.OrderNotFound}`);
                if (!boxTxSnap.exists) throw new Error(`TX_ERR::${ErrorCode.BoxNotFound}::${orderData.boxId}`);
                const orderTxData = orderTxSnap.data() as Order;
                const boxTxData = boxTxSnap.data() as Box;

                // Re-validate status
                if (!editableStatuses.includes(orderTxData.status)) {
                     logger.warn(`${functionName} TX Conflict: Order ${orderId} status changed to ${orderTxData.status} during TX. Aborting edit.`, logContext);
                     return; // Abort gracefully
                }
                 if (nonEditablePaymentStatuses.includes(orderTxData.paymentStatus)) {
                     logger.warn(`${functionName} TX Conflict: Order ${orderId} payment status changed to ${orderTxData.paymentStatus} during TX. Aborting edit.`, logContext);
                     return; // Abort gracefully
                 }

                // Calculate Inventory Changes
                const inventoryUpdates: { [key: string]: admin.firestore.FieldValue } = {};
                const currentInventory = boxTxData.inventory ?? {};
                const originalItemMap = new Map<string, number>(orderTxData.items.map(item => [item.productId, item.quantity]));
                const newItemMap = new Map<string, number>(newOrderItems.map(item => [item.productId, item.quantity]));

                // Iterate through all unique products involved
                allProductIds.forEach(productId => {
                    const originalQty = originalItemMap.get(productId) ?? 0;
                    const newQty = newItemMap.get(productId) ?? 0;
                    const change = newQty - originalQty; // Positive if added/increased, negative if removed/decreased

                    if (change !== 0) {
                        const currentStock = currentInventory[productId] ?? 0;
                        const stockAfterChange = currentStock - change; // Subtract the *change* (if change is negative, stock increases)

                        // Check if adjustment leads to negative stock ONLY if we are increasing the quantity (change > 0)
                        if (change > 0 && stockAfterChange < 0) {
                            logger.error(`${functionName} TX Check: Insufficient inventory for product ${productId}. Available: ${currentStock}, Needed change: ${change}.`, logContext);
                            throw new Error(`TX_ERR::${ErrorCode.InventoryUnavailable}::${productId}`);
                        }
                        inventoryUpdates[`inventory.${productId}`] = FieldValue.increment(-change); // Increment by negative change to adjust stock
                    }
                });

                // Prepare Order Update
                const now = Timestamp.now();
                const updateData: { [key: string]: any } = {
                    items: newOrderItems, // Replace with the new item list
                    totalAmount: newItemsTotal, // Update calculated total
                    finalAmount: newFinalAmount, // Update calculated final amount
                    notes: updatedNotes === undefined ? orderTxData.notes : (updatedNotes ?? null), // Update notes only if provided
                    updatedAt: FieldValue.serverTimestamp(),
                    statusHistory: FieldValue.arrayUnion({
                        // Use a specific status/reason for edit? Or just rely on log?
                        // status: orderTxData.status, // Keep current status
                        timestamp: now,
                        userId: userId,
                        role: userRole,
                        reason: `Order edited by ${userRole ?? 'User'}`
                    }),
                     processingError: null, // Clear previous errors
                };

                // --- Perform Writes ---
                // 1. Update Order Document
                transaction.update(orderRef, updateData);
                // 2. Update Box Inventory (if changes occurred)
                if (Object.keys(inventoryUpdates).length > 0) {
                    transaction.update(boxRef, inventoryUpdates);
                }
            }); // End Transaction
            logger.info(`${functionName} Order ${orderId} edited successfully.`, logContext);


            // 9. Log Action (Async)
            const logDetails = { orderId, customerId: orderData.customerId, oldItemCount: orderData.items.length, newItemCount: newOrderItems.length, oldFinalAmount: orderData.finalAmount, newFinalAmount, notesChanged: updatedNotes !== undefined, triggerUserId: userId, triggerUserRole: userRole };
            if (userRole === 'Admin' || userRole === 'SuperAdmin') {
                logAdminAction("EditOrder", logDetails).catch(err => logger.error("Failed logging admin action", { err }));
            } else {
                logUserActivity("EditOrder", logDetails, userId).catch(err => logger.error("Failed logging user activity", { err }));
            }

            // 10. Return Success
            return { success: true };

        } catch (error: any) {
            // Error Handling
            logger.error(`${functionName} Execution failed.`, { ...logContext, error: error?.message, details: error?.details });
            const isHttpsError = error instanceof HttpsError;
            const code = isHttpsError ? error.code : 'UNKNOWN';
            let finalErrorCode: ErrorCode = ErrorCode.InternalError;
            let finalErrorMessageKey: string = "error.internalServer";

            if (isHttpsError) {
                finalErrorCode = (error.details as any)?.errorCode as ErrorCode || ErrorCode.InternalError;
                finalErrorMessageKey = error.message.startsWith("error.") ? error.message : `error.editOrder.generic`;
                if (!Object.values(ErrorCode).includes(finalErrorCode)) finalErrorCode = ErrorCode.InternalError;
                 if (error.message.includes("::")) { finalErrorMessageKey = error.message; }
            } else if (error.message?.startsWith("TX_ERR::")) {
                 const parts = error.message.split('::');
                 const txErrCode = parts[1] as ErrorCode;
                 finalErrorCode = Object.values(ErrorCode).includes(txErrCode) ? txErrCode : ErrorCode.TransactionFailed;
                 finalErrorMessageKey = `error.transaction.${finalErrorCode.toLowerCase()}`;
                 if (parts[2]) finalErrorMessageKey += `::${parts[2]}`;
            }

            // Log failure activity?
            logUserActivity("EditOrderFailed", { orderId, error: error.message }, userId).catch(...)

            return { success: false, error: finalErrorMessageKey, errorCode: finalErrorCode };
        } finally {
             logger.info(`${functionName} Execution finished. Duration: ${Date.now() - startTimeFunc}ms`, logContext);
        }
    }
);
