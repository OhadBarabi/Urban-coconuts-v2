/**
 * Export all Cloud Functions defined in the project.
 * This file serves as the entry point for Firebase Functions deployment.
 */

import * as admin from "firebase-admin";

// Initialize Firebase Admin SDK (do this once)
if (admin.apps.length === 0) {
  admin.initializeApp();
}

// --- Import Core Functions ---
import { createOrder } from './core/createOrder';
import { updateOrderStatus } from './core/updateOrderStatus';
import { cancelOrder } from './core/cancelOrder';
import { handleOrderCancellationSideEffects } from './core/handleOrderCancellationSideEffects'; // Background
import { editOrder } from './core/editOrder';
import { addTipToOrder } from './core/addTipToOrder';

// --- Import Rentals Functions ---
import { getAvailableRentalItems } from './rentals/getAvailableRentalItems';
import { createRentalBooking } from './rentals/createRentalBooking';
import { confirmRentalPickup } from './rentals/confirmRentalPickup';
import { confirmRentalReturn } from './rentals/confirmRentalReturn';
import { handleRentalDeposit } from './rentals/handleRentalDeposit'; // Background function
import { cancelRentalBooking } from './rentals/cancelRentalBooking';
import { getAvailableReturnBoxes } from './rentals/getAvailableReturnBoxes';

// --- Import Events Functions ---
import { getEventMenus } from './events/getEventMenus';
import { checkEventAvailability } from './events/checkEventAvailability';
import { createEventBooking } from './events/createEventBooking';
import { approveEventBooking } from './events/approveEventBooking';
import { confirmEventAgreement } from './events/confirmEventAgreement';
import { createGoogleCalendarEvent } from './events/createGoogleCalendarEvent'; // Background function
import { assignEventResources } from './events/assignEventResources';
import { updateEventStatus } from './events/updateEventStatus';
import { cancelEventBooking } from './events/cancelEventBooking'; // Renamed export

// --- Import Courier Functions ---
import { startShift } from './courier/startShift';
import { endShift } from './courier/endShift';

// --- Import RBAC Functions ---
import { createRole, updateRole, deleteRole, listRoles } from './rbac/manageRoles';
import { listPermissions, assignRoleToUser } from './rbac/managePermissionsUsers';

// --- Import Admin Functions ---
import { setUserActiveStatus, adjustBoxInventory } from './admin/manageUsersInventory';
import { createPromoCode, updatePromoCode, deletePromoCode, listPromoCodes } from './admin/managePromoCodes';
import { createProduct, updateProduct, listProducts, setProductActiveStatus } from './admin/manageProduct';
import { createMenu, updateMenu, listMenus, setMenuActiveStatus } from './admin/manageMenu';
import { createBox, updateBox, listBoxes, setBoxStatus } from './admin/manageBox'; // <-- שורות חדשות

// --- Import Scheduled Functions ---
import { autoCancelExpiredOrders, deactivateExpiredPromotions, cleanupOldLogs } from './scheduled/scheduledFunctions'; // Background
import { calculateVipTiers } from './scheduled/calculateVipTiers';
import { generateDailySalesReport } from './scheduled/generateDailySalesReport';

// --- Import Auth Functions ---
import { sendOtp } from './auth/sendOtp';
import { verifyOtp } from './auth/verifyOtp';
import { generateMfaSetup, verifyMfaSetup, disableMfa, verifyMfaLogin } from './auth/manageMfa';

// --- Import Utility Functions (Helpers are usually not Cloud Functions themselves) ---
// Helpers like payment, encryption, permissions, gcal, notifications, logging are imported by the functions that use them.

// ... import other modules ...

// Export HTTPS Callable functions for deployment
export {
  // Core
  createOrder,
  updateOrderStatus,
  cancelOrder,
  editOrder,
  addTipToOrder,
  // Rentals
  getAvailableRentalItems,
  createRentalBooking,
  confirmRentalPickup,
  confirmRentalReturn,
  cancelRentalBooking, // Rental cancellation
  getAvailableReturnBoxes,
  // Events
  getEventMenus,
  checkEventAvailability,
  createEventBooking,
  approveEventBooking,
  confirmEventAgreement,
  assignEventResources,
  updateEventStatus,
  cancelEventBooking, // Event cancellation
  // Courier
  startShift,
  endShift,
  // RBAC
  createRole,
  updateRole,
  deleteRole,
  listRoles,
  listPermissions,
  assignRoleToUser,
  // Admin
  setUserActiveStatus,
  adjustBoxInventory,
  createPromoCode,
  updatePromoCode,
  deletePromoCode,
  listPromoCodes,
  createProduct,
  updateProduct,
  listProducts,
  setProductActiveStatus,
  createMenu,
  updateMenu,
  listMenus,
  setMenuActiveStatus,
  createBox, // <-- שורה חדשה
  updateBox, // <-- שורה חדשה
  listBoxes, // <-- שורה חדשה
  setBoxStatus, // <-- שורה חדשה
  // Auth
  sendOtp,
  verifyOtp,
  generateMfaSetup,
  verifyMfaSetup,
  disableMfa,
  verifyMfaLogin,
  // ... export other callable functions ...
};

// Ensure background/triggered functions are loaded for deployment by referencing them.
handleOrderCancellationSideEffects;
handleRentalDeposit;
createGoogleCalendarEvent;
autoCancelExpiredOrders;
deactivateExpiredPromotions;
cleanupOldLogs;
calculateVipTiers;
generateDailySalesReport;
// ... add references for other background/triggered functions ...
