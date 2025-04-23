import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";

// --- Import Models ---
import { Order, OrderStatus, RentalBooking, RentalBookingStatus, EventBooking, EventBookingStatus, DailyReport } from '../models'; // Adjust path if needed

// --- Configuration ---
// Ensure Firebase Admin is initialized (moved to index.ts)
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const FUNCTION_REGION = "me-west1"; // <<<--- CHANGE TO YOUR REGION
const TIME_ZONE = "Asia/Jerusalem"; // Important for defining "yesterday"

// --- Helper to get start and end Timestamps for yesterday ---
function getYesterdayTimestamps(timeZone: string): { start: Timestamp, end: Timestamp, reportDateStr: string } {
    const now = new Date();
    // Use Intl to format date parts correctly in the target timezone
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = formatter.formatToParts(now).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {} as Record<string, string>);

    const todayStartStr = `${parts.year}-${parts.month}-${parts.day}T00:00:00`;
    const todayStart = new Date(new Date(todayStartStr).toLocaleString('en-US', { timeZone: timeZone })); // Start of today in target TZ

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1); // Start of yesterday

    const yesterdayEnd = new Date(todayStart);
    yesterdayEnd.setMilliseconds(yesterdayEnd.getMilliseconds() - 1); // End of yesterday (23:59:59.999)

    const reportDateStr = yesterdayStart.toISOString().split('T')[0]; // YYYY-MM-DD format for report ID

    return {
        start: Timestamp.fromDate(yesterdayStart),
        end: Timestamp.fromDate(yesterdayEnd),
        reportDateStr: reportDateStr
    };
}

// --- The Scheduled Function ---
// Schedule: e.g., Run daily at 00:10 AM Israel time (to process the previous day)
export const generateDailySalesReport = functions.scheduler.onSchedule(
    {
        schedule: "every day 00:10", // Adjust schedule as needed
        timeZone: TIME_ZONE,
        region: FUNCTION_REGION,
        memory: "1GiB", // Allow memory for potentially large queries/aggregation
        timeoutSeconds: 540, // Max timeout
    },
    async (context) => {
        const functionName = "[generateDailySalesReport V1]";
        const startTimeFunc = Date.now();
        logger.info(`${functionName} Execution started. Event ID: ${context.eventId}`);

        // 1. Determine Date Range for "Yesterday"
        const { start: yesterdayStart, end: yesterdayEnd, reportDateStr } = getYesterdayTimestamps(TIME_ZONE);
        logger.info(`${functionName} Generating report for date: ${reportDateStr} (Range: ${yesterdayStart.toDate().toISOString()} to ${yesterdayEnd.toDate().toISOString()})`);

        // 2. Initialize Report Data Structure
        const reportData: DailyReport = {
            reportDate: reportDateStr,
            generatedAt: FieldValue.serverTimestamp(),
            timeZone: TIME_ZONE,
            totalOrders: 0,
            completedOrders: 0,
            cancelledOrders: 0,
            totalRevenueSmallestUnit: 0, // Sum of finalAmount for completed orders
            totalTipsSmallestUnit: 0,
            totalUcCoinsUsed: 0,
            totalCouponDiscountSmallestUnit: 0,
            revenueByBox: {}, // { boxId: { completedOrders: number, revenue: number } }
            revenueByProduct: {}, // { productId: { quantitySold: number, revenue: number } }
            // Rental Data
            totalRentalBookings: 0,
            completedRentalBookings: 0, // Based on return timestamp
            totalRentalRevenueSmallestUnit: 0, // Sum of finalCharge for completed rentals
            rentalRevenueByItem: {}, // { rentalItemId: { completedRentals: number, revenue: number } }
            // Event Data
            totalEventBookings: 0,
            completedEventBookings: 0, // Based on actualEndTime
            totalEventRevenueSmallestUnit: 0, // Sum of totalAmount for completed events
            // Other metrics
            newCustomers: 0,
            processingErrors: [],
        };

        const reportRef = db.collection('dailyReports').doc(reportDateStr);

        try {
            // 3. Process Orders from Yesterday
            logger.info(`${functionName} Processing orders...`);
            const ordersSnapshot = await db.collection('orders')
                .where('orderTimestamp', '>=', yesterdayStart)
                .where('orderTimestamp', '<=', yesterdayEnd)
                .get();

            reportData.totalOrders = ordersSnapshot.size;

            ordersSnapshot.forEach(doc => {
                const order = doc.data() as Order;
                const boxId = order.boxId ?? 'unknown';

                if (order.status === OrderStatus.Black) {
                    reportData.completedOrders++;
                    const revenue = order.finalAmount ?? 0;
                    reportData.totalRevenueSmallestUnit += revenue;
                    reportData.totalTipsSmallestUnit += order.tipAmountSmallestUnit ?? 0;
                    reportData.totalUcCoinsUsed += order.ucCoinsUsed ?? 0;
                    reportData.totalCouponDiscountSmallestUnit += order.couponDiscountValue ?? 0;

                    // Revenue by Box
                    if (!reportData.revenueByBox[boxId]) {
                        reportData.revenueByBox[boxId] = { completedOrders: 0, revenue: 0 };
                    }
                    reportData.revenueByBox[boxId].completedOrders++;
                    reportData.revenueByBox[boxId].revenue += revenue;

                    // Revenue by Product
                    order.items.forEach(item => {
                        const productId = item.productId;
                        const itemRevenue = (item.unitPrice * item.quantity); // Use snapshot price
                        if (!reportData.revenueByProduct[productId]) {
                            reportData.revenueByProduct[productId] = { quantitySold: 0, revenue: 0 };
                        }
                        reportData.revenueByProduct[productId].quantitySold += item.quantity;
                        reportData.revenueByProduct[productId].revenue += itemRevenue;
                    });

                } else if (order.status === OrderStatus.Cancelled) {
                    reportData.cancelledOrders++;
                }
            });
            logger.info(`${functionName} Processed ${reportData.totalOrders} orders. Completed: ${reportData.completedOrders}, Cancelled: ${reportData.cancelledOrders}.`);

            // 4. Process Rental Bookings Completed Yesterday
            // Note: We query based on *return* timestamp falling within yesterday
            logger.info(`${functionName} Processing rental bookings...`);
            const rentalsSnapshot = await db.collection('rentalBookings')
                .where('actualReturnTimestamp', '>=', yesterdayStart)
                .where('actualReturnTimestamp', '<=', yesterdayEnd)
                // Optionally filter by status if needed (e.g., only 'Returned' or 'Completed')
                // .where('bookingStatus', '==', RentalBookingStatus.Returned)
                .get();

            reportData.completedRentalBookings = rentalsSnapshot.size; // Assuming query returns only completed ones

            rentalsSnapshot.forEach(doc => {
                const rental = doc.data() as RentalBooking;
                const rentalItemId = rental.rentalItemId ?? 'unknown';
                // Use finalCharge or sum of fees? Let's use finalCharge if available, else sum fees.
                const revenue = rental.finalChargeSmallestUnit ??
                               ((rental.rentalFeeSmallestUnit ?? 0) +
                                (rental.overtimeFeeChargedSmallestUnit ?? 0) +
                                (rental.cleaningFeeChargedSmallestUnit ?? 0) +
                                (rental.damageFeeChargedTotalSmallestUnit ?? 0));

                reportData.totalRentalRevenueSmallestUnit += revenue;

                // Revenue by Rental Item
                if (!reportData.rentalRevenueByItem[rentalItemId]) {
                    reportData.rentalRevenueByItem[rentalItemId] = { completedRentals: 0, revenue: 0 };
                }
                reportData.rentalRevenueByItem[rentalItemId].completedRentals++;
                reportData.rentalRevenueByItem[rentalItemId].revenue += revenue;
            });
             // Get total rental bookings created yesterday (optional metric)
            const totalRentalsCreatedSnapshot = await db.collection('rentalBookings')
                .where('createdAt', '>=', yesterdayStart)
                .where('createdAt', '<=', yesterdayEnd)
                .count().get(); // Use count aggregation
            reportData.totalRentalBookings = totalRentalsCreatedSnapshot.data().count;
            logger.info(`${functionName} Processed rentals. Created: ${reportData.totalRentalBookings}, Completed: ${reportData.completedRentalBookings}.`);


            // 5. Process Event Bookings Completed Yesterday
            // Note: Query based on *actualEndTime* falling within yesterday
            logger.info(`${functionName} Processing event bookings...`);
            const eventsSnapshot = await db.collection('eventBookings')
                .where('actualEndTime', '>=', yesterdayStart)
                .where('actualEndTime', '<=', yesterdayEnd)
                .where('bookingStatus', '==', EventBookingStatus.Completed) // Explicitly filter by completed status
                .get();

            reportData.completedEventBookings = eventsSnapshot.size;

            eventsSnapshot.forEach(doc => {
                const event = doc.data() as EventBooking;
                const revenue = event.totalAmountSmallestUnit ?? 0; // Use the final calculated amount
                reportData.totalEventRevenueSmallestUnit += revenue;
                // Could add revenue breakdown by event type or menu if needed
            });
             // Get total event bookings created yesterday (optional metric)
            const totalEventsCreatedSnapshot = await db.collection('eventBookings')
                .where('createdAt', '>=', yesterdayStart)
                .where('createdAt', '<=', yesterdayEnd)
                .count().get(); // Use count aggregation
            reportData.totalEventBookings = totalEventsCreatedSnapshot.data().count;
            logger.info(`${functionName} Processed events. Created: ${reportData.totalEventBookings}, Completed: ${reportData.completedEventBookings}.`);


            // 6. Count New Customers Created Yesterday
            logger.info(`${functionName} Counting new customers...`);
            try {
                const newCustomersSnapshot = await db.collection('users')
                    .where('createdAt', '>=', yesterdayStart)
                    .where('createdAt', '<=', yesterdayEnd)
                    .where('role', '==', 'Customer') // Ensure they are customers
                    .count().get(); // Use count aggregation API
                reportData.newCustomers = newCustomersSnapshot.data().count;
                logger.info(`${functionName} Found ${reportData.newCustomers} new customers.`);
            } catch (customerCountError) {
                logger.error(`${functionName} Failed to count new customers.`, { error: customerCountError });
                reportData.processingErrors.push("Failed to count new customers.");
            }

            // 7. Save Report to Firestore
            logger.info(`${functionName} Saving report document: dailyReports/${reportDateStr}`);
            // Use set with merge: true to create or overwrite the report for the day
            await reportRef.set(reportData, { merge: true });
            logger.info(`${functionName} Report saved successfully.`);

        } catch (error: any) {
            logger.error(`${functionName} An error occurred during report generation.`, { error: error?.message, stack: error?.stack });
            // Attempt to save partial report with error information
            try {
                reportData.processingErrors.push(`Fatal Error: ${error?.message ?? 'Unknown error'}`);
                reportData.generatedAt = FieldValue.serverTimestamp(); // Update timestamp even on error
                await reportRef.set(reportData, { merge: true });
                 logger.warn(`${functionName} Saved partial report with error information.`);
            } catch (saveError) {
                 logger.error(`${functionName} Failed to save partial report after error.`, { saveError });
            }
        } finally {
            const duration = Date.now() - startTimeFunc;
            logger.info(`${functionName} Execution finished. Duration: ${duration}ms`);
        }
    }
);
