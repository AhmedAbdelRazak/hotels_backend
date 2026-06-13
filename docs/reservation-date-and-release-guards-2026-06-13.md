# Reservation Date And Release Guards - 2026-06-13

## Why this exists

Reservation edits happen from several PMS surfaces:

- `/admin/*` reservation details and edit modals.
- `/hotel-management/*` report and reservation edit modals.
- OTA platform review and release workflows.

Two fields are especially sensitive:

- `checkin_date`
- `checkout_date`

These dates must not drift because of timezone parsing, stale modal state, or unrelated reservation edits. The backend now treats any real check-in/check-out change as an intentional operation that must be explicitly marked by the frontend.

## Date update protection

Backend controller:

- `controllers/reservations.js`
- Function: `protectReservationDateUpdate`
- Rejection code: `reservation_date_change_requires_intent`

Accepted intent fields:

- `__reservationDateUpdateIntent`
- `__dateUpdateIntent`
- `dateUpdateIntent`

Behavior:

1. If the payload does not include `checkin_date` or `checkout_date`, nothing special happens.
2. If the payload includes either date but the date-only value matches the stored reservation date, the backend strips the no-op date field before saving.
3. If the payload changes either date without an explicit date intent, the backend returns `409` and does not save the reservation.
4. If the payload changes either date with explicit intent, the backend normalizes changed dates to `YYYY-MM-DD` before saving.
5. If no date-only values changed, `days_of_residence` is also stripped so a stale/no-op date payload cannot change the stay length.

This protects admin and hotel-management routes from accidental date drift when the user edits pricing, status, source, comments, or other unrelated fields.

## Frontend intent rules

Admin modal:

- `hotels_frontend/src/AdminModule/AllReservation/EditReservationMain.js`

Hotel report modal:

- `hotels_frontend/src/HotelModule/HotelReports/EditReservationMain.js`

Hotel-management full reservation editor:

- `hotels_frontend/src/HotelModule/ReservationsFolder/EditWholeReservation/EditReservationMain.js`

Rules:

- Date picker values are hydrated from date-only keys (`YYYY-MM-DD`) instead of timezone-sensitive ISO conversions.
- The frontend sets `__reservationDateUpdateIntent: true` only when the user uses a date picker/change handler.
- Normal saves send no date intent. If unchanged date values are still present in older payload structures, the backend strips them.

## Hotel-management pricing reminder

For hotel-management routes, changing hotel-facing pricing should update only the hotel-visible/root bucket. It must not overwrite client-facing totals, OTA expenses, or admin-managed pricing distribution unless a platform admin explicitly uses the pricing editor intended for that purpose.

## SUPER Admin return before hotel release

Backend endpoint:

```text
PUT /admin/ota-reservations/:reservationId/revert-platform-review/:userId
```

Controller:

- `controllers/janat.js`
- Function: `revertOtaReservationToPlatformReview`

Frontend caller:

- `hotels_frontend/src/AdminModule/apiAdmin.js`
- Function: `revertOtaReservationToPlatformReview`

Frontend UI:

- `hotels_frontend/src/AdminModule/AllReservation/MoreDetails.js`
- Button: `Return before hotel release`
- Arabic label is defined in `AR_LABELS.returnToPlatformReview`.

Behavior:

1. Only the configured SUPER ADMIN can call this endpoint.
2. Reservation must have `otaPlatformReview` metadata.
3. If it is already pending platform review, the endpoint returns `409`.
4. On success:
   - `state` and `reservation_status` become the OTA platform review status.
   - `pendingConfirmation.status` becomes `pending`.
   - release timestamps are cleared.
   - reversion metadata and reason are stored.
   - `reservationAuditLog` receives action `returned-to-platform-review`.
   - hotel notifications refresh so hotel-facing lists update.

## Debug checklist

If dates move unexpectedly:

1. Check the update response for `reservation_date_change_requires_intent`.
2. Check whether the frontend sent `__reservationDateUpdateIntent`.
3. Compare stored dates using date-only values, not local timezone display.
4. Inspect `reservationAuditLog` and `adminChangeLog` for the update source.

If a reservation still appears released to the hotel after SUPER Admin reversal:

1. Verify `otaPlatformReview.status` is pending.
2. Verify `reservation_status` and `state` are the OTA platform review status.
3. Check hotel notification refresh logs.
4. Confirm the hotel-management query excludes pending OTA platform review reservations.
