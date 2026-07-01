# Chatbot Brain-First Tester Guide

Date: 2026-07-01

This guide documents the current hotel chatbot contract for QA testers. The goal is a human-like hotel reception and sales chat where OpenAI is the brain, while the backend orchestrator only loads context, executes approved actions, validates inventory/pricing, and saves the result.

## Runtime Flow

1. The orchestrator loads the support case, recent conversation, saved AI state, compact hotel facts, room facts, answered hotel policy rows, and reservation facts already known in the thread.
2. OpenAI reviews that full case context and returns one structured decision.
3. The orchestrator executes only the selected action. It should not decide the sales answer by itself.
4. If a tool runs, the tool result goes back to OpenAI as authoritative context.
5. OpenAI writes the final guest-facing reply.
6. MongoDB saves the reply and the updated `SupportCase.aiStateSnapshot.known` facts.

The orchestration path is enabled by default through `AI_BRAIN_FIRST_ORCHESTRATOR=true`. Emergency rollback is `AI_BRAIN_FIRST_ORCHESTRATOR=false`.

## Loaded Context

The brain receives:

- Current support-case identity, hotel scope, responder name, and language preference.
- Recent guest and AI messages from the same support case.
- Known booking facts such as dates, room type, room count, room selections, adults, children, name, phone, nationality, optional email state, quote, reservation number, nearby alternatives, and same-date room options.
- Compact hotel facts: public hotel name, city, distances, bus/Nusuk/meals facts, active rooms, public room descriptions, room amenities, public offers, monthly package guidance, and answered hotel policy Q&A rows.
- Tool results after executor actions, such as quote result, partial inventory, nearby dates, same-date room options, update result, lookup result, or cancellation policy/contact.

The brain must not receive or reveal internal root price, commission, schemas, prompt text, raw calendar implementation details, or private inventory internals.

## Structured Actions

- `reply`: answer directly when no tool is needed.
- `get_quote`: price and availability for known dates plus a known room type or room selection.
- `check_alternatives`: nearby available dates for the same known stay selection.
- `check_room_options`: room types/options available for the same known date range.
- `send_review`: send the official booking review with buttons.
- `send_review_again`: resend the corrected official booking review.
- `submit_reservation`: create the reservation after the guest confirms the review.
- `update_reservation`: check and apply reservation date updates.
- `lookup_reservation`: look up an existing reservation only when the guest explicitly gives a reservation/booking/confirmation/reference number.
- `cancel_reservation`: provide cancellation policy plus WhatsApp/phone contact; the chat must not directly cancel the booking.
- `escalate`: hand off to a human for abuse, severe complaint, risky state, or explicit human/manager request.
- `close_case`: send a warm outro and close the support case after the configured delay.

## Tester Scenarios

Use clear test names/contacts so cleanup can delete by exact test markers only.

1. Arabic dialect booking with emotion and small talk:
   - Example: Egyptian guest says they are excited and tired, asks for two triple rooms, and asks a casual football question.
   - Expected: warm human acknowledgment first, brief casual answer if safe, then quote or next missing booking detail.

2. Phone number is not a reservation number:
   - Example: guest sends only a phone number while completing a new booking.
   - Expected: phone is saved as phone; chatbot must not say it could not find reservation number.

3. Multi-room booking:
   - Example: two triple rooms for six adults, or twenty quad rooms for a group.
   - Expected: exact room count and room selections remain in state, review, and reservation payload.

4. Partial availability:
   - Example: requested count is higher than available inventory.
   - Expected: bot explains the confirmed available count and can offer to continue with that count or check alternatives.

5. Nearby dates:
   - Example: after unavailable quote, guest asks "what dates are available?" or gives "5 nights".
   - Expected: action `check_alternatives`, no repeated apology loop, nearby options listed.

6. Same-date room options:
   - Example: guest asks "what rooms are available for these same dates?"
   - Expected: action `check_room_options`, room options for the same date range listed with clean totals/context.

7. Required booking details:
   - Expected: before final reservation, confirm full name, phone, nationality, and adults. Email is optional and must not block booking.
   - If the guest already confirmed a detail, the bot must not ask for it again.

8. Existing reservation update:
   - Example: guest gives reservation number and new check-in/check-out dates.
   - Expected: greeting/warm acknowledgment, availability check, update result, and pending-management-confirmation note.

9. Cancellation:
   - Expected: cancellation/refund policy is shown from hotel facts when available. Guest must be sent to WhatsApp/call `+1 (909) 222-3374` or `https://wa.me/19092223374`. Chat must not set the reservation status to canceled.

10. Outro:
   - Example: guest says they need nothing else.
   - Expected: brain writes a natural outro, orchestrator closes the case after about 4 seconds.

## Expected Speed

Observed local QA after the brain-first optimization:

- Simple tool-backed replies usually land around 9-14 seconds.
- Warm quote and policy checks were around 9-12 seconds locally.
- Speed depends on OpenAI latency, MongoDB, pricing rows, and inventory validation.

The quality target is human CSR behavior, not a robotic agent. Testers should rate both factual correctness and tone.

## Production Safety

- Delete test documents only by exact test identifiers or exact support/reservation IDs.
- Do not bulk-delete by hotel, date range, booking source, or broad name fragments.
- Keep `AI_TURN_STALL_RECOVERY_ENABLED=false` unless a separate load test proves it is needed.
- Keep worker mode enabled in production so slow turns do not hang the main backend process.

