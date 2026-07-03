# Chatbot Follow-Up Context Hardening

Date: 2026-07-02

This document records the production hardening work done after the real Zad Ajyad support case `6a468b217e95b5da3c033b1a`.

The purpose is to help future maintainers enhance the AI agent without accidentally undoing the behavior we fixed today. The most important rule from this work is:

OpenAI remains the brain. The orchestrator validates, preserves known state, runs tools, and prevents bad/out-of-context replies from reaching the guest.

## Current Deployment State

Backend repository:

- Local path: `D:\JannatBooking\hotels_backend`
- Production path: `/home/ahmedadmin/Hotels/hotels_backend`
- GitHub branch: `master`
- Production PM2 app: `hotels-backend`
- Production deployed commit after this work: `73e98e7`

Frontend repository:

- Local path: `D:\JannatBooking\jannatbooking_ssr`
- Production path: `/home/ahmedadmin/Hotels/jannatbooking_ssr`
- Production PM2 app: `jannat-ssr`
- No frontend code changed in this specific follow-up-context hardening pass.

PM2/server health after deployment:

- `hotels-backend` was online after restart.
- Observed production memory after restart/checks was around `240 MB` to `275 MB`.
- CPU was `0%` at the final status check.
- `jannat-ssr` was online.
- PM2 error log still contained older repair/fallback entries from previous cases and tests. No new crash was observed from this deployment.

Production has many pre-existing untracked `.env.backup-*` and `.bak-*` files in `/home/ahmedadmin/Hotels/hotels_backend`. These were not created or modified by this pass. Do not delete them casually.

## Important Runtime Env Notes

Known production AI runtime from the surrounding work:

- `OPENAI_CHATBOT_MODEL=gpt-5.4-mini`
- `OPENAI_CHATBOT_REASONING_EFFORT=low`
- `OPENAI_CHATBOT_TIMEOUT_MS=9000`

The chatbot is intentionally running affordable/fast settings. Because of that, the backend validators are important. They catch cases where the model writes a plausible but wrong follow-up.

## Real Case That Triggered This Work

Support case:

- Case ID: `6a468b217e95b5da3c033b1a`
- Guest: Ebrahim attarwala
- AI responder: Khadija
- Hotel: Zad Ajyad
- Case status when rechecked: `closed`
- Close reason: `ai_idle_timeout`
- `aiToRespond`: `false`
- No reservation was created in this case.
- The real case was not mutated during this fix.

Observed conversation pattern:

1. Guest sent dates: `August 5 to August 20`.
2. AI noted dates.
3. Guest sent `5 bed`.
4. AI quoted `Family Quintuple Room`.
5. Guest asked `Or family suite`.
6. AI said `Family Suite` was unavailable and offered alternatives.
7. Guest asked location/distance.
8. AI answered location/distance correctly enough.
9. Guest said `Yes`.
10. The AI did not produce the expected clear follow-up.
11. Guest asked `Whats the process of booking`.
12. AI gave a generic process reply:
   - It asked the guest to share check-in/check-out dates.
   - It asked the guest to choose the room type.
   - This was wrong because dates and room context were already known.

Why this was bad:

- The guest had already provided dates.
- The guest had already discussed room options.
- The latest room (`Family Suite`) was unavailable.
- A previous quote (`Family Quintuple Room`) existed.
- The next response should have explicitly used those facts instead of restarting a generic booking flow.

Correct future behavior:

- If the guest asks for the booking process and facts are known, the reply must say the known date range and room context.
- Example shape:
  - `For your stay from 2026-08-05 to 2026-08-20, the available quoted option is 1 Family Quintuple Room. The Family Suite is not available for these dates. To continue, please send number of adults, nationality, and phone number.`

## Root Cause

The agent had good hotel-fact answering, but the state handoff after a fact detour was weak.

Two issues combined:

1. After a hotel-fact reply, a short guest message such as `Yes` could be interpreted from stale booking state or old quote context.
2. A process/next-step question could be answered as generic education instead of a contextual next step.

In practice, this made the agent feel like it was stopping, looping, or forgetting the conversation even though `SupportCase.aiStateSnapshot.known` still had useful facts.

## Files Changed

Main backend file:

- `aiagent/core/orchestrator.js`

Documentation file added:

- `docs/chatbot-followup-context-hardening-2026-07-02.md`

No frontend files were changed in this pass.

## Commits In This Follow-Up Pass

These commits were created after commit `6093bef` and deployed through production:

- `6798055` - `Fix chatbot follow-up after hotel fact detours`
- `16b6ce4` - `Keep alternatives replies on tool result`
- `53cc3c7` - `Require contextual booking process replies`
- `bbe8af4` - `Block location drift in alternatives replies`
- `73e98e7` - `Require exact context in booking process replies`

Earlier same-day context commits immediately before this pass:

- `9ce6ee8` - `Tighten chatbot fact and price guidance`
- `534c907` - `Harden hotel fact reply validation`
- `8e96a78` - `Require maps for explicit hotel location replies`
- `6093bef` - `Block raw location numbers in fact replies`

## Behavioral Changes

### 1. Short Affirmation After Hotel-Fact Detour

New behavior:

- If the previous AI message was `hotel_fact_answered` and the latest guest message is a short affirmative like `Yes`, `OK`, `Sure`, or `Continue`, the orchestrator looks back to the previous unresolved booking action.

Examples:

- Previous unresolved action was `quote_unavailable`:
  - Resume `check_alternatives`.
- Previous unresolved action was `quote_ready`:
  - Resume `send_review` if the quote still matches known facts.

Why:

- Guests often ask a side question such as location, distance, bus, or policy before continuing.
- A short `Yes` after the side answer usually means "continue with what we were doing", not "quote the stale room again" or "repeat the location".

Key helpers added/changed:

- `conversationIndexOfEntry()`
- `previousAiBeforeEntry()`
- `latestGuestShortAffirmative()`
- `actionToResumeAfterHotelFactAffirmation()`

Main execution points:

- `executeBrainFirstDecision(...)`
- `planTurn(...)`

Important future note:

- Do not remove this as "too deterministic". It is not hotel-specific hardcoding. It is a generic conversation-state rule.

### 2. Booking Process Must Be Contextual

New behavior:

- When the guest asks "what is the booking process", "next step", or similar, the brain can answer directly, but the reply is validated.
- If known facts include dates or room context, the reply must explicitly show them.

Examples of rejected replies:

- `Share your check-in and check-out dates, choose the room type, then I will send quote.`
- `I already have the dates and room preference. Send adults, phone, nationality.`

The second one is still rejected because it does not show the exact known dates and room context.

Examples of accepted shape:

- `For your stay from 2026-08-05 to 2026-08-20, the available quoted option is 1 Family Quintuple Room. The Family Suite is not available for these dates. To continue, please send number of adults, nationality, and phone number.`

Key helper:

- `latestGuestAsksBookingProcess()`
- `bookingProcessReplyNeedsCorrection()`

Why:

- The old generic answer sounded polite but not intelligent.
- A real client can lose confidence if the agent asks again for facts already provided.

### 3. Alternatives Tool Result Must Stay On Alternatives

New behavior:

- When the tool is `check_alternatives`, the final reply must discuss alternatives/availability only.
- It must not drift back to older hotel-fact answers such as Google Maps, address, walking distance, or car distance.

Key helper:

- `alternativeReplyDriftedToHotelFact()`

Added writer instruction:

- Alternatives reply must not answer older hotel-fact/location questions.
- If no options are available, say that clearly and offer to adjust dates/room choice or continue with a previously available quote if present in the conversation.

Why:

- Production simulation showed the writer could answer the old location question again even after the alternatives tool ran.
- This made the tool path look broken.

### 4. Short Guest Name In English Hotel-Fact Fallbacks

Changed fallback address name:

- From full display name such as `Ebrahim attarwala`
- To short address name such as `Ebrahim`

Key helper reused:

- `shortGuestAddressName(...)`

Why:

- Full-name greetings in casual replies feel robotic.
- Full names belong in official booking review facts, not every normal response.

## PM2 Log Findings

Relevant observed logs around case `6a468b217e95b5da3c033b1a`:

- PM2 app `hotels-backend` stayed online.
- The case did not crash the backend.
- Logs showed:
  - `queued turn started`
  - `[aiagent][brain] action: 'reply'`
  - `[aiagent][orchestrator] stage: 'execute_brain_decision'`
  - A stale quote path attempted `get_quote` for `suite:2`
  - Quote tool result was unavailable with `code: 'room_not_found'`
  - The turn completed around `13651 ms`

Older error-log lines also showed:

- `compact brain tool reply repair used`
- `tool reply fallback used after validation`

Those older entries were from previous cases and stabilization work. They are not fatal by themselves. They mean the validator blocked a weak first response and repaired/fell back before sending.

Important operational note:

- PM2 logs may contain sensitive admin/login traffic from unrelated app usage. Do not copy secrets into docs or prompts.

Useful commands:

```bash
ssh jannat "cd /home/ahmedadmin/Hotels/hotels_backend && git rev-parse --short HEAD"
ssh jannat "pm2 status hotels-backend --no-color"
ssh jannat "pm2 logs hotels-backend --lines 120 --nostream --no-color"
ssh jannat "grep -n 'CASE_ID_HERE' /home/ahmedadmin/.pm2/logs/hotels-backend-out.log | tail -80"
ssh jannat "grep -n 'CASE_ID_HERE' /home/ahmedadmin/.pm2/logs/hotels-backend-error.log | tail -80"
```

## Production Validation Performed

All production validation used temporary `SupportCase` documents with `clientContact` markers. The real client case was not mutated.

Final strict temp marker:

- `codex-fact-detour-1783009456198`

Temporary docs created:

- `6a4690b0cf6a6bf9c322a5c3`
- `6a4690b0cf6a6bf9c322a5ca`

Cleanup:

- Deleted by exact marker prefix.
- Final cleanup result: `deletedCount: 2`
- No reservations were created.

Final tested scenario 1:

- Prior quote existed for `Family Quintuple Room`.
- Guest asked for `Family Suite`.
- `Family Suite` was unavailable.
- Guest asked location.
- AI answered location.
- Guest said `Yes`.

Expected:

- Resume alternatives path.
- Do not repeat location.
- Do not include maps/address/distance.

Final observed:

```text
I checked 45 days for your stay, and there are no alternatives available for the current dates and room choice. If you'd like, we can try adjusting the dates or the room selection and check again.
```

Result:

- Passed.
- Client action: `alternative_dates_unavailable`
- No location drift.

Final tested scenario 2:

- Same context.
- Guest asked: `Whats the process of booking`

Expected:

- Do not ask for dates again.
- Do not ask for room type again.
- Explicitly show known dates and room context.
- Ask only for the real missing fields.

Final observed:

```text
For your stay from 2026-08-05 to 2026-08-20, the available quoted option is 1 Family Quintuple Room. The Family Suite is not available for these dates. To continue with the booking, please send me these 3 details: - Number of adults - Nationality - Phone number Once I have them, I'll prepare the reservation for final confirmation, insha'Allah.
```

Result:

- Passed.
- It referenced the exact dates.
- It referenced the room context.
- It asked only missing fields.

Note:

- Formatting can still be improved in future so the 3 details render as separate lines/buttons when appropriate. Do not change the state logic to improve formatting.

## Local Validation Performed

Syntax:

```bash
node --check .\hotels_backend\aiagent\core\orchestrator.js
```

Focused local helper checks covered:

- `actionToResumeAfterHotelFactAffirmation(...)`
- `latestGuestAsksBookingProcess(...)`
- `bookingProcessReplyNeedsCorrection(...)`
- `alternativeReplyDriftedToHotelFact(...)`
- `shortGuestAddressName(...)`

Expected helper behavior:

- `Yes` after `hotel_fact_answered`, with older `quote_unavailable`, returns `check_alternatives`.
- `OK` after `hotel_fact_answered`, with older `quote_ready`, returns `send_review`.
- Generic process replies are rejected when known dates/room exist.
- Process replies pass only when exact known date range and room context are visible.
- Alternatives replies containing maps/address/distance are rejected.

## Safety Rules For Future Enhancements

Do not remove these rules:

1. Hotel-fact questions have priority over booking flow for that turn.
2. After the hotel-fact answer, short affirmations should resume the previous unresolved booking action.
3. Booking-process replies must use known state and must not ask again for known dates or known room choices.
4. Alternatives replies must not include location/map/distance content from an older guest question.
5. OpenAI writes the customer-facing text, but the orchestrator must validate and repair/fallback when the text is contextually wrong.
6. Never create fake reservations during QA unless a dedicated reservation test explicitly requires it and confirmation dispatch is safely disabled in the test process.
7. Delete test support cases only by exact marker or exact `_id`, never by broad hotel/date/name filters.

## Known Tradeoffs

Some validation failures cause a repair pass, which can increase response time.

Observed examples:

- `compact brain tool reply repair used` appeared during the final alternatives simulation.
- The final sent reply was correct, but repair adds latency.

This is acceptable for correctness, but future optimization should aim to make the first writer pass more deterministic.

Possible future improvement:

- Add a smaller deterministic formatter for alternatives/no-alternatives tool results, still fed by OpenAI wording when safe.
- Or add stricter tool-result prompt examples for `check_alternatives` and process replies.

Do not trade away correctness for speed on real customer-facing booking flow.

## Existing Case Handling Note

The original real case `6a468b217e95b5da3c033b1a` was already closed by `ai_idle_timeout` when rechecked after the fix.

Future action for similar real cases:

- Do not reopen or append messages automatically unless the business owner explicitly asks.
- If reopened manually, the new logic should handle follow-up messages better.

## Related Source Areas

Core runtime:

- `aiagent/core/orchestrator.js`
- `aiagent/core/db.js`
- `aiagent/core/actions.js`
- `aiagent/core/openai.js`
- `aiagent/core/selectors.js`
- `aiagent/core/nlu.js`

Models:

- `models/supportcase.js`
- `models/reservations.js`

Support-case routes/controllers:

- `controllers/supportcase.js`
- `routes/supportcase.js`
- `aiagent/routes/index.js`

Frontend display path to keep in mind:

- Main frontend repo: `D:\JannatBooking\jannatbooking_ssr`
- Production SSR app: `jannat-ssr`
- Chat widget/window styling lives in the frontend repo. This pass did not edit it.

## Recommended Future Regression Cases

Run these before any major prompt/orchestrator change:

1. Quote ready -> guest asks location -> AI answers -> guest says `Yes`.
   - Expected: proceed to booking/review path, not location repeat.

2. Quote unavailable -> guest asks distance -> AI answers -> guest says `Yes`.
   - Expected: alternatives path, not stale quote and not location repeat.

3. Known dates and room -> guest asks `what is the process of booking`.
   - Expected: exact dates and room context visible; ask only missing fields.

4. Known dates and unavailable latest room, but older available quote exists.
   - Expected: mention unavailable latest room and offer available older quote or alternatives.

5. Location plus prices in one message.
   - Expected: answer location with Google Maps link, then ask exact price inputs if needed.

6. City confusion such as `in Madinah?`.
   - Expected: clarify Makkah/no confirmed Madinah branch without resending map/address.

7. Bus/Nusuk/parking/cancellation fact questions mid-booking.
   - Expected: direct fact answer from hotel facts, then cleanly resume booking when guest continues.

8. Arabic/Urdu mixed with English.
   - Expected: same state behavior, guest language preserved, no full-name robotic greeting.

## Deployment Checklist Used

Local:

```bash
node --check .\hotels_backend\aiagent\core\orchestrator.js
git -C hotels_backend status --short --branch
git -C hotels_backend log --oneline -8
git -C hotels_backend push origin master
```

Production:

```bash
ssh jannat "set -e; cd /home/ahmedadmin/Hotels/hotels_backend; git pull --ff-only origin master; node --check aiagent/core/orchestrator.js; pm2 restart hotels-backend --update-env"
ssh jannat "cd /home/ahmedadmin/Hotels/hotels_backend && git status --short --branch && git rev-parse --short HEAD && pm2 status hotels-backend --no-color"
```

Final status:

- Local backend clean and aligned with `origin/master`.
- Production tracked files aligned with `origin/master` at `73e98e7`.
- Production still has pre-existing untracked backup files; ignore them unless intentionally auditing server backups.
- Frontend `jannatbooking_ssr` clean and aligned with `origin/main`.

## Late Production QA And Live Hardening Continuation

This section documents the later July 2 live-chat hardening pass after additional real and test cases were observed.

Primary goals:

- Keep the brain/orchestrator structure dynamic; do not hardcode July 15 or any single hotel scenario.
- Stop current/same hotel-day requests from being treated as bookable or from being answered with vague "tomorrow" guidance.
- Preserve mixed room requests such as one double room plus one quad room.
- Treat split stays as separate reservations, one reservation per period, instead of forcing one merged reservation.
- Prevent loops during split-stay review and confirmation.
- Prevent reservation names from being polluted by confirmation/rejection text.
- Use known profile phone data without repeatedly asking the guest to retype it.
- Offer optional email only after required fields are complete.
- Improve closer-hotel and price-objection sales handling with fact-based value and a clear next step.

### Additional Commits

Latest production sequence for this pass:

- `bf5e32b` - Harden hotel-day date and split-stay state.
- `438f585` - Avoid unchecked tomorrow same-day wording.
- `ee64cad` - Preserve split stay reviews during recovery.
- `9b65fa6` - Recover Arabic split stay slash dates.
- `3646501` - Use deterministic split stay reviews.
- `f5e1dd1` - Keep split stay period totals scoped.
- `f44a577` - Derive split stay totals from periods.
- `f5f238a` - Require closer hotel sales close.
- `8a71127` - Route confirmed profile phone to optional email.
- `9228e5a` - Guard future quote date wording.

Final deployed backend commit for this continuation:

- Local and GitHub `master`: `9228e5a`
- Production `/home/ahmedadmin/Hotels/hotels_backend`: `9228e5a`

### Dynamic Date And Availability Rules

Implemented/verified behavior:

- Hotel "today" is calculated dynamically using `HOTEL_BOOKING_TIMEZONE` / `TZ` with a UTC fallback, not the server UTC day by accident.
- Same hotel-day check-in is blocked through chat.
- The bot does not claim the next day/minimum date is available unless an actual availability search proves it.
- Alternative dates are discovered from inventory search. The July 15 result for Zad Ajyad is not hardcoded.
- Future quotes are guarded so the writer cannot call a verified future date range "past", "expired", or already passed.

### Split-Stay Fixes

Implemented/verified behavior:

- Arabic slash dates in split stays now prefer day/month when the context indicates Arabic date usage.
- Example recovered correctly: `5/9 to 10/9` and `15/9 to 20/9` become `2026-09-05 -> 2026-09-10` and `2026-09-15 -> 2026-09-20`.
- The official split-stay review is now composed from verified server facts instead of letting the writer recalculate totals.
- Split-stay quote recovery scopes money to each period and derives the combined total from the period totals when all period totals are known.
- A bad combined total from old AI text can no longer force repeated re-quotes when the individual verified periods already match.
- Confirming a split stay creates separate reservations with keys:
  - `<caseId>:split:1`
  - `<caseId>:split:2`

Validated result:

- Split stay created two separate reservations.
- Each period had the correct dates, nights, name, phone, nationality, and total.
- No loop after final review confirmation.

### Identity, Phone, And Email Flow

Implemented/verified behavior:

- Short confirmations such as "same number you see" now confirm the profile phone when the bot was asking for phone confirmation.
- After required fields are complete, the server routes directly to optional email or review instead of sending vague progress wording.
- Optional email remains optional and is offered only after required fields are complete.
- Confirmation phrases such as `مؤكد`, `ايون`, `تمام`, and rejection text like `هناك شيء غير صحيح` are guarded from becoming reservation names.

Validated result:

- Arabic profile-phone flow completed with:
  - Name: `احمد عبده`
  - Phone: `7771116666`
  - Nationality: `مصري`
  - Optional email skipped
  - Reservation created successfully

### Hotel Facts, Reactions, And Sales Handling

Implemented/verified behavior:

- Short reactions after hotel facts, such as `حلو ده` and `انا متحمس جدا`, no longer repeat the distance answer.
- The bot acknowledges warmly and offers next help.
- Closer-hotel requests now keep a fact-based value pitch for the current hotel and ask a clear next step, such as checking availability and price or handing off to the team.
- For Zad Ajyad, the pitch uses dynamic hotel facts such as walking/driving distance, service details, markets/services nearby, and suitable room context when known.
- The closer-hotel response is validated so it cannot leave the guest hanging without `check availability`, `continue`, `book`, or `reserve` wording.

### Production QA Sweep

Temporary QA harness:

- Local only: `tmp_aiagent_prod_qa_sweep.js`
- Production temp copy: `/home/ahmedadmin/Hotels/hotels_backend/tmp_aiagent_prod_qa_sweep.js`
- These were not committed.

Full production sweep result:

- Command: `node tmp_aiagent_prod_qa_sweep.js`
- Status: PASS
- Scenarios run: 14
- Test reservations created and cleaned up: 5
- Test support cases cleaned up: 14

Scenarios covered:

1. Hotel fact short reactions.
2. Arabic identity and double-room reservation.
3. Known profile phone and optional email flow.
4. Budget/value objection sales pitch.
5. Closer-hotel sales pitch and next step.
6. Date vs guest-count confusion (`26/7` stays checkout, not 26 adults).
7. Mixed room unavailable case with double plus quad.
8. Split-stay separate reservations.
9. Confirmation-number guard before official creation.
10. Thank-you/later outro.
11. Booking process after hotel-fact detour.
12. Same hotel-day block.
13. Ten people recommendation as two family/quintuple rooms.
14. Arabic one-night same-day request with dynamic alternatives.

Additional targeted production batches before the final sweep:

- High-risk batch passed:
  - mixed rooms unavailable
  - split-stay reservations
  - same-day block
  - Arabic one-night alternative dates
- Regression batch passed:
  - profile phone optional email
  - closer-hotel pitch

Syntax checks:

- Local: `node --check aiagent/core/orchestrator.js`
- Production: `node --check /home/ahmedadmin/Hotels/hotels_backend/aiagent/core/orchestrator.js`

### Home Server Health After QA

Final health check after deployment and full sweep:

- Load average: about `0.36, 0.39, 0.44`
- RAM: `15Gi` total, about `12Gi` available
- Swap: `0B` used
- Root disk: `466G` total, `38G` used, `9%`
- CPU package/core temperatures: about `44-45C`
- NVMe temperature: about `41.9C`
- PM2:
  - `hotels-backend` online
  - frontend/SSR services online
  - backend memory about `201MB` after QA

Notes:

- Backend restart count increased because of the controlled deploy/restart cycles.
- GitHub still reports existing Dependabot vulnerabilities during push; this pass did not change dependencies.
- Production has pre-existing untracked backup files; ignore them unless doing a backup audit.

### Existing Reservation Duplicate Guard Addendum

Implemented after the main QA sweep:

- Added a deterministic same-hotel duplicate guard before review/submit.
- The guard checks recent reservations from the last `31` days by creation/order/booked time.
- The match requires the important booking facts to align:
  - Same hotel.
  - Same guest name after title cleanup such as `Dr` / `د/`.
  - Same phone, allowing country-code suffix matches.
  - Same check-in and checkout dates.
  - Same room selection, including multi-room combinations and counts from `pickedRoomsType`.
- Email is stored in snapshots when present but is not required and does not control duplicate detection.
- The support case now stores a separate `aiExistingReservations` snapshot. This does not touch the `aiReservation` creation lock.

Runtime behavior:

- If one exact matching reservation exists:
  - The bot sends the existing confirmation details and public links.
  - The bot warns that creating another booking may duplicate the existing one.
  - The guest must explicitly choose/answer that they want a new separate booking or that the found reservation is not theirs before the flow resumes.
  - No duplicate reservation is created during the warning turn.
- If two or more exact matching reservations exist:
  - The bot sends the matching confirmation details and public links.
  - The bot stops automatic booking creation for that case.
  - The bot directs the guest to WhatsApp: `[+1 (909) 222-3374](https://wa.me/19092223374)`.
  - `aiToRespond` is turned off, and the case is scheduled to close after about two minutes.

Files changed:

- `aiagent/core/db.js`
- `aiagent/core/orchestrator.js`
- `models/supportcase.js`
- `controllers/supportcase.js`

Local validation:

- `node --check aiagent/core/orchestrator.js`
- `node --check aiagent/core/db.js`
- `node --check models/supportcase.js`
- `node --check controllers/supportcase.js`
- Focused helper assertions for:
  - Arabic title stripping (`د/ صابر...` vs `صابر...`)
  - phone suffix match
  - same hotel/date/room/name/phone match
  - hotel/date mismatch rejection
  - mixed room selection matching
  - one-duplicate acknowledgement wording such as `نعم كمل`

Deployment:

- Commit: `97fe88b` (`Guard duplicate AI reservations`)
- GitHub `master`: pushed to `97fe88b`.
- Production backend: pulled to `97fe88b`.
- Production backend: restarted with `pm2 restart hotels-backend --update-env`.

Production duplicate-guard validation:

- Created temporary same-hotel fixture reservations and support cases with a unique Codex marker.
- One existing matching reservation:
  - AI response action: `existing_reservation_warning`
  - Included existing reservation wording and a create-anyway quick reply.
  - Saved `aiExistingReservations.status = warning`.
  - Created no new reservation for the test support case.
- Two existing matching reservations:
  - AI response action: `existing_reservations_hard_cut`
  - Included the WhatsApp contact link.
  - Set `aiToRespond = false`.
  - Saved `aiExistingReservations.status = hard_cut`.
  - Created no new reservation for the test support case.
- Cleanup confirmed:
  - Test support cases deleted: `2`
  - Test fixture reservations deleted: `3`

Production regression QA after duplicate guard:

- First full sweep had one transient writer wording failure in `scenarioMixedRoomsUnavailable`; the case cleaned up successfully.
- Isolated `scenarioMixedRoomsUnavailable` rerun passed.
- Second full sweep passed all `14` scenarios.
- Second full sweep cleanup:
  - Test reservations deleted: `5`
  - Test support cases deleted: `14`
- Scenarios re-covered:
  - hotel fact reactions
  - Arabic identity reservation
  - profile phone optional email flow
  - budget/value pitch
  - closer-hotel pitch
  - date vs guest-count confusion
  - mixed double plus quad unavailable case
  - split-stay separate reservations
  - confirmation-number guard
  - thank-you/later outro
  - process after hotel-fact detour
  - same hotel-day block
  - ten people as two family/quintuple rooms
  - Arabic one-night same-day alternatives

Home server health after duplicate guard and regression QA:

- Load average: about `0.47, 0.51, 0.43`
- RAM: `15Gi` total, about `12Gi` available
- Swap: `0B` used
- Root disk: `466G` total, `38G` used, `9%`
- CPU package/core temperatures: about `41-44C`
- NVMe temperature: about `40.9C`
- PM2:
  - `hotels-backend` online
  - backend memory about `202MB`
  - frontend/SSR services online

### Current Final Status

- GitHub `master`: pushed through `97fe88b`.
- Production backend: pulled to `97fe88b`.
- Production backend: restarted with `pm2 restart hotels-backend --update-env`.
- Duplicate guard targeted production validation: passed.
- Full production regression QA sweep after duplicate guard: passed on rerun.
- No committed QA harness or broad cleanup scripts.
- Temporary QA harness files were removed after the final sweep.

### Future Notes

Some writer variance still appears in style, language mixing, and phrasing. The orchestrator now validates the risky parts that can damage bookings: dates, availability, totals, identity fields, final review, reservation creation, and required next steps.

Future improvements should focus on deterministic formatting for quote/review/fact replies without changing the verified state and action flow.
