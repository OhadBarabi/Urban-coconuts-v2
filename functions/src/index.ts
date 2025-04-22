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
import { updateEventStatus } from './events/updateEventStatus'; // <-- שורה חדשה
// ... import other event functions ...

// ... import other modules ...

// Export HTTPS Callable functions for deployment
export {
  // Core
  createOrder,
  updateOrderStatus,
  // Rentals
  getAvailableRentalItems,
  createRentalBooking,
  confirmRentalPickup,
  confirmRentalReturn,
  cancelRentalBooking,
  getAvailableReturnBoxes,
  // Events
  getEventMenus,
  checkEventAvailability,
  createEventBooking,
  approveEventBooking,
  confirmEventAgreement,
  assignEventResources,
  updateEventStatus, // <-- שורה חדשה
  // ... export other callable functions ...
};

// Ensure background/triggered functions are loaded for deployment by referencing them.
handleRentalDeposit;
createGoogleCalendarEvent;
// ... add references for other background/triggered functions ...