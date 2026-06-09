# Agent Price Variant Assignment

## Scope

- Agents can receive multiple saved price variants at once.
- Assignment hotels are derived from the selected agents' existing hotel accounts.
- The agents tab shows matching hotels as read-only context instead of allowing manual hotel selection.
- Agent reservation creation lets an agent choose an assigned price variant when variants exist.
- When a variant is selected, agent room prices are filtered strictly to that variant and remain read-only.

## Implementation Notes

- `controllers/overall_dashboard.js` derives per-agent hotel scope from `hotelIdWork`, `hotelIdsWork`, `hotelsToSupport`, and `hotelIdsOwner`.
- `services/agentRoomOverrides.js` can resolve same-date agent prices by selected `priceVariantDataId` and `priceVariantItemId`.
- `services/reservationPricing.js` preserves selected variant metadata during canonical reservation pricing.
- `OverallCalendarPricingModal.js` derives the assignment hotel list from selected agents and selected variants.
- `ZReservationForm2.js` builds assigned variant options from `agentPricingRate` rows and filters agent pricing by the selected variant.

## Verification

- `node --check controllers/overall_dashboard.js`
- `node --check services/agentRoomOverrides.js`
- `node --check services/reservationPricing.js`
- Focused service check confirmed selected same-date variant lookup returns the chosen variant row.
- `npm run build` in `hotels_frontend` compiled successfully.
