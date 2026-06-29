# AI Chatbot Go-Live Stability - 2026-06-28

## What Was Fixed

- Zad Ajyad now has a dedicated private positioning context for the writer: answer the guest's question first, then softly position Ajyad location, Al Haram convenience when supported by saved distance facts, and direct-booking value only when natural.
- Zad Ajyad price objections now route through the discount/value handler. The bot may explain that direct hotel booking avoids third-party commission layers and can often mean about 25-30% better value depending on dates and availability, but it must not invent a new total or guarantee an extra discount.
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
- Stale turn recovery is now fenced with per-turn ownership. If recovery replaces a slow planner run, the older run may finish its OpenAI/database work but it cannot send an outdated or duplicate assistant message to the guest.
- After required reservation details are captured, the chatbot now asks once for an optional email address before final review. Guests can skip it, but captured emails can be used for confirmation delivery and future lead/marketing workflows.
- Selected-hotel fact answers are now post-booking-aware. After a reservation is created, service questions such as bus/shuttle availability end with a general helpful follow-up instead of asking whether to continue a reservation that is already confirmed.
- Arabic greeting-only messages with the full blessing, such as "alaykum assalam wa rahmatullah wa barakatuh" in Arabic script, now match the fast smalltalk classifier. They reply before slot hydration, room/date recovery, or OpenAI fallback, preventing simple greetings from stalling a live customer chat.
- Fast reservation-detail replies now append atomically only when no AI reply has already been saved after the same latest guest message. This prevents duplicate prompts when recovery and an in-flight turn race each other.
- Optional email skip text is isolated from identity parsing, so Arabic phrases like "skip please / I do not have email" cannot overwrite the captured guest name during final review.
- Final reservation creation now requires the public quick-reply action `place_reservation`. Typed "yes", "confirm", or "complete reservation" re-shows the final action buttons instead of creating a booking.
- Reservation corrections now re-run through slot capture and send a fresh final review before the guest can press the final booking button.
- Latest explicit nationality corrections win over older text, including Arabic contrast phrases such as "I speak Egyptian dialect, but I am Jordanian".
- Arabic count parsing now recognizes common shorthand and typo forms such as "فرد", "الاطفال فرد", and "الباغين فرد".

- First greetings are deterministic and short: Islamic greeting, guest name, agent name, selected hotel reception/reservations, and one "how can I help" question. The LLM no longer expands the opening message.
- Agent-name pings such as "Aisha?" now carry the immediately previous unanswered direct question when no assistant reply came between the two guest messages. This prevents the bot from forgetting "are you with the hotel?" and falling into reservation-detail collection.
- Standalone agent-name greetings/pings such as "hi Aisha" now receive a deterministic fast acknowledgement instead of entering slow planning.
- The carry-forward path includes a looser hotel-relationship matcher for conversational Arabic such as "are you working with the hotel?" so that an immediate agent-name ping cannot swallow the real question.
- Arabic hotel relationship detection now includes Egyptian forms such as "shaghala with the hotel" / "shaghal with the hotel".
- Small room-count requests such as "room for two" / "عايز غرفة لفردين" run through a pre-detail fast lane. They recommend the matching room type, merge same-message dates if present, and otherwise ask for check-in and checkout dates instead of phone/name details.
- Public client message updates schedule short safety retries. If the latest guest message still has no AI reply after the quiet window, the backend schedules the AI turn again without duplicating already-answered chats.
- Safety retries and active-lock rechecks no longer interrupt an in-flight AI answer unless the database case has a genuinely newer guest message than the active turn. This prevents retry loops from repeatedly canceling the answer and leaving the public widget silent.
- Agent-name pings that carry a previous direct guest question run before the normal short quiet window. A rapid sequence like "are you with the hotel?" then "Aisha?" now answers the real question immediately instead of waiting or drifting into booking-detail collection.
- Arabic dual guest-count wording such as "lifardeen / lishakhseen / lideifeen" is preserved before number normalization, so "I need a room for two" in Arabic enters the deterministic room-count fast lane.
- Hotel relationship/trust questions such as "are you working with the hotel?" now have a pre-quiet/pre-hydration deterministic answer. They should not wait for slot recovery, room scans, or OpenAI before reassuring the guest that they are speaking with reception/reservations for the selected hotel.
- The public client update controller also has a narrow immediate trust-question reply. This protects the widget from planner-lock races for "are you with the hotel?" and for an agent-name ping immediately after that unanswered question.

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

- Unplanned guest questions should never receive a canned "generic" fallback. The dynamic writer receives the full chat context and must answer the latest question directly, then return to the booking flow only when it is natural and useful.
- Zad Ajyad positioning is a sales guardrail, not a claim generator. Do not describe it as luxury, guaranteed cheapest, or the best hotel in Makkah unless verified source facts are added later.
- `AI_DELAY_NOTICE_ENABLED` defaults to `false`.
- `AI_TURN_STALL_RECOVERY_MS` defaults to 8000 ms. If the latest guest message still has no AI reply and the active turn is stale, recovery interrupts the stale state and reruns the turn from the latest database conversation.
- All `humanSend` paths verify that the active planner still owns the turn before waiting, policy checks, and database append. This is the guard that prevents the mobile chat from receiving stale duplicate replies after recovery.
- `nextReservationDetailStep` routes complete mandatory details to `email_or_skip` before `finalize` when no email has been provided or skipped.
- `hotelFactNextStepText` and the selected-hotel fact-writing instruction use a post-booking next step when a reservation reference already exists, preventing redundant pre-booking prompts after confirmation.
- Current default reply targets:
  - General: 3000-5000 ms
  - Casual: 3000-4500 ms
  - Booking quote: 4000 ms
  - Booking prompt/review: 3000 ms
- Deterministic handlers still own hard facts, inventory, reservation creation, payments, cancellation, and saved hotel facts.
- Dynamic OpenAI fallback is used only when no specific deterministic handler owns the turn.
- Greeting-only, thanks-only, and clear casual messages use the pre-hydration fast lane when they contain no booking, payment, handoff, or existing-reservation signal.
- During `email_or_skip`, the bot captures only email/skip intent before moving to final review; required identity fields are protected from that optional step.
- The public widget must send the quick-reply `clientAction`; the backend intentionally does not create reservations from typed final-confirmation text.
- Room-count fast lane ownership is intentional: it runs before reservation-detail collection so a guest who says "I need a room for two" while the bot is waiting for contact details still gets a useful room/date answer, not a phone prompt.
- `AI_CLIENT_REPLY_SAFETY_RETRY_MS` defaults to 1500 ms and is a controller-level backup for public chat message updates; it retries up to four times and only reschedules when the latest saved guest message has no later AI reply.
- Planner lock retries are queue-only for the same guest message. They interrupt only when the latest guest text differs from the active turn text, so real guest follow-ups still preempt stale work while safety retries cannot cancel themselves forever.
- The room-count fast lane should be tested with both English and Arabic forms, including "room for two" and "عايز غرفة لفردين"; expected behavior is a double-room recommendation plus a date request, never phone/name collection.
- Trust/relationship questions should be tested both alone and followed by an agent-name ping. Expected behavior is a direct reassurance about the selected hotel reception/reservations within the normal prompt target.
- If the controller-level trust reply fires, the orchestrator is intentionally not scheduled for that same message. This avoids duplicate reassurance replies while preserving normal AI handling for every other message.

## Final Go-Live Pass - Legacy Engine

The OpenAI-first experiment was removed from the runtime path and the legacy orchestrator is the production engine again. The legacy flow now keeps the deterministic booking guardrails that worked best, with focused fixes for the latest go-live defects:

- Final booking creation requires the public quick-reply action `place_reservation`; typed confirmation text only re-shows the final button.
- Explicit room changes from the latest guest turn win over older assistant recommendations, so a later "make it triple" cannot be overwritten by a previous double-room quote.
- Room recommendations by guest count still work, including cases such as "for me and my son" where a double room is the natural recommendation when available.
- Booking memory questions such as "what room did we choose?" answer from the current slots and keep the active booking buttons visible.
- Price reminders during reservation-detail collection no longer intercept labeled guest details when a guest name contains words such as "Price".
- Optional-email prompts keep the skip-email quick reply visible after price or memory reminders.
- Language-switch acknowledgements preserve the active booking quick replies, so moving from English to Arabic does not strand the guest.
- Room type lists are formatted line-by-line in the customer-service monitoring UI for readability.
- Saved Arabic hotel facts, including bus and policy details, are translated/adapted before being shown to English guests.
- Arabic Gregorian month dates are parsed before Hijri fallback, so phrases such as "15 August 2026" in Arabic script stay Gregorian while explicit Hijri months such as Ramadan still use Hijri conversion.

Local production-like QA passed on 2026-06-28 with `AI_AGENT_ENGINE=legacy`, `AI_AGENT_USE_LEGACY=true`, `AI_AGENT_DEBUG=false`, and WhatsApp dry-run enabled:

- `english_full_25_turn_stress`: 22 guest turns, 22 AI replies, 0 slow replies, reservation saved with correct name, phone, nationality, guests, hotel, and room context.
- `arabic_full_memory_buttons`: 14 guest turns, 14 AI replies, 0 slow replies, reservation saved with correct Arabic guest name, phone, nationality, guests, and hotel.
- `final_button_required`: reservation was not created until the actual quick-reply button was used.
- `post_review_price_not_dates`: price reminder after review did not ask for dates again and preserved the final booking path.
- `room_change_no_stale_quote`: later triple-room request replaced the earlier double quote and did not reuse stale room context.
- `language_switch_mid_flow`: switched to Arabic, answered in Arabic, and kept booking quick replies available.

Go-live quality note: English and Arabic are the current production target and tested at 9+/10 for the Zad Ajyad booking flow. Spanish, French, Urdu, Hindi, Indonesian, and Malay use the same routing and deterministic guards, but should be treated as future polish at roughly 7.5-8.5/10 depending on how explicit the guest is.

## Public Widget And Admin Monitor Follow-Up - 2026-06-29

- Guest-closed public widget cases must set `caseStatus: "closed"`, `closedBy: "client"`, `aiToRespond: false`, and `aiHandoffReason: "client_closed_case"`.
- The public SSR widget should stop client polling, typing emits, and socket listeners once `conversationEnded` is true. The rating UI may remain visible, but it should not continue live polling a closed case.
- The admin customer-service history view should not render historical closed chats as live AI waits. Closed/history cases may show historical reply metrics, but the monitor status must be closed/paused and current waiting time should be blank.
- Mobile chat links are rendered as visible link chips in the public SSR widget so reservation confirmation and payment links are obvious on phone screens.
- The public SSR widget may show a short local "agent is typing" indicator after guest send. This is cosmetic only and must not create extra backend or OpenAI requests.
- Final Arabic and English reservation-created messages intentionally include a short warm note that the hotel is happy the guest booked, while preserving confirmation number, details link, payment link, and post-booking help prompt.
