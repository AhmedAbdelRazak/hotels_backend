# Chatbot Arabic/French Date, Price, and Required-Details Hardening

Date: 2026-07-03

This document records the chatbot hardening work done after reviewing the real
Jannat Booking/Zad Ajyad support cases shared on 2026-07-03.

The main goal was to fix the Arabic date/price failure without damaging the
current chatbot structure. The secondary goal was to make required booking
details present better in the existing support widget UI.

The most important rule from this pass:

OpenAI remains the brain. The backend orchestrator should preserve known facts,
route obvious tool turns, and prevent stale or destructive memory changes from
overwriting a better guest-derived state.

## 2026-07-03 8-Bed Planning, Side-Question, and Live QA Follow-Up

This follow-up was triggered by production support case
`6a4870ad03ee56c351e6130a`.

Observed guest intent:

- Arabic guest asked for a room/stay for himself and 6 friends, then asked if
  rooms with 8 beds were available.
- After check-in/check-out dates were supplied, the bot considered options that
  did not exist at Zad Ajyad instead of planning real hotel room combinations.

Important hotel rule confirmed during this pass:

- Do not trust the raw `bedsCount` database value alone for Zad Ajyad capacity.
  It was observed as `1` across active room types.
- Capacity is derived from the canonical room type first:
  - `doubleRooms` = 2 beds/guest capacity
  - `tripleRooms` = 3 beds/guest capacity
  - `quadRooms` = 4 beds/guest capacity
  - `familyRooms` = 5 beds/guest capacity
- Therefore an 8-bed request should plan `1 familyRooms + 1 tripleRooms`, not an
  imaginary single 8-bed room.

Production behavior hardened in this follow-up:

- Requested bed count and relationship guest count are preserved through later
  date turns. Example: "me and 6 friends" plus "8 beds" becomes 7 guests with an
  8-bed target, then plans `familyRooms:1 + tripleRooms:1`.
- Room planning remains generic and data-driven. The 8-bed case is not hard
  coded; it falls out of the active room-capacity planner.
- Arabic date turns like `15 August to 25 August`, Arabic checkout corrections,
  Arabic children-under-age phrases, and French accented nationality continue to
  be parsed deterministically before the model can overwrite them.
- If the guest asks a hotel fact or service question during a booking step, the
  bot answers that question first, then restores the latest booking checkpoint
  and buttons.
- Final-review side questions now restore the stored safe quick replies from the
  checkpoint when strict quote regeneration is too conservative. This preserves
  `place_reservation` / `revise_reservation` after questions such as "Do you
  have a bus to Haram?"
- If the brain-first OpenAI call times out, the orchestrator now falls back to a
  deterministic route instead of silently returning no guest-facing answer:
  hotel fact, quote, split-stay quote, final review, or required-details prompt,
  depending on the known facts.

Runtime commits from this follow-up:

- `2d98893` - requested bed planning and initial 8-bed regression coverage.
- `3477205` - Arabic/French parsing hardening for recent scenarios.
- `38e983c` - keep hotel fact replies ahead of quote refresh.
- `d68bcb8` - prioritize hotel fact side questions before quote refresh paths.
- `bb66b37` - restore booking checkpoint buttons after hotel facts.
- `6232ac6` - add brain-first timeout fallback so guests are not ignored on an
  OpenAI timeout.

Files touched by the runtime follow-up:

- `aiagent/core/orchestrator.js`
- `scripts/chatbotRegressionChecks.js`
- This documentation file

Validation performed:

- Local `npm run test:chatbot`: `PASS 17 chatbot regression checks`.
- Server `npm run test:chatbot`: `PASS 17 chatbot regression checks`.
- Production deployed commit: `6232ac6`.
- GitHub `origin/master`: `6232ac6` before this documentation-only update.
- PM2 app: `hotels-backend`, status `online`, unstable restarts `0`.
- Health endpoint:
  - `http://127.0.0.1:8080/api/aiagent/health`
  - returned `ok: true`, `openai: true`
  - model family: `gpt-5.4-mini`
  - reasoning effort: `low`

Final live production QA sweep:

- Runner marker: `codexqa-20260704-1783137487523`
- Total scenarios: `22`
- Passed: `22`
- Failed: `0`
- Created support cases: `22`
- Real tracked test reservations created: `4`
- Duplicate fixture reservations created: `4`
- Average scenario time: `15049 ms`
- Cleanup result: `supportCasesDeleted: 22`, `reservationsDeleted: 8`
- Post-cleanup verification:
  - marker support cases remaining: `0`
  - marker fixture reservations remaining: `0`

The final live QA scenarios were:

1. Exact Arabic 8-bed support case plans `familyRooms:1 + tripleRooms:1`.
2. 8-bed final-review bus question answers the bus question and keeps final
   review buttons.
3. Actual 8-bed reservation creation creates one reservation with two rooms:
   `familyRooms:1 + tripleRooms:1`.
4. July 2 unavailable quote detour resumes alternatives after a hotel-fact
   answer.
5. Booking-process question preserves known dates and room.
6. Arabic rapid date correction keeps the latest intended dates.
7. Arabic price follow-up with existing facts returns the quote path.
8. French details parse adults, accented nationality, and triple room.
9. Arabic children-under-12 count preserves children as children, not age as
   count.
10. Seven guests plan `familyRooms:1 + doubleRooms:1` and produce a guest-facing
    reply.
11. Ten guests plan `familyRooms:2` and produce a guest-facing reply.
12. Explicit `1 double + 1 quad` selection is preserved and produces a
    guest-facing reply.
13. Same-day check-in is blocked politely.
14. Guest asking for a confirmation number before creation does not get a fake
    confirmation.
15. Thank-you / no-more-help path uses a safe outro and does not imply a pending
    booking.
16. Short reaction after hotel fact does not repeat a long fact answer.
17. Optional email skip proceeds to final review.
18. Profile phone "same number" answer is accepted.
19. One duplicate reservation warns before creating another.
20. Duplicate-warning acknowledgement then creates a separate marked test
    booking.
21. Two duplicate reservations hard-cut automatic creation.
22. Split-stay creates separate reservations and sends the outro.

Cleanup caution for future work:

- The live QA runner creates real marked support cases and real marked test
  reservations. It must always delete by exact marker/case/reservation IDs only.
- Do not delete broad production support cases or reservations during chatbot
  testing.
- Existing server `.env.backup-*` and `.bak-*` files are historical artifacts and
  were intentionally left untouched.

## Final Outcome Summary

Final deployed backend commits:

- `4ffb298` - `Harden chatbot date price recovery`
- `c1b087f` - `Expand chatbot hardening documentation`
- This follow-up commit - one-by-one messy booking detail recovery for labeled and
  unlabeled standalone date messages
- `e3da4a1` - `Harden chatbot one-by-one detail recovery`
- `a7f4313` - `Harden chatbot booking recovery`

Final production state after the original runtime deployment:

- GitHub `master` contains the patch.
- Production backend `/home/ahmedadmin/Hotels/hotels_backend` is on `4ffb298`.
- `hotels-backend` was restarted through PM2 after the pull.
- `jannatbooking_ssr` was not changed and was not restarted.
- Public AI health returned HTTP `200` after deployment.
- `https://jannatbooking.com` returned HTTP `200` after deployment.
- PM2 showed `hotels-backend` online after restart.
- Backend logs after restart showed:
  - `[aiagent] slim OpenAI-led orchestrator active.`
  - `[aiagent] initialized.`
  - `[socket] DB watcher broadcasting conversation updates enabled.`
  - `Server is running on port 8080`
  - `MongoDB Atlas is connected`

Original local validation:

- `node --check aiagent\core\orchestrator.js`
- `node --check aiagent\core\nlu.js`
- `git diff --check`
- Focused local regression harness: `PASS 35 chatbot regression checks`

Follow-up local validation after one-by-one data hardening:

- `node --check aiagent\core\orchestrator.js`
- `node --check aiagent\core\nlu.js`
- Focused local regression harness: `PASS 42 chatbot regression checks`

Latest booking-recovery follow-up validation after `a7f4313`:

- `node --check aiagent\core\orchestrator.js`
- `node --check aiagent\core\nlu.js`
- `node --check scripts\chatbotRegressionChecks.js`
- `npm run test:chatbot`
- `git diff --check`
- Local and production result: `PASS 8 chatbot regression checks`

Original sync check:

- Local backend: `4ffb298`, clean working tree.
- Production backend tracked tree: `4ffb298`, in sync with `origin/master`.
- Local SSR: `2f5d1f1`, clean working tree.
- Production SSR tracked tree: `2f5d1f1`, in sync with `origin/main`.

Latest booking-recovery sync check after `a7f4313`:

- Local backend: `a7f4313`, clean tracked working tree.
- GitHub `origin/master`: `a7f4313`.
- Production backend tracked tree: `a7f4313`, in sync with `origin/master`.
- Production backend was restarted with PM2 after the pull.
- Production AI health returned `ok: true` from:
  - `http://127.0.0.1:8080/api/aiagent/health`
  - `https://jannatbooking.com/api/aiagent/health`
  - `https://xhotelpro.com/api/aiagent/health`
- No frontend or SSR code changed for this follow-up.

## Current Deployment State

Backend repository:

- Local path: `D:\JannatBooking\hotels_backend`
- Production path: `/home/ahmedadmin/Hotels/hotels_backend`
- GitHub branch: `master`
- Production PM2 app: `hotels-backend`
- Production deployed runtime commit after the original pass: `4ffb298`
- Latest deployed runtime commit after the booking-recovery follow-up: `a7f4313`
- Latest documentation sync commit before the one-by-one data follow-up:
  `c1b087f`
- Files changed locally in this pass:
  - `aiagent/core/orchestrator.js`
  - `aiagent/core/nlu.js`
  - `docs/chatbot-arabic-french-date-price-required-details-hardening-2026-07-03.md`
- Files changed in the `a7f4313` booking-recovery follow-up:
  - `aiagent/core/orchestrator.js`
  - `package.json`
  - `scripts/chatbotRegressionChecks.js`

Frontend repository:

- Local path: `D:\JannatBooking\jannatbooking_ssr`
- Production path: `/home/ahmedadmin/Hotels/jannatbooking_ssr`
- Production PM2 app: `jannat-ssr`
- No frontend code changed in this pass.

Important deployment note:

- The production backend was originally observed at `9a37fa3` during the
  read-only pre-deploy check.
- It was then fast-forwarded to `4ffb298`.
- The production SSR stayed at `2f5d1f1` because this patch did not require any
  frontend change.

## 2026-07-03 Follow-Up: Booking Checkpoint, Capacity, and Timing Hardening

This section documents the later same-day follow-up that produced commit
`a7f4313` (`Harden chatbot booking recovery`).

The follow-up was based on another real Zad Ajyad Arabic booking transcript. The
important failure was not the hotel-fact answer itself. The bot answered the bus
question correctly, but after answering it, it did not preserve the guest's
place in the booking flow. The guest had already reached a final review with
buttons, asked whether there was a bus to Haram, then had to write a casual
"let's book" message to restart the booking continuation.

Correct behavior from this follow-up:

1. Answer the guest's latest question first.
2. Do not ignore any guest question, even if it is off-topic or comes in the
   middle of booking.
3. After answering, restore the latest valid booking checkpoint in the same
   message when a checkpoint exists.
4. Show quick replies that match that checkpoint, not a generic or stale step.
5. If there is not enough data to continue, say that politely and list only the
   missing data needed for the next step.
6. Never claim "everything is ready" when quote, dates, guest counts, room
   capacity, name, phone, nationality, or final review confirmation is missing.
7. Keep the behavior generic. The real transcript is a regression example, not a
   production branch.

### Example Flow That Must Stay Fixed

Real flow shape:

1. Guest gives dates and guests.
2. Bot quotes and asks whether to continue.
3. Guest continues.
4. Bot collects required details.
5. Bot shows final review and quick replies:
   - complete booking
   - something is wrong
6. Guest asks an off-topic but relevant hotel fact:
   - bus/shuttle to Haram
7. Bot must answer the bus question and then restore the final review prompt and
   quick replies in the same message.

The required pattern is:

```text
[nice direct answer to the guest's latest question]

[latest booking checkpoint summary/review, if still valid]

[localized next-step prompt]
[matching quick replies/buttons]
```

For Arabic final-review recovery, the expected button set is equivalent to:

- `إتمام الحجز`
- `هناك شيء غير صحيح`

For quote/continue recovery, the expected button set is equivalent to:

- `نعم، تابع`
- `أريد تعديل شيء`

These labels are examples of the checkpoint type. Production logic must choose
labels from the current language/action context, not from one transcript.

### Booking Checkpoints

The follow-up introduced a small deterministic checkpoint layer around hotel
fact detours.

Current checkpoint categories:

- quote/continue checkpoint
  - guest has a valid quote
  - next action is to continue or modify
- required-details checkpoint
  - quote exists
  - booking is not ready because required guest details are missing
- optional-email checkpoint
  - required details are present
  - email is optional and can be skipped
- final-review checkpoint
  - quote and required details are present
  - guest must confirm the official review before reservation creation

Important behavior:

- Checkpoints are computed from current recovered facts and the latest durable
  state.
- Checkpoints are not created from one guest name, one phone number, one room
  name, one hotel, one case ID, or one date range.
- The checkpoint must be the latest valid booking step. For example, if the
  latest valid step is final review, the bot must not go backward to "do you
  want to continue?" unless required facts became invalid.
- If a quote no longer matches the current facts, the old quote must not be used
  to create a final-review checkpoint.
- If current room selections cannot fit the known guest count, the old room plan
  must be replanned or rejected before quote/review recovery.

New/changed orchestrator helpers in `aiagent/core/orchestrator.js`:

- `latestBookingCheckpointBeforeEntry`
  - Finds the latest usable booking checkpoint before a hotel-fact entry.
- `bookingCheckpointRestoreMessage`
  - Builds deterministic restore text for quote, required-details,
    optional-email, and final-review checkpoints.
- `bookingCheckpointQuickReplies`
  - Chooses localized quick replies for the restored checkpoint.
- `appendBookingCheckpointToHotelFactReply`
  - Appends the checkpoint after the hotel-fact answer.
- `hotelFactQuickRepliesWithBookingCheckpoint`
  - Ensures quick replies match the restored checkpoint.
- `sendHotelFactReplyFromOpenAI`
  - Answers the hotel fact first, then appends deterministic checkpoint recovery.
- `sendBrainToolReplyFromOpenAI`
  - Supports a validated reply suffix so deterministic recovery can be appended
    after the writer produces the fact answer.

### Hotel-Fact Detour Contract

Hotel facts include questions such as:

- bus/shuttle/transport to Haram
- distance to Haram
- address or location
- parking
- breakfast or meals
- Nusuk
- cancellation/refund/policy facts

Required behavior:

- Answer the fact from saved hotel facts when available.
- If saved facts are not enough, say politely that the detail is not confirmed
  in the available hotel data.
- Do not invent schedules, exact shuttle times, prices, guarantees, or policies.
- Do not drop the booking flow after the answer.
- Do not ask the guest to repeat details already recovered.

Examples of safe wording:

- "The available hotel data says there is shuttle/bus support; exact timings can
  be confirmed with reception. Your booking details are still ready below..."
- "I do not have a confirmed schedule in the hotel data, but I can continue your
  booking from the current review..."

Unsafe wording:

- Claiming exact shuttle timings without stored facts.
- Saying the booking is ready when required details are missing.
- Answering only the hotel fact and leaving the guest without the current booking
  button.
- Restarting the flow by asking for dates again when dates are already known.

### Continue-Intent After A Detour

The guest may resume with natural language instead of clicking a button. The
follow-up widened continuation recognition so Arabic casual booking intent can
resume the correct step.

Examples that should resume booking when a valid checkpoint exists:

- `يلا نحجز`
- `نحجز بقا`
- `تمام كمل`
- `تمام احجز`
- English equivalents such as `let's book`, `continue`, `go ahead`

Important safety:

- This does not bypass final review.
- If the latest checkpoint is final review, the bot should show/confirm the
  final review path, not silently create the reservation unless the official
  confirmation rules are satisfied.
- If required details are missing, the bot must ask for the missing details
  instead of pretending the booking can be completed.

### Room Capacity Planning

The follow-up also fixed a room-capacity problem exposed by larger guest groups.
The previous behavior could keep a selected room plan whose capacity was too
small for the known guest count.

New/changed helpers:

- `activeRoomCapacityCandidates`
  - Builds available room candidates from active hotel room data.
- `roomSelectionsGuestCapacity`
  - Computes total capacity for selected rooms.
- `bestRoomSelectionsForGuests`
  - Finds a generic best-fit room plan for a known guest count.
- `ensureRoomPlanForGuestCapacity`
  - Replaces or invalidates an under-capacity room plan before quote/review.
- `quoteMatchesKnown`
  - Now rejects quotes when selected room capacity is lower than known guests.

Selection principle:

- Use active room types and their capacities.
- Prefer enough capacity without excessive over-capacity.
- Prefer practical fewer-room plans when otherwise equivalent.
- Do not hard-code "family + double" for seven guests.

Example covered by regression:

- If active rooms include double, triple, quadruple, and family-style room
  capacities, seven guests should produce a valid enough-capacity plan such as
  one family room plus one double room when that is the best available fit.
- This is an outcome of generic scoring over active hotel rooms, not a fixed
  branch for the number `7`.

Safety rule:

- A quote/review must not survive if it was created for a room plan that cannot
  fit the current guest count.
- When guest count changes, selected-room capacity must be checked before any
  quote, review, or reservation submission.

### Arabic Guest Count Preservation

The follow-up fixed a labeled Arabic guest-count edge where children under a
certain age could be dropped to zero.

Example shape:

```text
عدد الكبار 4 عدد الاطفال تحت 12 سنه 3
```

Expected recovered facts:

- adults: `4`
- children: `3`

Required behavior:

- Do not treat "under 12 years" as meaning zero children.
- Do not mistake the age threshold (`12`) for the number of children.
- Preserve both adult and child counts when the text labels them clearly.

### Turkish And Economical Nearby-Date Routing

The follow-up added a lightweight language/context detector for Turkish and for
nearby cheaper-date requests.

New/changed helpers:

- `languageFactsFromGuestText`
- `latestGuestRequestsCheaperNearbyDates`

Purpose:

- If the guest clearly writes Turkish, keep the active language aligned with the
  guest instead of forcing Arabic/English from older context.
- If the guest asks for cheaper/economical nearby dates, route to alternative
  date handling instead of a generic value-objection answer.

Safety:

- Turkish detection requires clear Turkish markers.
- Arabic remains Arabic when Arabic script is present.
- The cheaper-date path should not invent prices; it should use the existing
  alternative-date/quote logic.

### Bed Count And Room Capacity Facts

Some room data can expose unreliable `bedsCount` values. For example, a room
type that is operationally triple/quad/family may still have `bedsCount: 1` in
stored data.

Follow-up behavior:

- `compactHotelFacts` now prefers known room-type capacity from
  `roomCapacityForKey(room.roomType)` before falling back to stored `bedsCount`.
- `suggestRoomOptionsForStay` uses the same safer capacity basis.

Why this matters:

- The bot should not tell guests a triple/family room only fits one person
  because a legacy `bedsCount` field is incomplete.
- Capacity and bed display are related but not identical. Capacity should drive
  fit/quote planning.

### Timing And Quality Notes

The requested target was an average reply time around 10-15 seconds, but only if
quality and integrity stay first.

No production env timing knob was changed in `a7f4313`.

The timing improvement in this follow-up is structural:

- Hotel-fact detours can now answer and restore the checkpoint in one message.
- Natural "continue booking" messages after a detour are recognized earlier.
- Valid room plans are repaired before quote/review instead of drifting into a
  slow or confusing recovery turn.
- Quote/review capacity checks prevent stale work from continuing.

Why no hard-coded 10-15 second timer was added:

- The AI agent already has humanized typing delay and guest-typing wait rules.
- OpenAI response time, DB reads, quote calculations, and hotel-fact context can
  vary.
- A fixed timer would not improve quality and could make fast deterministic
  answers feel artificially slow.
- Quality-first behavior means the bot should take longer when it must verify
  context or run a tool.

Production health after deployment reported:

- `model: gpt-5.4-mini`
- `reasoningEffort: low`
- `writerReasoningEffort: low`
- `nluReasoningEffort: low`
- `analysisReasoningEffort: low`

This indicates the live configuration was already using the lower-latency
reasoning setting at the time of verification. Future timing work should prefer
measured improvements in deterministic routing, prompt size, and tool latency
before changing model quality settings.

### Regression Harness Added In This Follow-Up

New file:

- `scripts/chatbotRegressionChecks.js`

New npm script:

- `npm run test:chatbot`

The harness is a dry-run Node assertion suite. It sets local dry-run/fake
notification env values before requiring the orchestrator so tests do not send
real WhatsApp, email, or reservation confirmations.

Current covered scenarios:

1. Arabic labeled children-under-age count is preserved.
2. Seven guests produce a valid generic family-plus-double-style room plan.
3. Invalid one-room family selection for seven guests is replanned before
   quote/review.
4. Quote cannot match if selected capacity is too small.
5. Hotel fact side question restores final-review checkpoint and buttons.
6. Booking intent after hotel fact resumes final review.
7. Turkish language and economical nearby dates are detected.
8. Room facts expose type capacity before unreliable `bedsCount`.

Exact local and server output:

```text
PASS Arabic labeled children-under-age count is preserved
PASS Seven guests produce family plus double room plan
PASS Invalid one-room family selection is replanned before quote/review
PASS Quote cannot match if selected capacity is too small
PASS Hotel fact side question restores final review checkpoint and buttons
PASS Booking intent after hotel fact resumes final review
PASS Turkish language and economical nearby dates are detected
PASS Room facts expose type capacity before unreliable bedsCount
PASS 8 chatbot regression checks
```

### Deployment And Health Notes For `a7f4313`

Local validation before commit:

```powershell
node --check aiagent\core\orchestrator.js
node --check aiagent\core\nlu.js
node --check scripts\chatbotRegressionChecks.js
npm run test:chatbot
git diff --check
```

Commit and push:

- Commit: `a7f4313 Harden chatbot booking recovery`
- Branch: `master`
- Remote: `origin`
- GitHub push completed successfully.
- GitHub reported existing dependency vulnerabilities on push. This follow-up
  did not change dependencies.

Production deployment:

```bash
cd /home/ahmedadmin/Hotels/hotels_backend
git pull --ff-only origin master
node --check aiagent/core/orchestrator.js
node --check aiagent/core/nlu.js
node --check scripts/chatbotRegressionChecks.js
npm run test:chatbot
pm2 restart hotels-backend --update-env
```

Production result:

- Production moved from `e3da4a1` to `a7f4313`.
- `hotels-backend` restarted successfully.
- PM2 showed `hotels-backend` online.
- Memory after restart was around `271 MB`.
- Logs showed:
  - `[aiagent] slim OpenAI-led orchestrator active.`
  - `[aiagent] initialized.`
  - `[socket] DB watcher broadcasting conversation updates enabled.`
  - `Server is running on port 8080`
  - `MongoDB Atlas is connected`

Read-only public smoke checks:

- `https://jannatbooking.com/api/aiagent/health`
  - HTTP `200`
  - payload included `ok: true`, `openai: true`
- `https://xhotelpro.com/api/aiagent/health`
  - HTTP `200`
  - payload included `ok: true`, `openai: true`
- `https://jannatbooking.com/api/single-hotel/zad-ajyad`
  - HTTP `200`
- `https://jannatbooking.com/api/active-hotel-list`
  - HTTP `200`
- `https://jannatbooking.com/api/room-query-list/2026-08-25_2026-08-28_all_3_0_Makkah`
  - HTTP `200`

No reservation writes were performed during this verification. The public smoke
checks were read-only.

### Future Test Cases To Keep

Add or keep focused checks whenever this area is touched:

- Final review plus hotel fact:
  - guest asks about bus/shuttle
  - expected: hotel-fact answer first, final review restored, final-review
    buttons visible
- Quote/continue plus hotel fact:
  - guest has quote and asks about parking/breakfast/distance
  - expected: fact answer first, quote/continue checkpoint restored
- Required details plus hotel fact:
  - guest has quote but is missing nationality/phone/name
  - expected: fact answer first, missing-details message restored
- Optional email plus hotel fact:
  - guest has required details and email is optional
  - expected: fact answer first, skip-email/continue path preserved
- Not enough data:
  - guest asks off-topic before dates/room/guest count are known
  - expected: answer what can be answered, then politely ask only for missing
    booking data
- Casual Arabic continue after detour:
  - `يلا نحجز`
  - expected: resume latest checkpoint without bypassing final-review safety
- Seven or more guests:
  - expected: selected rooms have enough total capacity
- Labeled adult/children counts:
  - expected: child age thresholds are not mistaken for child count
- Turkish economical nearby dates:
  - expected: Turkish response context and alternative-date route
- Room data with bad `bedsCount`:
  - expected: capacity comes from room type where known

### Future Cautions From This Follow-Up

- Do not remove checkpoint recovery from hotel-fact replies. It is what prevents
  the guest from feeling ignored after asking a side question.
- Do not make checkpoint recovery depend on exact button text from one language.
  Use the current action/state and localize the labels.
- Do not treat every "yes/ok" after a hotel fact as permission to create a
  reservation. The latest safe checkpoint decides what can happen next.
- Do not let the writer invent a booking checkpoint from prose. The checkpoint
  should be based on structured/recovered facts and quote validity.
- Do not keep a stale quote if guest count, dates, room type, or room selections
  changed.
- Do not trust stored `bedsCount` over known room-type capacity for fit
  decisions.
- Do not change model/reasoning settings just to chase a timing target unless
  the regression suite and supervised live checks prove quality is preserved.
- Do not delete production `.env.backup-*` or `.bak-*` files during chatbot
  deployment. They were pre-existing server artifacts and should be handled only
  in a separate cleanup task.

## Production Health Check Before Deploy

Read-only production checks were run from the local machine and over the `jannat`
SSH alias.

Public HTTP checks:

- `https://xhotelpro.com/api/aiagent/health` returned HTTP `200`.
- Health payload reported:
  - `ok: true`
  - `openai: true`
  - `model: gpt-5.4-mini`
  - `reasoningEffort: low`
- `https://jannatbooking.com` returned HTTP `200`.
- `https://xhotelpro.com` returned HTTP `200`.

PM2 status on production at `2026-07-03 13:16 UTC`:

- `hotels-backend`: online, uptime about `6h`, restarts `0`, memory about `301 MB`.
- `jannat-ssr`: online, uptime about `6h`, restarts `0`, memory about `78 MB`.
- `zad-ssr`: online.
- `hotels-frontend`: online.
- Other apps were also online.

Recent backend PM2 log tail:

- Recent `hotels-backend` entries were normal HTTP `200`/`304` traffic.
- Recent `/api/aiagent/health` checks returned `200`.
- No new backend crash was seen in the tail checked during this pass.

Recent SSR PM2 log tail:

- `jannat-ssr` was online.
- Error tail still showed two image warnings:
  - `/assets/janat/1755216831611.jpg`
  - `/assets/janat/1755216844209.jpg`
- These were not caused by this backend chatbot patch.

Production working tree note:

- `/home/ahmedadmin/Hotels/hotels_backend` had many pre-existing untracked
  `.env.backup-*` and `.bak-*` files.
- The tracked production backend tree was not showing modified tracked files.
- Do not delete the backup files casually during deployment.

## Runtime Architecture Map For Future Work

The chatbot structure around this patch has four important layers.

### 1. Public Support Widget

Main frontend area:

- `jannatbooking_ssr/components/SupportWidget.js`

Ownership:

- Displays public chat messages.
- Renders markdown-style `**bold**` text used by the required-details rows.
- Shows quick replies/buttons returned by the backend.
- Should not own booking memory, pricing logic, date parsing, or room selection
  recovery.

Important UI contract:

- The backend can safely send plain text with line breaks.
- The backend can safely send bullet rows such as:
  - `- **Full Name:** Needed`
  - `- **Phone:** Needed`
- This pass intentionally did not introduce a new structured frontend data
  contract because the widget already renders the needed formatting.

Future caution:

- If a future patch introduces real structured required-field payloads, keep the
  current text fallback until all deployed widgets understand the new shape.

### 2. Backend Socket/API Entrypoints

Main backend area:

- `server.js`
- `controllers/supportcase.js`
- `routes/supportcase.js`
- `services/supportCaseMaintenance.js`

Ownership:

- Accepts support-case messages.
- Emits socket updates.
- Schedules AI turns.
- Maintains AI idle/recovery behavior.
- Keeps public/client endpoints separate from admin endpoints.

Future caution:

- Do not move conversational interpretation into `server.js`.
- Do not make support-case socket handlers parse booking meaning directly.
- Keep AI turn scheduling separate from fact recovery and quote execution.

### 3. Orchestrator / Memory / Guards

Main backend file:

- `aiagent/core/orchestrator.js`

Ownership:

- Rebuilds `known` facts from:
  - `SupportCase.aiStateSnapshot.known`
  - support-case `conversation`
  - assistant quote/review messages
  - guest messages
- Runs deterministic guards before and after the brain-first path.
- Chooses when a tool action must run before a free-form reply.
- Protects the guest from stale assistant memory and bad generic replies.

Important principle:

- The orchestrator is not the writer.
- The orchestrator may send action-owned system messages such as quote/review
  fallbacks and required-details rows.
- Normal conversational wording should still come from the brain unless a guard
  must prevent a bad or unsafe reply.

### 4. NLU / Room / Date / Quote Helpers

Main files:

- `aiagent/core/nlu.js`
- `aiagent/core/actions.js`
- `aiagent/core/db.js`

Ownership:

- `nlu.js` maps quick room/date/amenity signals and falls back to LLM intent
  classification when needed.
- `actions.js` owns quote/reservation actions and must remain the source of
  price/availability truth.
- `db.js` loads support cases, hotels, previous chats, and safe compact data.

Important principle:

- Price must come from quote/action helpers, not from brain prose.
- Room/date extraction can be deterministic when clear, but should not guess
  beyond what the guest or trusted tool result supports.

## Support Case Fields To Respect

The support-case document is the durable source of conversation history. Future
chatbot changes should respect these fields:

- `conversation`
  - Ordered chat transcript.
  - Each entry may be guest, AI/support, or system.
  - Recovery must read this defensively because old cases may have partial,
    stale, or malformed entries.
- `aiStateSnapshot.known`
  - Compact saved memory for the current support case.
  - Should be treated as useful but not infallible.
  - Conversation recovery exists because this snapshot can be thin after worker
    fallback, restart, or older code paths.
- `aiToRespond`
  - AI may respond only when this is true and policy allows it.
- `caseStatus`
  - Closed cases should not be mutated by QA unless explicitly intended.
- `aiResponderName`
  - Controls assistant display identity.
  - Should not drive parsing logic.
- `supportScope`
  - Distinguishes hotel reception scope from Jannat platform support scope.
  - Do not let hotel-specific booking logic accidentally run before Jannat
    platform handoff is complete.
- `clientAction`
  - Important for quick replies and deterministic continuation.
  - Must remain stable where frontend buttons depend on it.
- `quickReplies`
  - Guest-facing choices.
  - Keep them language-appropriate and aligned with the current action.

Field safety rule:

- Do not add new required support-case fields for chatbot behavior unless there
  is a migration/backfill plan and the old message text fallback still works.

## Fact Priority Rules

When future work touches memory recovery, use this priority order:

1. Explicit latest guest message.
2. Fresh tool result or quote/review action.
3. Existing valid saved `aiStateSnapshot.known`.
4. Clear earlier guest messages in the same case.
5. Assistant acknowledgements anchored by valid facts.
6. Brain prose without structured facts.

Practical rules:

- A complete valid guest-derived date range should not be overwritten by one
  assistant date echo.
- An assistant acknowledgement can restore missing state, but should not replace
  stronger current state.
- A quote that no longer matches current dates/room selections must be dropped
  or refreshed.
- A room type from assistant prose should not overwrite a conflicting current
  room type unless there is a new guest selection or a tool result.
- Guest corrections sent quickly after each other should be accepted when they
  answer the same outstanding question.

## No-Hardcoding Policy From This Pass

The production fixes are intentionally dynamic.

Not allowed in chatbot logic:

- Support case IDs.
- Guest names.
- AI responder names.
- Hotel names.
- Fixed real guest dates.
- Fixed real quote prices.
- Fixed nationality or room outcome tied to one transcript.

Allowed:

- Generic language terms such as `الحساب`, `المبلغ`, `personnes adultes`.
- Generic context rules such as "Arabic-script slash date prefers day/month".
- Generic confidence anchors such as "assistant message contains two valid ISO
  dates in chronological order".
- Generic UI labels such as `Full Name`, `Phone`, and their Arabic equivalents.

Why this matters:

- The two real cases were used as regression examples, not as code branches.
- The same logic should work for other guests, other responders, and other
  hotels using the same chatbot structure.

## Real Cases Reviewed

### French Case

Case:

- Case ID: `6a477a85f7652de71c82cb0a`
- Guest: Raham Abdel
- Language: French
- Hotel: Zad Ajyad

Observed conversation:

1. Guest said he is Algerian and wants to reserve a room for `03` adult men.
2. AI correctly answered in French.
3. AI suggested a triple room and asked for dates.
4. Guest said he would coordinate with companions and come back.
5. AI closed politely.

Conclusion:

- The French conversation was customer-facing fine.
- The invisible weakness was memory quality:
  - `adults: 3` was not reliably preserved from `03 personnes adultes`.
  - `Algerian` nationality was not reliably preserved from French `algérien`.
  - The triple-room mapping depended too much on assistant text instead of the
    guest's original request.

Fix intent:

- Preserve those facts in deterministic recovery without changing the good
  conversational behavior.

### Arabic Rapid-Date Case

Case:

- Case ID: `6a47a8a6f7652de71c82e518`
- Guest: Ibrahim
- Language: Arabic
- Hotel: Zad Ajyad

Observed conversation:

1. Guest asked for the price for `6` nights.
2. Guest asked room capacity and price for a room for two.
3. Guest sent `5/8/2026`.
4. AI correctly registered arrival as `2026-08-05` and asked for checkout.
5. Guest sent `22/8/2026`.
6. Guest quickly sent `12/8/2026`.
7. AI ended up treating `12/8/2026` as a new arrival date and asked for checkout
   again.

Root cause:

- Recovery treated the first date-only answer after the AI checkout question as
  checkout, then cleared the "AI asked checkout" context too early.
- When the guest immediately sent another date-only message before a useful AI
  reply, the second date was no longer understood as a checkout correction.
- A later assistant echo containing only one date and arrival wording could
  overwrite the valid range and turn the stay into a partial stay.

Correct behavior:

- Keep `2026-08-05` as check-in.
- Treat the later `12/8/2026` as the corrected checkout.
- Quote `2026-08-05` to `2026-08-12` once room facts are known.

### Arabic Price Follow-Up Case

Case:

- Case ID: `6a47a9a5f7652de71c82e7c2`
- Guest: Ibrahim
- Language: Arabic
- Hotel: Zad Ajyad

Observed conversation:

1. AI had verbally acknowledged a stay from `2026-08-12` to `2026-08-20`.
2. Guest asked:
   - `بدي أعرف الحساب`
   - `تقريبي`
   - `أريد معرفة السعر`
3. AI should have quoted or re-quoted.
4. Instead, the flow drifted:
   - It asked for extra confirmation.
   - It interpreted `تقريبي` like a hotel-distance/context question.
   - It gave generic price wording instead of using the quote tool.

Root cause:

- Arabic price intent did not include `الحساب` / `المبلغ`.
- A short follow-up like `تقريبي` is ambiguous by itself, but after "I want to
  know the total/account" it should inherit price context.
- The brain-first path could run before the deterministic date/price quote guard.

Correct behavior:

- If known facts are enough for a quote and the guest asks for price/total, run
  the quote tool before the brain writes a generic reply.
- Treat contextual `تقريبي` as a price estimate request when the previous guest
  or AI turn was about price/total.

## Code Changes

### 1. Safer Date Recovery

File:

- `aiagent/core/orchestrator.js`

New helper:

- `mergeAssistantBoundaryFactsSafely`
- `assistantAcknowledgedStayFacts`
- `mergeAssistantAcknowledgedStayFacts`

Purpose:

- Prevent a single assistant date echo from destructively overwriting a complete
  valid guest-derived stay range.
- Recover clearly acknowledged stay facts from the transcript when the stored
  `aiStateSnapshot` is thin or stale.

Specific protection:

- If current memory has both `checkinISO` and `checkoutISO`, and an assistant
  message has only one conflicting `checkinISO`, ignore that assistant boundary
  fact.
- If an assistant-only checkout would make the stay invalid, ignore it.
- If current memory already has a complete valid stay and a later assistant
  acknowledgement contains a different complete stay, the assistant dates do not
  overwrite the current range.
- If current memory already has a room type and an assistant acknowledgement has
  a conflicting room type, the assistant room type does not overwrite it.

Additional recovery change:

- After a guest answers a checkout-date prompt, recovery no longer clears the
  checkout-question context immediately.
- This allows consecutive date-only guest messages to behave as checkout
  corrections until an AI response changes the context.

Assistant acknowledgement recovery:

- The recovery is not case-specific.
- It does not hard-code Ibrahim, Rania, Zad Ajyad, a support case ID, or a price.
- It can recover dates from any assistant message that contains a valid ISO date
  range such as `2026-08-12` to `2026-08-20`.
- Room and guest recovery uses the existing generic room/guest NLU helpers.
- Arabic/English acknowledgement words are only extra confidence signals for
  transcript recovery; a valid ISO stay range can anchor recovery across
  languages.
- Generic option text is still protected because room/guest extraction from AI
  messages requires either an acknowledgement signal or an ISO date-range anchor.

Why this is safe:

- It only protects complete valid ranges from weaker assistant-only boundary
  facts.
- It does not block explicit guest date ranges or normal quote facts.
- It recovers missing state from conversation history without introducing
  customer-specific rules.

### 2. Arabic Price Intent and Contextual Estimate Follow-Up

File:

- `aiagent/core/orchestrator.js`

Changed helpers:

- `guestAsksPriceAvailabilityOrBooking`
- `latestGuestAsksPriceGuidance`
- `shouldForceQuote`

New helpers:

- `shortApproximateOnlyText`
- `shortApproximatePriceFollowup`
- `latestGuestAsksPriceWithContext`

New Arabic price signals:

- `الحساب`
- `المبلغ`
- contextual `تقريبي`
- contextual `تقريبا`
- contextual `تقريبًا`
- contextual `تقديري`

Important distinction:

- `تقريبي` alone is not treated as a hotel/location fact.
- `تقريبي` after `بدي أعرف الحساب` is treated as price intent.

Pre-brain quote guard:

- If the latest turn has price intent or a date-boundary correction, and quote
  inputs are known, the orchestrator saves facts and runs `handleBrainQuote`
  before handing the turn to the brain-first path.

Why this matters:

- It prevents the AI from asking for already-known details.
- It prevents hotel-fact/distance drift during a price request.
- It preserves the current architecture: the quote tool remains the source of
  price truth.

### 2b. Arabic Single-Date and English Location Classifier Edges

File:

- `aiagent/core/orchestrator.js`

Additional parser/classifier hardening:

- `singleGregorianDateFromText` now accepts a single slash-date inside
  Arabic-script text using day/month order.
- This covers short answers like `من تاريخ 5/8/2026` without tying logic to a
  specific support case.
- Approximate-only text such as `تقريبي` is blocked from the hotel-fact path so
  it cannot be misread as `قريب`.
- English location wording like `How far is the hotel from Haram?` is recognized
  as a hotel-fact question.

Why this is safe:

- The Arabic date fallback only applies when the message itself contains
  Arabic script.
- Existing known-date context still controls ambiguous non-Arabic slash dates.
- The hotel-fact adjustment is lexical and generic; it does not hardcode guest
  names, case IDs, hotel names, or fixed dates.

### 2c. One-By-One Messy Booking Detail Recovery

Files:

- `aiagent/core/orchestrator.js`
- `aiagent/core/nlu.js`

New or changed helpers:

- `quickSingleGregorianMonthDate`
- `labeledDateBoundaryFactsFromText`
- `standaloneSingleDateFromText`
- `sequentialStandaloneDateFactsFromConversation`
- `recoverKnownFactsFromConversation`

Problem covered:

- Some guests send booking details as separate messages instead of one organized
  form.
- Example:
  - `checkin date: July 25th 2026`
  - `checkout date: july 26th`
  - `Ahmed Abdelrazak`
  - `US`
- Another common example:
  - `15/8/2026`
  - `20/8/2026`

Expected behavior after this follow-up:

- Labeled single month-name dates are recovered as their correct boundary:
  - `checkin date: July 25th 2026` -> `checkinISO: 2026-07-25`
  - `checkout date: july 26th` -> `checkoutISO: 2026-07-26`
- Unlabeled standalone date messages are paired in chronological order when
  safe:
  - first standalone date: `15/8/2026`
  - second later standalone date: `20/8/2026`
  - recovered stay: `2026-08-15` to `2026-08-20`
- Month-name standalone date messages also pair:
  - `July 25th 2026`
  - `July 26th`
  - recovered stay: `2026-07-25` to `2026-07-26`
- Once the recovery sees labeled booking dates, it treats following simple
  identity lines in that same detail sequence as possible booking details:
  - `Ahmed Abdelrazak` -> full name
  - `US` -> nationality

Safety boundaries:

- The standalone date pairing is conservative.
- It only uses short standalone date-like guest messages.
- It ignores price/date sentences such as `I want price for 15/8/2026` so a
  pricing question is not silently converted into a stay range.
- Ambiguous non-Arabic slash dates still need context. For example, `5/8/2026`
  without language/context is not guessed as month/day or day/month by this
  follow-up.
- Stronger facts still win:
  - explicit labeled boundary
  - prompted date answer
  - full date range in one message
  - quote/review/tool facts
  - existing valid recovered range

Why this is safe:

- It mirrors how the brain would understand messy guest messages, but makes the
  durable recovery layer able to rebuild the same state after restart or worker
  fallback.
- It does not create reservations.
- It does not skip quote flow.
- It only fills missing date/name/nationality facts; room type, quote, phone,
  and guest count remain required when absent.

### 3. French Guest Count, Nationality, and Room Capacity

Files:

- `aiagent/core/orchestrator.js`
- `aiagent/core/nlu.js`

Added support for:

- `algérien`, `algérienne`, `algerian`, `algeria`
- French nationality context like `je suis ...`
- `personnes adultes`
- `adultes`
- `hommes`
- `voyageurs`
- `enfants`

Important edge fixed:

- `03 personnes adultes` now maps as `3` guests.
- Leading-zero room capacity counts such as `03` now map correctly to room
  capacity in `nlu.js`.

Expected result for the French case:

- `adults: 3`
- `children: 0`
- `nationality: Algerian`
- `roomTypeKey: tripleRooms`

### 4. Required Booking Details UI/UX Text

File:

- `aiagent/core/orchestrator.js`

New helpers:

- `bookingDetailLabels`
- `bookingDetailsMissingValue`
- `bookingRoomSummaryForDetails`
- `bookingDetailValueForField`
- `bookingDetailRowsForMessage`

Changed behavior:

- `buildMandatoryDetailsMessage` now returns structured rows with bold labels.
- `buildNationalityNeededMessage` now reuses the same structured details format
  when nationality is the only missing field.

English example shape:

```text
Almost ready. Please send the missing details below:
- **Full Name:** Needed
- **Phone:** Needed
- **Checkin to Checkout:** 2026-08-05 to 2026-08-12
- **Room Type:** Double Room
- **Guests:** 2 adults
- **Nationality:** Needed
Then I can prepare the booking review.
```

Arabic example shape:

```text
تمام، أرسل لي البيانات الناقصة:
- **الاسم الكامل:** مطلوب
- **رقم الهاتف:** مطلوب
- **الوصول إلى المغادرة:** 2026-08-05 إلى 2026-08-12
- **نوع الغرفة:** غرفة مزدوجة
- **الضيوف:** ٢ بالغين
- **الجنسية:** مطلوب
بعدها أجهز لك مراجعة الحجز.
```

Frontend note:

- `jannatbooking_ssr/components/SupportWidget.js` already supports `**bold**`
  rendering and label/value line styling.
- No widget code change was needed.
- This avoids a new frontend contract and keeps the change low risk.

## Helper Contract Notes

These helper contracts matter if future us enhances the chatbot.

### `recoverKnownFactsFromConversation`

Purpose:

- Rebuild a stable `known` object from saved state plus transcript.

Must preserve:

- Guest-provided facts should win over assistant echoes.
- Valid quote facts can restore quote memory only when they still match known
  dates and room selection.
- Profile name/phone can be used as provisional facts, but should be marked for
  confirmation when appropriate.
- The function must be safe for old support cases with incomplete entries.

Do not:

- Add external network calls here.
- Create reservations here.
- Depend on current PM2 memory only.
- Hardcode one support case transcript.

### `mergeAssistantBoundaryFactsSafely`

Purpose:

- Merge assistant single-date boundary facts without damaging a complete stay.

Must preserve:

- A complete current range such as `2026-08-05` to `2026-08-12` should remain
  intact if an assistant later says only `arrival: 2026-08-12`.
- Assistant-only date facts should never make checkout earlier than or equal to
  check-in.

Do not:

- Make assistant single-date facts stronger than guest facts.

### `assistantAcknowledgedStayFacts`

Purpose:

- Recover missing dates/room/guest count from assistant acknowledgements when
  saved memory is thin.

Trusted anchors:

- Valid ISO range in chronological order.
- Clear acknowledgement language.
- Existing generic room/guest NLU helpers.

Must preserve:

- Generic option lists must not be mistaken for confirmed selections.
- Assistant acknowledgements can fill missing fields, but should not replace a
  stronger current complete range or conflicting current room type.

Do not:

- Use hotel names, responder names, or guest names as confidence anchors.

### `latestGuestAsksPriceWithContext`

Purpose:

- Detect direct and contextual price/quote intent.

Must preserve:

- Direct price words should trigger price intent.
- `تقريبي` alone should stay context-sensitive.
- `تقريبي` after `بدي أعرف الحساب`, `أريد معرفة السعر`, or similar price
  context should trigger price intent.
- Hotel fact questions must remain hotel facts when they truly ask for location,
  parking, breakfast, bus, policies, etc.

Do not:

- Treat every short Arabic word as price intent.
- Let approximate-price words route to location just because they contain a
  root similar to `قريب`.

### `singleGregorianDateFromText`

Purpose:

- Convert a single date-like guest answer into an ISO date when context makes it
  safe.

Must preserve:

- Arabic-script slash dates prefer day/month order.
- Existing known date context still helps disambiguate.
- Ambiguous non-Arabic slash dates should not be over-guessed when context is
  missing.

Do not:

- Change global date interpretation for every language without regression
  tests.

### `quickSingleGregorianMonthDate`

Purpose:

- Parse one month-name Gregorian date such as `July 25th 2026` or `checkout
  date: july 26th`.

Must preserve:

- Explicit year when provided.
- Future-year inference when year is omitted.
- Checkout year inheritance from known check-in when the checkout omits a year.

Do not:

- Treat multiple dates as a single date.
- Use it as a quote substitute; it only returns a date fact.

### `labeledDateBoundaryFactsFromText`

Purpose:

- Use guest labels such as `checkin date:` and `checkout date:` to set the
  correct boundary.

Must preserve:

- Check-in labels set only `checkinISO`.
- Checkout labels set only `checkoutISO`.
- A full date range in one message should still be handled by the existing range
  parser.

Do not:

- Let unlabeled dates use this path.

### `standaloneSingleDateFromText`

Purpose:

- Identify a short guest message that is just one date and safe to use for
  sequential pairing.

Must preserve:

- Ignore price, room, phone, nationality, and reservation-number messages.
- Ignore long mixed-intent sentences.
- Keep ambiguous dates conservative when language/context is missing.

Do not:

- Treat `I want price for 15/8/2026` as a standalone date.

### `sequentialStandaloneDateFactsFromConversation`

Purpose:

- Recover a date range from separate standalone date messages.

Must preserve:

- Pair earlier standalone date as check-in and later standalone date as checkout.
- Only fill missing date boundaries.
- Use the latest safe chronological pair if the guest corrects themselves with
  another standalone date.

Do not:

- Override an already complete valid range.
- Invent room type, quote, phone, nationality, or guest count.

### `buildMandatoryDetailsMessage`

Purpose:

- Ask for missing required booking details in a readable, frontend-friendly way.

Must preserve:

- Bold label rows.
- Existing text fallback.
- Required fields only:
  - full name
  - phone
  - check-in/check-out
  - room type/selection
  - guest counts
  - nationality
- Optional email remains optional and should not appear before required details
  are handled.

Do not:

- Ask for passport number, ID number, or other unsupported booking fields.
- Require frontend changes unless a new payload contract is introduced safely.

## Safe Extension Guide

When adding a new language, phrase, or chatbot behavior, follow this sequence:

1. Identify whether the change is:
   - a fact parser change,
   - a price/quote routing change,
   - a hotel-fact answer change,
   - a required-details UX change,
   - or a reservation action change.
2. Add the smallest generic parser/routing rule possible.
3. Add or update focused regression assertions.
4. Confirm the change does not depend on one guest, case, responder, hotel, or
   exact date.
5. Run syntax checks.
6. Run focused chatbot regression checks.
7. Update this documentation with:
   - trigger phrase,
   - expected structured facts,
   - expected action,
   - risk avoided,
   - production verification notes.

Good examples:

- Add `personnes adultes` as a French guest-count signal.
- Add `الحساب` as an Arabic price/total signal.
- Add "how far from Haram" as a generic English hotel-location signal.

Bad examples:

- `if caseId === "6a47..."`.
- `if guestName.includes("Ibrahim")`.
- `if hotelName === "Zad Ajyad" then force double room`.
- Guessing a price in prose because the guest asked for `تقريبي`.

## Action Routing Rules To Preserve

Price / quote:

- If dates and room selection are known and the guest asks for price, use quote
  flow before free-form brain prose.
- If a quote exists but no longer matches the current stay, refresh it.
- If dates or room are missing, ask only for the missing stay facts first.

Hotel facts:

- Location, distance, parking, bus, breakfast, policy, branch, airport-distance,
  and similar questions may be answered as hotel facts.
- Hotel facts must not overwrite booking facts.
- Hotel fact detours should resume booking context afterward instead of
  restarting the flow.

Required details:

- Do not ask for full name, phone, or nationality before a quote if the guest is
  clearly asking for price and quote inputs are known.
- After a quote is shown and the guest wants to continue, ask for missing
  required details in structured rows.
- Ask only the missing fields, but it is okay to display known fields in the row
  summary so the guest can review the context.

Reservation creation:

- Never create a reservation from a normal conversational "yes" unless the
  official review/confirmation path has been satisfied.
- Confirmation-number requests before creation should be answered as pending,
  not fabricated.

## Validation Run Locally

Syntax checks:

```powershell
cd D:\JannatBooking\hotels_backend
node --check aiagent\core\orchestrator.js
node --check aiagent\core\nlu.js
```

Result:

- Passed.

Whitespace/diff check:

```powershell
git diff --check -- aiagent\core\orchestrator.js aiagent\core\nlu.js
```

Result:

- Passed.
- Git only warned that LF may be converted to CRLF when Git touches the files.

Focused regression harness:

- Local Node assertion harness requiring `./aiagent/core/orchestrator`.
- Result after the original runtime patch: `PASS 35 chatbot regression checks`.
- Result after the one-by-one detail follow-up: `PASS 42 chatbot regression checks`.

Warnings seen while requiring backend modules:

- `API key does not start with "SG."`
- `Twilio env incomplete: messages will fail unless DRY_RUN is true`

These are environment warnings from local module loading and did not affect the
chatbot assertions.

## Regression Scenarios Covered

New 2026-07-03 scenarios:

1. French case:
   - `algérien`
   - `03 personnes adultes`
   - triple-room inference
   - nationality preservation
2. Arabic rapid-date correction:
   - Arabic-script single date `من تاريخ 5/8/2026`
   - `2026-08-05` check-in
   - `22/8/2026` first checkout
   - `12/8/2026` corrected checkout
   - stale assistant arrival echo ignored
3. Arabic price follow-up:
   - `بدي أعرف الحساب`
   - contextual `تقريبي`
   - `أريد معرفة السعر`
   - `تقريبي` is not treated as a hotel-distance/fact question
4. Required-details UX:
   - English bold rows
   - Arabic bold rows
   - current widget-compatible markdown format
5. One-by-one messy detail recovery:
   - labeled month-name check-in message
   - labeled month-name checkout message
   - unlabeled sequential slash dates:
     - `15/8/2026`
     - `20/8/2026`
   - unlabeled sequential month-name dates:
     - `July 25th 2026`
     - `July 26th`
   - simple following identity lines:
     - full name
     - nationality

Previous documented scenario categories rechecked:

1. Hotel fact short reactions:
   - `ok` is not a hotel fact.
   - location question is a hotel fact.
   - `How far is the hotel from Haram?` is a hotel fact.
2. Arabic identity and double-room path:
   - Arabic price intent still works.
   - Arabic double-room selection still maps to `doubleRooms`.
3. Known profile phone flow:
   - `same number` still works.
4. Budget/value objection:
   - expensive/discount request still detected.
5. Closer-hotel request:
   - closer-to-Haram request still detected.
6. Date vs guest-count confusion:
   - `26/7/2026` after checkout question is checkout, not 26 adults.
7. Mixed room selection:
   - `1 double room and 1 quad room` preserves both room selections.
8. Split-stay periods:
   - two date ranges parse as two stay periods.
9. Confirmation-number guard:
   - guest asking for confirmation delivery is detected.
10. Thank-you/later outro:
   - later/no further help is detected.
11. Booking process after fact detour:
   - booking-process request is detected.
12. Same-day invalid boundary:
   - checkout equal to check-in is rejected.
13. Ten people recommendation basis:
   - `10 adults` remains guest count.
14. Arabic one-night checkout:
   - Arabic checkout wording is recognized for date boundary.

Additional exact transcript guard added after the first validation:

- Replayed the Arabic Rania/Ibrahim transcript shape before `بدي أعرف الحساب`.
- Confirmed recovery has:
  - `checkinISO: 2026-08-12`
  - `checkoutISO: 2026-08-20`
  - `roomTypeKey: doubleRooms`
  - `adults: 2`
- Confirmed missing fields before the price request are only:
  - `quote`
  - `fullName`
  - `phone`
  - `nationality`
- Confirmed `بدي أعرف الحساب` is price intent.
- Confirmed contextual `تقريبي` after the account/price request is price intent.
- Therefore the patched flow has the facts needed to run the quote tool instead
  of asking add-on/breakfast confirmation questions.

## Cleanliness / Production Readiness

Local backend final status:

- Commit `4ffb298` was created and pushed to GitHub.
- Local backend working tree was clean after commit.

Production backend final status:

- Production was fast-forwarded from `9a37fa3` to `4ffb298`.
- `node --check aiagent/core/orchestrator.js` passed on production.
- `node --check aiagent/core/nlu.js` passed on production.
- `pm2 restart hotels-backend --update-env` completed successfully.
- `pm2 status --no-color` showed `hotels-backend` online.
- Public AI health returned HTTP `200`.

Local and production SSR status:

- `jannatbooking_ssr` stayed clean.
- Local SSR remained at `2f5d1f1`.
- Production SSR remained at `2f5d1f1`.
- No SSR/widget code changed or restarted.

Code-scope risk:

- No schema changes.
- No database migrations.
- No support-case schema changes.
- No frontend rendering changes.
- No new environment variables.
- No reservation creation or dispatch behavior changed.
- No destructive operations were run.

The runtime code patch was deployed and verified. Future edits should repeat the
same local checks and a production health/log check before considering the
chatbot safe.

## Safe Production Deployment Checklist

Use this sequence after committing and pushing the backend changes:

```bash
ssh jannat

cd /home/ahmedadmin/Hotels/hotels_backend
git fetch origin master
git status -sb
git pull --ff-only origin master

node --check aiagent/core/orchestrator.js
node --check aiagent/core/nlu.js

pm2 restart hotels-backend --update-env
pm2 status --no-color
pm2 logs hotels-backend --lines 120 --nostream --no-color
```

From local machine after restart:

```powershell
Invoke-WebRequest https://xhotelpro.com/api/aiagent/health -UseBasicParsing
Invoke-WebRequest https://jannatbooking.com -UseBasicParsing
Invoke-WebRequest https://xhotelpro.com -UseBasicParsing
```

Expected post-deploy results:

- `hotels-backend` online.
- No restart loop.
- Memory in the normal hundreds of MB.
- `https://xhotelpro.com/api/aiagent/health` returns HTTP `200`.
- Recent backend PM2 logs show normal HTTP traffic and no new crash/error burst.

Frontend deployment:

- Not required for this patch.
- Restarting `jannat-ssr` is not necessary unless another frontend change is
  added before deployment.

Actual deployment executed for this pass:

- `git pull --ff-only origin master` on production backend.
- Production moved to `4ffb298`.
- Server-side syntax checks passed.
- `hotels-backend` restarted through PM2.
- AI health endpoint returned HTTP `200`.
- Jannat website returned HTTP `200`.
- Backend log tail showed normal traffic and startup initialization.

## Recommended Live Smoke Test After Deploy

Use one supervised live case only first.

Test Arabic rapid-date path:

1. Ask in Arabic for price for a double room / two people.
2. Give check-in `5/8/2026`.
3. When asked checkout, send `22/8/2026`.
4. Immediately send `12/8/2026`.
5. Expected:
   - The bot quotes or continues with `2026-08-05` to `2026-08-12`.
   - It does not change arrival to `2026-08-12`.

Test Arabic price follow-up:

1. Establish dates, room type, and guest count.
2. Ask `بدي أعرف الحساب`.
3. Optionally follow with `تقريبي`.
4. Expected:
   - The bot treats this as price intent.
   - It uses the quote flow when quote facts are missing/stale.

Test required-details display:

1. Continue after quote.
2. Stop before giving name/phone/nationality.
3. Expected:
   - The bot shows bold structured rows for missing details.
   - The support widget renders labels clearly.

## Future Regression Matrix

Before changing the chatbot again, rerun or recreate focused checks for these
areas.

Date/state recovery:

- Arabic single date after arrival prompt:
  - input: `من تاريخ 5/8/2026`
  - expected check-in: `2026-08-05`
- Arabic consecutive checkout correction:
  - known check-in: `2026-08-05`
  - first checkout: `22/8/2026`
  - corrected checkout: `12/8/2026`
  - expected range: `2026-08-05` to `2026-08-12`
- Assistant stale echo:
  - assistant says only `2026-08-12` as arrival after a valid range exists
  - expected: do not overwrite complete range
- Unlabeled sequential slash dates:
  - message 1: `15/8/2026`
  - message 2: `20/8/2026`
  - expected range: `2026-08-15` to `2026-08-20`
- Unlabeled sequential month-name dates:
  - message 1: `July 25th 2026`
  - message 2: `July 26th`
  - expected range: `2026-07-25` to `2026-07-26`
- Labeled one-by-one details:
  - `checkin date: July 25th 2026`
  - `checkout date: july 26th`
  - `Ahmed Abdelrazak`
  - `US`
  - expected:
    - `checkinISO: 2026-07-25`
    - `checkoutISO: 2026-07-26`
    - `fullName: Ahmed Abdelrazak`
    - `nationality: US`
- Mixed-intent date sentence:
  - `I want price for 15/8/2026`
  - expected: not treated as a standalone date-only boundary

Arabic price routing:

- input: `بدي أعرف الحساب`
  - expected: price intent
- input: `تقريبي` after a price/account request
  - expected: price intent
- input: `تقريبي` alone
  - expected: not hotel-fact-only
- input: `قريب من الحرم؟`
  - expected: hotel fact
- input: `أريد معرفة السعر`
  - expected: price intent

French parsing:

- input: `je suis algérien`
  - expected nationality: `Algerian`
- input: `03 personnes adultes`
  - expected adults: `3`
- input: `chambre pour 03 personnes adultes`
  - expected room key: `tripleRooms`

Room and guest safety:

- input: `1 double room and 1 quad room`
  - expected two room selections, not one overwritten room type
- input: `26/7/2026` while asking for guest count
  - expected date-like token, not `26` adults
- input: `10 adults`
  - expected guest count, not room count

Hotel fact detours:

- input: `ok`
  - expected not hotel fact
- input: `How far is the hotel from Haram?`
  - expected hotel fact
- input: closer-hotel request
  - expected closer-hotel handling / human-safe path
- after hotel fact answer, guest asks booking process
  - expected contextual booking next step, not generic restart

Required details:

- English rows include:
  - `**Full Name:** Needed`
  - `**Phone:** Needed`
  - `**Checkin to Checkout:** ...`
- Arabic rows include:
  - `**الاسم الكامل:** مطلوب`
  - `**رقم الهاتف:** مطلوب`
  - `**الوصول إلى المغادرة:** ...`

Reservation safety:

- Guest asking for confirmation number before reservation exists:
  - expected no fake confirmation number
- Guest says thanks/later:
  - expected polite outro/close behavior, not forced booking
- Guest asks booking process with known facts:
  - expected summary of known facts and exact next required action

## Known Warnings / Non-Issues Seen During This Pass

Local module-load warnings:

- `API key does not start with "SG."`
- `Twilio env incomplete: messages will fail unless DRY_RUN is true`

Meaning:

- These appeared while requiring backend modules locally for the assertion
  harness.
- They were environment warnings, not chatbot regression failures.
- They did not prevent syntax checks or the focused regression harness from
  passing.

Git warnings:

- Windows Git warned that LF may be converted to CRLF on touched files.
- `git diff --check` passed.
- No whitespace errors were found.

GitHub push warning:

- GitHub reported existing dependency vulnerabilities on push.
- This patch did not change dependencies.
- Dependency remediation should be handled separately, not inside a chatbot
  behavior patch.

Production server artifacts:

- Existing untracked `.env.backup-*` and `.bak-*` files were present before this
  deployment.
- They were not created by this pass.
- They should not be broadly removed during chatbot work.

## Rollback / Recovery Notes

If production behaves badly after a future chatbot patch:

1. Check health first:
   - `https://xhotelpro.com/api/aiagent/health`
   - PM2 status/logs for `hotels-backend`
2. Confirm the deployed commit:
   - `cd /home/ahmedadmin/Hotels/hotels_backend`
   - `git rev-parse --short HEAD`
3. If rollback is required, prefer a normal Git revert commit over destructive
   checkout/reset.
4. Restart only `hotels-backend` for backend-only chatbot changes.
5. Restart `jannat-ssr` only if frontend widget code changes.
6. After rollback/revert, run:
   - server-side `node --check` on changed JS files
   - PM2 restart/status/log tail
   - public AI health check

Rollback caution:

- Do not reset production with untracked backup files present unless explicitly
  planned.
- Do not delete support cases or reservations to fix chatbot behavior.
- Real support cases used for diagnosis should remain read-only unless there is
  an explicit data-repair task.

## Future Cautions

- Do not remove the quote-tool guard just because the brain can answer in
  natural language. Price must remain tool-backed.
- Do not let assistant-only single-date messages overwrite complete guest-derived
  ranges.
- Keep contextual short replies language-aware. Words like `تقريبي` need previous
  turn context.
- Keep the required details as frontend-friendly text unless a real frontend data
  contract is introduced later.
- If production logs show old `.bak` or `.env.backup-*` files, treat them as
  existing server artifacts and avoid broad cleanup during chatbot deploys.
