# Chatbot Reservation Memory And Casual UX - 2026-06-24

## Why This Exists

Live guest-style testing showed the chatbot was close, but not yet natural
enough for a hotel CSR:

- It sometimes repeated questions after the guest had already answered.
- Arabic/Egyptian short answers such as `فردين` needed to be understood as a
  guest count, not treated as vague chat.
- Correction or complaint messages such as `I never said 6 people` or
  `منا قولتلك احنا فردين` must update the booking state without becoming a
  guest name.
- Casual and emotional messages needed a warm professional answer, including a
  simple Islamic dua where appropriate, instead of sounding robotic or jumping
  into a booking prompt.
- Arabic typing status in the public widget needed feminine wording when the AI
  assistant persona is female.
- Once mandatory reservation details are complete, optional email must not block
  reservation creation.

The target experience remains: dynamic multilingual CSR, easy reservation,
strong conversation memory, brief sales-aware wording, and a visible frontend
rhythm of silence first, then `X is typing...`, then the answer.

## Source Changes

Backend production app: `hotels-backend`

- `0370cac` - `Tighten AI reservation detail flow`
- `69572a0` - `Handle softer guest distress wording`
- `208aee5` - `Guard casual replies from booking prompts`

Main backend file:

- `aiagent/core/orchestrator.js`

SSR production app: `jannat-ssr`

- `4820c28` - `Fix Arabic AI typing indicator`

Main SSR file:

- `components/SupportWidget.js`

Related earlier fixes from the same stabilization thread:

- `6e27085` - backend AI room recovery path hardening
- `c02c383` - frontend send/end-chat stuck-state protection

## Behavior Now Expected

- Room lists use the hotel room catalog and preserve Arabic display names where
  available.
- Guest counts are remembered across English and Arabic, including:
  - `me and my friend`
  - `two`
  - `فردين`
  - `انا و صديقي`
  - `انا وصاحبي`
- A correction sentence can update the guest count without being saved as the
  guest name.
- A complaint sentence while waiting for booking details is not accepted as a
  guest name.
- The bot should avoid redundant guest-count questions when the count is already
  known.
- Reservation finalization creates the reservation once required details are
  present. Missing optional email is marked as skipped instead of adding another
  required-feeling step.
- Soft distress wording such as `I am a little sad today` receives a warm,
  professional reply and a light dua, then gently returns to service.
- Initial greetings and casual turns are guarded so an OpenAI-written casual
  reply cannot suddenly ask for booking fields such as nationality, phone,
  dates, room type, or guest count.
- In Arabic, the AI typing text for a female assistant uses feminine phrasing:
  `تكتب الآن...`.
- The frontend send button and end-chat button should recover even if a request
  stalls or is aborted.

## Same-Chat Reservation Memory Follow-Up

Later live testing exposed a final-review memory regression in the Sara flow:

- The guest sent mandatory details as:
  `Ahmed Test / 9998881999 / US / For two individuals`.
- The bot failed to preserve `US` as the nationality and later accepted
  `I already told you` as the saved nationality.
- When the guest asked `Do you remember the data I gave you for my reservation?`,
  the bot repeated the final `Complete Reservation` prompt instead of reading
  back the current reservation details.

Expected behavior after the follow-up fix:

- Standalone nationality aliases in multiline payloads, such as `US`, hydrate
  and display as a valid nationality, for example `American`.
- Complaint/chase text such as `I already told you` is never accepted as a
  nationality during live capture or restart hydration.
- Guest counts in multiline detail payloads, such as `For two individuals`, are
  recovered after server restarts.
- Same-chat memory questions such as `Do you remember the data I gave you?`,
  `What is my nationality here?`, Spanish `Recuerdas los datos de mi reserva?`,
  French `Vous vous souvenez des details de ma reservation ?`, and Arabic
  already-provided wording receive a current booking summary before any next
  action prompt.
- The bot preserves the active reservation step after answering the memory
  question and only shows final quick replies when the reservation is actually
  ready for completion.

## Live Test Evidence

All tests used temporary public support cases and exact cleanup markers. No
broad production cleanup was used.

Long Arabic and English test:

- Arabic support case: `6a3c3dcc4f4a5a9a06f0363d`
- Arabic reservation created: `3147046995`
- English support case: `6a3c3e2e4f4a5a9a06f03753`
- English reservation created: `7594846771`
- Saved messages: 44 total across both cases
- Result:
  - Arabic flow passed.
  - English booking flow passed.
  - Arabic correction text did not become a guest name.
  - Reservation creation worked in both languages.
  - The first English run exposed a weak emotional phrase, which led to
    `69572a0`.

Targeted emotional-flow retest:

- Support case: `6a3c3edf81920355986b8b69`
- Reservation created: `2833158443`
- Result:
  - `I'm a little sad today` received a sympathetic dua-style answer.
  - Guest count stayed remembered.
  - Reservation creation still worked.
  - The test exposed one startup/casual guard issue, which led to `208aee5`.

Startup and distress smoke test:

- Support case: `6a3c3f9e251f8acef72ef690`
- Result:
  - Initial `Hi` returned a normal greeting from the assistant.
  - Sadness follow-up returned a warm professional reply.
  - No booking-field prompt leaked into the casual greeting.

Cleanup verification after all tests:

- Remaining `codexLiveTestSupportCases`: `0`
- Remaining `codexSourcePageCases`: `0`
- Recent AI test reservations: `0`

## Verification Completed

Backend:

- `node --check aiagent/core/orchestrator.js`
- Backend import smoke test passed.
- PM2 restarted `hotels-backend`.
- OpenAI health endpoint returned active models:
  - writer model: `gpt-5.5`
  - NLU model: `gpt-5.4-mini`
  - analysis model: `gpt-5.4-mini`
- `hotels-backend` was online after restart.

SSR:

- `npm run build`
- PM2 restarted `jannat-ssr`.
- `https://jannatbooking.com` returned HTTP `200`.
- `jannat-ssr` was online after restart.

Repository:

- `git diff --check` passed for changed source.
- Backend and SSR commits were pushed and fast-forwarded on the home server.

## Timing Notes

The desired user-visible rhythm is:

- about 2 seconds of silence after the guest sends a message
- then about 2-6 seconds of visible `X is typing...`
- best case around 5 seconds total
- tolerated upper band around 8 seconds total

The final live content flow scored around 9/10. Most backend slow-turn logs were
roughly within the target band, but a few OpenAI-heavy dynamic turns appeared
around 10-11 seconds from script polling. Treat this as the main remaining UX
risk if a future test demands perfect 5-8 second timing.

Future timing options:

- Keep deterministic fast paths for known hotel facts, room lists, reservation
  state, and repeated questions.
- Use OpenAI for dynamic wording, emotional intelligence, multilingual nuance,
  and ambiguous intent.
- If timing still exceeds 8 seconds in production, consider streaming or a
  stricter soft-timeout fallback for casual writer calls.

## Regression Checklist

For the next serious QA pass, use at least 20 total guest messages and cover:

1. English greeting and casual talk.
2. Arabic greeting and casual talk.
3. Soft emotional message, for example `I'm a little sad today`.
4. Arabic emotional message.
5. Room-type question, including Arabic and English room display names.
6. Date range collection.
7. Guest count from English phrase, for example `me and my friend`.
8. Guest count from Arabic phrase, for example `فردين`.
9. Complaint/correction sentence, for example `I never said 6 people`.
10. No redundant guest-count question after the count is known.
11. Full name, phone, nationality, adult count, and reservation final review.
12. Complete Reservation action creates exactly one reservation.
13. Post-booking confirmation number recall.
14. End-chat button remains usable.
15. Send box does not get stuck after an aborted or slow request.
16. Arabic female assistant typing text reads as feminine.
17. Test support cases and test reservations are deleted by exact IDs only.

## Preserve These Rules

- Do not hard-code one-off guest complaints as special cases; generalize the
  meaning into correction, refusal, distress, or booking-detail intent.
- Do not let OpenAI overwrite verified booking state with a worse guess.
- Do not let casual replies ask for booking fields unless the guest actually
  started a booking flow.
- Do not block reservation creation on optional email.
- Do not delete production data broadly during cleanup. Use exact temporary
  test IDs and recheck that zero test records remain.
- Do not rely on chat memory alone for reservation details; keep structured
  state authoritative and pass the useful conversation context to OpenAI for
  tone and language.

## Open Follow-Ups

- GitHub reported dependency vulnerabilities during push: 158 total, including
  7 critical and 83 high. This is a separate dependency/security task and was
  not changed during chatbot QA.
- If future live tests still show 10+ second turns, tighten writer fallbacks or
  introduce streaming/early typing UX before changing the conversation logic.

## French And Spanish Follow-Up

After the main English/Arabic QA, the French and Spanish paths were checked for
the same dynamic-chat assumptions.

Confirmed from source:

- The public widget offers Spanish and French as selectable chat languages.
- Backend language detection and explicit language switching support Spanish
  and French.
- Deterministic hotel facts, room-list replies, date-change prompts, location
  replies, final-review labels, and reservation-detail labels include Spanish
  and French branches.
- Number-word parsing already understands Spanish and French counts such as
  `dos personas` and `deux personnes`.

Extra hardening added:

- Spanish/French companion-pair phrases now infer 2 guests:
  - `para mi y mi amigo`
  - `somos dos`
  - `pour moi et mon ami`
  - `nous sommes deux`
- The guest-count likelihood helper now runs after multilingual number-word
  normalization, so `dos personas` and `deux personnes` are treated correctly.
- The casual-reply guard now catches Spanish/French accidental booking-field
  prompts, so a casual greeting should not turn into a sudden request for
  nationality, phone, dates, room type, or guest count.

Parser smoke covered:

- Spanish pair, Spanish `somos dos`, Spanish word count, Spanish numeric count.
- French pair, French `nous sommes deux`, French word count, French numeric
  count.
- Spanish/French casual booking-field guard.

Remaining note: English and Arabic received the full live 20+ message production
QA. French and Spanish are now structurally supported and parser-smoked, but
they should still get a future live end-to-end conversation test before calling
them fully production-scored at 9+/10.

## 2026-06-25 Follow-Up: Reservation Memory Gaps

After reviewing the latest Ahmed/Sara and Arabic Ahmed/Hana/Aisha production
chats, the biggest remaining problems were not tone; they were routing and
state-memory edges:

- Arabic distance wording such as `... للحرم` could be missed during final
  review, so the bot repeated the final booking prompt instead of answering the
  hotel fact.
- Meal/food questions could fall through to the cancellation policy when the
  hotel did not have a matching meal policy row.
- A guest saying `اكد الحجز` or simply confirming after a side question could be
  forced through another redundant final prompt if the previous bot message had
  no quick-reply button.
- First-turn requests with dates plus a clear guest count needed to infer the
  matching room type and move toward quote/review instead of asking the guest to
  repeat the room choice.
- Arabic final reviews should display normalized nationalities in Arabic, for
  example `مصري`, not English `Egyptian`.

Hardening added:

- Selected-hotel meals are now a first-class fact question, separate from
  cancellation/refund policy.
- Hotel-policy lookup no longer defaults to cancellation when the latest
  policy-like question has no matching policy row.
- Final-review state can answer direct selected-hotel fact questions while
  preserving the reservation state.
- Final reservation creation accepts clear typed confirmations in the final
  state, including Arabic `اكد الحجز`, even after a side fact answer.
- Direct reservation start now infers the active room type from clear guest
  counts when the selected hotel has that matching active room.
- Arabic nationality display was localized for current-memory replies and final
  reservation review.

Private smoke covered:

- Arabic meal question does not answer cancellation/refund.
- Arabic `restaurants nearby?` style questions remain local-area questions, not
  in-hotel meal questions.
- Arabic `ممكن اعرف المسافة قد ايه للحرم` is detected as a distance question.
- Arabic final review shows `مصري` for Egyptian nationality.
- Arabic final `نعم` and `اكد الحجز` are accepted in final-review state.
- Arabic first-turn booking text with `٤ افراد` maps to 4 guests and
  `quadRooms`.
- English meal question does not answer cancellation/refund.
- English `What rooms do you guys have?` stays a room-list question.
- English `room for 2 individuals` maps to `doubleRooms`.
