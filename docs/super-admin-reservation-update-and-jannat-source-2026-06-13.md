# Super Admin Reservation Update And Jannat Source Guard - 2026-06-13

## Scope

This note covers two production rules:

- Super admins must be able to save reservation updates from admin reservation edit flows even when the selected room/date is blocked on the hotel calendar.
- Reservations created from `/admin/jannatbooking-tools?tab=reservations` must save `booking_source` as `Jannat Employee` by default. A stale or old client posting `manual` or `Manual Reservation` is normalized server-side.

## Backend Contract

Files:

- `controllers/reservations.js`
- `services/reservationPricing.js`
- `controllers/janat.js`

Reservation update flow:

- `updateReservation` resolves `superAdminUpdateActor` from the authenticated/requesting actor.
- Super admins are not treated as `orderTakerBasicEditOnly`.
- `normalizeReservationStayPricing(existingReservation, updatePayload, { allowBlockedCalendar: superAdminUpdateActor })` allows super-admin updates to pass calendar-blocked room/date pricing.
- When the calendar row is blocked but a super admin override is allowed, the pricing service does not prefer the blocked calendar row for recalculation. It keeps the provided reservation pricing first, falling back to room/base pricing only when no valid provided price exists.
- Regular order takers still receive blocked-calendar and inventory restrictions.

Pricing service:

- `normalizeReservationStayPricing` accepts an optional third `options` argument.
- `options.allowBlockedCalendar` is passed to `buildCanonicalRoomPricing`.
- Existing callers without the option retain the old strict behavior.

Jannat Tools employee reservation creation:

- `controllers/janat.js` uses `normalizeEmployeeBookingSource`.
- Blank, `manual`, and `Manual Reservation` are stored as `Jannat Employee`.
- The normalized value is used in both the reservation document and the reservation audit log.

## Frontend Contract

Files:

- `src/HotelModule/ReservationsFolder/EditWholeReservation/EditReservationMain.js`
- `src/AdminModule/JannatTools/OrderTaker.js`

Shared hotel-management edit form:

- The effective lock is `basicEditRestrictionsActive = basicEditOnly && !isSuperAdminUser(user)`.
- Client-side blocked-calendar toasts, disabled source/payment controls, room type restrictions, room assignment visibility, and the reduced save payload all use this effective lock.
- Normal order takers remain restricted.

Jannat Tools order-taker form:

- The booking source state initializes and resets to `Jannat Employee`.
- The visible `Manual Reservation` option was removed.
- The payload uses `normalizeEmployeeBookingSource(bookingSource)` before posting to the backend.

## Verification

- Backend syntax checks:
  - `node --check controllers/reservations.js`
  - `node --check services/reservationPricing.js`
  - `node --check controllers/janat.js`
- Frontend production build:
  - `npm run build`

## Regression Notes

- Do not remove backend normalization. It protects old browser tabs and direct API clients.
- Do not pass `allowBlockedCalendar` for general users or order takers.
- If future reservation update paths call `normalizeReservationStayPricing`, decide explicitly whether the actor is allowed to override blocked calendar dates.
