# Hotel Management Inventory Occupancy Debugging - 2026-06-13

## Route

- Frontend route:
  - `/hotel-management/main-dashboard?overall=summary&summaryTab=inventory`
- Backend endpoints:
  - `GET /api/overall-dashboard/summary/:userId`
  - `GET /api/overall-dashboard/executive-report/inventory/:userId`
  - `GET /api/overall-dashboard/executive-report/inventory-day/:userId`

## Issue Found

- Zad Al Safa (`68da202900a070e8123c27c4`) showed near-zero occupancy for Ramadan 1447 even though the hotel had historical stays in that period.
- The live request was using `invStart=2026-02-18` and `invEnd=2026-06-12`, so the inventory report was stretched from Ramadan through the page-level end date.
- The detailed inventory calendar also used live-availability status rules, where `checked_out` and `early_checked_out` are non-blocking. That is correct for future availability validation, but wrong for historical occupancy reports.
- Hotel-management inventory inherited the general hotel-management reservation visibility cutoff, which hid pre-cutoff historical reservations even when the user explicitly selected an older occupancy period.

## Production Data Check

- Hotel:
  - `zad al safa`
  - `68da202900a070e8123c27c4`
- Room inventory:
  - `roomCountDetails` rows: 7
  - physical room count: 56
  - inventory units after bed-based expansion: 66
- Ramadan 1447 overlap before the fix:
  - 436 reservations overlapped the selected stay dates.
  - Most valid historical stays were `checked_out`, so live-availability filtering removed them from occupancy.
  - Non-cancel/no-show occupied unit-nights were about 1,590, which is roughly 80% of 66 units over 30 days.

## Fix Contract

- Live availability validation stays conservative:
  - `checked_out` and `early_checked_out` remain non-blocking by default.
- Historical occupancy reports opt into completed stays:
  - `includeCompletedStays: true`
  - `includeHistoricalReservations: true`
- This opt-in is used by:
  - `overallExecutiveInventoryReport`
  - `overallExecutiveInventoryDayReport`
- The inventory tab summary occupancy query does not apply the hotel-management historical cutoff, but other summary tabs keep the existing visibility behavior.
- Frontend inventory month selection derives `invStart` and `invEnd` from the selected Hijri/Gregorian month. A stale parent `dateTo` should not stretch a Hijri-month inventory report.

## Regression Checks

- For Ramadan 1447 on Zad Al Safa, the detailed inventory calendar should show high historical occupancy instead of 0%.
- Day detail drill-down should include historical checked-out reservations for the selected stay date.
- Future availability and reservation creation/edit validation should still treat checked-out reservations as non-blocking.
- If a URL contains `invHYear=1447&invHMonth=8`, the inventory request should resolve to `2026-02-18` through `2026-03-19`.
