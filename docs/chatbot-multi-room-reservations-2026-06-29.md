# Chatbot Multi-Room Reservations - 2026-06-29

## Why

Live Zad Ajyad chat showed a guest selecting two room types in one Arabic reply:
"the double and the quad" (`\u0627\u0644\u0645\u0632\u062f\u0648\u062c\u0629
\u0648\u0627\u0644\u0631\u0628\u0627\u0639\u064a\u0629`). The chatbot
previously kept only one `roomTypeKey`, so a multi-room request could be priced,
reviewed, or saved as a single room type.

## Contract

- The chatbot can understand one or more room lines in the same guest turn.
- Supported examples include:
  - Arabic "the double and the quad"
    (`\u0627\u0644\u0645\u0632\u062f\u0648\u062c\u0629
    \u0648\u0627\u0644\u0631\u0628\u0627\u0639\u064a\u0629`)
  - Arabic "two double rooms"
    (`\u063a\u0631\u0641\u062a\u064a\u0646
    \u0645\u0632\u062f\u0648\u062c\u0629`)
  - `two double rooms`
  - `I want double room` followed by `And triple room` in the same message.
- Single-room bookings keep the old behavior.
- Multi-room quotes use a selection key such as
  `doubleRooms:1+quadRooms:1|2026-09-13|2026-09-20`, so old single-room quotes
  are not reused accidentally.
- Final reviews render room lines separately and show the grand total for the
  full reservation.
- Reservation creation flattens the saved `pickedRoomsType` and
  `pickedRoomsPricing` like OrderTaker:
  - one double + one quad saves two rows with different `room_type` values.
  - two double rooms saves two rows, both `doubleRooms`, each with `count: 1`.

## Files

- `aiagent/core/orchestrator.js`
  - Parses room selections from current and recovered conversation text.
  - Aggregates quotes across room selections.
  - Builds deterministic multi-line review text.
- `aiagent/core/actions.js`
  - Builds flattened reservation room-pricing rows from aggregate quote lines.

## Local Verification

- `node --check aiagent/core/orchestrator.js`
- `node --check aiagent/core/actions.js`
- In-process local simulation with `AI_AGENT_TEST_EXPORTS=true` verified:
  - Arabic "the double and the quad" -> `doubleRooms:1 + quadRooms:1`,
    total 1295 SAR in the fake 7-night fixture, saved rows `doubleRooms`,
    `quadRooms`.
  - English `two double rooms` -> `doubleRooms:2`, saved rows
    `doubleRooms`, `doubleRooms`.
  - Arabic "two double rooms" -> `doubleRooms:2`.
  - Multiline `I want double room\nAnd triple room` ->
    `doubleRooms:1 + tripleRooms:1`.

## Notes

- The test fixture used fake local prices and did not write to MongoDB.
- Existing reservation date-update automation still keeps its older safety rule
  for unsupported multi-room existing-reservation updates.
