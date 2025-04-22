/**
 * Export all Cloud Functions defined in the project.
 * This file serves as the entry point for Firebase Functions deployment.
 */

import * as admin from "firebase-admin";

// Initialize Firebase Admin SDK (do this once)
if (admin.apps.length === 0) {
  admin.initializeApp();
}

// Import functions from their respective files
import { createOrder } from './core/createOrder';
import { updateOrderStatus } from './core/updateOrderStatus';
import { getAvailableRentalItems } from './rentals/getAvailableRentalItems';
import { createRentalBooking } from './rentals/createRentalBooking';
import { confirmRentalPickup } from './rentals/confirmRentalPickup';
import { confirmRentalReturn } from './rentals/confirmRentalReturn';
import { handleRentalDeposit } from './rentals/handleRentalDeposit'; // Background function
import { cancelRentalBooking } from './rentals/cancelRentalBooking'; // <-- שורה חדשה

// ... import other functions as they are added ...

// Export HTTPS Callable functions for deployment
export {
  createOrder,
  updateOrderStatus,
  getAvailableRentalItems,
  createRentalBooking,
  confirmRentalPickup,
  confirmRentalReturn,
  cancelRentalBooking, // <-- שורה חדשה
  // Note: handleRentalDeposit is a background function, no need to export here
  // ... export other callable functions ...
};

// Ensure background functions are loaded for deployment by referencing them.
handleRentalDeposit;
// ... add references for other background functions ...