# Chatbot Post-Booking Close And Typing - 2026-06-22

Production tightening after the Marwa/Aisha single-hotel test chat.

- After a reservation is created and the guest clearly closes the conversation
  with a no-thanks/goodbye message, the AI sends one short warm closing reply and
  schedules the support case to close after `AI_POST_BOOKING_CLOSE_MS`.
- The default post-booking close delay is 5 seconds. This is separate from the
  normal idle follow-up and idle-close timers, so active booking chats are not
  shortened.
- Server-initiated close events now let the SSR support widget show the rating
  panel instead of immediately wiping the chat state.
- AI typing is emitted as soon as an AI turn starts planning, so guests see the
  active assistant as typing during response preparation.
- Reservation-detail hydration now restores full name, phone, nationality, guest
  count, children default, and email skip from the existing transcript after a
  backend restart. This prevents duplicate nationality/detail questions if PM2
  restarts mid-flow.
