import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from "firebase-functions/logger";
import * as admin from 'firebase-admin';
// Ensure all necessary types are imported, including the corrected enum
// Removed unused Box and PaymentStatus for now
import { RentalBooking, RentalBookingStatus, PermissionKey, CancellationDetails, CancellationInitiator } from '../models';
import { checkPermission } from '../utils/permissions';

const db = admin.firestore();

interface CancelRentalBookingPayload {
  bookingId: string;
  cancellationReason?: string; // Optional reason from user/staff
}

/**
 * Cancels a rental booking if it's in the PendingPickup status.
 * Requires authentication and appropriate permissions (owner or RentalManage).
 * Updates booking status and restores inventory in a transaction.
 */
export const cancelRentalBooking = onCall({ region: 'europe-west3' }, async (request) => {
  // 1. Authentication Check
  if (!request.auth) {
    logger.error("cancelRentalBooking: Unauthenticated call.");
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  const cancellerId = request.auth.uid;

  // 2. Input Validation
  const data = request.data as CancelRentalBookingPayload;
  if (!data.bookingId) {
    logger.error("cancelRentalBooking: Missing required field: bookingId.", { payload: data });
    throw new HttpsError('invalid-argument', 'Missing required field: bookingId');
  }

  logger.info(`cancelRentalBooking: Attempting to cancel booking ${data.bookingId} by ${cancellerId}.`);

  const bookingRef = db.collection('rentalBookings').doc(data.bookingId);

  // Declare bookingData outside the transaction to potentially use it for payment voiding later
  let bookingData: RentalBooking | null = null;

  try {
    await db.runTransaction(async (transaction) => {
      // 3. Read Booking Document
      const bookingDoc = await transaction.get(bookingRef);
      if (!bookingDoc.exists) {
        logger.warn(`cancelRentalBooking: Booking ${data.bookingId} not found.`);
        throw new HttpsError('not-found', 'Booking not found.');
      }
      // Assign to the outer scope variable
      bookingData = bookingDoc.data() as RentalBooking;

      // 4. Permission/Ownership Check
      const isOwner = cancellerId === bookingData.customerId;
      if (!isOwner) {
          const hasAdminPermission = await checkPermission(cancellerId, PermissionKey.RentalManage);
          if (!hasAdminPermission) {
            logger.warn(`cancelRentalBooking: User ${cancellerId} does not have permission to cancel booking ${data.bookingId}.`);
            throw new HttpsError('permission-denied', 'You do not have permission to cancel this booking.');
          }
      }

      // 5. Status Check
      if (bookingData.bookingStatus !== RentalBookingStatus.PendingPickup) {
        logger.warn(`cancelRentalBooking: Booking ${data.bookingId} cannot be cancelled. Status is ${bookingData.bookingStatus}.`);
        throw new HttpsError('failed-precondition', 'Booking cannot be cancelled at this stage.');
      }

      // 6. Prepare Cancellation Data
      const cancellationDetails: CancellationDetails = {
        cancelledBy: isOwner ? CancellationInitiator.Customer : CancellationInitiator.Staff, // *** THIS IS THE CORRECTED LINE ***
        cancellationReason: data.cancellationReason ?? (isOwner ? 'Cancelled by customer' : 'Cancelled by staff'),
        cancellationTimestamp: admin.firestore.FieldValue.serverTimestamp() as admin.firestore.Timestamp,
        refundProcessed: false, // Placeholder
        refundDetails: undefined
      };

      // 7. Prepare Booking Update
      const bookingUpdateData: Partial<RentalBooking> = { // Use Partial for update
        bookingStatus: RentalBookingStatus.Cancelled,
        cancellationDetails: cancellationDetails,
        updatedAt: admin.firestore.FieldValue.serverTimestamp() as admin.firestore.Timestamp,
      };

      // 8. Prepare Inventory Update (for the pickup box)
      const boxRef = db.collection('boxes').doc(bookingData.pickupBoxId);
      // Read the box within the transaction to ensure atomicity
      const boxSnapshot = await transaction.get(boxRef);
      if (!boxSnapshot.exists) {
         // Although unlikely if booking exists, good practice to check
         logger.error(`cancelRentalBooking: Pickup box ${bookingData.pickupBoxId} not found during transaction for booking ${data.bookingId}.`);
         throw new HttpsError('not-found', `Pickup box ${bookingData.pickupBoxId} not found.`);
      }
      const inventoryUpdate = {
        [`rentalInventory.${bookingData.rentalItemId}`]: admin.firestore.FieldValue.increment(1)
      };

      // 9. Perform Transaction Writes
      transaction.update(bookingRef, bookingUpdateData);
      transaction.update(boxRef, inventoryUpdate);
      logger.info(`cancelRentalBooking: Transaction prepared for booking ${data.bookingId}.`);

      // 10. Log payment void/refund placeholder *inside* transaction
      if (bookingData?.paymentDetails?.transactionId) { // Use optional chaining
          logger.info(`cancelRentalBooking: Placeholder - Payment transaction ${bookingData.paymentDetails.transactionId} for booking ${data.bookingId} should be voided/refunded.`);
      }

    }); // End of transaction

    // 11. Post-Transaction Logging
    logger.info(`cancelRentalBooking: Booking ${data.bookingId} cancelled successfully by ${cancellerId}.`);

    return { success: true };

  } catch (error: any) {
    // 12. Error Handling
    if (error instanceof HttpsError) {
      // Re-throw HttpsErrors directly (like not-found, permission-denied, failed-precondition)
      throw error;
    }
    logger.error(`cancelRentalBooking: Error cancelling booking ${data.bookingId}.`, { error: error?.message || error });
    throw new HttpsError('internal', 'An unexpected error occurred while cancelling the booking.');
  }
});
