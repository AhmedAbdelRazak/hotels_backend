# Hotel OpenAI knowledge synchronization worker

## Safety boundary

`hotel-openai-sync` is a separate Node/PM2 process. The PMS API does not call or
await OpenAI. Hotel, room, calendar, pricing, policy and reservation writes keep
their existing request path.

The worker writes only:

- its own sync, cleanup and checkpoint collections; and
- the hidden `HotelDetails.openaiKnowledge` field, with Mongoose timestamps
  disabled.

OpenAI failures remain in the sync-job collection. They never roll back or fail a
PMS request, and the currently ready vector stays active until a replacement has
finished indexing, passed search verification and won the Mongo compare-and-swap.

## Enrollment

A hotel is synchronized only when one of these explicit gates applies:

- `openaiKnowledge.autoSyncEnabled` is `true`; or
- its ID is listed in `HOTEL_OPENAI_KNOWLEDGE_HOTEL_IDS`.

An existing vector ID alone does not enroll a hotel. A newly uploaded hotel is
enrolled by the manual sync command unless `--disable-auto-sync` is supplied.

The worker also requires the hotel to satisfy the same core publication rules as
the public hotel list: active hotel flags, photos, non-zero coordinates, and at
least one active, photographed room with a positive base price. An enrolled hotel
that stops satisfying those rules is retired from AI serving, and its old OpenAI
resources are removed after the cleanup grace period.

## Runtime behavior

1. Non-blocking Mongoose post-commit hooks enqueue the exact changed hotel after
   `save`, `updateOne`, `updateMany`, `findOneAndUpdate`/`findByIdAndUpdate`, or
   `replaceOne`. The known distance `bulkWrite` path is explicitly covered too.
2. A durable per-hotel job is upserted; rapid edits are coalesced for eight seconds.
3. The worker reloads the latest hotel and compares a stable content hash.
4. Unchanged content performs no OpenAI upload.
5. Changed content is uploaded to a candidate vector store and polled until ready.
6. A generic retrieval search verifies the candidate.
7. MongoDB atomically swaps only `openaiKnowledge`, provided both the hotel
   `updatedAt` and prior vector version still match.
8. The superseded store/file is queued for delayed, retryable cleanup.

Leases recover jobs after a crash. Startup/hourly reconciliation repairs the rare
case where the API process exits after committing a hotel update but before its
non-blocking queue write. The daily change in the Asia/Riyadh coverage start is
naturally detected by hourly reconciliation.

Mongo change streams are optional because the current database connection does
not expose a replica set. They remain disabled by default; route/model post-commit
triggers are the primary event source.

## Commands

Focused safety checks:

```bash
npm run test:ai-hotel-vector
```

One-shot reconciliation (useful before enabling the continuous process):

```bash
npm run ai:hotel-vector:worker:once
```

Continuous local worker:

```bash
npm run ai:hotel-vector:worker
```

Production PM2 process, from the backend directory:

```bash
pm2 start ecosystem.hotel-openai-sync.config.js
pm2 save --force
pm2 status hotel-openai-sync --no-color
```

The worker must remain a single PM2 instance. Database leases still protect crash
recovery, but one instance keeps OpenAI upload/cleanup ordering intentionally
simple.

## Optional environment controls

- `HOTEL_OPENAI_KNOWLEDGE_HOTEL_IDS`: comma-separated explicit hotel IDs.
- `HOTEL_OPENAI_KNOWLEDGE_HORIZON_END`: fallback `YYYY-MM-DD` horizon for a newly
  enrolled hotel that has no saved coverage end.
- `HOTEL_OPENAI_KNOWLEDGE_DEBOUNCE_MS`: default `8000`.
- `HOTEL_OPENAI_KNOWLEDGE_POLL_MS`: default `1500`.
- `HOTEL_OPENAI_KNOWLEDGE_LEASE_MS`: default `300000`.
- `HOTEL_OPENAI_KNOWLEDGE_RECONCILE_MS`: default `3600000`.
- `HOTEL_OPENAI_KNOWLEDGE_CLEANUP_GRACE_MS`: default `3600000`.
- `HOTEL_OPENAI_KNOWLEDGE_INDEX_TIMEOUT_MS`: default `300000`.
- `HOTEL_OPENAI_KNOWLEDGE_API_TIMEOUT_MS`: default `60000` for each individual
  OpenAI API request.
- `HOTEL_OPENAI_KNOWLEDGE_CHANGE_STREAM_ENABLED`: default `false`; enable only on
  a verified Mongo replica set. Post-commit triggers work without it.

For already-enrolled hotels, the saved per-hotel `coverageThrough` remains the
authority unless an environment fallback is explicitly supplied.
