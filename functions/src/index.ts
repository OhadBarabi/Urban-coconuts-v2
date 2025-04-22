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
// Import background/triggered functions so they are included in the deployment
import { handleRentalDeposit } from './rentals/handleRentalDeposit';
// ... import other functions as they are added ...

// Export HTTPS Callable functions for deployment
export {
  createOrder,
  updateOrderStatus,
  getAvailableRentalItems,
  createRentalBooking,
  confirmRentalPickup,
  confirmRentalReturn,
  // Note: handleRentalDeposit is a background function, no need to export here
  // unless you specifically want to call it via HTTPS for testing (not recommended for prod)
  // ... export other callable functions ...
};

// Ensure background functions are loaded for deployment by referencing them.
// This ensures the imported code (like handleRentalDeposit) is not removed by tree-shaking.
// Add references for other background/triggered functions here as well.
handleRentalDeposit;