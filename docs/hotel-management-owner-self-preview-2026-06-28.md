# Hotel Management Owner-Self Preview Fix - 2026-06-28

## Context

Account `658c777af848bc6562f5c5ba` (`xhoteleg@gmail.commm`) is an owner-style hotel account with:

- `role: 2000`
- `roleDescription: hotelmanager`
- `belongsToId` equal to its own `_id`
- multiple assigned hotels in `hotelIdsWork` / `hotelsToSupport`
- only one cached `hotelIdsOwner` entry

The UI must treat this as an owner/overall-dashboard account, not as a scoped single hotel manager.

## Root Cause

Two checks assumed an owner account always has an empty `belongsToId`.

That made this account look like a scoped hotel manager because `belongsToId` was set to the account's own id. The frontend then rendered the scoped manager dashboard and could also redirect toward a single hotel route.

The super-admin preview endpoint also required the selected hotel to be present in the target account's cached hotel arrays. That is too strict for true hotel owners because the authoritative owner relationship is `HotelDetails.belongsTo`.

## Fix

- Treat `role: 2000` accounts as owner-style when `belongsToId` is empty or equals the account `_id`.
- Prevent self-owned owner accounts from the single-hotel dashboard redirect.
- Let super-admin preview open a selected hotel owner when `HotelDetails.belongsTo` matches the target account, even if the target account's cached hotel arrays are incomplete.
- Align the same owner-self rule in the main dashboard, top navbar, overall side menu, and account-management preview routing.

## Expected Behavior

- Super admins can click any hotel row and open the owner's overall dashboard without the "This account is not scoped to the selected hotel" error.
- The owner/self-bound `2000 + hotelmanager` account sees the owner-style `/hotel-management/main-dashboard` structure.
- Normal hotel-manager staff accounts whose `belongsToId` points to a different owner remain in the scoped manager dashboard.
