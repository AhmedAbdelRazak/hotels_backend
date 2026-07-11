# Chatbot hotel knowledge, exact pricing, and GPT-5.5 production change

Date: 2026-07-10

## Outcome and scope

This change gives the guest chatbot one current OpenAI vector store per managed
public hotel, upgrades only the guest-chatbot model family to GPT-5.5, and keeps
all database mutations behind deterministic backend actions.

The PMS remains the source of truth. OpenAI retrieval helps the brain answer
hotel facts, room descriptions, room capacities, physical room counts, blocked
dates, and monthly estimated prices quickly. Retrieval never creates or updates
a reservation and never supplies the authoritative final total by itself.

The protected flow is:

1. The chatbot brain receives compact current hotel facts and may search only
   the current hotel's ready vector store.
2. For an exact stay price, the backend reloads the current PMS room and only
   the requested calendar dates from a timestamp-consistent snapshot, then
   calculates every occupied night.
3. The planner presents the exact quote. It remembers the conversation and must
   answer every guest turn without repeating an adjacent answer.
4. Reservation create/update remains a backend action. Immediately before the
   database mutation, the backend reloads and recalculates the create or update
   candidate inside the action. Any price, blackout, base, capacity,
   physical-count, room-ID, room-mix, settlement, or commission change returns a
   refreshed quote for explicit approval instead of silently writing stale data.

## Non-negotiable pricing rules

- A positive `pricingRate.price` for an occupied night is the exact guest
  nightly price.
- If an in-coverage date has no calendar row, the exact room's
  `price.basePrice` is used, with nothing added.
- `rootPrice`, default cost, margin, and commission are not added to the guest
  price.
- Check-in is included and checkout is excluded.
- Cross-month stays are calculated night by night and summed. A monthly average
  in the vector is sales guidance, not final arithmetic.
- An explicit blocked/closed/restricted/unavailable row, a black calendar row,
  or a non-positive guest calendar price blocks that night.
- Dates after the published pricing horizon are unavailable rather than guessed.
- The reservation action performs the same price calculation again before
  writing to MongoDB.
- A missing/non-positive internal root price falls back to the positive room
  settlement cost, or the guest price when no cost exists. This prevents a valid
  guest quote from producing a zero hotel settlement or inflated commission.

Example verified read-only against Zad Ajyad on 2026-07-10:

- Stay: 2026-07-25 through 2026-08-05, or 11 occupied nights.
- Current exact nightly prices: eleven nights at SAR 75.
- Exact current total: SAR 825 per room.
- Ten-room total: SAR 8,250.

If those PMS prices change, the next quote and the pre-create refresh use the new
values. The example is evidence for the tested snapshot, not a permanent price.

## Inventory and room-selection rules

Existing and historical reservation occupancy is deliberately ignored for this
chatbot's provisional recommendation rule. These limits remain strict:

- explicit blocked calendar nights;
- the published pricing horizon; and
- `totalSellableUnits` for the exact room configuration/room ID.

Every room configuration keeps its stable PMS room ID, display name, source PMS
type, canonical type, verified capacity, physical count, sellable-unit count,
and pricing unit. Two family-room configurations are never merged merely because
both use the broad `familyRooms` PMS category.

If a guest asks for more units than one exact configuration contains, the
allocator keeps all physical units of the requested configuration and fills the
remainder from the next suitable active configuration. It shows both the
requested and proposed mixes and requires explicit guest agreement before review
or reservation creation.

Examples:

- A hotel with five doubles and at least five triples: ten requested doubles
  become a proposal for five doubles plus five triples.
- Zad Ajyad currently has four doubles and four triples. Ten requested doubles
  become four doubles, four triples, and two quads. This read-only simulation
  returned zero unfilled rooms and required confirmation.
- One guest may use a double room when the hotel has no active single-room
  configuration.
- Six guests at Zad Ajyad resolve to the exact `Spacious Six-Bed Room`, room ID
  `6a4a84216022cd7f31729011`, capacity six, physical count 35, and base price
  SAR 100. The five-person family room remains a separate room ID.
- A room with zero configured units is documented but is not recommended.
- An ambiguous capacity is documented but excluded from automatic party-size
  recommendations until management clarifies it.
- Mixed-room quotes carry an exact per-room average nightly price, per-room stay
  total, room-line total, and grand total; one room type's price is never reused
  for another room type.

## Vector document schema v3

Each hotel document contains:

- `hotelId`, public URL, generated/source timestamps, timezone, schema version,
  and knowledge version;
- bilingual public name, description, address, location, distances, property
  facts, amenities/services, rating, and public policy Q&A;
- hotel-level inventory totals by exact room ID and canonical room type;
- for every room: stable ID, source and canonical type, bilingual name and
  description, capacity evidence, beds, amenities, views, physical room count,
  total sellable units, base nightly rate, pricing unit, monthly estimated rate
  summaries, and explicit blocked dates;
- clear rules stating that occupancy history is ignored, physical counts and
  explicit blackouts are enforced, missing calendar rows use base price exactly,
  and outside-horizon dates are unavailable.

Monthly estimates are calculated from each open date's effective guest price:
positive calendar price when present, otherwise exact base price. Blocked dates
are excluded. Each month also records minimum/maximum rate, open-night count,
blocked-night count, and the blocked-date list.

No reservations, guest PII, internal margins, credentials, private contact
numbers, or payment details are included in a hotel vector.

## Initial managed public-hotel set

The initial set is the 11 hotels currently returned by the public hotel list.
The table is from the schema-v3 PMS dry run.

| Hotel ID | Hotel | Room configurations | Physical rooms | Sellable units |
| --- | --- | ---: | ---: | ---: |
| `6a40b6a1a6efe70450536038` | zad ajyad | 5 | 102 | 102 |
| `68b74714fb50e159d48c714f` | zad al sad | 5 | 100 | 100 |
| `68da202900a070e8123c27c4` | zad al safa | 6 | 55 | 65 |
| `68b7dfc8fb50e159d48c9086` | zad al qimma | 3 | 60 | 60 |
| `68992107e8d36376f71dd373` | taaj alzahabiya | 4 | 90 | 90 |
| `68b7fe14fb50e159d48c9fc9` | zad al majd | 6 | 170 | 170 |
| `68bca932d0ce3198b51d0ba9` | zad al rehab | 5 | 86 | 86 |
| `66fa9542fda59d440898b0e9` | zad al hayah | 4 | 160 | 160 |
| `68bd161619587184618ae1a0` | wardat al kheir | 4 | 70 | 70 |
| `68d8131500a070e8123beacf` | durrah al hijaz hotel | 5 | 40 | 40 |
| `68bfe73b6d4d4b05e156835d` | zad al mashaer | 4 | 80 | 80 |

Zad Al Safa has more sellable units than physical rooms because one shared-room
configuration is sold per bed. Zad Al Hayah has one generic family configuration
whose capacity is not sufficiently explicit, so it fails closed for automatic
capacity matching. Durrah Al Hijaz has one active configuration with a declared
count of zero, so it cannot be allocated.

## Safe PMS-to-OpenAI synchronization

`hotel-openai-sync` is an independent, single-instance worker. The PMS request
does not call or await OpenAI.

After a successful hotel-details save or query update, a non-blocking post-commit
notifier enqueues that exact managed hotel. Rapid edits are coalesced. The worker
then:

1. Reloads the latest PMS document and builds a stable source hash.
2. Does nothing when content is unchanged.
3. Uploads changed content to a candidate vector store.
4. Waits for indexing and verifies retrieval on the candidate.
5. Atomically publishes the candidate only if the hotel timestamp and previous
   vector version still match.
6. Leaves the current ready vector active after any upload/index/search failure.
7. Queues the superseded file/store for guarded delayed cleanup.

The worker writes only its three dedicated job/checkpoint collections and the
hidden `HotelDetails.openaiKnowledge` subdocument. Metadata writes disable hotel
timestamps, so they do not masquerade as PMS content edits. The client update
controller strips `openaiKnowledge`, and the field is `select: false` by default.

Startup and hourly reconciliation recover the small window where the API could
exit after committing a PMS edit but before enqueuing it. A worker/OpenAI failure
cannot roll back or fail the PMS operation.

Guest-facing PMS hotel facts are read fresh on every brain turn. Exact pricing
loads base/count facts and filtered calendar rows with matching `updatedAt`
timestamps; a concurrent PMS edit causes one bounded retry and then fails closed
instead of producing a hybrid old/new quote.

## Saved MongoDB metadata

The hidden `openaiKnowledge` subdocument stores identifiers and state, not the
large knowledge JSON:

```json
{
  "provider": "openai",
  "autoSyncEnabled": true,
  "vectorStoreId": "vs_...",
  "vectorStoreName": "Jannat Booking - <hotel> - <hotelId> - v<version>",
  "files": [
    {
      "documentKey": "hotel_knowledge",
      "fileId": "file-...",
      "vectorStoreFileId": "...",
      "filename": "<hotel>-<hotelId>-knowledge-v<version>.json",
      "sha256": "...",
      "status": "ready"
    }
  ],
  "sourceSha256": "...",
  "documentSha256": "...",
  "schemaVersion": 3,
  "knowledgeVersion": 1,
  "status": "ready",
  "coverageFrom": "YYYY-MM-DD",
  "coverageThrough": "2027-04-15",
  "sourceUpdatedAt": "...",
  "generatedAt": "...",
  "indexedAt": "...",
  "syncedAt": "...",
  "lastError": ""
}
```

The exact production vector/file identifiers and versions are recorded in the
deployment evidence section after upload verification.

## OpenAI runtime configuration

Only chatbot traffic changes to GPT-5.5. Generic OpenAI workflows retain their
existing generic model settings.

- Planner/booking reasoning: GPT-5.5, `medium` reasoning.
- Writer, NLU, fact-support/analysis paths: GPT-5.5, `low` reasoning.
- Responses API enabled.
- File search enabled and restricted to the current hotel's ready/current vector
  store, with at most three results.
- The response thread resets when the model, hotel vector, or source fact version
  changes, preventing stale cross-version context.
- Responses `previous_response_id` continuation is disabled by default while the
  authoritative transcript is replayed. This prevents the same history from
  being supplied twice and growing quadratically; the brain still receives
  current Known facts and recent transcript context.
- A compact priority contract is placed at the retained head of the system
  prompt. Tests pass it through the real 28,000-character prompt cap and verify
  that pricing, horizon, physical inventory, no-redundancy, review/submit,
  payment, 909 contact, and restricted-number rules survive trimming.

Direct canary calls before deployment returned valid JSON. The first isolated
comparison returned:

- GPT-5.5 low: 5.891 seconds.
- GPT-5.5 medium: 4.813 seconds.
- Previous GPT-5.4-mini medium comparison: 5.191 seconds.

The final configured runtime canary returned GPT-5.5 medium reasoning in 2.646
seconds and GPT-5.5 low writer output in 2.281 seconds.

These small canaries show no immediate latency regression, but the production
10-scenario run is the acceptance gate for the requested 20–40 second guest-turn
range.

Official implementation references used for this change:

- GPT-5.5 model: <https://developers.openai.com/api/docs/models/gpt-5.5>
- Reasoning guidance: <https://developers.openai.com/api/docs/guides/reasoning>
- File search: <https://developers.openai.com/api/docs/guides/tools-file-search>
- Prompt caching: <https://developers.openai.com/api/docs/guides/prompt-caching>

## Preserved conversation and policy rules

- Planner/brain-first orchestration remains in place.
- Every guest turn must receive a new AI entry.
- Adjacent semantically repetitive replies are rejected and rewritten while
  exact facts, prices, dates, room counts, confirmation numbers, links, and
  contacts are preserved.
- The public administration contact remains `+1 (909) 222-3374` and
  `https://wa.me/19092223374` where a contact is appropriate.
- A Saudi reception/front-desk number remains restricted and may be disclosed
  only through the verified paid-existing-reservation path.
- A phone number is never treated as a reservation confirmation number.
- Pay at hotel remains allowed. Online payment is recommended, including an
  available partial payment, because completed payment fully secures the spot;
  it is not falsely described as mandatory.
- Language matching, concise sales framing, room facts, direct-booking value,
  confirmation numbers, reservation details links, and payment links remain
  protected.

## Final consent and large-inventory hardening

The final production pass added deterministic protection around the exact quote
and physical room plan:

- An official review stores a version-2 checkpoint containing exact stay dates,
  stable room IDs and counts, nights, total rooms, grand total, average price,
  currency, per-night prices, and room-line prices.
- Reservation submission is allowed only after the latest guest turn gives pure
  consent to that usable checkpoint. An older consent message cannot be reused.
- A confirmation combined with a question, correction, deferral, or payment
  question does not create a reservation. The question is answered and the
  guest must confirm again afterward.
- An arbitrary model-produced `submit_reservation` action cannot bypass the
  official review/checkpoint gate. Missing, malformed, legacy, or changed
  checkpoints fail closed and return to review.
- The exact guest-approved overflow mix remains locked across identity, email,
  payment, and hotel-fact turns. A question such as "Does the double room have
  parking?" cannot let model-proposed room fields replace that mix. Only a
  deterministic explicit room-change request unlocks it and requires a fresh
  quote/approval.
- Chat can safely process up to 200 total rooms in one request. A larger request
  is never silently truncated; it receives an explicit no-booking response and
  administration handoff. The create action independently enforces the same
  limit.
- Reservation serialization preserves one picked-room row per physical unit and
  validates the aggregate room count. This removes the old 50-room truncation
  risk while retaining a bounded safety ceiling.

## Validation before deployment

- Changed/untracked JavaScript syntax: 28/28 passed.
- Chatbot deterministic regression: 134/134 passed.
- Hotel vector/sync safety suite: 24/24 passed.
- OpenAI Responses/file-search integration checks: passed.
- Live-QA cleanup/redundancy offline safety self-test: passed.
- `git diff --check`: passed.
- Eleven public-hotel schema-v3 dry runs: 11/11 passed without MongoDB or OpenAI
  writes.
- Focused injected-loader checks passed immediate pre-insert revalidation for an
  unchanged quote and rejection for calendar price, blackout, base price,
  capacity, physical count, mixed-room count, and mixed-room total changes.
- Existing-reservation updates have the same mutation-adjacent reload barrier.
  If exact configuration, physical count, capacity, nightly price, total,
  settlement, or commission changes, no update is written and the guest is shown
  the refreshed total for renewed approval. A regression guard verifies that
  this path never claims the stale update succeeded.

The live QA runner uses a 48–96 character marker ending in a UUID v4, tracks exact
case/reservation ObjectIds, proves ownership before deletion, deletes one exact
document at a time, and verifies no tracked documents remain. It does not use a
marker regex or `deleteMany`.

## Deployment evidence

The guarded rollout completed successfully. Runtime validation finished on
2026-07-11 UTC (2026-07-10 America/Los_Angeles).

### Git and runtime release

- Branch: `master`.
- Initial hotel-vector/GPT-5.5 release: `a1e084e3bb728c2059957100683557fb2060a911`.
- Non-redundant review response hardening:
  `d31f473a05a0d4f2542c12217f839d02a114d321`.
- Exact reviewed-quote submission preservation:
  `5f0f38d5bc4f0352a13f6baade583f6d279cc8ad`.
- Final consent/physical-inventory release:
  `4b0ea4e898e2a32fb4b743b8934adb69fec4862c`.
- Local `master`, GitHub `origin/master`, and the production backend were all
  verified at the final runtime release SHA before this documentation-only
  synchronization.

The production health endpoint returned `ok=true`, `openai=true`, GPT-5.5 for
planner/reasoning/analysis/NLU/writer, `medium` planner reasoning, `low` writer,
NLU and analysis reasoning, Responses enabled, continuation disabled, and
current-hotel-only ready-knowledge retrieval with a maximum of three results.
Both the loopback and public HTTPS health endpoints passed.

### Eleven ready OpenAI hotel documents

All rows use schema version 3, status `ready`, and coverage through
`2027-04-15`. The verified coverage start was `2026-07-11` UTC. The OpenAI
vector-store file ID equals the uploaded file ID shown below.

| Hotel | Knowledge version | Vector store ID | File ID | Saved filename |
| --- | ---: | --- | --- | --- |
| zad ajyad | 4 | `vs_6a51b73c58808191800e10d5dc6d0aea` | `file-A7r3RBsV367F3zQYHT3Vwu` | `zad-ajyad-6a40b6a1a6efe70450536038-knowledge-v4.json` |
| zad al sad | 1 | `vs_6a51b6e87ddc8191895d8f728f393c01` | `file-Wd96M1pSd1RfsYVYgkSiYN` | `zad-al-sad-68b74714fb50e159d48c714f-knowledge-v1.json` |
| zad al safa | 1 | `vs_6a51b72fa9908191a7a0d537ccd620c1` | `file-3SQTkUBoYmJsyWCfo5rLat` | `zad-al-safa-68da202900a070e8123c27c4-knowledge-v1.json` |
| zad al qimma | 1 | `vs_6a51b6f1c79481919ed737a7c8bdb986` | `file-CreGD3EiLGEcGJJPLM2q47` | `zad-al-qimma-68b7dfc8fb50e159d48c9086-knowledge-v1.json` |
| taaj alzahabiya | 1 | `vs_6a51b6dac50881919bde6d99c0349147` | `file-D6pNwTpRLM4vZjNqdDzwZg` | `taaj-alzahabiya-68992107e8d36376f71dd373-knowledge-v1.json` |
| zad al majd | 1 | `vs_6a51b6fcacd48191914c5bc9ea5ca8f7` | `file-SkkfDxcYj1cVRZEgomPN8g` | `zad-al-majd-68b7fe14fb50e159d48c9fc9-knowledge-v1.json` |
| zad al rehab | 1 | `vs_6a51b70723dc8191a8f96eea08bf8d3c` | `file-4JvmccGxixAVjJ7jtmdbpA` | `zad-al-rehab-68bca932d0ce3198b51d0ba9-knowledge-v1.json` |
| zad al hayah | 1 | `vs_6a51b6d0c0e88191b5c5132b2927d02f` | `file-NaHGSV7meyyz27TpQkLBxg` | `zad-al-hayah-66fa9542fda59d440898b0e9-knowledge-v1.json` |
| wardat al kheir | 1 | `vs_6a51b7118f3c81919a618c60867ff370` | `file-9LgiwCqSsutkQ3bWR3E5vj` | `wardat-al-kheir-68bd161619587184618ae1a0-knowledge-v1.json` |
| durrah al hijaz hotel | 1 | `vs_6a51b72517bc81919660ca8f78eb4f7a` | `file-1pUspksLxz4gwzZ5Gphnnt` | `durrah-al-hijaz-hotel-68d8131500a070e8123beacf-knowledge-v1.json` |
| zad al mashaer | 1 | `vs_6a51b71a9e4c8191b367ab55eb749580` | `file-GDhVz44w1QNae8V2JbDcX1` | `zad-al-mashaer-68bfe73b6d4d4b05e156835d-knowledge-v1.json` |

### Live production QA

Scenario 44 separately tested the new physical-overflow and consent contract:

- Request: ten double rooms for 20 adults, 2026-07-21 through 2026-07-23.
- Exact proposed/stored mix: four doubles (`6a40df5f1a6d1850eb25c183`),
  four triples (`6a40e0981a6d1850eb25c27c`), and two quads
  (`6a40e45a1a6d1850eb25c58b`).
- Exact two-night total: SAR 1,500.
- The guest approved the changed mix; a parking question preserved the exact
  mix; a pay-at-hotel confirmation question did not create a reservation; the
  later pure confirmation created exactly one reservation with ten matching
  picked-room rows.
- Result: 7/7 turns passed, planner-processing average 32,077 ms per turn.

The requested normal-timing production sweep produced:

| Scenario | Turns | Planner average ms/turn | Result |
| ---: | ---: | ---: | --- |
| 34 | 1 | 12,380 | PASS |
| 35 | 6 | 21,838 | PASS |
| 36 | 8 | 37,472 | PASS |
| 37 | 2 | 22,099 | PASS |
| 38 | 6 | 24,637 | PASS |
| 39 | 1 | 40,968 | PASS |
| 40 | 1 | 40,192 | PASS |
| 41 | 1 | 41,976 | PASS |
| 42 | 2 | 33,053 | PASS |
| 43 | 8 | 27,066 | PASS |

Scenarios 34-43 passed 10/10 over 36 guest turns. Their weighted average was
28,916 ms per turn. Including scenario 44, the final production acceptance set
passed 11/11 scenarios over 43 turns with a weighted average of 29,430 ms per
turn. These weighted values use the runner's raw `totalMs`, not multiplication
of the displayed rounded scenario averages. They measure planner processing and
exclude the runner's deliberate 3.15-second guest quiet window plus normal
queue/worker-launch overhead. Adding the known quiet window gives approximately
32.1 seconds for scenarios 34-43 and 32.6 seconds for the combined set, before
small queue/launch overhead. The measured processing and quiet-window estimate
meet the requested 20-40 second whole-chat average, while real guest-visible
latency can vary with queue load. Three isolated one-turn Arabic planner calls
measured 40.2-42.0 seconds; they are recorded rather than hidden.

### Production safety and cleanup verification

- Pre-restart guard: zero recent open client cases, zero unanswered guest turns,
  and zero reservations in `creating` state.
- Only `hotels-backend` restarted: PID `22388` became `25892`.
- `hotel-openai-sync` remained PID `24362`, `hotels-frontend` remained PID
  `1168`, and `jannat-ssr` remained PID `1182`.
- The vector-worker error log remained empty. The backend error log timestamp
  remained earlier than the deployment restart, proving no new backend error-log
  entry during the rollout or QA.
- Scenario 44 immediately deleted its one exact reservation and then its exact
  support case. Scenarios 35, 38, and 43 likewise deleted their exact test
  reservations before final case cleanup.
- Scenario-44 final cleanup: `remainingCases=0`, `remainingReservations=0`.
- Scenario-34-43 final cleanup: 10 exact cases deleted,
  `remainingCases=0`, `remainingReservations=0`.
- An independent read-only query after both runs found zero cases for either UUID
  marker and zero reservations related to all 11 exact test case IDs.
- No `deleteMany`, broad marker regex, production-history cleanup, frontend
  restart, PMS restart, or vector-worker restart was used.

## Rollback

The backend and vector worker are independent.

- Stop only `hotel-openai-sync` to stop future uploads; this does not affect PMS
  writes or the currently published vectors.
- Restore the chatbot-specific model environment variables and restart only the
  backend with updated environment to return chatbot traffic to the prior model.
- Revert the backend commit with a new normal Git revert if code rollback is
  needed. Do not use a destructive reset on production.
- Do not bulk-delete vector stores or files. A superseded resource is removed
  only by its exact guarded cleanup job after the grace period and only when it
  is no longer active.
