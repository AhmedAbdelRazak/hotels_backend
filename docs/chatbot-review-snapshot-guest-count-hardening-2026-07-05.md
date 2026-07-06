# Chatbot Review Snapshot And Guest Count Hardening - 2026-07-05

## Context

This pass focused on the B2C Jannat Booking chatbot quality after the July 3 behavior started to regress in live conversations. The highest-risk symptoms were:

- Guests sending details in separate messages, for example check-in, check-out, guest count, and room count one message at a time.
- The bot sounding robotic after hotel fact questions instead of naturally steering the guest toward a reservation.
- Required detail flows asking too early or in the wrong order, especially optional email vs. final review.
- Multi-guest and multi-room requests needing real room combinations instead of invented room types.
- Two separate reservations in the same chat needing to remain separate all the way to reservation creation.
- Jannat Booking and Jannat Support recommendations needing to sell priority Zad Ajyad without looping guests back to the hotel they came from.
- Meal questions needing a clear room-only answer while still reassuring guests that nearby restaurants are available.
- Post-confirmation payment/contact questions needing direct answers, including the temporary WhatsApp number: +1 (909) 222-3374.

## Fixes

- Increased the default OpenAI chatbot timeout from 12 seconds to 20 seconds in `aiagent/core/openai.js`. This gives the brain enough time for harder multilingual turns without changing the max timeout cap.
- Tightened quote and review discount formatting so direct-booking prices keep the old price in `<s class="message-price-old">` and the final price in `<strong class="message-price-new">` on the same row.
- Added deterministic split-stay quote rendering for available multi-period requests. The brain still owns state and intent, but the money/date rows are now stable and cannot lose the discount HTML.
- Preserved split-stay review and submit flow so two separate stay periods create separate reservation records using `:split:1`, `:split:2`, etc.
- Added safeguards so optional email is offered before official review, and final review is not shown before the optional email step is handled.
- Blocked stray QA/scenario numbers such as `8` from appearing in required-detail prompts.
- Improved address handling so the bot addresses the chat guest when possible, while still keeping the reservation holder name in the booking details.
- Prevented test/QA profile names from being used as real booking names.
- Stopped profile display names from silently becoming the reservation full name.
- Prevented date-like values such as `20260716` from being recovered as phone numbers.
- Tightened Arabic identity parsing for combined name, phone, and nationality lines.
- Preserved adult/child counts across separate messages such as "3 adults", "one child", and "that makes four".
- Protected reviewed multi-guest reservations from later admin update payloads that would accidentally reset guests to one adult.
- Repaired room-count parsing:
  - "room for two people" is treated as a room type/guest capacity request, not two rooms.
  - "03 triple room for 3 people" is treated as one triple room when the surrounding text clearly means guest capacity.
  - A quote reply is rejected if it shows a room count that conflicts with the tool result.
  - 8 guests are mapped to real combinations, for example family plus triple, not an imaginary 8-bed room.
- Improved budget objection handling so price concerns preserve the last quote instead of accidentally mutating the stay.
- Improved hotel fact answers:
  - Avoid raw source labels like "registered details" or "hotel data says".
  - Avoid raw number dumps after factual answers.
  - Add a light sales bridge asking for dates/guests or offering the 25% direct-booking discount.
- Meal handling now says bookings are room-only and points guests to nearby restaurants instead of promising meals.
- Post-confirmation payment questions now get a clear yes-style answer for paying at the hotel, including the confirmation number when available.
- WhatsApp/contact requests now consistently provide +1 (909) 222-3374 and `https://wa.me/19092223374`.
- Confirmation-number requests before a booking no longer get misread as WhatsApp/contact-number requests.
- Jannat Support recommendation wording no longer uses meals as a selling point; it focuses on location, transport, or hotel strength.
- The reusable live QA harness was added at `scripts/liveChatbotQa.js` and keeps reservation dispatch, emails, and WhatsApp dry-run disabled by default.

## Challenges

- OpenAI sometimes returned a good split-stay quote but omitted the required discount HTML. This was fixed by making the split-stay price rows deterministic while preserving the conversation flow around them.
- The live harness initially expected raw ISO dates, but Arabic replies naturally localized dates. The harness now accepts localized Arabic date ranges as long as the correct day/year range is present.
- Some live-like test names were being treated as real guest names. The parser now ignores QA/test profile names and requires explicit booking identity details.
- Budget objections looked like possible quote changes because they included price language. The orchestrator now restores stay selection for non-stay turns.
- Cleaning test data required strict boundaries. Cleanup used only support cases whose `sourceUrl` started with `https://xhotelpro.com/codex-live-qa/`, plus reservations linked to those exact support case IDs or `codexqa.*` emails.

## Local Verification

Static checks:

- `node --check aiagent/core/orchestrator.js` passed.
- `node --check aiagent/core/openai.js` passed.
- `node --check scripts/liveChatbotQa.js` passed.
- `npm run test:chatbot` passed with 54 chatbot regression checks.

Focused live QA cases rerun in the local database:

- Scenario 14, marker `codexqa-live-local-20260706-separated-final1`, case `6a4b47cb5f16fcc154d0dea1`.
  - Replayed the separate-message pattern:
    - `دخول 2026-07-16`
    - `خروج 2026-07-18`
    - `2 أشخاص`
    - `غرفة واحدة`
  - Result: one AI turn after the quiet wait, one clean quote, no reservation created.
  - Timing: 1 turn, about 19.3 seconds in the final local run.
- Scenario 12, marker `codexqa-live-local-20260706-focused-s12`, case `6a4b4804d5871953dfa1af1d`.
  - Replayed 8 guests.
  - Result: real multi-room combination was quoted, not an invented 8-bed room.
  - Timing: about 9.4 seconds.
- Scenario 20, marker `codexqa-live-local-20260706-focused-s20`, case `6a4b480409cae1a59ef4221a`.
  - Replayed Jannat Booking priority recommendation.
  - Result: Zad Ajyad was recommended with sales framing around Ajyad/Haram/discount, without a fake confirmation number.
  - Timing: about 2.2 seconds.
- Scenario 29, marker `codexqa-live-local-20260706-focused-s29`, case `6a4b4816e92a33d12f754b71`.
  - Replayed two separate reservations in one chat:
    - Period 1: 2026-07-16 to 2026-07-18.
    - Period 2: 2026-07-20 to 2026-07-22.
  - Result: split quote showed both periods and discount markup.
  - Result: optional email was offered before review.
  - Result: final review showed two separate bookings.
  - Result: two reservation documents were created and linked as separate split reservations:
    - `6a4b4842e92a33d12f754bf1`, confirmation `7469782894`, `:split:1`, 2026-07-16 to 2026-07-18.
    - `6a4b4842e92a33d12f754bf8`, confirmation `5045793685`, `:split:2`, 2026-07-20 to 2026-07-22.
  - Timing: 5 turns, average about 8.9 seconds per turn.

The reusable live harness now contains 29 scenarios. Earlier work in this hardening cycle exercised the broader set, but the final post-fix rerun was intentionally focused on the highest-risk requested paths above.

## Database Cleanup

After verification, all Codex live-QA documents were cleaned from the local database.

Dry run before deletion:

- Support cases found: 102.
- Reservations found: 20.

Deletion scope:

- Support cases only where `sourceUrl` matched `https://xhotelpro.com/codex-live-qa/...`.
- Reservations only where `aiSupportCaseId` matched one of those exact support case IDs, a split key based on those IDs, `customer_details.aiSupportCaseId` matched one of those IDs, or `customer_details.email` started with `codexqa.`.

Deletion result:

- Deleted support cases: 102.
- Deleted reservations: 20.

Verification after deletion:

- Remaining Codex live-QA support cases: 0.
- Remaining `codexqa.*` reservation emails: 0.
- Remaining split test reservations created today: 0.

No real guest support cases or real reservations were targeted by this cleanup.

## Monitoring Notes

- The local live harness forces safe test settings:
  - `AI_SKIP_RESERVATION_CONFIRMATION_DISPATCH=true`
  - `SUPPORT_CASE_EMAIL_NOTIFICATIONS_ENABLED=false`
  - `WHATSAPP_DRY_RUN=true`
  - `AI_PLAN_USE_WORKER=false`
- The PM2/worker approach remains sequential for chatbot turns: the next unanswered case should be picked after the current one finishes instead of running many expensive OpenAI flows concurrently.
- The guest quiet window remains important. The harness validates the burst-message behavior by sending multiple guest messages before allowing the bot to respond.
- During production rollout, monitor:
  - `pm2 status`
  - recent `pm2 logs`
  - CPU and memory
  - server temperature, keeping it below 78 C
  - API health endpoint / app response
  - a small number of smoke chatbot flows, not a full heavy 29-scenario run on the live server unless needed.

## Production Rollout Results

Rollout commit:

- Local commit: `96d660acb9a649e75632d20ec3d07508cfdd50dd`.
- GitHub `origin/master`: `96d660acb9a649e75632d20ec3d07508cfdd50dd`.
- Server checkout at `/home/ahmedadmin/Hotels/hotels_backend`: `96d660acb9a649e75632d20ec3d07508cfdd50dd`.

Deployment steps:

- Pushed `master` to GitHub.
- Pulled on `ssh jannat` with `git pull --ff-only origin master`.
- Ran server-side checks before restart:
  - `node --check aiagent/core/orchestrator.js` passed.
  - `node --check scripts/liveChatbotQa.js` passed.
  - `npm run test:chatbot` passed with 54 chatbot regression checks.
- Restarted only `hotels-backend` with `pm2 restart hotels-backend --update-env`.

Production health after restart:

- `/api/aiagent/health` on port `8080` returned `ok: true`, `openai: true`.
- `/api/active-hotels` returned successfully.
- `hotels-backend` was online in PM2 after restart.
- Backend memory was about 262 MB during final PM2 check.
- CPU was 0% during final PM2 check.
- System RAM had about 12 GiB available.
- Root disk usage was 9%.
- CPU package temperature was about 31 C, safely below the 78 C limit.

Production smoke tests after restart:

- Scenario 14, marker `codexqa-prod-smoke-20260706-separated`.
  - Tested the separate-message pattern after deploy.
  - Passed in one turn, about 19.8 seconds.
  - Auto-cleanup deleted 1 support case and 0 reservations.
- Scenario 12, marker `codexqa-prod-smoke-20260706-8guests`.
  - Tested 8 guests mapping to a real room combination.
  - Passed in one turn, about 12.8 seconds.
  - Auto-cleanup deleted 1 support case and 0 reservations.
- Scenario 20, marker `codexqa-prod-smoke-20260706-jannat-ajyad`.
  - Tested Jannat Booking recommending priority Zad Ajyad with sales framing.
  - Passed in one turn, about 4.2 seconds.
  - Auto-cleanup deleted 1 support case and 0 reservations.

Production cleanup verification:

- Remaining `codexqa-prod-smoke-*` cases: 0.
- Remaining `https://xhotelpro.com/codex-live-qa/...` cases: 0.
- Remaining `codexqa.*` reservation emails: 0.

Log notes:

- The backend out log showed clean startup after restart:
  - AI orchestrator initialized.
  - Socket DB watcher enabled.
  - Server running on port `8080`.
  - MongoDB Atlas connected.
- Older error-log entries still include previous validation-repair lines and the earlier `RESERVATION_DETAILS_HOTEL_SELECT.join is not a function` reservation-update error. No new fatal startup error was observed after this rollout.
- One production smoke quote used the compact repair path before sending the final accepted reply. This is the intended safety validator path, not a failed user response.

## Upcoming Tightening

- Add one combined end-to-end live QA scenario for the exact full chain: hotel has no rooms, Jannat Support greets, recommends priority Ajyad, user clicks transfer, Ajyad continues. The current harness checks the hotel-unavailable component and the Jannat priority recommendation component, but a single chain assertion would make this easier to monitor.
- Improve small Arabic grammar details in deterministic quote builders, for example `2 أشخاص` vs. `شخصين`, when doing a polish-only pass.
- Keep extending the live harness instead of manual one-off testing, so future chatbot changes can rerun the same scenarios quickly and safely.
