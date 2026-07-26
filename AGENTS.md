# Repository guidance for coding agents

## External OTA virtual-card capture reconciliation

When a user asks to mark an Agoda, Expedia, or Booking.com reservation as captured from an externally completed virtual-card payment, read [docs/ops/external-ota-vcc-capture-reconciliation.md](docs/ops/external-ota-vcc-capture-reconciliation.md) completely before taking action.

Use `scripts/reconcileExternalVccCapture.js` and always run its dry run before `--apply`. Do not use an ad hoc database update. Require completed USD processor evidence, exact Invoice ID to `reservation_id` mapping, exact-cent totals, a unique transaction ID, a full verified backup, a conditional update, and post-write verification.

Never store or log PAN, CVV/CVC, expiry, credentials, or billing-address data. Never change SAR pricing, `paid_amount`, `paid_amount_breakdown`, payout/cost/margin fields, stay dates, rooms, guest data, hotel assignment, reservation lifecycle, or financial-cycle state while reconciling an external capture. Existing SAR payment accounting is not proof of a card capture; structured capture identifiers and status fields control duplicate detection. Never treat a declined, pending, or inconclusive Bank of America attempt as captured.
