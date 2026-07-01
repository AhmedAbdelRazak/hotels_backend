# Slim OpenAI-Led B2C Orchestrator

Date: 2026-06-30

The B2C AI chat runtime was simplified so OpenAI leads the customer-facing conversation and `aiagent/core/orchestrator.js` acts mainly as a dispatcher/tool runner.

For the full production go-live story, operational issues, PM2/server health notes, Hijri handling, idle auto-close behavior, and future QA commands, see `docs/b2c-openai-chatbot-go-live-runbook-2026-06-30.md`.

## Runtime Contract

- OpenAI receives compact hotel facts, known booking facts, recent transcript, and action rules.
- OpenAI returns JSON with a customer reply, extracted facts, quick replies, and one action.
- The orchestrator executes only operational actions:
  - `get_quote`
  - `send_review`
  - `submit_reservation`
  - `update_reservation`
  - `cancel_reservation`
  - `escalate`
  - `close_case`
- The orchestrator never sends full room calendars to OpenAI. It fetches exact pricing rows only for the requested stay dates.
- Booking memory is persisted in `SupportCase.aiStateSnapshot.known` so each turn has authoritative known facts.
- The public API surface stayed stable: `schedulePlanTurn`, `wireSocket`, `finalizeImmediatePlaceReservation`, and worker `__worker.planTurn` still exist.

## Important UX Rules

- Wait for guest silence before replying.
- Show AI typing before sending the answer.
- Match the guest language/dialect naturally.
- Do not ask again for facts already in the known facts block or transcript.
- Use human handoff/escalation when the guest is angry, disrespectful, requests a human, or the flow becomes risky.

## Verification

- `node --check aiagent/core/orchestrator.js`
- `node --check controllers/supportcase.js`
- `node --check server.js`
- Helper smoke confirmed Arabic digits normalize for phone/adult counts and required booking fields pass when quote and guest details are complete.

## Rollout Note

This change removes the old scripted local brain from the runtime path. Production deployment should be followed by one supervised B2C case only, with PMS and server health visible, before any multi-chat testing.
