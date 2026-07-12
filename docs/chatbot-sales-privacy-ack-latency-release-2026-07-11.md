# Sales-first chatbot privacy, reservation acknowledgement, and latency release

Date: 2026-07-11 America/Los_Angeles (final QA completed 2026-07-12 UTC)

## Outcome

This release makes the hotel chatbot concise, sales-first, inventory-private,
and resilient when the guest sends a harmless acknowledgement while a
reservation is being created.

The GPT-5.5 planner remains the conversational brain. It understands the full
recent conversation, decides the next conversational action, speaks the guest's
language, and handles hotel questions and sales naturally. Deterministic backend
code remains responsible only where exactness or a database mutation is
required:

- calculate an exact price from the current PMS room and nightly calendar;
- validate the approved physical room mix;
- create, look up, or update a reservation;
- prevent disclosure of private hotel inventory; and
- stop a mutation when the guest sends a real correction before the insert.

An ordinary answer therefore uses one planner call. A second writer call is used
only after a tool result needs to be expressed to the guest. Network retry loops
and sequential model fallbacks are disabled; safe deterministic fallbacks handle
a failed or invalid model response without another long OpenAI wait.

## Incident that drove this release

The reported Arabic conversation had four connected failures:

1. `150 SAR` and nearby date numbers in a burst were allowed to contaminate the
   party-size parser.
2. The corrupted party then produced a stale four-room plan even after the guest
   explicitly said `غرفة واحدة`.
3. The response exposed total stock such as 35 six-bed rooms, 34 five-person
   rooms, and 25 quad rooms. A guest never needs those internal totals.
4. The bot showed several unsuitable choices instead of selling the smallest
   suitable room: one triple room for the guest, spouse, and child.

The long response also arrived after approximately 109 seconds. This was well
outside the desired conversational range.

## Correct behavior now

### Party and room understanding

- Price amounts and date fragments are not guest or child counts.
- Wife plus child is understood as two adults and one child.
- Arabic dual-child and child-age phrases preserve the real child count.
- An unnumbered plural such as "children" remains unresolved; the bot asks only
  for the missing count instead of guessing.
- A room-capacity question such as "is this enough for 3?" does not overwrite
  the booking party.
- A hotel-fact question such as "does the double room have parking?" does not
  alter the chosen room mix.
- An explicit latest correction such as "one room" repairs an older corrupted
  multi-room state.

### Sales-first recommendation

- One guest may be sold a real double room when there is no single room.
- Two adults and one child are offered one suitable triple room.
- Six guests asking for six beds resolve to Zad Ajyad's exact `Spacious Six-Bed
  Room`, not several smaller rooms, while that exact configuration is sellable.
- A suitable explicit room request is respected. Alternatives are not offered
  merely to make the guest choose.
- A comparison is shown only when the guest asks to compare or the requested
  configuration cannot satisfy the request. Guest-facing comparisons are capped
  at two useful choices.
- The response sells clearly and moves toward a reservation while asking only
  information that is actually missing.

### Large room requests

Physical room counts are enforced internally, but never disclosed as hotel
stock. If a guest requests more units of one configuration than the hotel owns,
the allocator uses every sellable unit of that configuration and fills the
remainder with the next suitable active configurations. The changed mix is
shown as the guest's proposed booking, and explicit approval is required before
review or creation.

The current production Zad Ajyad simulation for ten requested doubles produces:

- four double rooms;
- four triple rooms; and
- two quad rooms.

The two-night total in the tested calendar was SAR 1,500. The guest approved the
mix before the reservation path continued. A generic regression fixture also
proves the requested rule that five available doubles plus sufficient triples
becomes five doubles plus five triples.

The bot may say what is in the guest's proposed or confirmed allocation. It may
not say the hotel's total units, remaining units, raw stock, or sellable-unit
counts. This rule is applied recursively to model output, tool output, and quick
replies in English, Arabic, French, and Spanish.

## Pricing contract

Pricing remains exact and independent of model arithmetic:

1. Check-in is included and checkout is excluded.
2. Each occupied night uses that exact room configuration's positive calendar
   guest price.
3. When an in-coverage night has no calendar row and is not blocked, the exact
   room's `basePrice` is used with nothing added.
4. Cross-month stays are calculated night by night and then summed.
5. A mixed room allocation prices every room line independently.
6. An explicit blocked/closed night and a date beyond the published horizon fail
   closed.
7. Before reservation insertion, the backend reloads and revalidates the current
   exact quote and room mix.

Monthly vector averages are useful hotel knowledge and sales guidance. They are
not used as the authoritative final booking total. This preserves the requested
smooth OpenAI-led conversation without trusting a language model to perform the
money calculation.

## Reservation progress and harmless guest messages

When a confirmed reservation enters the slower create path, the server emits an
immediate localized progress status before it waits in the planner queue. The
SSR widget keeps that status visible until the final AI message or the guarded
expiry; normal local typing events do not erase it.

Harmless acknowledgements while creation is in flight include phrases such as:

- `OK`, `okay`, `sure`, and `take your time`;
- `تمام`, `حسناً`, `خذ وقتك`, and equivalent short acknowledgements.

Those messages do not interrupt the already approved reservation. Immediately
before every reservation insert, the create action rechecks messages that
arrived after confirmation:

- a harmless acknowledgement allows the approved insert to continue;
- an actual date, room, guest, price, or identity correction stops the insert;
  and
- split-stay creation repeats the guard before each period.

The final confirmation response is allowed to reach the guest even if a harmless
acknowledgement arrived after the original confirmation. A deliberately skipped
stale response is not emitted as a phantom socket message.

## Conversation quality rules

- Every guest turn receives a relevant answer unless it is a harmless in-flight
  acknowledgement already covered by the visible reservation progress state.
- Adjacent and non-adjacent semantic repetition is rejected. Critical exact
  facts such as prices, dates, room mixes, confirmation numbers, and links remain
  repeatable when the guest asks for them again.
- Deterministic fallback wording has multiple context-aware variants and does
  not cycle through the same robotic response.
- Hotel facts are answered directly and naturally. Compound questions validate
  every requested topic; a correct Nusuk answer cannot hide a missing bus answer.
- The booking checkpoint survives hotel-location, bus, Nusuk, meal, parking, and
  payment detours.
- Language matching, professional sales language, pay-at-hotel support, and the
  recommendation to pay online to secure the spot remain intact.
- The public administration contact remains `+1 (909) 222-3374` and
  `https://wa.me/19092223374` only where contact is appropriate. Saudi reception
  details remain restricted to the verified paid-reservation path.
- Reservation confirmation numbers, detail links, receipt links, and payment
  links are shown only when the corresponding workflow has produced them.

## OpenAI runtime and latency controls

- Guest-chatbot planner, NLU, analysis, and writer model family: GPT-5.5.
- Planner reasoning: medium for booking and complex turns.
- Writer/NLU/support reasoning: low where safe.
- Responses API: enabled.
- Current-hotel-only file search: enabled only for a ready vector store.
- SDK retries: zero.
- Sequential model fallback calls: disabled by default.
- OpenAI deadline: bounded to approximately 22 seconds by default and never
  configurable above 24 seconds through the chatbot timeout setting.
- Planner concurrency: bounded above one so an unrelated long case does not
  serialize every guest, while retaining a safe upper limit.
- Stable prompt policy receives the larger prompt budget, preserving priority
  rules and improving prompt-cache reuse.

If a model response violates exact price, date, room-count, stock-privacy, or
tool-result requirements, the existing tool result is expressed by a local
validated fallback. This is intentionally not another OpenAI round trip.

Official implementation guidance:

- OpenAI latency optimization:
  <https://developers.openai.com/api/docs/guides/latency-optimization#make-your-users-wait-less>
- OpenAI prompt caching:
  <https://developers.openai.com/api/docs/guides/prompt-caching#how-it-works>

## Hotel knowledge vectors and PMS isolation

The schema-v3 hotel vectors and independent sync worker documented in
`chatbot-openai-hotel-knowledge-gpt55-production-2026-07-10.md` remain intact.
The initial managed public set contains 11 active hotels, including Zad Ajyad.
Each vector contains public hotel facts, bilingual descriptions, exact room IDs,
display names, capacities, physical counts for internal allocation, base prices,
monthly summaries, and explicit blocked dates. It excludes reservations, guest
PII, credentials, private contacts, margins, and payment data.

The PMS save never waits for OpenAI. A successful HotelDetails mutation sends a
non-blocking post-commit notification for that exact hotel. The independent
single-instance worker builds and verifies a candidate vector, publishes it
atomically only when the source version still matches, and leaves the previous
ready vector active on any failure. Metadata writes are hidden, timestamp-safe,
and cannot be submitted by the PMS client.

This release does not change the PMS frontend. The `hotels_frontend` worktree is
deliberately untouched.

Final read-only production verification found:

- 11 hotels from the live public-list endpoint and the same 11 through the
  database public-eligibility filter;
- 11/11 managed vectors ready, searchable, and mapped to the correct hotel;
- current coverage from 2026-07-12 through 2027-04-15;
- Zad Ajyad at knowledge version 5 and the other ten hotels at version 2 after
  the daily coverage refresh;
- 11/11 source timestamps equal to the current HotelDetails timestamps and
  11/11 dry comparisons `unchanged`;
- no missing or extra managed hotel IDs, no pending/retry/failed sync jobs, and
  no worker error log; and
- exactly one online `hotel-openai-sync` process.

Zad Ajyad's public website currently shows four photographed configurations,
while its knowledge document correctly contains all five active positive-price
configurations, including the six-bed room. Hotel enrollment follows the public
hotel set; room knowledge follows the hotel's active, usable room data.

Existing enrolled hotels update automatically. A brand-new public hotel needs
one initial enrollment through the manual sync command or the managed hotel-ID
configuration. The public-versus-managed audit detects that condition; its
missing-managed list is currently empty.

## Validation evidence

### Deterministic and build gates

- Chatbot regression suite: 153/153 passed.
- Hotel OpenAI vector/sync safety suite: 24/24 passed.
- OpenAI Responses/file-search integration checks: passed.
- Live-QA runner cleanup/repetition/progress self-test: passed.
- Backend changed-file JavaScript syntax: passed.
- SSR production build: passed.
- Backend and SSR `git diff --check`: passed.
- Independent release diff audit: no blocker found before release.

The 153 checks explicitly cover the Khalifa price/child-count corruption, stale
one-room recovery, spouse/child parsing, capacity-question protection, room
amenity state protection, single-to-double sales, exact six-bed resolution,
large physical overflow, stock privacy, exact pricing/base fallback,
acknowledgement-safe creation, immediate progress recognition, model-call
bounds, no redundancy, hotel-fact checkpoints, payment/contact restrictions,
review-before-submit, and mutation-adjacent quote preservation.

### Ten-scenario production-grade live gate

Command:

```bash
node scripts/liveChatbotQa.js --production-release
```

Marker:

```text
codexqa-live-20260712-5bc4e27b-4e1e-4b9a-b8de-d18fdf646010
```

| Scenario | Turns | Average turn |
| --- | ---: | ---: |
| 9. Final review confirmation creates reservation | 5 | 17.412 s |
| 14. Burst messages processed after quiet wait | 1 | 18.407 s |
| 24. Ambiguous `03` becomes one triple for 3 guests | 1 | 12.478 s |
| 25. Single guest changes to spouse-child triple without stock leak | 2 | 19.787 s |
| 36. Bus, Nusuk, and location detours preserve review | 8 | 20.056 s |
| 38. Post-confirmation service facts do not reopen booking | 6 | 17.975 s |
| 39. Arabic Levant month and checkout-day-only quote | 1 | 13.306 s |
| 41. Arabic slash-message burst quotes all facts | 1 | 18.704 s |
| 43. Arabic price follow-up and requested comparison | 8 | 16.490 s |
| 44. Ten doubles use the approved physical mixed allocation | 7 | 20.275 s |

Overall acceptance result:

- scenarios: 10/10 passed;
- guest turns: 40;
- average turn: 18.292 seconds;
- p95 turn: 29.220 seconds;
- slowest turn: 37.264 seconds;
- required maximum average: 40 seconds;
- hard per-turn rejection limit: 60 seconds; and
- final marker cleanup: 0 support cases and 0 reservations remaining.

The runner freezes tracked IDs before cleanup, verifies exact marker ownership,
deletes only individually tracked test records, and rescans afterward. A PASS is
printed only after zero residue is proven.

## Changed runtime files

- `aiagent/core/actions.js`: mutation-adjacent guest revision callback.
- `aiagent/core/openai.js`: bounded timeout, zero retries, optional file-search
  suppression, metadata normalization, and no sequential fallback by default.
- `aiagent/core/orchestrator.js`: party healing, sales-first allocation, stock
  privacy, hotel-fact completeness, acknowledgement race protection, progress
  status, repetition protection, and simplified brain/tool routing.
- `controllers/supportcase.js`: passes the just-saved conversation and existing
  review snapshot directly to the scheduler so the reservation wait status does
  not require another MongoDB read.
- `scripts/chatbotRegressionChecks.js`: deterministic release safeguards.
- `scripts/liveChatbotQa.js`: canonical ten-scenario release gate, timing limits,
  message/quick-reply privacy scans, progress assertions, and exact cleanup.
- `jannatbooking_ssr/components/SupportWidget.js`: durable server-issued
  reservation progress status while the guest types or acknowledges.

## Operational release and rollback

Only `hotels-backend` and `jannat-ssr` are release targets. The PMS process and
`hotel-openai-sync` are not restarted for this chatbot release.

Before the backend restart, production must show no recent open AI case with a
pending/unanswered guest turn and no reservation action currently creating.
The check is repeated to avoid a race. Deployment uses a fast-forward-only pull,
explicit process names, health checks, and recent-log inspection.

Rollback is a normal Git revert of the release commit followed by rebuilding the
SSR and restarting only the affected chatbot processes. Do not use `git reset
--hard`, do not clean production untracked files, and do not delete broad test
data. The existing HotelDetails/vector metadata and PMS data require no rollback
for this release because their schema and processes are unchanged.
