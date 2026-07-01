# B2C OpenAI Chatbot Go-Live Runbook - 2026-06-30

Date: 2026-06-30

This document records the production go-live work for the Jannat Booking B2C hotel chatbot, the operational issues seen during testing, the fixes deployed, and the intended future architecture.

The main goal is simple:

OpenAI should be the conversation brain and human voice. The backend orchestrator should stay small, exact, and operational.

## Final Architecture

The agreed architecture is:

- OpenAI owns customer-facing conversation, tone, language, dialect, sales flow, small talk, and polite unrelated answers.
- The orchestrator owns exact data, persistence, buttons, and actions.
- The orchestrator should not sound like a second chatbot and should not produce scripted customer replies except deterministic openings, reviews, confirmations, and emergency fallbacks.
- The orchestrator must never send full calendars to OpenAI.
- OpenAI may infer/normalize natural-language intent and return structured data, but the orchestrator must verify exact pricing, availability, and reservation actions.

### OpenAI Responsibilities

OpenAI receives compact context and leads the chat:

- Hotel identity and short summary.
- Room types and human meaning, for example double room means suitable for two guests/two beds depending on hotel setup.
- Saved hotel facts such as location, bus service, policies, meals, parking, and payment rules.
- Pricing guidance only when compact and approximate.
- Required reservation fields.
- Current known booking facts.
- Recent transcript.
- Language/dialect instructions.
- Islamic-friendly tone instructions.
- Action rules.

OpenAI returns:

- Customer-facing reply when a reply is ready.
- Extracted booking facts.
- Action request when exact data or a backend action is needed.
- Optional quick replies/buttons.

Expected action examples:

- `get_quote`
- `send_review`
- `submit_reservation`
- `update_reservation`
- `cancel_reservation`
- `escalate`
- `close_case`

### Orchestrator Responsibilities

The orchestrator executes exact operations:

- Fetch exact availability for the requested stay dates.
- Fetch exact pricing rows for the requested stay dates.
- Persist known booking facts in `SupportCase.aiStateSnapshot.known`.
- Send final review buttons.
- Create reservation only after the final button/action is used.
- Emit socket events for typing, support-case updates, close events, and AI pause.
- Auto-close inactive AI cases safely.
- Escalate risky or angry chats.

The orchestrator should not:

- Send huge calendars to OpenAI.
- Hard-code customer conversation language.
- Ask repeated form-like questions when OpenAI can naturally continue.
- Invent price, policy, reservation confirmation, payment status, or availability.
- Continue processing a closed support case.

## Current Production Flow

1. Case opens.
2. Backend sends a short deterministic greeting.
3. OpenAI context is prepared from compact hotel data, known facts, rules, and transcript.
4. Guest sends message.
5. Public widget waits for 2 seconds of guest silence before the backend starts responding.
6. If the guest types again, the 2-second quiet timer restarts.
7. The widget shows the AI agent typing for at least 2 seconds while the orchestrator/OpenAI work.
8. OpenAI extracts intent/facts and either replies directly or asks for an action.
9. Orchestrator performs exact action if needed.
10. OpenAI writes the polished customer-facing answer, unless the answer is one of the deterministic action messages.
11. If the guest is inactive for 5 minutes after the latest AI message, the case auto-closes safely.

## Initial Prompt Rules To Preserve

The initial OpenAI prompt should continue to include these principles:

- You are a professional customer service and reservations representative for the selected hotel.
- Match the guest language and dialect naturally. If the guest changes language, follow the guest.
- Use the agent name and guest name in the chosen language when possible.
- Be warm, human, and concise. Do not sound like a form or memorized script.
- Answer polite small talk naturally first, then gently guide back to the stay.
- For polite unrelated questions, answer briefly when possible, then return to hotel help. If live web/current info is enabled later, request that tool/action instead of inventing.
- This is an Islamic-friendly reservations platform. Use respectful phrases naturally when appropriate, without exaggeration.
- Ask one clear next question at a time whenever possible.
- Remember confirmed fields and do not ask for them again unless they are unclear or changed.
- Never invent exact availability, price, payment status, cancellation result, or reservation confirmation.
- Monthly pricing guidance is approximate. Exact stays require backend quote.
- If the guest is angry, insulting, threatening, asks for a manager/human, or raises a sensitive complaint, return an escalation action.
- If the guest is ready to book and all needed data is present, return the review action.
- If the guest asks to review or correct the reservation, return the review/update action.
- Return dates to the orchestrator in Gregorian/Melady ISO format when possible.
- If the guest used Hijri, preserve the Hijri display text too so Arabic review/quote can show both Hijri and Melady.

## Booking Fields

The AI should know that a new reservation generally needs:

- Check-in date.
- Check-out date.
- Room type or enough guest/bed information to choose one.
- Adults/children when relevant.
- Full guest name.
- Phone number.
- Nationality.
- Email is optional.

The final reservation review should be deterministic and button-based. OpenAI can lead the conversation up to review, but reservation creation should remain a backend action.

## Pricing And Calendar Strategy

Important production rule:

Do not send full calendars to OpenAI.

Approved approach:

- Give OpenAI compact pricing guidance only.
- If a month has mostly one price, represent it as a monthly guide, for example `August 2026: about 85 SAR per night`.
- If a month has no calendar price and no block, represent base price only.
- If a full month is blocked, say the month appears blocked.
- For exact user dates, OpenAI should return ISO date range and room/guest facts.
- The orchestrator checks exact availability and exact nightly prices only for that requested stay.

This keeps OpenAI fast and avoids large prompt payloads.

## Date And Hijri Handling

The guest may write dates in:

- Arabic Gregorian dates.
- English Gregorian dates.
- Short numeric dates.
- Hijri months.
- Arabizi/transliterated phrases.

Current direction:

- Let OpenAI do as much date understanding as possible.
- The orchestrator should receive Gregorian/Melady ISO dates.
- If OpenAI is unsure, it should ask a natural confirmation question instead of forcing the guest to convert.
- If the guest writes Hijri dates, OpenAI should return:
  - `checkinISO`
  - `checkoutISO`
  - `checkinHijriText`
  - `checkoutHijriText`
  - `dateRangeOriginalText`
  - `dateCalendar: "hijri"`

This allows the review to show both calendars for Hijri-speaking guests.

### Hijri Fix Deployed

Commit:

- `f95df3d Preserve Hijri dates in B2C AI replies`

What it fixed:

- Added Arabic display for `Iman` as `إيمان`.
- Preserved Hijri display fields in known facts.
- Cleared stale Hijri display fields if ISO dates change without new Hijri metadata.
- Added prompt instructions for OpenAI to return Gregorian ISO plus Hijri display metadata.
- Updated review date lines to show both Hijri and Melady when available.
- Added quote fallback if OpenAI writer times out after exact backend quote succeeds.
- If planning times out but known facts already include dates and room, the system can still quote instead of asking the guest to convert Hijri.

Production example from case `6a445405cacf700568fbff6f`:

- Guest used Hijri-style dates.
- Known facts resolved to:
  - check-in: `2026-08-01`
  - check-out: `2026-08-09`
  - room: `doubleRooms`
  - nights: 8
  - total: 600 SAR
- AI replied with both the original Hijri range and Gregorian dates.

## Reply Timing And Typing UX

Current intended behavior:

- Guest typing has priority.
- Wait for 2 seconds of silence after the latest guest typing/message.
- If the guest types again, restart the quiet timer.
- Show agent typing for at least 2 seconds.
- OpenAI response target should usually be 3-8 seconds.
- Avoid sending "please wait" filler unless truly needed.
- Never overlap replies with active guest typing.

Related environment/config values:

- `AI_GUEST_REPLY_QUIET_MS=2000`
- `AI_TYPING_MIN_VISIBLE_MS=2000`
- `OPENAI_CHATBOT_TIMEOUT_MS=12000`
- `AI_IDLE_AUTO_CLOSE_MS=300000`

## 5-Minute Inactivity Auto-Close

Requirement:

If the guest has not typed or responded for 5 minutes after the latest AI message, the AI case should close safely.

Commit:

- `9b4eca8 Auto close idle B2C AI cases`

Behavior:

- The backend schedules idle close after an AI reply.
- If the guest types or sends anything, the timer is pushed forward.
- The close update only succeeds if the latest DB conversation entry is still that same AI message.
- This prevents closing over a newer guest response.
- Startup recovery re-schedules or closes open AI cases after backend restarts.

Safety fix:

- `0433afd Reduce idle AI case recovery memory`

Why it was needed:

- The first idle recovery implementation loaded full conversation arrays for up to 150 open AI cases on backend startup.
- Some support cases can have long transcripts.
- This created memory pressure during an already sensitive production test day.

What changed:

- Startup recovery now fetches only the latest conversation entry.
- Recovery limit reduced from 150 to 75.
- Timer close no longer re-loads the full case before closing.
- MongoDB enforces the "latest message is still this AI message" condition atomically.
- The closed-case payload selected after close is compact and does not include the full conversation.

## Production Issues Faced

### 1. PMS Freezing And Failed Support Case Fetches

Symptoms:

- Admin PMS customer-service tab showed `Failed to fetch support cases`.
- Some tabs appeared frozen or blank.
- Reservations/admin routes intermittently failed.
- User could not reliably monitor PMS notifications.

What we found:

- `hotels-backend` had repeated OOM crashes.
- PM2 restart count reached 66+.
- Logs showed Node heap reaching about 4 GB and crashing with:
  - `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`

Actions taken:

- Restarted only `hotels-backend` when it was bloated.
- Avoided restarting all services unnecessarily.
- Checked PM2, memory, load, temperatures, and route health.
- Patched idle recovery memory behavior.

Post-fix health snapshot:

- `hotels-backend`: online.
- Memory: about 185 MB RSS after 5+ minutes.
- CPU: near 0% in PM2 samples.
- Load average: about `0.25, 0.49, 0.61`.
- RAM available: about 12 GiB.
- CPU package temperature: about 41 C.
- NVMe temperature: about 44 C.
- PMS customer-service page returned HTTP 200.
- PMS reservations tools page returned HTTP 200.
- Jannat hotel page returned HTTP 200.

### 2. PM2 Environment Override

Symptom:

- `.env` had `OPENAI_CHATBOT_TIMEOUT_MS=12000`.
- `pm2 env 5` still showed `OPENAI_CHATBOT_TIMEOUT_MS=8000`.

Impact:

- OpenAI requests timed out too early.
- Some guest turns fell back unnecessarily.

Action taken:

- Restarted backend with explicit runtime env:
  - `OPENAI_CHATBOT_TIMEOUT_MS=12000`
  - `AI_IDLE_AUTO_CLOSE_MS=300000`
- Ran `pm2 save --force`.
- Verified with `pm2 env 5`.

Important future note:

Always verify PM2 env after changing `.env`. Dotenv will not override an environment variable already injected by PM2.

### 3. Robotic Replies

Symptoms:

- AI sounded memorized.
- It repeated stock phrases.
- It sometimes answered unrelated to the latest guest text.
- It did not respond naturally to small talk such as "how are you?"
- It pushed booking fields too aggressively.

Decision:

- Stop over-planning with local orchestrator logic.
- Let OpenAI be the main conversation lead.
- Keep deterministic backend only for exact actions.

Prompt direction:

- Human CSR and sales representative.
- Natural small talk first.
- One question at a time.
- Remember already provided info.
- Match dialect.
- Use professional warmth.
- Do not say words like "typo" to the guest.
- Do not hard-code sample phrasing.

### 4. Language Mixing

Symptom:

- English chat sometimes received Arabic hotel fact fragments, for example bus-service answer had Arabic text inside English reply.

Fix direction:

- OpenAI prompt must instruct language adaptation/translation of saved facts.
- Saved hotel facts may be stored in Arabic, but the customer answer should match the guest language unless the guest switches language.

### 5. Unrealistic Testing Phrases

Symptom:

- Test messages included phrases like "sorry typo..." or repeated exact scripted samples.
- User correctly flagged that real guests will not say that.

Testing rule going forward:

- Simulate real guests, not QA hints.
- Use natural Arabic dialects, English, Arabizi, incomplete messages, and casual phrasing.
- Do not include meta words like "typo" unless the guest naturally wrote them.

### 6. Support Case Cleanup Risk

Problem:

- Testing generated support cases.
- There was a dangerous moment where it appeared non-test cases might have been removed.

Future cleanup rule:

- Never broadly delete support cases.
- Only remove cases clearly created by Codex/testing.
- Filter by explicit test markers such as Codex QA names/tags.
- Confirm counts before and after.
- Prefer closing test cases over deleting when production history matters.
- Confirm backups before any restoration.

## Important Commits From This Go-Live Work

- `df606d9 Slim B2C AI orchestrator`
  - Rebuilt the B2C orchestrator around OpenAI-led conversation.
  - Kept public compatibility exports.
  - Persisted known facts in `SupportCase.aiStateSnapshot.known`.

- `b653c9b Stabilize OpenAI-led B2C chat turns`
  - Reduced bulky hotel context sent to OpenAI.
  - Removed large room pricing/context pieces from initial prompt.
  - Added safer OpenAI timeout fallback behavior.
  - Added Arabic localized agent-name coverage.

- `9b4eca8 Auto close idle B2C AI cases`
  - Added 5-minute idle auto-close.
  - Added startup timer recovery.
  - Added safe latest-message guard.

- `f95df3d Preserve Hijri dates in B2C AI replies`
  - Preserved Hijri display metadata.
  - Updated prompt/review behavior for Hijri users.
  - Added fallback quote message when quote succeeded but writer timed out.

- `0433afd Reduce idle AI case recovery memory`
  - Fixed memory pressure from idle recovery.
  - Avoided full conversation hydration during startup/timer close.
  - Confirmed backend memory stayed around 185 MB after deployment watch.

## Production Verification Commands

Use these commands from the local workstation:

```bash
ssh jannat 'date; uptime; free -h | sed -n "1,3p"; pm2 list --no-color'
```

```bash
ssh jannat 'ps -p $(pm2 pid hotels-backend) -o pid,etime,pcpu,pmem,rss,vsz,cmd'
```

```bash
ssh jannat 'sensors 2>/dev/null | head -35'
```

```bash
ssh jannat 'curl -sS -m 8 http://127.0.0.1:8080/api/aiagent/health; echo'
```

```bash
ssh jannat "pm2 env 5 | grep -E 'OPENAI_CHATBOT_TIMEOUT_MS|AI_IDLE_AUTO_CLOSE_MS'"
```

```bash
ssh jannat "curl -sS -m 8 -I 'https://xhotelpro.com/admin/customer-service?tab=active-hotel-cases' | head"
```

```bash
ssh jannat "curl -sS -m 8 -I 'https://xhotelpro.com/admin/jannatbooking-tools?tab=reservations' | head"
```

```bash
ssh jannat "curl -sS -m 8 -I 'https://jannatbooking.com/single-hotel/zad-ajyad?lang=ar' | head"
```

Open client AI case check:

```bash
ssh jannat 'cd /home/ahmedadmin/Hotels/hotels_backend && node - <<'"'"'NODE'"'"'
require("dotenv").config();
const mongoose = require("mongoose");
const SupportCase = require("./models/supportcase");
(async () => {
  await mongoose.connect(process.env.DATABASE, { useNewUrlParser: true, useUnifiedTopology: true });
  const cases = await SupportCase.find({ openedBy: "client", caseStatus: "open", aiToRespond: true })
    .select("_id clientName displayName1 updatedAt conversation")
    .sort({ updatedAt: -1 })
    .limit(10)
    .lean();
  console.log(JSON.stringify(cases.map((c) => {
    const conv = Array.isArray(c.conversation) ? c.conversation : [];
    const last = conv[conv.length - 1] || null;
    return {
      id: String(c._id),
      clientName: c.clientName || c.displayName1 || "",
      updatedAt: c.updatedAt,
      messageCount: conv.length,
      lastIsAi: !!last?.isAi,
      lastAt: last?.date || null,
      lastMessage: String(last?.message || "").slice(0, 120)
    };
  }), null, 2));
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
NODE'
```

## Local Code Verification

Before production deploys, at minimum run:

```bash
node --check hotels_backend/aiagent/core/orchestrator.js
```

```bash
node --check hotels_backend/aiagent/core/db.js
```

Depending on touched files:

```bash
node --check hotels_backend/controllers/supportcase.js
node --check hotels_backend/server.js
```

## Production Deploy Pattern Used

Backend code deployment:

```bash
git -C hotels_backend push origin master
```

On server:

```bash
ssh jannat "cd /home/ahmedadmin/Hotels/hotels_backend && git pull --ff-only origin master"
```

Restart only backend:

```bash
ssh jannat "cd /home/ahmedadmin/Hotels/hotels_backend && OPENAI_CHATBOT_TIMEOUT_MS=12000 AI_IDLE_AUTO_CLOSE_MS=300000 pm2 restart hotels-backend --update-env && pm2 save --force"
```

Then verify:

```bash
ssh jannat "pm2 env 5 | grep -E 'OPENAI_CHATBOT_TIMEOUT_MS|AI_IDLE_AUTO_CLOSE_MS'"
```

## Testing Guidance Going Forward

Production testing must be careful because this is operational.

Recommended order:

1. One chat only.
2. Two chats concurrently.
3. Three chats concurrently.
4. Four chats concurrently.
5. Five chats concurrently.

For each test:

- Use realistic guest language.
- Use Arabic heavily because most audience is Arabic-speaking.
- Include Egyptian, Gulf, Levant, and mixed dialect forms.
- Include incomplete multi-message guests.
- Include polite small talk.
- Include trust questions such as "are you with the hotel?"
- Include hotel service questions.
- Include pricing and cancellation questions.
- Include Hijri and Gregorian dates.
- Include real booking completion through final button.
- Confirm the reservation is saved.
- Confirm the case closes when complete or after 5 minutes of real inactivity.
- Monitor PMS notifications and active support case lists.
- Monitor backend memory, CPU, temperatures, and PM2 restart count.

Realistic Arabic pattern to test:

- Guest sends one thought split over several messages.
- Example:
  - "حياكم الله عاوز غرفتين"
  - "لثلاث اشخاص"
  - "لمدة سبع ايام"
  - "اعتبارا من 30/6/2026"
  - "ممكن السعر واسم الفندق وموقعه"

Expected behavior:

- AI waits for quiet period.
- AI does not forget the earlier pieces.
- AI answers location/name question.
- AI uses collected stay details.
- AI asks only the missing question if needed.
- AI gives exact quote once backend returns exact price/availability.

## Current Known Good Production State After Final Patch

After deploying `0433afd`:

- `hotels-backend` stayed online for more than 5 minutes.
- Memory stayed around 185 MB RSS.
- PM2 CPU sample was 0%.
- Server load decreased.
- CPU package temperature decreased to about 41 C.
- Open client AI cases query returned `[]`.
- `https://xhotelpro.com/admin/customer-service?tab=active-hotel-cases` returned HTTP 200.
- `https://xhotelpro.com/admin/jannatbooking-tools?tab=reservations` returned HTTP 200.
- `https://jannatbooking.com/single-hotel/zad-ajyad?lang=ar` returned HTTP 200.
- AI health endpoint returned:
  - `ok: true`
  - `openai: true`
  - `reasoningEffort: low`

## Things To Watch Next

- Memory after long production use, not only 5-minute soak.
- PMS notification behavior during live multi-chat test.
- Auto-close behavior after real 5-minute inactivity.
- Whether PM2 env persists correctly after a machine reboot.
- Whether OpenAI replies stay human and avoid scripted repetition.
- Whether Arabic dialects are handled naturally without hardcoded examples.
- Whether Hijri review consistently shows both Hijri and Melady dates.
- Whether English replies translate Arabic saved hotel facts cleanly.
- Whether reservation review and confirmation stay deterministic and safe.

## Do Not Forget

- The PMS is operational and must remain responsive during chatbot testing.
- If PMS freezes, stop chatbot testing and check backend memory/PM2 first.
- Do not run heavy browser tests from the home server.
- Do not open multiple production chats before one-chat test is healthy.
- Do not delete support cases broadly.
- Do not send full calendars to OpenAI.
- Do not hard-code guest wording in tests or prompts.
- Keep OpenAI as the brain; keep the orchestrator as the exact-action runner.

