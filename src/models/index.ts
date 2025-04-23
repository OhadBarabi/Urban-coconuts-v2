import * as admin from "firebase-admin";

// --- Enums (Mirroring Backend Logic) ---
export enum Role {
  Customer = "Customer",
  Courier = "Courier",
  Admin = "Admin",
  SuperAdmin = "SuperAdmin",
}

export enum CourierShiftStatus {
  OnDuty = "OnDuty",
  OffDuty = "OffDuty",
  Break = "Break",
}

export enum OrderStatus {
  Red = "Red", // New, Unassigned
  Yellow = "Yellow", // Assigned, Preparing
  Green = "Green", // Ready for Pickup / En Route
  Black = "Black", // Delivered / Completed
  Cancelled = "Cancelled", // Generic Cancelled
}

export enum PaymentMethod {
  CreditCardApp = "CreditCardApp",
  BitApp = "BitApp",
  UC_Coins_Only = "UC_Coins_Only",
  CashOnDelivery = "CashOnDelivery",
  CreditOnDelivery = "CreditOnDelivery",
}

export enum PaymentStatus {
  Pending = "Pending",
  PendingCourier = "PendingCourier", // For Cash/Credit on Delivery
  Authorized = "Authorized",
  Paid = "Paid", // Captured successfully
  Failed = "Failed", // Auth or Capture failed
  Voided = "Voided",
  Captured = "Captured", // Explicit capture state if needed
  Refunded = "Refunded",
  PartiallyRefunded = "PartiallyRefunded",
  CaptureFailed = "CaptureFailed",
  VoidFailed = "VoidFailed",
  RefundFailed = "RefundFailed",
  PaidToCourier = "PaidToCourier", // Cash paid to courier
  Cancelled = "Cancelled", // If order cancelled before payment processed
}

export enum RentalBookingStatus {
    PendingDeposit = "PendingDeposit",
    DepositAuthorized = "DepositAuthorized", // Deposit auth succeeded
    DepositFailed = "DepositFailed",
    AwaitingPickup = "AwaitingPickup", // Deposit OK, ready for pickup
    PickedUp = "PickedUp", // Item collected by customer
    AwaitingReturn = "AwaitingReturn", // Alias for PickedUp? Or separate? Let's use PickedUp
    ReturnOverdue = "ReturnOverdue", // Past expected return time
    ReturnedPendingInspection = "ReturnedPendingInspection", // Returned to box, needs check
    ReturnProcessing = "ReturnProcessing", // Courier processing return
    ReturnCompleted = "ReturnCompleted", // Return processed, final payment calculated
    AwaitingFinalPayment = "AwaitingFinalPayment", // Final payment pending
    PaymentFailed = "PaymentFailed", // Final payment failed
    Completed = "Completed", // Final payment successful
    Cancelled = "Cancelled", // Cancelled before pickup
    RequiresManualReview = "RequiresManualReview", // Error state
}

export enum EventBookingStatus {
    PendingAdminApproval = "PendingAdminApproval",
    PendingCustomerAgreement = "PendingCustomerAgreement",
    Confirmed = "Confirmed",
    Preparing = "Preparing",
    InProgress = "InProgress",
    Delayed = "Delayed",
    Completed = "Completed",
    CancelledByAdmin = "CancelledByAdmin",
    CancelledByCustomer = "CancelledByCustomer",
    RequiresAdminAttention = "RequiresAdminAttention",
    RequiresManualReview = "RequiresManualReview", // For payment/GCal failures
}

export enum EventItemType {
    Product = "Product",
    Package = "Package",
    Service = "Service",
    Rental = "Rental",
}

export enum EventResourceType {
    Team = "Team",
    Vehicle = "Vehicle",
    Equipment = "Equipment",
    StaffMember = "StaffMember",
}

// --- Helper Interfaces ---
export interface I18nMap {
  [langCode: string]: string;
}

export interface GeoPointJson { // For API input/output if not using Firestore types directly
  latitude: number;
  longitude: number;
}

export interface OperatingHoursRule {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

export interface OperatingHoursMap {
  // Keys like "Mon", "Tue" etc. or 0-6 for Sun-Sat
  [day: string]: OperatingHoursRule;
}

export interface StatusHistoryEntry {
  status?: string; // The status being set
  timestamp: admin.firestore.Timestamp;
  userId?: string | null; // User who triggered the change
  role?: string | null; // Role of the user
  reason?: string | null; // Optional reason for change
  // For Order Status specific
  from?: string; // Previous status
  to?: string; // New status
}

export interface PaymentDetails {
  // Common fields
  gatewayName?: string | null;
  currencyCode?: string | null;

  // Authorization (Deposit or Initial Auth)
  authTimestamp?: admin.firestore.Timestamp | null;
  gatewayTransactionId?: string | null; // Auth ID
  authAmountSmallestUnit?: number | null; // Amount authorized
  authSuccess?: boolean | null;
  authError?: string | null;

  // Charge / Capture
  chargeTimestamp?: admin.firestore.Timestamp | null;
  chargeTransactionId?: string | null; // Capture/Charge ID
  chargeAmountSmallestUnit?: number | null; // Amount captured/charged
  chargeSuccess?: boolean | null;
  chargeError?: string | null;

  // Void
  voidTimestamp?: admin.firestore.Timestamp | null;
  voidSuccess?: boolean | null;
  voidError?: string | null;

  // Refund
  refundTimestamp?: admin.firestore.Timestamp | null;
  refundId?: string | null; // Refund transaction ID from gateway
  refundAmountSmallestUnit?: number | null; // Amount refunded
  refundSuccess?: boolean | null;
  refundError?: string | null;

  // Settlement / Finalization (e.g., for rentals)
  settlementTimestamp?: admin.firestore.Timestamp | null;
  settlementTransactionId?: string | null; // ID of final charge/refund if different
  settlementAmountSmallestUnit?: number | null; // Net amount settled
  settlementSuccess?: boolean | null;
  settlementError?: string | null;
  finalizationSuccess?: boolean | null; // Flag from confirmAgreement

  // Cash related
  cashPaymentReceived?: boolean | null;
  cashReceivedTimestamp?: admin.firestore.Timestamp | null;
  cashReceivingCourierId?: string | null;
}

export interface AdminApprovalDetails {
    status: "Approved" | "Rejected" | "ApprovedWithChanges" | "Pending";
    adminUserId?: string | null; // User who performed action
    timestamp?: admin.firestore.Timestamp | null;
    notes?: string | null;
}

// --- Firestore Document Interfaces (V5) ---

export interface User {
  uid: string;
  email?: string | null;
  phoneNumber: string;
  displayName?: string | null;
  photoURL?: string | null;
  role: Role | string;
  permissions?: string[] | null;
  groups?: string[] | null;
  isActive: boolean;
  isMfaEnabled?: boolean;
  // mfaSecret: string | null; // Should not be directly in DB model if possible
  preferredLanguage?: string | null;
  createdAt: admin.firestore.Timestamp;
  lastLoginTimestamp?: admin.firestore.Timestamp | null;
  vipTier?: string | null;
  vipTierLastCalculated?: admin.firestore.Timestamp | null;
  ucCoinBalance?: number; // Integer
  paymentGatewayCustomerId?: string | null;
  inactivityFlag?: string | null;
  updatedAt?: admin.firestore.Timestamp;

  // Courier specific fields (only if role === Role.Courier)
  shiftStatus?: CourierShiftStatus | string;
  currentShiftId?: string | null;
  currentBoxId?: string | null;
  assignedBoxIds?: string[] | null; // V5
  cashOnHand?: number; // Integer
  pickupTimeBufferMinutes?: number | null; // Integer, V5
  averageRating?: number | null;
  ratingCount?: number | null;
  ratingLastCalculated?: admin.firestore.Timestamp | null;
}

export interface Box {
  boxNumber: string; // V5
  boxName_i18n?: I18nMap | null;
  location: admin.firestore.GeoPoint; // For GeoFirestore
  g?: { geohash: string; geopoint: admin.firestore.GeoPoint }; // Field added by GeoFirestore
  isActive: boolean;
  isCustomerVisible: boolean;
  priority: number; // V5
  colorCode?: string | null;
  currencyCode: string;
  countryCode?: string;
  address?: string | null;
  assignedCourierId?: string | null; // Ref: users
  assignedMenuIds?: string[] | null; // Assume sorted by menu priority
  hiddenProductIds?: string[] | null;
  operatingHours?: OperatingHoursMap | null;
  inventory?: { [productId: string]: number }; // Map<String, Integer>
  createdAt?: admin.firestore.Timestamp;
  updatedAt?: admin.firestore.Timestamp;
}

export interface Menu {
  menuName_i18n: I18nMap;
  description_i18n?: I18nMap | null;
  imageUrl?: string | null;
  priority: number; // V5
  isActive: boolean;
  isEventMenu?: boolean;
  availableProducts?: string[] | null; // Array of product IDs
  applicableEventTypes?: string[] | null;
  minOrderValueSmallestUnit?: number | null; // Integer
  createdAt?: admin.firestore.Timestamp;
  updatedAt?: admin.firestore.Timestamp;
}

export interface Product {
  productName_i18n: I18nMap;
  description_i18n?: I18nMap | null;
  imageUrl?: string | null;
  category?: string | null;
  priceSmallestUnit: number; // Integer
  tags?: string[] | null; // V5
  priority: number; // V5
  isActive: boolean;
  allergens?: string[] | null;
  nutritionalInfo?: { [key: string]: any }; // Map
  createdAt?: admin.firestore.Timestamp;
  updatedAt?: admin.firestore.Timestamp;
}

export interface OrderItem {
  orderItemId: string; // Unique ID within the order
  productId: string; // Ref: products
  productName: string; // Snapshot (translated based on user pref at time of order?)
  quantity: number; // Integer
  unitPrice: number; // Integer, Snapshot
  itemStatus?: string; // e.g., "PickedUp", "Missing"
}

export interface Order {
  orderNumber?: string;
  customerId: string; // Ref: users
  courierId?: string | null; // Ref: users
  boxId: string; // Ref: boxes
  items: OrderItem[];
  status: OrderStatus | string;
  statusHistory?: StatusHistoryEntry[];
  paymentMethod: PaymentMethod | string;
  paymentStatus: PaymentStatus | string;
  currencyCode: string;
  authDetails?: PaymentDetails | null; // Store initial auth details here
  paymentDetails?: PaymentDetails | null; // Store final charge/refund details here
  totalAmount: number; // Integer, sum of item prices
  ucCoinsUsed?: number | null; // Integer
  couponCodeUsed?: string | null;
  couponDiscountValue?: number; // Integer
  tipAmountSmallestUnit?: number | null; // Integer
  finalAmount: number; // Integer, final amount charged/to be charged
  orderTimestamp: admin.firestore.Timestamp;
  deliveredTimestamp?: admin.firestore.Timestamp | null;
  pickupTimeWindow?: { start: admin.firestore.Timestamp; end: admin.firestore.Timestamp };
  notes?: string | null;
  issueReported?: boolean;
  issueDetails?: { reportedAt: admin.firestore.Timestamp; reason: string; resolution?: string };
  orderQrCodeData?: string;
  cancellationSideEffectsProcessed?: boolean;
  createdAt?: admin.firestore.Timestamp;
  updatedAt?: admin.firestore.Timestamp;
}

export interface RentalItem {
  itemName_i18n: I18nMap;
  description_i18n?: I18nMap | null;
  imageUrl?: string | null;
  rentalFeeSmallestUnit: number; // Integer
  depositSmallestUnit: number; // Integer
  currencyCode?: string;
  isActive: boolean;
  attributes?: { [key: string]: any }; // Map
  createdAt?: admin.firestore.Timestamp;
  updatedAt?: admin.firestore.Timestamp;
}

export interface RentalBooking {
  customerId: string; // Ref: users
  rentalItemId: string; // Ref: rentalItems
  bookingStatus: RentalBookingStatus | string;
  pickupBoxId: string; // Ref: boxes
  returnBoxId?: string | null; // Ref: boxes
  pickupCourierId?: string | null; // Ref: users
  returnCourierId?: string | null; // Ref: users
  pickupTimestamp?: admin.firestore.Timestamp | null;
  expectedReturnTimestamp?: admin.firestore.Timestamp | null;
  actualReturnTimestamp?: admin.firestore.Timestamp | null;
  returnedCondition?: "OK" | "Dirty" | "Damaged" | string | null;
  rentalFeeSmallestUnit: number; // Integer, Snapshot
  depositSmallestUnit: number; // Integer, Snapshot
  currencyCode: string;
  paymentStatus: PaymentStatus | string;
  paymentDetails?: PaymentDetails | null; // Holds deposit auth/capture/void/refund
  finalChargeSmallestUnit?: number | null; // Integer, final calculated charge (rental + fees)
  overtimeFeeChargedSmallestUnit?: number | null; // Integer
  cleaningFeeChargedSmallestUnit?: number | null; // Integer
  damageFeeChargedTotalSmallestUnit?: number | null; // Integer
  depositProcessed?: boolean; // Flag for background function
  processingError?: string | null;
  createdAt?: admin.firestore.Timestamp;
  updatedAt?: admin.firestore.Timestamp;
}

export interface EventBookingItem {
    bookingItemId: string; // Unique ID for this line item within the booking
    itemId: string; // Original item ID (product, service, package, rental type)
    itemType: EventItemType | string;
    productName: string; // Snapshot (translated)
    quantity?: number | null; // INTEGER
    durationHours?: number | null; // Number
    calculatedPriceSmallestUnit: number; // INTEGER - Total price for this line
    appliedUnitPriceSmallestUnit?: number | null; // INTEGER - Unit/hourly rate applied
    productId?: string | null; // Link back to original product/rentalItem if needed
    // Runtime fields for rentals within events (if applicable)
    returned?: boolean;
    pickupTimestamp?: admin.firestore.Timestamp | null;
    expectedReturnTimestamp?: admin.firestore.Timestamp | null;
    actualReturnTimestamp?: admin.firestore.Timestamp | null;
    returnedCondition?: string | null;
    returnBoxId?: string | null;
}

export interface EventBooking {
    customerId: string; // Ref: users
    eventDate: admin.firestore.Timestamp;
    startTime: admin.firestore.Timestamp;
    endTime: admin.firestore.Timestamp;
    durationMinutes?: number; // Calculated
    location: { address: string; coordinates?: admin.firestore.GeoPoint | null; zoneId?: string | null; notes?: string | null };
    eventMenuId?: string | null; // Ref: menus
    selectedItems: EventBookingItem[]; // Use the detailed interface
    totalAmountSmallestUnit: number; // INTEGER
    currencyCode: string;
    minOrderRequirementMet?: boolean;
    bookingStatus: EventBookingStatus | string;
    statusChangeHistory?: StatusHistoryEntry[];
    adminApprovalDetails?: AdminApprovalDetails | null;
    agreementSentTimestamp?: admin.firestore.Timestamp | null;
    agreementConfirmedTimestamp?: admin.firestore.Timestamp | null;
    paymentStatus: PaymentStatus | string;
    paymentDetails?: PaymentDetails | null; // Details of the upfront payment
    cancellationFeeAppliedSmallestUnit?: number | null; // INTEGER
    cancellationTimestamp?: admin.firestore.Timestamp | null;
    cancelledBy?: "Customer" | "Admin" | "SystemAuto" | string | null;
    cancellationReason?: string | null;
    assignedResources?: { [resourceType: string]: string[] } | null; // Map<Type, Array<ID>>
    assignedLeadCourierId?: string | null; // Ref: users (if applicable)
    actualStartTime?: admin.firestore.Timestamp | null;
    actualEndTime?: admin.firestore.Timestamp | null;
    lastDelayReason?: string | null;
    customerFeedbackId?: string | null; // Ref: userFeedback
    googleCalendarEventId?: string | null;
    needsManualGcalCheck?: boolean | null;
    needsManualGcalDelete?: boolean | null;
    processingError?: string | null;
    createdAt?: admin.firestore.Timestamp;
    updatedAt?: admin.firestore.Timestamp;
}

export interface EventResource {
    resourceType: EventResourceType | string;
    name: string;
    details?: { [key: string]: any }; // Map
    email?: string | null; // For attendees
    baseLocation?: admin.firestore.GeoPoint | null;
    isActive: boolean;
    createdAt?: admin.firestore.Timestamp;
    updatedAt?: admin.firestore.Timestamp;
}

export interface Shift {
    courierId: string; // Ref: users
    boxId: string; // Ref: boxes
    startTime: admin.firestore.Timestamp;
    endTime?: admin.firestore.Timestamp | null;
    startCashSmallestUnit: number; // Integer
    endCashSmallestUnit?: number | null; // Integer
    expectedEndCashSmallestUnit?: number | null; // Integer
    cashDifferenceSmallestUnit?: number | null; // Integer
    isConfirmedByAdmin?: boolean;
    confirmationTimestamp?: admin.firestore.Timestamp | null;
    confirmingAdminId?: string | null;
    notes?: string | null;
    createdAt?: admin.firestore.Timestamp;
    updatedAt?: admin.firestore.Timestamp;
}

export interface RoleDoc {
    roleName?: string;
    description?: string | null;
    permissions: string[];
}

export interface PermissionDoc {
    description?: string | null;
    category?: string | null;
}

export interface AppConfigGeneral {
    defaultCurrencyCode?: string;
    defaultPickupTimeBufferMinutes?: number; // V5
    logRetentionDays?: number;
    inactivityThresholdDays?: number;
    supportedLanguages?: string[];
    standardTags?: string[]; // V5
}
// Define interfaces for other appConfig documents as needed
export interface AppConfigTipSettings {
    tipEnabled?: boolean;
    tipOptionsPercentage?: number[];
    allowCustomTip?: boolean;
}
export interface AppConfigMatRentalSettings {
    overtimeIntervalMinutes?: number;
    overtimeFeeSmallestUnit?: number;
    cleaningFeeSmallestUnit?: number;
    allowedReturnRadiusKm?: number;
    maxReturnResults?: number;
}
export interface AppConfigEventSettings {
    minOrderValueSmallestUnit?: { [currency: string]: number }; // Map<String, Integer>
    cancellationFeeSmallestUnit?: { [currency: string]: number }; // Map<String, Integer>
    cancellationWindowHours?: number;
    validLocationZones?: any[]; // Define Zone structure if used
    defaultEventDurationMinutes?: number;
    maxBookingLeadTimeDays?: number;
    minBookingLeadTimeDays?: number;
    requiresAdminApproval?: boolean;
    googleCalendarIntegrationEnabled?: boolean;
    targetCalendarIds?: { [resourceTypeOrKey: string]: string }; // Map<String, String>
    timeZone?: string; // e.g., 'Asia/Jerusalem'
}
export interface AppConfigAlertRules {
    velocityCheckPeriodMinutes?: number;
    highSalesThreshold?: number;
    staleInventoryPeriodDays?: number;
    minStockForStaleCheck?: number;
    lowSalesThresholdForStale?: number;
}
export interface AppConfigVipSettings {
    lookbackDays?: number;
    rules?: { tier: string; minSpending?: number; minOrders?: number }[];
}
export interface AppConfigRatingSettings {
    ratingLookbackPeriodDays?: number;
    minRatingsForAverage?: number;
}


export interface PromoCode {
    couponCode?: string | null;
    description?: string | null;
    isActive: boolean;
    validFrom?: admin.firestore.Timestamp | null;
    validUntil?: admin.firestore.Timestamp | null;
    maxTotalUses?: number | null;
    currentTotalUses?: number;
    maxUsesPerUser?: number | null;
    targetAudienceRules?: { [key: string]: any }; // Map
    allowCombining?: boolean;
    discountDetails: { type: "percentage" | "fixedAmount"; percentageValue?: number | null; fixedAmountSmallestUnit?: number | null };
    minOrderValueSmallestUnit?: number | null; // Integer
    createdAt?: admin.firestore.Timestamp;
    updatedAt?: admin.firestore.Timestamp;
}

export interface UserFeedback {
    bookingId: string; // Ref: orders or eventBookings
    bookingType: "Order" | "Event" | string;
    customerId: string; // Ref: users
    courierId?: string | null; // Ref: users
    rating: number; // e.g., 1-5
    comments?: string | null;
    tags?: string[] | null;
    timestamp: admin.firestore.Timestamp;
}

export interface ActivityLog {
    timestamp: admin.firestore.Timestamp;
    userId: string; // User performing action or system
    userRole?: string | null;
    action: string; // e.g., "CreateOrder", "UpdateBoxStatus"
    details: { [key: string]: any }; // Map with context
    ipAddress?: string | null;
    userAgent?: string | null;
}

export interface DailyReport {
    reportDate: string; // YYYY-MM-DD
    generationTimestamp: admin.firestore.Timestamp;
    totalRevenueSmallestUnit: number; // Integer
    totalOrders: number;
    totalTipsSmallestUnit?: number; // Integer
    revenueByCurrency?: { [currency: string]: number }; // Map<String, Integer>
    ordersByCurrency?: { [currency: string]: number }; // Map<String, Integer>
    paymentMethodCounts?: { [method: string]: number }; // Map<String, Integer>
    revenueByBox?: { [boxId: string]: number }; // Map<String, Integer>
    ordersByBox?: { [boxId: string]: number }; // Map<String, Integer>
    averageOrderValueSmallestUnit?: number; // Integer
    // Add more aggregated fields as needed
}
