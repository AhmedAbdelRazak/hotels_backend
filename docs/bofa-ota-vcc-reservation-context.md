# Bank of America OTA VCC reservation context

This integration uses two deliberately separate records.

## Internal payment audit snapshot

The reservation stores an immutable snapshot for each Bank of America checkout:

- Bank reference number
- Jannat Booking reservation confirmation number
- hotel name
- OTA confirmation number and SHA-256 fingerprint
- check-in and checkout dates
- OTA name/provider
- stay length and room count
- amount and currency
- server billing-profile identifier/source

The snapshot contains no PAN, expiration date, CVN, access key, signature, or guest
identity. It is the authoritative reconciliation record for support and dispute review.

## Signed Bank of America request context

The Hosted Payments request sends only fields intended for the gateway:

- `reference_number`: unique Jannat Booking order/payment-attempt reference
- `merchant_defined_data1`: `OTA_VIRTUAL_CARD`
- `merchant_defined_data2`: OTA name
- `merchant_defined_data3`: English/ASCII hotel name
- `merchant_defined_data4`: stay dates and a one-way OTA-confirmation fingerprint
- signed USD amount, currency, transaction type, and server-owned billing fields

Every field above is included in `signed_field_names`. The raw OTA confirmation is not
sent as merchant-defined data because Bank of America's Hosted Payments guide prohibits
personally identifiable information in those fields. The signed Bank reference maps the
gateway transaction back to the full internal snapshot.

## Microform / REST migration

The same internal snapshot will feed the Microform `/pts/v2/payments` request after Bank
of America enables Direct REST payment routing for the production merchant. Structured
`travelInformation.lodging` fields must remain disabled until Bank of America confirms
that lodging industry-data processing is enabled for the merchant and processor; sending
an unsupported industry-data profile can cause a valid payment to be rejected.
