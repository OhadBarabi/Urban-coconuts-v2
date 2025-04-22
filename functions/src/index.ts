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
import { handleRentalDeposit } from './rentals/handleRentalDeposit'; // <-- שורה חדשה (רק import, לא export)
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

// Ensure background functions are loaded for deployment by importing them
// This line ensures the handleRentalDeposit function code is included in the deployment bundle.
// Even though it's not exported for direct calling, Firebase needs to know about it.
// If you have more background functions, import them here as well.
handleRentalDeposit; // This reference ensures the import is not removed by tree-shaking