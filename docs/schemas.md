# Firestore Schemas - Urban Coconuts V2 (Version 5)

מסמך זה מרכז את הגדרות ה-Schemas הסופיות (V5) עבור כל ה-Collections המרכזיים ב-Firestore בפרויקט Urban Coconuts V2.0.

**עדכון אחרון:** 22 באפריל 2025 (משקף V5)

---

## Core Collections

### 1. `users`

* **מטרה:** ניהול כל סוגי המשתמשים (לקוחות, שליחים, מנהלים).
* **ID Document:** `userId` (זהה ל-Firebase Auth UID).
* **שדות:**
    * `uid` (String): Firebase Auth UID (שכפול לנוחות שאילתות).
    * `email` (String?): כתובת מייל (אם נאספה).
    * `phoneNumber` (String): מספר טלפון (משמש לאימות). **(אינדקס)**
    * `displayName` (String?): שם לתצוגה.
    * `photoURL` (String?): קישור לתמונת פרופיל.
    * `role` (String): תפקיד המשתמש ("Customer", "Courier", "Admin", "SuperAdmin"). **(אינדקס)**
    * `permissions` (Array<String>?): הרשאות ספציפיות שנוספו מעבר לתפקיד (פחות נפוץ).
    * `groups` (Array<String>?): קבוצות שהמשתמש חבר בהן (למשל, למיקוד קופונים). **(אינדקס array-contains)**
    * `isActive` (Boolean): האם המשתמש פעיל (ברירת מחדל: `true`). **(אינדקס)**
    * `isMfaEnabled` (Boolean): האם אימות דו-שלבי מופעל.
    * `mfaSecret` (String?): (מוצפן!) הסוד עבור TOTP MFA. **לא לשמור ישירות!** יש להשתמש בפתרון מאובטח.
    * `preferredLanguage` (String?): קוד שפה מועדף (למשל, "he", "en").
    * `createdAt` (Timestamp): זמן יצירת המשתמש.
    * `lastLoginTimestamp` (Timestamp?): זמן התחברות אחרון. **(אינדקס)**
    * `vipTier` (String?): דרגת VIP (למשל, "Bronze", "Silver", "Gold"). **(אינדקס)**
    * `vipTierLastCalculated` (Timestamp?): מתי חושבה דרגת ה-VIP לאחרונה.
    * `ucCoinBalance` (Integer): יתרת מטבעות UC (מספר שלם).
    * `paymentGatewayCustomerId` (String?): מזהה לקוח אצל ספק הסליקה (אם קיים).
    * `inactivityFlag` (String?): דגל לאי-פעילות ("PendingReview" או תאריך). **(אינדקס)**
    * `updatedAt` (Timestamp): זמן עדכון אחרון.
    * **שדות ספציפיים לשליח (`role == "Courier"`):**
        * `shiftStatus` (String): "OnDuty", "OffDuty", "Break". **(אינדקס)**
        * `currentShiftId` (String?): מזהה המשמרת הפעילה הנוכחית.
        * `currentBoxId` (String?): מזהה הארגז שבו השליח נמצא במשמרת הנוכחית. **(אינדקס)**
        * `assignedBoxIds` (Array<String>?): מזהי הארגזים שהשליח **מורשה** לעבוד בהם (V5). **(אינדקס array-contains)**
        * `cashOnHand` (Integer): סכום המזומן הנוכחי בידי השליח (יחידה קטנה ביותר).
        * `pickupTimeBufferMinutes` (Integer?): תוספת זמן איסוף ספציפית לשליח (V5).
        * `averageRating` (Number?): דירוג ממוצע.
        * `ratingCount` (Integer?): מספר הדירוגים שקיבל.
        * `ratingLastCalculated` (Timestamp?): מתי חושב הדירוג לאחרונה.
    * **שדות ספציפיים למנהל (`role == "Admin" | "SuperAdmin"`):**
        * (שדות נוספים לפי הצורך)

### 2. `boxes`

* **מטרה:** ניהול נקודות האיסוף הניידות ("ארגזים").
* **ID Document:** `boxId` (אוטומטי או מזהה פנימי).
* **שדות:**
    * `boxNumber` (String): מספר הארגז לתצוגה ללקוח/שליח (V5). **(אינדקס)**
    * `boxName_i18n` (Map<String, String>?): שם פנימי/תיאורי לארגז (לשימוש פנימי/ניהולי).
    * `location` (GeoPoint): מיקום גאוגרפי נוכחי. **(נדרש אינדקס גאו-מרחבי)**
    * `isActive` (Boolean): האם הארגז פעיל תפעולית (ע"י מנהל). **(אינדקס)**
    * `isCustomerVisible` (Boolean): האם הארגז גלוי ללקוחות באפליקציה. **(אינדקס)**
    * `priority` (Number): עדיפות הארגז (לקביעת סדר הצגה, V5). **(אינדקס)**
    * `colorCode` (String?): קוד צבע לזיהוי ויזואלי (למשל, HEX).
    * `currencyCode` (String): קוד המטבע הראשי של הארגז (ILS, USD, EUR). **(אינדקס)**
    * `countryCode` (String): קוד המדינה (למשל, "IL").
    * `address` (String?): כתובת טקסטואלית של המיקום הנוכחי (יכול להתעדכן).
    * `assignedCourierId` (String?, Ref: `users`): מזהה השליח המשויך כרגע לארגז. **(אינדקס)**
    * `assignedMenuIds` (Array<String>?): מזהי התפריטים הזמינים בארגז זה (יש לשמור ממוינים לפי עדיפות תפריט). **(אינדקס array-contains)**
    * `hiddenProductIds` (Array<String>?): מזהי מוצרים שמוסתרים ספציפית בארגז זה.
    * `operatingHours` (Map<String, Object>?): שעות הפעילות המתוכננות (למשל, `{ "Mon": { "start": "09:00", "end": "17:00" } }`).
    * `inventory` (Map<String, Integer>): מלאי המוצרים הנוכחי בארגז (`productId` -> כמות).
    * `createdAt` (Timestamp).
    * `updatedAt` (Timestamp).

### 3. `menus`

* **מטרה:** ניהול תפריטים (רגילים ולאירועים).
* **ID Document:** `menuId` (אוטומטי או שם ייחודי).
* **שדות:**
    * `menuName_i18n` (Map<String, String>): שם התפריט (מתורגם).
    * `description_i18n` (Map<String, String>?): תיאור (מתורגם, אופציונלי).
    * `imageUrl` (String?): תמונה ראשית לתפריט.
    * `priority` (Number): עדיפות התפריט (לקביעת סדר הצגה, V5). **(אינדקס)**
    * `isActive` (Boolean): האם התפריט פעיל. **(אינדקס)**
    * `isEventMenu` (Boolean): האם זהו תפריט לאירועים (ברירת מחדל `false`). **(אינדקס)**
    * `availableProducts` (Array<String>?): מזהי המוצרים הזמינים בתפריט זה.
    * `applicableEventTypes` (Array<String>?): (רלוונטי ל-`isEventMenu: true`) סוגי אירועים מתאימים. **(אינדקס array-contains)**
    * `minOrderValueSmallestUnit` (Integer?): (רלוונטי ל-`isEventMenu: true`) מינימום הזמנה ספציפי לתפריט אירוע.
    * `createdAt` (Timestamp).
    * `updatedAt` (Timestamp).

### 4. `products`

* **מטרה:** קטלוג המוצרים הנמכרים.
* **ID Document:** `productId` (אוטומטי או SKU).
* **שדות:**
    * `productName_i18n` (Map<String, String>): שם המוצר (מתורגם).
    * `description_i18n` (Map<String, String>?): תיאור (מתורגם, אופציונלי).
    * `imageUrl` (String?): תמונה ראשית למוצר.
    * `category` (String?): קטגוריה ראשית (למשל, "משקאות", "חטיפים"). **(אינדקס)**
    * `priceSmallestUnit` (Integer): מחיר המוצר ביחידה הקטנה ביותר (אגורות/סנטים).
    * `tags` (Array<String>?): תגיות למוצר (למשל, "New", "Spicy", "Vegan", "GlutenFree", "Discount_10", "BOGO", V5). **(אינדקס array-contains)**
    * `priority` (Number): עדיפות המוצר (לקביעת סדר הצגה בתפריט, V5). **(אינדקס)**
    * `isActive` (Boolean): האם המוצר פעיל וזמין למכירה. **(אינדקס)**
    * `allergens` (Array<String>?): רשימת אלרגנים ידועים.
    * `nutritionalInfo` (Map?): מידע תזונתי (קלוריות, שומן, וכו').
    * `createdAt` (Timestamp).
    * `updatedAt` (Timestamp).

### 5. `orders`

* **מטרה:** ניהול הזמנות רגילות של לקוחות.
* **ID Document:** `orderId` (אוטומטי).
* **שדות:**
    * `orderNumber` (String): מספר הזמנה קריא (אופציונלי).
    * `customerId` (String, Ref: `users`). **(אינדקס)**
    * `courierId` (String?, Ref: `users`). **(אינדקס)**
    * `boxId` (String, Ref: `boxes`). **(אינדקס)**
    * `items` (Array<Map>): רשימת הפריטים המוזמנים:
        * `orderItemId` (String).
        * `productId` (String, Ref: `products`).
        * `productName` (String): Snapshot מתורגם.
        * `quantity` (Integer).
        * `unitPrice` (Integer): Snapshot.
        * `itemStatus` (String).
    * `status` (String): "Red", "Yellow", "Green", "Black", "Cancelled". **(אינדקס)**
    * `statusHistory` (Array<Map>): `{ status, timestamp, userId?, reason? }`.
    * `paymentMethod` (String).
    * `paymentStatus` (String). **(אינדקס)**
    * `currencyCode` (String).
    * `authDetails` (Map?).
    * `paymentDetails` (Map?).
    * `totalAmount` (Integer).
    * `ucCoinsUsed` (Integer?).
    * `couponCodeUsed` (String?).
    * `couponDiscountValue` (Integer).
    * `tipAmountSmallestUnit` (Integer?).
    * `finalAmount` (Integer).
    * `orderTimestamp` (Timestamp). **(אינדקס)**
    * `deliveredTimestamp` (Timestamp?). **(אינדקס)**
    * `pickupTimeWindow` (Map): `{ start: Timestamp, end: Timestamp }`. **(אינדקס `pickupTimeWindow.end`)**
    * `notes` (String?).
    * `issueReported` (Boolean?).
    * `issueDetails` (Map?).
    * `orderQrCodeData` (String).
    * `cancellationSideEffectsProcessed` (Boolean).
    * `createdAt` (Timestamp).
    * `updatedAt` (Timestamp).

---

## Rental Module Schemas

### 6. `rentalItems`

* **מטרה:** קטלוג סוגי הפריטים להשכרה.
* **ID Document:** `rentalItemId`.
* **שדות:**
    * `itemName_i18n` (Map<String, String>).
    * `description_i18n` (Map<String, String>?).
    * `imageUrl` (String?).
    * `rentalFeeSmallestUnit` (Integer).
    * `depositSmallestUnit` (Integer).
    * `currencyCode` (String).
    * `isActive` (Boolean).
    * `attributes` (Map?).
    * `createdAt` (Timestamp).
    * `updatedAt` (Timestamp).

### 7. `rentalBookings`

* **מטרה:** ניהול הזמנות השכרה.
* **ID Document:** `bookingId`.
* **שדות:**
    * `customerId` (String, Ref: `users`). **(אינדקס)**
    * `rentalItemId` (String, Ref: `rentalItems`). **(אינדקס)**
    * `bookingStatus` (String). **(אינדקס)**
    * `pickupBoxId` (String, Ref: `boxes`). **(אינדקס)**
    * `returnBoxId` (String?, Ref: `boxes`). **(אינדקס)**
    * `pickupCourierId` (String?, Ref: `users`).
    * `returnCourierId` (String?, Ref: `users`).
    * `pickupTimestamp` (Timestamp?).
    * `expectedReturnTimestamp` (Timestamp?).
    * `actualReturnTimestamp` (Timestamp?). **(אינדקס)**
    * `returnedCondition` (String?).
    * `rentalFeeSmallestUnit` (Integer).
    * `depositSmallestUnit` (Integer).
    * `currencyCode` (String). **(אינדקס)**
    * `paymentStatus` (String). **(אינדקס)**
    * `paymentDetails` (Map?).
    * `finalChargeSmallestUnit` (Integer?).
    * `overtimeFeeChargedSmallestUnit` (Integer?).
    * `cleaningFeeChargedSmallestUnit` (Integer?).
    * `damageFeeChargedTotalSmallestUnit` (Integer?).
    * `depositProcessed` (Boolean).
    * `processingError` (String?).
    * `createdAt` (Timestamp).
    * `updatedAt` (Timestamp).

---

## Event Coordination Schemas

### 8. `eventBookings`

* **מטרה:** ניהול הזמנות אירועים.
* **ID Document:** `bookingId`.
* **שדות:**
    * `customerId` (String, Ref: `users`). **(אינדקס)**
    * `eventDate` (Timestamp). **(אינדקס)**
    * `startTime` (Timestamp). **(אינדקס)**
    * `endTime` (Timestamp). **(אינדקס)**
    * `durationMinutes` (Number).
    * `location` (Map): `{ address, coordinates?, zoneId?, notes? }`.
    * `eventMenuId` (String?, Ref: `menus`).
    * `selectedItems` (Array<Map>): `{ bookingItemId, itemId, itemType, productName, quantity?, durationHours?, calculatedPriceSmallestUnit, appliedUnitPriceSmallestUnit?, productId? }`.
    * `totalAmountSmallestUnit` (Integer).
    * `currencyCode` (String). **(אינדקס)**
    * `minOrderRequirementMet` (Boolean).
    * `bookingStatus` (String, Enum). **(אינדקס)**
    * `statusChangeHistory` (Array<Map>): `{ from, to, timestamp, userId, role, reason? }`.
    * `adminApprovalDetails` (Map?): `{ status, approvedByUserId?, timestamp?, adminNotes? }`.
    * `agreementSentTimestamp` (Timestamp?).
    * `agreementConfirmedTimestamp` (Timestamp?).
    * `paymentStatus` (String, Enum). **(אינדקס)**
    * `paymentDetails` (Map?).
    * `cancellationFeeAppliedSmallestUnit` (Integer?).
    * `cancellationTimestamp` (Timestamp?).
    * `cancelledBy` (String?).
    * `cancellationReason` (String?).
    * `assignedResources` (Map<String, Array<String>>?).
    * `assignedLeadCourierId` (String?, Ref: `users`). **(אינדקס)**
    * `actualStartTime` (Timestamp?).
    * `actualEndTime` (Timestamp?).
    * `lastDelayReason` (String?).
    * `customerFeedbackId` (String?, Ref: `userFeedback`).
    * `googleCalendarEventId` (String?).
    * `needsManualGcalCheck` (Boolean?).
    * `needsManualGcalDelete` (Boolean?).
    * `processingError` (String?).
    * `createdAt` (Timestamp).
    * `updatedAt` (Timestamp).

### 9. `eventResources` (קטלוג)

* **מטרה:** קטלוג משאבים ייעודיים לאירועים.
* **ID Document:** `resourceId`.
* **שדות:**
    * `resourceType` (String): "Team", "Vehicle", "Equipment", "StaffMember". **(אינדקס)**
    * `name` (String).
    * `details` (Map?).
    * `email` (String?).
    * `baseLocation` (GeoPoint?).
    * `isActive` (Boolean). **(אינדקס)**
    * `createdAt` (Timestamp).
    * `updatedAt` (Timestamp).

---

## Supporting Collections

### 10. `couriers`

* (ראה הרחבה תחת `users`).

### 11. `shifts`

* **מטרה:** ניהול משמרות של שליחים.
* **ID Document:** `shiftId`.
* **שדות:**
    * `courierId` (String, Ref: `users`). **(אינדקס)**
    * `boxId` (String, Ref: `boxes`). **(אינדקס)**
    * `startTime` (Timestamp). **(אינדקס)**
    * `endTime` (Timestamp?). **(אינדקס)**
    * `startCashSmallestUnit` (Integer).
    * `endCashSmallestUnit` (Integer?).
    * `expectedEndCashSmallestUnit` (Integer?).
    * `cashDifferenceSmallestUnit` (Integer?).
    * `isConfirmedByAdmin` (Boolean).
    * `confirmationTimestamp` (Timestamp?).
    * `confirmingAdminId` (String?).
    * `notes` (String?).
    * `createdAt` (Timestamp).
    * `updatedAt` (Timestamp).

### 12. `roles`

* **מטרה:** הגדרת תפקידים במערכת.
* **ID Document:** `roleId`.
* **שדות:**
    * `roleName` (String).
    * `description` (String?).
    * `permissions` (Array<String>). **(אינדקס array-contains)**

### 13. `permissions`

* **מטרה:** קטלוג כל ההרשאות האפשריות במערכת.
* **ID Document:** `permissionId`.
* **שדות:**
    * `description` (String?).
    * `category` (String?).

### 14. `appConfig`

* **מטרה:** ריכוז הגדרות גלובליות.
* **מסמכים (דוגמאות):**
    * **`general`:** `defaultCurrencyCode`, `defaultPickupTimeBufferMinutes`, `logRetentionDays`, `inactivityThresholdDays`, `supportedLanguages`, `standardTags`.
    * **`tipSettings`:** `tipEnabled`, `tipOptionsPercentage`, `allowCustomTip`.
    * **`matRentalSettings`:** `overtimeIntervalMinutes`, `overtimeFeeSmallestUnit`, `cleaningFeeSmallestUnit`, `allowedReturnRadiusKm`, `maxReturnResults`.
    * **`eventSettings`:** `minOrderValueSmallestUnit`, `cancellationFeeSmallestUnit`, `cancellationWindowHours`, `validLocationZones`, `defaultEventDurationMinutes`, `maxBookingLeadTimeDays`, `minBookingLeadTimeDays`, `requiresAdminApproval`, `googleCalendarIntegrationEnabled`, `targetCalendarIds`, `timeZone`.
    * **`alertRules`:** `velocityCheckPeriodMinutes`, `highSalesThreshold`, `staleInventoryPeriodDays`, `minStockForStaleCheck`, `lowSalesThresholdForStale`.
    * **`vipSettings`:** `lookbackDays`, `rules`.
    * **`ratingSettings`:** `ratingLookbackPeriodDays`, `minRatingsForAverage`.

### 15. `promoCodes` (או `promotions`)

* **מטרה:** ניהול קופונים והנחות.
* **ID Document:** `promoId`.
* **שדות:**
    * `couponCode` (String?). **(אינדקס)**
    * `description` (String?).
    * `isActive` (Boolean). **(אינדקס)**
    * `validFrom` (Timestamp?).
    * `validUntil` (Timestamp?). **(אינדקס)**
    * `maxTotalUses` (Integer?).
    * `currentTotalUses` (Integer).
    * `maxUsesPerUser` (Integer?).
    * `targetAudienceRules` (Map?).
    * `allowCombining` (Boolean).
    * `discountDetails` (Map): `{ type, percentageValue?, fixedAmountSmallestUnit? }`.
    * `minOrderValueSmallestUnit` (Integer?).
    * `createdAt` (Timestamp).
    * `updatedAt` (Timestamp).

### 16. `userFeedback`

* **מטרה:** איסוף משוב מלקוחות.
* **ID Document:** `feedbackId`.
* **שדות:**
    * `bookingId` (String). **(אינדקס)**
    * `bookingType` (String).
    * `customerId` (String, Ref: `users`). **(אינדקס)**
    * `courierId` (String?, Ref: `users`). **(אינדקס)**
    * `rating` (Number). **(אינדקס)**
    * `comments` (String?).
    * `tags` (Array<String>?).
    * `timestamp` (Timestamp). **(אינדקס)**

### 17. `adminLogs` / `userActivityLogs`

* **מטרה:** רישום פעולות במערכת.
* **ID Document:** אוטומטי.
* **שדות:**
    * `timestamp` (Timestamp). **(אינדקס)**
    * `userId` (String). **(אינדקס)**
    * `userRole` (String?).
    * `action` (String). **(אינדקס)**
    * `details` (Map).
    * `ipAddress` (String?).
    * `userAgent` (String?).

### 18. `dailyReports`

* **מטרה:** אחסון דוחות מכירה יומיים מסוכמים.
* **ID Document:** `YYYY-MM-DD`.
* **שדות:** (ראה פלט של `generateDailySalesReport`)

---

מסמך זה מהווה את הבסיס למבנה הנתונים ב-Firestore. יש ליצור את האינדקסים המומלצים כדי להבטיח ביצועים טובים של שאילתות.