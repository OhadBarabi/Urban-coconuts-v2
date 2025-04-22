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
// ... import other functions as they are added ...
// import { getNearbyBoxes } from './customer/getNearbyBoxes'; // Example
// import { startShift } from './courier/startShift'; // Example

// Export functions for deployment
export {
  createOrder,
  updateOrderStatus,
  // ... export other functions ...
  // getNearbyBoxes, // Example
  // startShift, // Example
};