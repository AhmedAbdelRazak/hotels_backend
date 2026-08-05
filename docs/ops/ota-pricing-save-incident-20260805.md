# OTA pricing-save incident — 2026-08-05

## Scope and evidence

The reported example is fixed to these non-guest identifiers:

- Reservation Mongo ID: `6a735107b880d28d664f6039`
- PMS confirmation: `8052012670`
- Agoda confirmation: `686490863`
- Hotel: Zad Ajyad (`6a40b6a1a6efe70450536038`)
- Stay: 2026-08-16 through 2026-08-27 (11 nights)

The user-provided screenshots show the intended pricing before Save:

- client total: SAR 768.35 (`69.85` per night)
- hotel base total: SAR 825.00 (`75.00` per night)
- net after OTA expenses: SAR 475.42 (`43.22` per night)
- OTA expenses: SAR 292.93 (`26.63` per night)
- platform margin: SAR -349.58 (`-31.78` per night)
- general commission: SAR 82.50

Production evidence was collected read-only from the primary with majority read
concern and from the existing PM2/Nginx logs. The two pricing PUTs completed at
2026-08-05 17:03:23Z and 17:04:24Z with HTTP 200. Their append-only reservation
audits show commission changing from SAR 165.00 to SAR 0.00, then SAR 0.00 to
SAR 0.00. No backend exception was logged. The complete nightly pricing arrays
were saved correctly and remain identical.

The same reservation also has `otaPlatformReview.status = pending` and no
release actor/timestamp, while a generic reservation update changed both
`reservation_status` and `state` to `confirmed`. That contradictory lifecycle
state must be returned to `OTA Platform Review`; it must not be interpreted as
an authorization to release the booking.

## Root cause and preventive controls

The browser accepted a free-form commission value and converted any value that
JavaScript could not parse—including localized digits, directional characters,
or a blank value—to numeric zero. The backend accepted that zero as a valid,
explicit replacement. The pricing normalizer resets commission assignment when
pricing changes, which made this silent coercion destructive across the
top-level, admin-pricing, and financial-cycle commission fields.

The corrective controls are deliberately layered:

1. The browser distinguishes missing, valid, and invalid money; supports the
   same localized input grammar as the server; never coerces invalid commission
   to zero; and preserves explicit zero.
2. Distribution drafts are applied only for fields the user touched. Save
   applies valid touched drafts, rejects totals that cannot be allocated to
   exact cents, and leaves untouched nightly columns unchanged.
3. The API rejects invalid, negative, conflicting, blank, and malformed
   explicit commission values. An omitted commission preserves the existing
   stored commission fields rather than resetting them.
4. The OTA list projection includes all commission sources so reopening the
   modal cannot substitute a default for an already-saved value.
5. OTA review actions require the marker, reservation status, and state to be
   mutually consistent. Generic reservation updates cannot bypass the dedicated
   review/release lifecycle, including through a super-admin status update.
6. Non-2xx pricing responses remain failures in the browser and surface the
   server message instead of appearing successful.

## Data-repair safety

The companion incident repair utility is fixed to the one screenshot-proven
reservation. It is dry-run by default and requires an explicit repair ID to
write. The dry run must use an explicit repair ID and emits a canonical
`--repair-at` timestamp. Apply requires that same repair ID and exact timestamp,
so the reviewed and applied document, backup envelope, and hashes are
deterministic. Before changing the reservation it stores the complete raw BSON
document in a permanent backup collection, records canonical hashes in a
manifest, and uses a full-document compare-and-swap filter. It then reads the
document from the primary with majority concern and verifies the complete
expected hash.

```bash
node scripts/repairOtaPricingSaveIncident20260805.js \
  --repair-id <unique-repair-id> \
  --repair-at <canonical-ISO-timestamp>

# Stop hotels-backend, then use the exact command emitted by that dry run:
node scripts/repairOtaPricingSaveIncident20260805.js \
  --apply \
  --repair-id <same-unique-repair-id> \
  --repair-at <same-canonical-ISO-timestamp>
```

An apply without both interlocks is rejected. Do not generate a new timestamp
between dry run and apply.

The repair changes only:

- commission amount to SAR 82.50 in the top-level, admin-pricing, and
  financial-cycle representations;
- `reservation_status` and `state` back to `OTA Platform Review`;
- the two confirmation snapshots back to their exact pre-incident audit values;
- repair timestamps/version and one append-only repair audit entry.

It does not change rooms, room identity, room count, nightly prices, stay dates,
guest data, hotel assignment, payment data, payout data, OTA source facts, or
the two historical incident audits. Rollback is allowed only while the live
document still has the exact repaired hash.

Historical audit review found many other pricing saves with zero outcomes, but
they are not safe to rewrite automatically: some have later finance activity or
intentional no-commission decisions, and the previous amount is not proof of
the value the operator intended to enter. Those records should be reviewed with
reservation-specific evidence; this incident utility must never be broadened.

## Production verification checklist

- Run all focused backend and frontend tests, then the complete OTA inbound
  regression suite and a production frontend build.
- Deploy only committed, reviewed source using the established backend/frontend
  service directories; preserve all pre-existing untracked server artifacts.
- Run the repair dry run against the production primary with the intended
  repair ID and timestamp; review identifiers, hashes, field diff, exact emitted
  apply command, and backup collection name.
- Apply once with the reviewed repair ID and verify the backup, manifest, exact
  repaired hash, SAR 82.50 commission representations, pending review state,
  unchanged nightly arrays, and unchanged payment/stay/room hashes.
- Confirm both PM2 applications are online with stable restart counts, inspect
  post-deploy error/access logs, and smoke-test the public application.
