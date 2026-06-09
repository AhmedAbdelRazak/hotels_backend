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
- Arabic reservation update quick replies render as `الخيار ١`, `الخيار ٢`, etc.
- Arabic reservation update option parsing accepts Arabic option text and Arabic-Indic digits.
- Arabic reservation date-update success text renders correctly with no mojibake.
- Arabic unavailable update options render correctly with no mojibake.
- Arabic confirmed-too-old cancellation policy message renders correctly.
- Arabic cancellation specialist-review quick replies render correctly.
- Jannat customer chat and hotel support chat mobile composers use a textarea and do not send on Enter for mobile keyboard viewports.

## Cleanup

No QA support-case documents or reservation documents were created by these in-process tests.
