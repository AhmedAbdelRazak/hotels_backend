# PMS Settings Payload Health - 2026-06-28

## Why this exists

The PMS backend heap spiked while an overall dashboard settings route was loading a large calendar-pricing payload. The expensive shape was:

- `/api/overall-dashboard/settings-calendar-pricing/:userId`
- owner-scoped hotels
- every room
- every `pricingRate` row for every room
- price variant data and agent options

Node/V8 can keep heap reserved after large JSON responses, so repeated navigation or cancelled browser requests can make PM2 show high heap even after active requests fall back to zero.

## Current behavior

- Overall settings option payloads no longer select deep `roomCountDetails.pricingRate` arrays.
- `/api/overall-dashboard/settings-calendar-pricing/:userId` returns compact hotel/room data plus `pricingGroups` summaries generated in MongoDB.
- Full calendar rows are fetched only for the selected room through:
  - `GET /api/overall-dashboard/settings-calendar-pricing/:userId/room-rows?ownerId=<ownerId>&hotelId=<hotelId>&roomId=<roomId>`
- `/api/admin/global-hotel-settings/*` now uses purpose-specific projections instead of one full hotel query.
- `/api/hotel-details/:hotelId?view=management` is compact by default and only includes deep room pricing arrays when `includePricingRows=true`.

## Frontend expectations

- Overall calendar pricing shows saved pricing from compact `pricingGroups`.
- Clicking Edit lazily fetches the selected room rows before opening the update preview.
- Single-hotel settings requests `includePricingRows=true` only on `activeTab=roomcount&currentStep>=3`.

## Operational check

After deploy, watch:

- PM2 heap for `hotels-backend`
- `/admin/global-hotel-settings`
- `/hotel-management/main-dashboard?ownerId=<ownerId>&overall=settings`
- `/hotel-management/settings/<ownerId>/<hotelId>?activeTab=roomcount&currentStep=1`
- `/hotel-management/settings/<ownerId>/<hotelId>?activeTab=roomcount&currentStep=3&selectedRoomType=<roomId>`
