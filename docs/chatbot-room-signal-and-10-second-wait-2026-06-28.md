# Chatbot Room Signal And 10 Second Wait Notice - 2026-06-28

## Root Cause From The Marwa / Nadia Chat

- The guest used Arabic/Egyptian wording for a triple room, especially `ثلاثى`.
  `aiagent/core/nlu.js` understood `ثلاثية`, but not all common variants with
  alef maqsura/yeh endings or Egyptian `تلاتى` wording.
- The later assistant room-options message mentioned several room types. The
  room-memory scanner could treat that assistant list as a selected room,
  usually the first room in the list, which let stale/wrong room state leak into
  the quote.
- The old Arabic decline detector matched `لا` too broadly. In words like
  `ثلاثى`, that substring could be interpreted as a negative answer in some
  branches.
- When a turn took too long, the guest could see silence. The chatbot had
  typing indicators and recovery paths, but no rare professional "I need a
  moment" message after the hard 10 second threshold.

## Behavior Contract

- Arabic and English room choices must be treated as fresh guest room signals
  when the guest explicitly chooses or asks price/availability for a room.
- Assistant option lists such as "Double / Triple / Quad, which do you prefer?"
  must not become the selected room by themselves.
- A later conflicting assistant quote must not override the latest explicit
  guest room choice.
- `لا` should only count as an Arabic decline when it appears as a standalone
  word or clear decline phrase, not inside another Arabic word.
- If the chatbot has not produced a real answer after about 10 seconds, it may
  send one rare, localized, system-marked AI wait notice. That notice must not
  block the real final answer or silence-recovery logic.
- The target remains that normal chatbot turns finish under 8 seconds in
  production. The 10 second notice is a safety net, not the normal path.

## Implementation Notes

- `aiagent/core/nlu.js`
  - Added Arabic room normalization for diacritics, hamza/alef variants,
    alef maqsura/yeh, and ta marbuta/ha endings.
  - Added common Arabic/Egyptian triple-room synonyms.
- `aiagent/core/orchestrator.js`
  - Reduced default reply target windows slightly so the orchestrator aims below
    the 8 second UX requirement more consistently.
  - Added `AI_DELAY_NOTICE_MS` and `AI_DELAY_NOTICE_COOLDOWN_MS`.
  - Added a localized wait notice that is saved with
    `isAi: true`, `isSystem: true`, and `clientAction: "ai_wait_notice"`.
  - Ignored system wait notices when deciding whether a real AI answer already
    happened after the latest guest message.
  - Ignored assistant room-option prompts for room-memory selection.
  - Let explicit guest room choices, and room price/availability questions,
    beat conflicting later assistant quotes.
  - Replaced broad decline regex checks with the safer `declinesText` helper.
- `aiagent/core/db.js`
  - The atomic append guard now compares `requireLatestGuestText` against the
    latest real guest message, ignoring AI/system messages. This keeps the final
    answer saveable after a wait notice while preserving duplicate protection.

## Validation Performed Locally

- `node --check aiagent/core/nlu.js`
- `node --check aiagent/core/orchestrator.js`
- `node --check aiagent/core/db.js`
- Parser smoke test:
  - Arabic `ثلاثى`, `ثلاثي`, `ثلاثية`, `تلاتى`, and an Arabic triple-room
    price/date sentence map to `tripleRooms`.
  - English `triple room` maps to `tripleRooms`; `double room` maps to
    `doubleRooms`.
  - `nluStep({ lastUserMessage })` returns `intent: reserve_room` and
    `roomTypeKey: tripleRooms` for the Arabic triple-room price sentence.
- Orchestrator smoke test:
  - `declinesText("ثلاثى") === false`.
  - `declinesText("لا") === true`.
  - Assistant option-list prompts are ignored as room selections.
  - Latest explicit guest `tripleRooms` signal beats a later conflicting
    assistant `doubleRooms` quote.
  - A wait notice does not count as a final AI reply; a real later AI answer
    does.
- `git diff --check` passed except for normal Windows LF-to-CRLF warnings.

## Production Monitoring Checklist

- After deploy, check PM2 status and backend logs for startup success.
- Confirm `https://xhotelpro.com/api/aiagent/health` returns 200.
- Watch logs for `delay_notice.sent`; this should be rare.
- Watch slow-turn logs. If many turns exceed 8 seconds, inspect model/tool
  latency before changing guest-facing copy.
- Check memory and host temperature after restart. This change uses small
  per-turn timers and an atomic, per-support-case MongoDB update; it should not
  introduce wide scans, loops, or heap pressure.
