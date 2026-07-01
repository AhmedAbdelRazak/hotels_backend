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

## 2026-06-30 Late Production Stabilization

Deployed commits:

- `92519de` - stabilized B2C booking handoff and support-case list performance.
- `6bf086c` - made latest guest date corrections override older stored quotes/dates.

Key fixes:

- Support-case PMS list endpoints now load a recent conversation preview instead of full conversation arrays for every open/closed client case.
- Prior-chat counts for PMS list rows now use normalized `clientContact` aggregation instead of scanning full matching conversations.
- The booking turn now handles nationality, optional email, quote-ready, review, and skip-email paths deterministically before asking OpenAI again.
- Gregorian date ranges are no longer shown as `Dates (Hijri)` unless the guest actually used Hijri/mixed-calendar input.
- The date parser now accepts typo-heavy range connectors such as `though`, `thru`, `throu`, and `throughh`.
- If the guest says the review is wrong or corrects dates with wording like `instead`, latest facts win and old quotes are discarded.
- OpenAI prompt now explicitly says latest corrections override Known facts and old quotes must not be reused after a correction.

Production validation:

- Exact clone of stuck case `6a448b6c3bc6a559686597ee` was tested on a temporary support case and deleted afterward.
- Test phrase: `I want the accomdation to be from 20 Aug though 26th instead please`.
- Result: `quote_ready`, room `Quadruple Room - Comfort & Privacy`, dates `August 20, 2026 - August 26, 2026`, `6` nights, `600 SAR`.
- Response time: about `3.0s` for the cloned production turn.
- Adjacent check: `Something is wrong` alone did not repeat the old review/quote; it asked for details with no quick replies.
- Cleanup check confirmed `0` Codex QA support cases remained.
- Production health after deployment: `hotels-backend` online, root API responding, memory around `269 MB`, system memory available around `12 GB`.

Runtime safety state after deployment:

- `AI_AGENT_ENABLED=true`
- `AI_PLAN_USE_WORKER=false`
- `AI_TURN_STALL_RECOVERY_ENABLED=false`

Keep the old worker and stall recovery disabled unless a separate load test proves they are needed and safe.
