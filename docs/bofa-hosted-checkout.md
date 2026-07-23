# Bank of America embedded Hosted Checkout

This integration uses the Secure Acceptance Hosted Payments Page iframe. OTA
card number, expiration date, and CVN are entered on Bank of America's origin;
they do not pass through the frontend API or backend.

## Required profile settings

- Integration method: Hosted Checkout
- Payment form: Single Page
- Card types: Visa and Mastercard
- Currency: USD
- CVN Display: enabled
- CVN Required: enabled
- Billing and shipping steps: disabled
- Merchant POST URL:
  `https://xhotelpro.com/api/bofa/checkout/callback/merchant`
- Card number masking: last four digits only
- Transaction type sent by the application: `sale`

Do not promote an edited profile until the application environment below is
configured and the non-charge checks pass.

## Backend-only environment

```text
BOFA_SA_ENV=live
BOFA_SA_PROFILE_ID=<Hosted Checkout profile UUID>
BOFA_SA_ACCESS_KEY=<active HMAC-SHA256 profile access key>
BOFA_SA_SECRET_KEY=<matching profile secret key>
BOFA_SA_APP_ORIGIN=https://xhotelpro.com
```

The secret key must never be committed, logged, placed in React environment
variables, pasted into a browser form, or sent through chat. Install it directly
in the backend `.env` from a locally downloaded key file or a secure secret
manager. The REST Shared Secret keys under global Key Management are not the
same as a Secure Acceptance profile key and must not be used here.

## Release gate

1. Run `node --test services/bofaSecureAcceptance.test.js scripts/bofaVccBilling.test.js`.
2. Confirm `/api/bofa/health` reports `readyForCharge: true` as the configured
   super admin.
3. Confirm the customer-facing site returns `X-Frame-Options: SAMEORIGIN`.
4. Open a reservation whose check-in is today or earlier and verify that the
   Bank of America form renders inside the modal. Do not submit a real card as
   part of a configuration-only test.
5. Promote the saved Secure Acceptance draft only after steps 1-4 pass.

Any timeout, incomplete callback, amount mismatch, invalid signature, partial
approval, or unknown response blocks retry until the transaction is reconciled
in Merchant Services. A signed full `ACCEPT` with reason code `100` is the only
result recorded as charged.
