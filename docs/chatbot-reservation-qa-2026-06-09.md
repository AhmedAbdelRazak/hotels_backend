# Chatbot Reservation QA - 2026-06-09

## Scope

This pass verifies the AI support chatbot behavior for:

- New reservation detail collection.
- Existing reservation date updates.
- Existing reservation cancellation policy handling.
- Arabic quick replies and Arabic customer-facing text.
- Mobile chat composer newline behavior.

## Expected Behavior

- The reservation-detail extractor reads the current chat context, latest guest message, active wait step, and already-known slots before asking for missing data.
- The bot should not ask again for details already supplied.
- When choices are better than typing, the bot should provide localized quick replies.
- Arabic users must receive Arabic labels and Arabic customer-facing messages.
- Date updates can be completed only by the system update tool after availability is checked.
- Cancellations are not performed automatically by chat. If the reservation has been confirmed for 14 days or more, the bot explains the policy and offers specialist review. If the guest insists, the bot escalates to a human specialist.
- On mobile chat composers, Enter/newline behavior should work through the mobile keyboard; desktop Enter sends unless Shift+Enter is used.

## Local QA Cases

The focused in-process QA used fake support-case state and did not write to MongoDB.

- Arabic contextual no-children reply sets `children=0` and `childrenProvided=true`.
- Arabic digit-only zero child count sets `children=0` and `childrenProvided=true`.
- Arabic optional email decline sets `emailSkipped=true`.
- Arabic reservation update quick replies render as localized Arabic option labels, for example `الخيار ١`, `الخيار ٢`, etc.
- Arabic reservation update option parsing accepts Arabic option text and Arabic-Indic digits.
- Arabic reservation date-update success text renders correctly with no mojibake.
- Arabic unavailable update options render correctly with no mojibake.
- Arabic confirmed-too-old cancellation policy message renders correctly.
- Arabic cancellation specialist-review quick replies render correctly.
- Jannat customer chat and hotel support chat mobile composers use a textarea and do not send on Enter for mobile keyboard viewports.

## Production QA Cases

Production QA used the deployed backend code with fake support-case state and did not write to MongoDB.

- Arabic contextual no-children extraction passed.
- Arabic digit-only zero child count extraction passed.
- Arabic optional email decline extraction passed.
- Arabic reservation update quick reply labels and Arabic option parsing passed.
- Arabic reservation date-update success and unavailable-date text passed with no mojibake.
- Arabic confirmed-too-old cancellation policy text and specialist-review quick replies passed.
- Public availability checks returned HTTP 200 for `https://jannatbooking.com/` and `https://xhotelpro.com/`.

## Production Health

- `hotels-backend`, `jannat-frontend`, and `hotels-frontend` were online in PM2 after deployment.
- Backend active requests were 0, event-loop p95 was about 2 ms, and used heap was about 111 MB.
- The backend error log had no writes after `2026-06-08 13:58:32 -0700`; the visible OOM/currency-timeout entries were historical.
- Server memory had about 12 GB available, root disk usage was 13%, and CPU package temperature was about 34 C.

## Cleanup

- No QA support-case documents or reservation documents were created by these in-process tests.
- A read-only production database scan found zero support cases or reservations matching the Codex/chatbot QA markers.
- Reservation `9550176494` was verified after QA at check-in `2026-09-23`, check-out `2026-10-08`, status `pending confirmation`.
