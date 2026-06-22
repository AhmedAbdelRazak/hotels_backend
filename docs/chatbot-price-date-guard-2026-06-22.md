# Chatbot Price Date Guard - 2026-06-22

Production tightening after the Marwa/Aisha single-hotel chat.

- The planner captures a full date range from the latest guest message before
  any early direct-answer or price branch runs.
- This covers Arabic price turns such as `من 21 اغسطس الى 25 اغسطس بكام؟`, where
  the guest already supplied check-in and checkout dates inside the same
  sentence.
- When those dates are captured and no room type is selected yet, the next
  booking pivot is room type or guest fit. The bot must not ask the guest to send
  check-in and checkout dates again.
- Existing-reservation, payment-help, and human-handoff messages are excluded
  from this new-booking date merge so support/update flows are not overwritten.
