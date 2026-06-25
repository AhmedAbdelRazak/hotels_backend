# Analytics Conversion Tracking - 2026-06-25

Jannat Booking now separates browser intent events from backend source-of-truth conversion events.

## Browser Events

The SSR frontend tracks:

- chat opens/starts as `generate_lead` / Meta `Lead`
- checkout start as `begin_checkout` / Meta `InitiateCheckout`
- payment amount selection as `add_payment_info` / Meta `AddPaymentInfo`
- payment button/order creation as `paymentClick` -> `add_payment_info` / Meta `AddPaymentInfo`
- successful browser payment completion as `purchase` / Meta `Purchase`

Frontend events still strip private payload keys before sending to GA/Meta.

## Backend Events

`services/conversionTracking.js` sends server-side events without blocking the reservation or payment response.

- AI chat reservation created: GA4 `generate_lead`, Meta `Lead`
- public/SSR reservation created from guest flow: GA4 `generate_lead`, Meta `Lead`
- PayPal checkout capture: GA4 `purchase`, Meta `Purchase`
- client payment-link capture: GA4 `purchase`, Meta `Purchase`
- post-stay/authorization capture: GA4 `purchase`, Meta `Purchase`

Authorizations that do not capture funds are not sent as backend `Purchase` events.

## Required Environment

Server-side events are enabled by default but only dispatch when provider secrets exist.

- GA4: `GA4_MEASUREMENT_ID` and `GA4_API_SECRET`
- Meta CAPI: `META_PIXEL_ID` and `META_CONVERSIONS_API_TOKEN`
- Optional: `META_GRAPH_API_VERSION` (default `v25.0`)
- Optional: `META_TEST_EVENT_CODE`
- Optional disable switch: `ANALYTICS_CONVERSIONS_ENABLED=false`

Supported fallback env names are in `services/conversionTracking.js`.

## Safety

- Analytics failures are logged but never fail a booking or payment.
- Event IDs are stable and stored under `reservation.analyticsDispatch.events` to avoid duplicate sends.
- Guest email/phone/name data sent to Meta is SHA-256 hashed only.
- GA Measurement Protocol uses the reservation/support-case identity as a backend client id when no browser GA client id is available.
