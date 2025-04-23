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
import { cancelOrder } from './core/cancelOrder'; // <-- שורה חדשה

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
import { cancelEventBooking as cancelEventBookingEvent } from './events/cancelEventBooking';

// --- Import RBAC Functions ---
import { createRole, updateRole, deleteRole, listRoles } from './rbac/manageRoles';
import { listPermissions, assignRoleToUser } from './rbac/managePermissionsUsers';

// --- Import Admin Functions ---
import { setUserActiveStatus, adjustBoxInventory } from './admin/manageUsersInventory';

// --- Import Scheduled Functions ---
import { autoCancelExpiredOrders, deactivateExpiredPromotions, cleanupOldLogs } from './scheduled/scheduledFunctions'; // Background

// --- Import Auth Functions ---
import { sendOtp } from './auth/sendOtp';
import { verifyOtp } from './auth/verifyOtp';
import { generateMfaSetup, verifyMfaSetup, disableMfa, verifyMfaLogin } from './auth/manageMfa';

// --- Import Utility Functions (Helpers are usually not Cloud Functions themselves) ---
import { logUserActivity } from './utils/logging';

// ... import other modules ...

// Export HTTPS Callable functions for deployment
export {
  // Core
  createOrder,
  updateOrderStatus,
  cancelOrder, // <-- שורה חדשה
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
  cancelEventBookingEvent, // Event cancellation
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
handleRentalDeposit;
createGoogleCalendarEvent;
autoCancelExpiredOrders;
deactivateExpiredPromotions;
cleanupOldLogs;
// Note: Utility functions like logUserActivity don't need to be referenced here
// as they are imported and used by other functions.
// ... add references for other background/triggered functions ...