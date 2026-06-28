# AI Chatbot Go-Live Stability - 2026-06-28

## What Was Fixed

- Booking context recovery now keeps an accepted quote sticky after restart/cold state.
- The Marwa/Hana flow no longer falls back to asking for check-in/check-out dates after the guest already accepted a quoted stay.
- Room recovery skips obvious reservation-detail payloads like name, phone, nationality, and guest count.
- Assistant quote parsing now extracts the room type directly before checking slower identity/contact patterns.
- Conversation role detection now recognizes `sender: "ai"` / `role: "assistant"` style entries as assistant messages, not guest messages. This prevents old or alternate transcript shapes from making the bot re-read its own quote as a guest request.
- Legacy proceed quick-reply actions such as `proceed_to_booking` are accepted during recovery, while current new messages still use `proceed`.
- Repeated hydration inside one turn is cached by conversation revision so missing contact details do not reopen room/date scans.
- Reply timing defaults were tightened toward 3-5 seconds, with shorter typing delays and no automatic 10-second delay notice unless explicitly enabled by env.
- Unplanned/unclear fallback replies now go through OpenAI with the full chat transcript and are instructed to answer in one or two professional sentences.
- Unanswered-turn recovery now force-releases stale in-flight AI turns after the stall window instead of deferring a few times and leaving the guest unanswered. This protects the customer chat from feeling frozen when a slow/interrupted turn never posts a reply.
- When a guest reconnects to an open case, the socket join now schedules a reply if the latest guest message is still unanswered, instead of only scheduling first greetings.

## Verified Replay

The Marwa/Hana transcript was replayed locally with exact production messages encoded safely as base64. Recovery now restores:

- Hotel: Zad Ajyad
- Room: tripleRooms
- Dates: 2026-08-19 to 2026-08-25
- Guest details: name, phone, Egyptian nationality, 3 adults
- Quote key: `tripleRooms|2026-08-19|2026-08-25`

The recovered state is `reservation_details` with all mandatory details present, so the next handler proceeds to reservation review instead of asking for dates again.

Follow-up replay also covered both assistant message shapes:

- `isAi: true` with the AI support email.
- `sender: "ai"` without `isAi`.

Both restore the same stay and guest details in under two seconds locally, instead of the previous 12+ second hydration path.

## Operational Notes

- `AI_DELAY_NOTICE_ENABLED` defaults to `false`.
- `AI_TURN_STALL_RECOVERY_MS` defaults to 8000 ms. If the latest guest message still has no AI reply and the active turn is stale, recovery interrupts the stale state and reruns the turn from the latest database conversation.
- Current default reply targets:
  - General: 3000-5000 ms
  - Casual: 3000-4500 ms
  - Booking quote: 4000 ms
  - Booking prompt/review: 3000 ms
- Deterministic handlers still own hard facts, inventory, reservation creation, payments, cancellation, and saved hotel facts.
- Dynamic OpenAI fallback is used only when no specific deterministic handler owns the turn.
