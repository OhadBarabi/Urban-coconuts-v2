import * as admin from 'firebase-admin';

/** Enum representing possible user roles. */
export enum UserRole {
  Admin = 'Admin',
  Manager = 'Manager',
  Courier = 'Courier',
  Customer = 'Customer',
  EventStaff = 'EventStaff',
}

/** Enum representing permission keys for various actions. */
export enum PermissionKey {
  UserCreate = 'user:create',
  UserRead = 'user:read',
  UserUpdate = 'user:update',
  UserDelete = 'user:delete',
  RoleManage = 'role:manage',
  ProductManage = 'product:manage',
  OrderCreate = 'order:create',
  OrderUpdateStatus = 'order:updateStatus',
  RentalCreate = 'rental:create',
  RentalManage = 'rental:manage',
  RentalConfirmPickup = 'rental:confirmPickup',
  RentalConfirmReturn = 'rental:confirmReturn',
  EventManage = 'event:manage',
  ReportView = 'report:view',
  SystemConfig = 'system:config',
  CourierManageShifts = 'courier:manageShifts',
  BoxManageInventory = 'box:manageInventory',
}

/** Interface representing a user in the system. */
export interface User {
  /** Unique identifier for the user. */
  userId: string;
  /** User's email address. */
  email: string;
  /** User's phone number (optional). */
  phoneNumber?: string;
  /** User's first name. */
  firstName: string;
  /** User's last name. */
  lastName: string;
  /** User's role. */
  role: UserRole;
  /** Indicates if the user is active. */
  isActive: boolean;
  /** Timestamp indicating when the user was created. */
  createdAt: admin.firestore.Timestamp;
  /** Timestamp indicating when the user was last updated. */
  updatedAt: admin.firestore.Timestamp;
  /** Payment gateway customer ID (optional). */
  paymentGatewayCustomerId?: string;
  /** VIP tier (optional). */
  vipTier?: string;
  /** Indicates if multi-factor authentication is enabled. */
  mfaEnabled: boolean;
}

/** Interface representing a role with associated permissions. */
export interface Role {
  /** Unique identifier for the role (same as UserRole). */
  roleId: UserRole;
  /** Display name of the role. */
  displayName: string;
  /** Array of permission keys granted to the role. */
  permissions: PermissionKey[];
}

/** Interface representing a box location. */
export interface Box {
  /** Unique identifier for the box. */
  boxId: string;
  /** Name of the box. */
  name: string;
  /** Geo location of the box. */
  location: admin.firestore.GeoPoint;
  /** Address of the box. */
  address: string;
  /** Indicates if the box is active. */
  isActive: boolean;
  /** Currency code used by the box. */
  currencyCode: string;
  /** Rental inventory mapping (rental item ID to quantity). */
  rentalInventory: { [rentalItemId: string]: number };
  /** Operating hours of the box (optional). */
  operatingHours?: object;
  /** Notes for the box (optional). */
  notes?: string;
  /** Timestamp indicating when the box was created. */
  createdAt: admin.firestore.Timestamp;
  /** Timestamp indicating when the box was last updated. */
  updatedAt: admin.firestore.Timestamp;
}

export enum FeeInterval {
  Hourly = 'Hourly',
  Daily = 'Daily',
  Weekly = 'Weekly',
}

/** Interface representing a rental item. */
export interface RentalItem {
  /** Unique identifier for the rental item. */
  rentalItemId: string;
  /** Name of the rental item. */
  name: string;
  /** Description of the rental item (optional). */
  description?: string;
  /** Category of the rental item. */
  category: string;
  /** Image URL of the rental item (optional). */
  imageUrl?: string;
  /** Deposit for the rental item (in smallest unit). */
  depositSmallestUnit: number;
  /** Rental fee for the item (in smallest unit). */
  rentalFeeSmallestUnit: number;
  /** Fee interval for the item (Hourly, Daily, Weekly). */
  feeInterval: FeeInterval;
  /** Currency code used for the rental item. */
  currencyCode: string;
  /** Indicates if the rental item is active. */
  isActive: boolean;
  /** Indicates if the rental item requires cleaning. */
  requiresCleaning: boolean;
  /** Attributes for the rental item (optional). */
  attributes?: object;
  /** Timestamp indicating when the rental item was created. */
  createdAt: admin.firestore.Timestamp;
  /** Timestamp indicating when the rental item was last updated. */
  updatedAt: admin.firestore.Timestamp;
}

/** Enum representing possible rental booking statuses. */
export enum RentalBookingStatus {
  PendingPickup = 'PendingPickup',
  Active = 'Active',
  PendingReturn = 'PendingReturn',
  Completed = 'Completed',
  Cancelled = 'Cancelled',
  Overdue = 'Overdue',
}

/** Enum representing possible payment statuses. */
export enum PaymentStatus {
  Pending = 'Pending',
  Authorized = 'Authorized',
  Captured = 'Captured',
  Voided = 'Voided',
  Refunded = 'Refunded',
  PartiallyRefunded = 'PartiallyRefunded',
  Failed = 'Failed',
  ActionRequired = 'ActionRequired',
  AuthorizationPending = 'AuthorizationPending',
  AuthorizationFailed = 'AuthorizationFailed',
  CaptureFailed = 'CaptureFailed',
  VoidFailed = 'VoidFailed',
}

/** Interface for payment details */
export interface PaymentDetails {
    transactionId: string;
    gateway: string;
    amountSmallestUnit: number;
    currencyCode: string;
    status: PaymentStatus;
    timestamp: admin.firestore.Timestamp;
    paymentMethodType: string;
    last4?: string;
    authorizationId?: string;
    captureId?: string;
    voidId?: string;
    refundDetails?: RefundDetails[];
    errorCode?: string;
    errorMessage?: string;
}

/** Interface for refund details */
export interface RefundDetails {
  refundId: string;
  amountSmallestUnit: number;
  currencyCode: string;
  timestamp: admin.firestore.Timestamp;
  reason?: string;
}

/** Enum representing who initiated a cancellation. */
 export enum CancellationInitiator {
   Customer = 'Customer',
   System = 'System',
   Staff = 'Staff',
 }

/** Interface representing cancellation details for bookings or orders. */
export interface CancellationDetails {
  cancelledBy: CancellationInitiator;
  cancellationReason?: string;
  cancellationTimestamp: admin.firestore.Timestamp;
  refundProcessed: boolean;
  refundDetails?: RefundDetails;
}

/** Interface representing a rental booking. */
export interface RentalBooking {
  /** Unique identifier for the booking. */
  bookingId: string;
  /** Customer who made the booking. */
  customerId: string;
  /** Rental item being booked. */
  rentalItemId: string;
  /** Status of the rental booking. */
  bookingStatus: RentalBookingStatus;
  /** Box where the item will be picked up. */
  pickupBoxId: string;
  /** Box where the item should be returned (optional). */
  returnBoxId?: string;
  /** Timestamp for when the item should be picked up (optional). */
  pickupTimestamp?: admin.firestore.Timestamp;
  /** Timestamp for when the item should be returned (optional). */
  expectedReturnTimestamp?: admin.firestore.Timestamp;
  /** Timestamp for when the item was actually returned (optional). */
  actualReturnTimestamp?: admin.firestore.Timestamp;
  /** Timestamp indicating when the booking was created. */
  createdAt: admin.firestore.Timestamp;
  /** Timestamp indicating when the booking was last updated. */
  updatedAt: admin.firestore.Timestamp;
  /** Deposit for the booking (in smallest unit). */
  depositSmallestUnit: number;
  /** Currency code used for the booking. */
  currencyCode: string;
  /** Payment status for this booking. */
  paymentStatus: PaymentStatus;
  /** Payment details for this booking. */
  paymentDetails?: PaymentDetails;
  /** Final charge for the booking, after return (optional, in smallest unit) */
  finalChargeSmallestUnit?: number;
  /** Payment details for the final charge (optional) */
  finalChargePaymentDetails?: PaymentDetails;
  /** Cancellation details if the booking is cancelled (optional). */
  cancellationDetails?: CancellationDetails;
  /** Notes from courier on return, if any. */
  courierNotesOnReturn?: string;
  /** Condition of the item when returned, if any. */
  returnedCondition?: string;
  /** Courier who did the pickup. */
  pickupCourierId?: string;
  /** Courier who did the return. */
  returnCourierId?: string;
  /** Url of the returned condition photo */
  returnedConditionPhotoUrl?: string;
}

/** Interface representing an order item. */
export interface OrderItem {
  /** Product in order. */
  productId: string;
  /** Quantity of the product. */
  quantity: number;
  /** Unit price of the product (in smallest unit). */
  unitPriceSmallestUnit: number;
  /** Name of the product */
  productName: string;
  /** Customizations made to the order (optional). */
  customization?: object;
}

/** Enum representing possible order statuses. */
export enum OrderStatus {
  Pending = 'Pending',
  Confirmed = 'Confirmed',
  Preparing = 'Preparing',
  ReadyForPickup = 'ReadyForPickup',
  OutForDelivery = 'OutForDelivery',
  Delivered = 'Delivered',
  Cancelled = 'Cancelled',
  Failed = 'Failed',
}

/** Interface representing an order. */
export interface Order {
  /** Unique identifier for the order. */
  orderId: string;
  /** Customer who made the order. */
  customerId: string;
  /** Box associated with the order (optional). */
  boxId?: string;
  /** Status of the order. */
  orderStatus: OrderStatus;
  /** Items in the order. */
  items: OrderItem[];
  /** Subtotal of the order (in smallest unit). */
  subtotalSmallestUnit: number;
  /** Tax applied to the order (in smallest unit). */
  taxSmallestUnit: number;
  /** Tip added to the order (optional, in smallest unit). */
  tipSmallestUnit?: number;
  /** Total amount of the order (in smallest unit). */
  totalSmallestUnit: number;
  /** Currency code used for the order. */
  currencyCode: string;
  /** Payment status for this order. */
  paymentStatus: PaymentStatus;
  /** Payment details for this order. */
  paymentDetails?: PaymentDetails;
  /** Delivery address for the order (optional). */
  deliveryAddress?: string;
  /** Delivery location for the order (optional). */
  deliveryLocation?: admin.firestore.GeoPoint;
  /** Scheduled pickup time for the order (optional). */
  scheduledPickupTime?: admin.firestore.Timestamp;
  /** Actual pickup time for the order (optional). */
  actualPickupTime?: admin.firestore.Timestamp;
  /** Timestamp indicating when the order was created. */
  createdAt: admin.firestore.Timestamp;
  /** Timestamp indicating when the order was last updated. */
  updatedAt: admin.firestore.Timestamp;
  /** Cancellation details if the order is cancelled (optional). */
  cancellationDetails?: CancellationDetails;
}

/** Interface representing a product. */
export interface Product {
  /** Unique identifier for the product. */
  productId: string;
  /** Name of the product. */
  name: string;
  /** Description of the product (optional). */
  description?: string;
  /** Price of the product (in smallest unit). */
  priceSmallestUnit: number;
  /** Currency code used for the product. */
  currencyCode: string;
  /** Category of the product. */
  category: string;
  /** Image URL of the product (optional). */
  imageUrl?: string;
  /** Indicates if the product is active. */
  isActive: boolean;
  /** Boxes where the product is available (optional). */
  availableAtBoxes?: string[];
  /** Allergens in the product (optional). */
  allergens?: string[];
  /** Timestamp indicating when the product was created. */
  createdAt: admin.firestore.Timestamp;
  /** Timestamp indicating when the product was last updated. */
  updatedAt: admin.firestore.Timestamp;
}

/** Interface representing a menu. */
export interface Menu {
  /** Unique identifier for the menu. */
  menuId: string;
  /** Name of the menu. */
  name: string;
  /** Description of the menu (optional). */
  description?: string;
  /** Products in the menu. */
  productIds: string[];
  /** Boxes where the menu is applicable (optional). */
  applicableBoxIds?: string[];
  /** Indicates if the menu is active. */
  isActive: boolean;
  /** Timestamp indicating when the menu was created. */
  createdAt: admin.firestore.Timestamp;
  /** Timestamp indicating when the menu was last updated. */
  updatedAt: admin.firestore.Timestamp;
}

/** Enum representing possible event statuses. */
export enum EventStatus {
  PendingConfirmation = 'PendingConfirmation',
  Confirmed = 'Confirmed',
  Preparation = 'Preparation',
  Active = 'Active',
  Completed = 'Completed',
  Cancelled = 'Cancelled',
}

/** Interface representing the event agreement details. */
export interface EventAgreement {
  signedByCustomer: boolean;
  signedTimestamp?: admin.firestore.Timestamp;
  agreementUrl?: string;
}

/** Interface representing an event booking. */
export interface EventBooking {
  /** Unique identifier for the event booking. */
  eventBookingId: string;
  /** Customer who made the event booking. */
  customerId: string;
  /** Type of the event. */
  eventType: string;
  /** Date of the event. */
  eventDate: admin.firestore.Timestamp;
  /** Duration of the event (in hours). */
  durationHours: number;
  /** Location of the event. */
  location: string;
  /** Number of guests for the event. */
  numberOfGuests: number;
  /** Menu selected for the event (optional). */
  menuId?: string;
  /** Special requests for the event (optional). */
  specialRequests?: string;
  /** Total price of the event (in smallest unit). */
  totalPriceSmallestUnit: number;
  /** Currency code used for the event. */
  currencyCode: string;
  /** Payment status for this event. */
  paymentStatus: PaymentStatus;
  /** Payment details for this event. */
  paymentDetails?: PaymentDetails;
  /** Status of the event. */
  eventStatus: EventStatus;
  /** Assigned staff members for the event (optional). */
  assignedStaffIds?: string[];
  /** Timestamp indicating when the event booking was created. */
  createdAt: admin.firestore.Timestamp;
  /** Timestamp indicating when the event booking was last updated. */
  updatedAt: admin.firestore.Timestamp;
  /** Cancellation details if the event booking is cancelled (optional). */
  cancellationDetails?: CancellationDetails;
  /** Event agreement data. */
  agreement?: EventAgreement;
}

/** Enum representing discount types for promo codes. */
export enum DiscountType {
  Percentage = 'Percentage',
  FixedAmount = 'FixedAmount',
}

/** Interface representing a promo code. */
export interface PromoCode {
  /** Unique code for the promo. */
  code: string;
  /** Description of the promo code. */
  description: string;
  /** Type of discount (Percentage or FixedAmount). */
  discountType: DiscountType;
  /** Value of the discount. */
  discountValue: number;
  /** Currency code for FixedAmount discounts (optional). */
  currencyCode?: string;
  /** Applicable product IDs (optional). */
  applicableProductIds?: string[];
  /** Applicable rental item IDs (optional). */
  applicableRentalItemIds?: string[];
  /** Minimum order value for the promo code (optional). */
  minOrderValueSmallestUnit?: number;
  /** Maximum number of uses for the promo code (optional). */
  maxUses?: number;
  /** Number of times the promo code has been used. */
  usesCount: number;
  /** Timestamp indicating when the promo code is valid from. */
  validFrom: admin.firestore.Timestamp;
  /** Timestamp indicating when the promo code is valid until. */
  validUntil: admin.firestore.Timestamp;
  /** Indicates if the promo code is active. */
  isActive: boolean;
  /** Timestamp indicating when the promo code was created. */
  createdAt: admin.firestore.Timestamp;
}

/** Interface representing a shift. */
export interface Shift {
  /** Unique identifier for the shift. */
  shiftId: string;
  /** Courier assigned to the shift. */
  courierId: string;
  /** Timestamp indicating the start of the shift. */
  startTimestamp: admin.firestore.Timestamp;
  /** Timestamp indicating the end of the shift (optional). */
  endTimestamp?: admin.firestore.Timestamp;
  /** Box where the shift starts. */
  startBoxId: string;
  /** Box where the shift ends (optional). */
  endBoxId?: string;
  /** Total earnings for the shift (optional, in smallest unit). */
  totalEarningsSmallestUnit?: number;
  /** Currency code for the shift. */
  currencyCode: string;
  /** Notes for the shift (optional). */
  notes?: string;
}

/** Enum representing actions for inventory logs. */
export enum InventoryLogAction {
  StockIn = 'StockIn',
  StockOut = 'StockOut',
  Adjustment = 'Adjustment',
  TransferIn = 'TransferIn',
  TransferOut = 'TransferOut',
  Sale = 'Sale',
  RentalPickup = 'RentalPickup',
  RentalReturn = 'RentalReturn',
}

/** Interface representing an inventory log. */
export interface InventoryLog {
  /** Unique identifier for the inventory log. */
  logId: string;
  /** Timestamp indicating when the log was created. */
  timestamp: admin.firestore.Timestamp;
  /** User who performed the action. */
  userId: string;
  /** Action performed. */
  action: InventoryLogAction;
  /** Product related to the action (optional). */
  productId?: string;
  /** Rental item related to the action (optional). */
  rentalItemId?: string;
  /** Box where the action occurred. */
  boxId: string;
  /** Change in quantity. */
  quantityChange: number;
  /** Reason for the action (optional). */
  reason?: string;
  /** Related Order ID, if any. */
  relatedOrderId?: string;
  /** Related Rental Booking ID, if any. */
  relatedBookingId?: string;
}

/** Enum representing notification types. */
export enum NotificationType {
  Info = 'Info',
  Warning = 'Warning',
  Error = 'Error',
  OrderUpdate = 'OrderUpdate',
  RentalUpdate = 'RentalUpdate',
  EventUpdate = 'EventUpdate',
}

/** Interface representing a notification. */
export interface Notification {
  /** Unique identifier for the notification. */
  notificationId: string;
  /** User who should receive the notification. */
  userId: string;
  /** Title of the notification. */
  title: string;
  /** Message of the notification. */
  message: string;
  /** Type of the notification. */
  type: NotificationType;
  /** Indicates if the notification has been read. */
  read: boolean;
  /** Timestamp indicating when the notification was created. */
  createdAt: admin.firestore.Timestamp;
  /** ID of a related entity, if any. */
  relatedEntityId?: string;
  /** Type of a related entity, if any. */
  relatedEntityType?: string;
}

/** Interface representing an audit log. */
export interface AuditLog {
  /** Unique identifier for the audit log. */
  logId: string;
  /** Timestamp indicating when the action occurred. */
  timestamp: admin.firestore.Timestamp;
  /** User who performed the action. */
  userId: string;
    /** User's email (optional)*/
  userEmail?: string;
  /** Action performed. */
  action: string;
  /** Type of entity related to the action. */
  entityType: string;
  /** ID of the entity related to the action. */
  entityId: string;
  /** Changes made to the entity. */
  changes: object;
  /** IP address of the user who performed the action (optional). */
  ipAddress?: string;
}

/** Interface representing multi-factor authentication configuration. */
export interface MfaConfig {
    /** Unique identifier of the user. */
    userId: string;
    /** Encrypted MFA secret. */
    secret: string;
    /** Encrypted backup codes. */
    backupCodes: string[];
    /** Indicates whether MFA is confirmed */
    confirmed: boolean;
}

/** Enum representing OTP types. */
export enum OtpType {
    Login = 'Login',
    PasswordReset = 'PasswordReset',
    MfaSetup = 'MfaSetup',
}

/** Interface representing a One Time Password */
export interface Otp {
    otpId: string;
    userId: string;
    code: string;
    expiresAt: admin.firestore.Timestamp;
    used: boolean;
    type: OtpType;
}

/** Interface representing a VIP Tier. */
export interface VipTier {
    /** Unique identifier of the vip tier */
    tierId: string;
    /** Name of the vip tier */
    name: string;
    /** Minimum spend to get this vip tier in smallest unit */
    minSpendSmallestUnit: number;
    /** Currency code for the vip tier */
    currencyCode: string;
    /** Description of the benefits of the tier */
    benefitsDescription: string;
}