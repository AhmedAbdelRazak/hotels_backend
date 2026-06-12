# Reservation edit modal and commission debugging runbook

Date: 2026-06-12

## What changed

This runbook documents the reservation edit fixes deployed for the PMS/admin reservation flows.

Frontend commits:

- `43e487a Smooth reservation edit modals`
- `26541a4 Add commission field to pricing modal`
- `2348c3a Stabilize pricing distribution modals`

Backend commit:

- `c58e62b Persist OTA pricing commission`
- `<latest>` Preserve explicit SUPER Admin commission during reservation pricing normalization

## User-facing symptoms

- Saving a reservation from the admin or hotel-management edit modal could feel frozen because a blocking success modal remained on screen or the parent details modal did not close reliably.
- In the admin reservation edit flow, SUPER Admin users needed a way to set the general reservation commission from the edit flow.
- In the OTA reservations pricing modal, users needed a separate general commission field.
- The pricing distribution UI showed three distribute buttons, one per total, so users sometimes clicked only one or two and saved partial distributions.
- SSH to the home server timed out while local Tailscale was in `NoState`.

## Affected routes

- `/admin/all-reservations?page=1&reservationId=<reservationId>`
- `/hotel-management/*` reservation detail/edit routes
- `/admin/ota-reservations`

## Important frontend files

- `hotels_frontend/src/AdminModule/AllReservation/MoreDetails.js`
  - Closes the edit modal after a successful reservation save.
  - Updates local reservation state when the edit form returns the saved reservation.

- `hotels_frontend/src/AdminModule/AllReservation/EditReservationMain.js`
  - Removes the blocking Ant Design success modal after save.
  - Uses `message.success` instead, then returns control to the parent modal.
  - Adds SUPER Admin commission override state.
  - Sends `commission` from the override when SUPER Admin enters one.
  - Passes commission controls into the shared pricing breakdown modal for SUPER Admin only.

- `hotels_frontend/src/HotelModule/HotelReports/EditReservationMain.js`
  - Calls `onReservationSaved` after successful save so the parent hotel detail modal can close cleanly.
  - Keeps the same save guard so repeated clicks while loading do not stack duplicate updates.

- `hotels_frontend/src/AdminModule/OtaReservations/OtaReservationsMain.js`
  - Adds separate `commissionValue` state.
  - Sends `commission` and `adminPricing.commissionAmount` in the OTA pricing update payload.
  - Uses one distribution button for all pricing totals.
  - Places the distribution button according to language direction.

- `hotels_frontend/src/AdminModule/JannatTools/EditPricingModal.js`
  - Shared pricing breakdown modal.
  - Replaced three per-row distribute buttons with one `Distribute totals` action.
  - Adds optional `showCommissionAmount`, `commissionAmount`, and `onCommissionChange` props.
  - Admin reservation edit passes these props only for SUPER Admins.
  - Keeps nightly pricing edits as local draft state while the modal is open.
  - Syncs edited rows back to the parent reservation only when the user clicks Apply/Save.
  - This prevents Distribute from being reset by parent rerenders while the user is still editing.

- Shared pricing modal callers hardened for stale state:
  - `hotels_frontend/src/AdminModule/AllReservation/EditReservationMain.js`
  - `hotels_frontend/src/HotelModule/HotelReports/EditReservationMain.js`
  - `hotels_frontend/src/AdminModule/CustomerService/HelperSideDrawer.js`
  - `hotels_frontend/src/AdminModule/JannatTools/OrderTaker.js`

- `hotels_frontend/src/AdminModule/OtaReservations/OtaReservationsMain.js`
  - The OTA pricing modal initializes draft state once per opened reservation.
  - Parent rerenders for the same reservation should not reset distributed totals while the user is editing.

## Important backend files

- `hotels_backend/controllers/janat.js`
  - `updateOtaReservationPricing` now allows `commission`.
  - OTA pricing audit entries include commission `from` and `to` values.

- `hotels_backend/controllers/reservations.js`
  - `normalizeReservationStayPricing` can reset commission when pricing changes.
  - `updateReservation` now preserves an explicitly submitted commission only for configured SUPER Admin actors after pricing normalization.
  - This covers the admin edit modal case where SUPER Admin changes pricing and commission together, or changes only commission while room rows are also present in the payload.

## Data fields to inspect

General reservation commission:

- `reservation.commission`
- `reservation.financial_cycle.commissionAmount`
- `reservation.commissionData.commissionAmount`
- `reservation.agentWalletSnapshot.commissionAmount`

OTA/admin pricing commission:

- `reservation.commission`
- `reservation.adminPricing.commissionAmount`

Nightly pricing rows:

- `pickedRoomsType[].pricingByDay[].clientPrice`
- `pickedRoomsType[].pricingByDay[].rootPrice`
- `pickedRoomsType[].pricingByDay[].netAfterExpenses`
- `pickedRoomsType[].pricingByDay[].otaExpenseAmount`
- `pickedRoomsType[].pricingByDay[].platformMargin`
- `pickedRoomsType[].pricingByDay[].commissionRate`

## Expected behavior

- Clicking save/update in reservation edit should finish, show a success toast, and close the edit modal instead of leaving the UI feeling frozen.
- The parent reservation details view should receive the updated reservation and refresh its displayed data.
- SUPER Admin users can enter a general commission amount in the admin edit reservation pricing modal.
- Non-SUPER Admin users should not see the shared pricing modal commission override in the admin edit reservation flow.
- OTA pricing edit has a separate general commission input.
- Pricing distribution has one button that distributes all editable totals together.
- In Arabic, the single distribute button appears on the left side of the input group. In English, it appears on the right side.
- Clicking Distribute updates the modal table draft immediately, but the parent reservation is updated only after Apply/Save.
- SUPER Admin commission from the admin edit modal should persist even when pricing rows are redistributed in the same save.

## Home server deployment steps

Server:

- SSH alias: `jannat`
- Frontend path: `/home/ahmedadmin/Hotels/hotels_frontend`
- Backend path: `/home/ahmedadmin/Hotels/hotels_backend`
- PM2 apps: `hotels-frontend`, `hotels-backend`

Safe deploy sequence:

```bash
cd /home/ahmedadmin/Hotels/hotels_frontend
git fetch origin master
git status -sb
git pull --ff-only origin master
npm run build

cd /home/ahmedadmin/Hotels/hotels_backend
git fetch origin master
git status -sb
git pull --ff-only origin master
node --check controllers/janat.js
node --check controllers/reservations.js
node --check server.js

pm2 restart hotels-backend hotels-frontend --update-env
pm2 list
```

Use `git pull --ff-only` so deployment never creates accidental merge commits on the server.

## Useful verification commands

Check server commits:

```bash
cd /home/ahmedadmin/Hotels/hotels_frontend
git log -2 --oneline

cd /home/ahmedadmin/Hotels/hotels_backend
git log -2 --oneline
```

Check PM2 status and recent logs:

```bash
pm2 list
pm2 logs hotels-backend --lines 80 --nostream
pm2 logs hotels-frontend --lines 80 --nostream
```

Check HTTP health from a local machine:

```powershell
Invoke-WebRequest https://xhotelpro.com/api/aiagent/health -UseBasicParsing
Invoke-WebRequest "https://xhotelpro.com/admin/all-reservations?page=1" -UseBasicParsing
```

## Manual test checklist

- As SUPER Admin, open an admin reservation detail from `/admin/all-reservations`.
- Open edit reservation.
- Open edit pricing breakdown.
- Confirm the commission amount input is visible.
- Change commission amount, apply pricing, then submit the reservation edit.
- Confirm the edit modal closes and details refresh.
- Reopen the reservation and confirm commission persists.
- Repeat a normal reservation edit without changing commission.
- As a non-SUPER Admin user, confirm the commission override is not visible.
- As hotel-management user, edit and save a reservation and confirm the modal closes cleanly.
- In `/admin/ota-reservations`, edit pricing, set general commission, distribute totals once, save, and confirm values persist.
- Repeat one pricing-modal check with Arabic selected and verify the distribute button is on the left.

## MoreDetails platform profit display

The SUPER Admin-only OTA cards in `src/AdminModule/AllReservation/MoreDetails.js` keep the raw OTA platform margin separate from the saved commission. When an explicit commission exists on `reservation.commission`, `financial_cycle.commissionAmount`, or `commissionData`, the displayed profit card changes from `Platform Profit` / `ربح المنصة` to `Platform Profit + Commission` / `ربح المنصة + العمولة` and shows `platform margin + saved commission`.

This is a display-only composition for MoreDetails. It should not mutate nightly pricing rows, OTA expense totals, hotel-visible totals, or the backend reservation payload.

## SSH and Tailscale debugging

Symptom:

```text
ssh jannat
ssh: connect to host 100.113.132.69 port 22: Connection timed out
```

If SSH times out before authentication, check local Tailscale first:

```powershell
tailscale status
tailscale status --json
tailscale ip -4
tailscale netcheck
```

If Tailscale shows `BackendState: NoState` or `no current Tailscale IPs`, the local Windows client is not connected to the tailnet. Restart and re-auth locally:

```powershell
Restart-Service Tailscale -Force
Start-Process "C:\Program Files\Tailscale\tailscale-ipn.exe"
tailscale up
tailscale status
tailscale ip -4
ssh jannat
```

If `tailscale up` does not print an auth URL and state stays `NoState`, open the Tailscale tray app and sign in/connect manually.

If Tailscale is connected but SSH still times out, then check the remote server state, SSH daemon, firewall, or public fallback alias.

## Rollback notes

Prefer a normal git revert over force resets:

```bash
cd /home/ahmedadmin/Hotels/hotels_frontend
git revert 26541a4 43e487a
npm run build

cd /home/ahmedadmin/Hotels/hotels_backend
git revert c58e62b

pm2 restart hotels-backend hotels-frontend --update-env
```

Do not use `git reset --hard` on the server unless the current working tree and deployment intent have been verified.
