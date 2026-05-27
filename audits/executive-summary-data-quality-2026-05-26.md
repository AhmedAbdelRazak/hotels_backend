# Executive Summary Data-Quality Audit - 2026-05-26

Route audited:
`/hotel-management/main-dashboard?ownerId=68b74714fb50e159d48c714d&overall=summary&page=1&dateFrom=2026-03-27&invStart=2026-03-27&dateTo=2026-05-26&invEnd=2026-05-26&dateBy=createdAt&range=custom`

## Scope

Backend references:
- `controllers/overall_dashboard.js`
- `routes/overall_dashboard.js`
- `models/reservations.js`
- `models/hotel_details.js`
- `models/rooms.js`
- `models/housekeeping.js`

Frontend references:
- `hotels_frontend/src/HotelModule/TheOverallStructure/OverallSummary/OverallSummaryMain.js`
- `hotels_frontend/src/HotelModule/TheOverallStructure/OverallSummary/ExecutiveReports.js`
- `hotels_frontend/src/HotelModule/TheOverallStructure/overallShared.js`
- `hotels_frontend/src/HotelModule/apiAdmin.js`

## Result

The screenshot value for Zad Al Safa, `7/56`, is correct for the current executive-summary definition, but the old label was too easy to misread.

The executive-summary hotel table uses range occupancy:
- numerator: the highest occupied sellable-room count on any single day in the selected date range.
- denominator: active/sellable physical rooms.
- blocked or out-of-service rooms are excluded from the denominator.

The Hotel Rooms Map uses live/current operational occupancy:
- it is based on the current Riyadh day.
- it includes currently in-house/active reservations and overdue in-house reservations.
- it excludes checked-out rooms from the live map.

Because these are different report definitions, the summary table and live map can legitimately show different occupied-room counts.

## Zad Al Safa Reconciliation

Hotel:
- Name: Zad Al Safa
- Hotel id: `68da202900a070e8123c27c4`
- Owner id: `68b74714fb50e159d48c714d`

Room counts:
- Physical rooms in `Rooms`: 60
- Active/sellable rooms: 56
- Blocked/out-of-service rooms: 4

Selected summary date range:
- From: 2026-03-27
- To: 2026-05-26
- Reservation summary date field: `createdAt`
- Occupancy range: 2026-03-27 through 2026-05-26

Reservation totals for the summary row:
- Created in selected range and included by operational filters: 0
- Gross total for those created reservations: 0 SAR
- This matches the screenshot row showing 0 reservations and 0 SAR.

Occupancy for the summary row:
- Occupancy candidates overlapping the selected range: 7 reservations.
- Peak occupied sellable rooms: 7.
- Peak dates found: 2026-03-27 and 2026-03-28.
- Current/live occupancy equivalent on 2026-05-26: 4 occupied rooms.

Cleanliness:
- Summary-style clean rooms: 45
- Summary-style dirty rooms: 4
- Open housekeeping rooms found during reconciliation: 1
- This matches the screenshot `45/4` clean/dirty fraction.

## Checklist

- [x] Verified hotel count and room totals against MongoDB.
- [x] Confirmed blocked/out-of-service rooms are excluded from sellable capacity.
- [x] Confirmed in-house reservations continue to count as occupied after planned checkout until operational checkout changes.
- [x] Confirmed Zad Al Safa `7/56` is range peak occupancy, while the live room map currently shows 4 occupied rooms.
- [x] Confirmed the summary row reservation count and total amount follow `dateBy=createdAt`.
- [x] Confirmed the occupancy numerator follows the selected date range by check-in/check-out overlap, not `createdAt`.
- [x] Confirmed clean/dirty uses room-map and housekeeping state, not reservation count shortcuts.
- [x] Confirmed the grand-total row aggregates raw room/reservation/money values before formatting.
- [x] Added UI clarity for "Min Available", "Peak Occupied", and "Clean / Dirty" so users do not confuse range summary with the live room map.

## Follow-Up Watch Points

- The summary cards and table now clarify that available rooms are minimum available rooms after peak occupancy for each hotel in the selected range.
- If product requirements change and owners prefer current/live occupancy on the general summary page, add a separate backend field such as `currentOccupiedRooms` instead of replacing range occupancy silently.
- The inventory tab remains the better place for day-by-day occupancy and room-night analysis.
- The Hotel Rooms Map remains the source of truth for live/current room state.
