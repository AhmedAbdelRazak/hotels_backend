# Chatbot Production Latency Handoff - 2026-06-24

## Production State

- Backend repo: `hotels_backend`
- Backend production app: `hotels-backend`
- Backend production SHA: `2af9b6b` (`Tighten reservation detail latency margin`)
- Backend branch: `master`
- SSR repo: `jannatbooking_ssr`
- SSR production app: `jannat-ssr`
- SSR SHA: `3224279`
- SSR branch: `main`

Local, GitHub, and the home server were checked after deployment:

- Backend local: `2af9b6b`
- Backend origin/master: `2af9b6b30e55f2e7a1201c17c23c4a507ee3ab65`
- Backend home server: `2af9b6b`
- SSR local: `3224279`
- SSR origin/main: `32242796d853b18e339025d57a466e4579f146f0`
- SSR home server: `3224279`

The home-server SSR worktree has an untracked `.env.production`; leave it in
place because it is runtime configuration, not source drift.

## What Changed

Main backend file:

- `aiagent/core/orchestrator.js`

Support/controller files touched during the stabilization:

- `controllers/supportcase.js`
- `controllers/reservations.js`

Behavior now expected:

- Public support cases that the client closes are truly closed. A follow-up
  client message to a closed case returns HTTP `409` with
  `SUPPORT_CASE_CLOSED`, and the AI responder is paused for that case.
- AI pacing is tuned for a fast human rhythm:
  - normal reply target: 3.4-4.4 seconds
  - booking quote target: 4.0 seconds
  - booking prompt target: 3.6 seconds
  - typing indicator delay: 3.0-3.6 seconds
  - guest quiet window: 2.4 seconds
  - reservation detail quiet window: 1.2 seconds
  - guest typing hold: 2.2 seconds
- The bot waits when the guest is still typing, so multiple separate messages
  such as "Hi", "How are you?", and "What room types do you have?" can be
  grouped before the AI answers.
- Post-booking routing is sticky only after a real AI-created reservation
  exists. Quote numbers alone must not put the case into post-booking mode.
- After booking, the guest can ask anything: confirmation number, Nusuk,
  maps/location, cancellation/refund, room questions, recommendations, or casual
  questions. These should answer from the completed reservation context when
  useful without restarting the booking flow.
- English address now avoids starting every message with the guest name. The
  bot may occasionally use Mr./Ms. or a neutral guest address.
- Arabic address should use respectful forms when addressing the guest, such as
  `Ostaz Ahmed` and `Ostaza Marwa`, instead of bare first names.
- Month-first date ranges such as "July 12 through July 16, 2026" are parsed.
- Distance/travel-time follow-ups answer deterministically for walking/car
  style questions.
- Room/date quote requests are guarded from false payment routing.
- Missing reservation details are chased through faster deterministic paths.
- The pending-confirmation notification count path was simplified so the old
  expensive count aggregation is no longer used in the notification response.

## Production Health Snapshot

Captured after the final backend restart:

- `hotels-backend`: online, 0% CPU, about 213 MB memory
- `jannat-ssr`: online, 0% CPU, about 75 MB memory
- Server memory: 15 GiB total, 1.8 GiB used, 13 GiB available
- Swap: 4.0 GiB total, 0 B used
- Root disk: 466 GB total, 30 GB used, 413 GB available, 7% used

The old backend error log still contained previous
`pending_confirmation_notification_count exceeded latency budget` entries. The
file timestamp was `2026-06-23 20:50:49 -0700`, before the latest handoff check.
No new backend crash was observed after the final restart.

One fresh non-chat observation remains: the pending-confirmation notification
list sometimes returns in roughly 0.84-1.0 seconds, but it succeeds and no
longer throws the old count timeout error. This is not the chatbot reply path,
but tomorrow it is worth checking indexes/query shape if admin polling still
feels heavy.

## Cleanup Done

Temporary production QA records were removed for these source markers:

- `codex_four_case_batch_final_alpha`
- `codex_burst_typing_alpha`

Cleanup result:

- Found temp support cases: 1
- Deleted temp support cases: 1
- Deleted temp reservations: 0
- Remaining temp support cases: 0
- Remaining reservations for found temp cases: 0
- Deleted support case id: `6a3b5ea64ae24f1615e02be7`

The local temporary batch harness
`scripts/codex_chat_latency_batch.js` was removed after cleanup.

## Verification Completed

- `node --check aiagent/core/orchestrator.js` passed after the final latency
  patch.
- Backend was pushed to GitHub and fast-forwarded on the home server.
- `hotels-backend` was restarted with PM2 and confirmed online.
- Backend local, GitHub, and home server SHAs match.
- SSR local, GitHub, and home server SHAs match.
- Production temp QA data was cleaned.

Earlier production QA during this stabilization showed:

- Case 1 `Ahmed`: passed with max reply about 4.66 seconds and cleanup complete.
- Case 2 `JBQA`: passed with max reply about 4.91 seconds and cleanup complete.
- Case 3 `Mona`: previously failed by a tiny margin at 5.025 seconds on a
  reservation-detail reply. The final deployed patch changed the reservation
  detail quiet window from 1.6 seconds to 1.2 seconds to recover that margin.

Important: after the final `2af9b6b` deployment, the long four-case production
suite was started but not completed before the user asked to stop for now. Do
not claim a final four-case pass until it is rerun tomorrow.

## Tomorrow Checklist

1. Recreate or restore the four-case production QA harness, but keep it
   temporary and delete it again afterward.
2. Rerun exactly four cases, each with at least 20 guest messages:
   - location and travel time
   - Nusuk / Rawdah / permits
   - room types
   - reservation creation
   - recommendations
   - casual questions
   - maps
   - post-booking confirmation-number recall
   - arbitrary post-booking questions after completion
3. Strictly fail any AI reply over 8 seconds. Target 3-5 seconds.
4. If a reply is barely over 5 seconds on reservation details, consider lowering
   `AI_RESERVATION_DETAIL_QUIET_MS` from `1200` to `1000`.
5. Rerun the burst typing/no-overlap smoke test:
   - send several guest messages quickly
   - emit guest typing while they are being sent
   - confirm no AI reply is sent while the guest is still typing
   - confirm the typing indicator appears after roughly 3-5 seconds, not
     instantly
6. Reconfirm closed client cases return `409 SUPPORT_CASE_CLOSED`.
7. Recheck PM2 status, memory, disk, and backend error log.
8. Delete all temporary QA support cases/reservations before final sign-off.

## Preserve These Rules

- Do not let a closed client case accept new messages or reawaken AI.
- Do not let a quote number alone count as a completed reservation.
- Do not restart booking flow after a reservation when the guest asks a normal
  post-booking question.
- Do not address the guest by bare name in every message.
- Keep Arabic honorifics respectful whenever the bot addresses the guest.
- Keep deterministic fast paths for common hotel facts and booking details; use
  LLM wording only where it does not threaten the latency target.
- Keep production test data temporary and remove it immediately after testing.
