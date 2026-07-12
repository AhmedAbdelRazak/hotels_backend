# Chatbot Initial-Introduction Restart Recovery - 2026-07-12

## Incident

Production support case `6a53ba0382e677a8cff5f3ac` was created at
`2026-07-12T16:00:03.413Z` for Zad Ajyad. The case stored the normal localized
system hold notice, but it never stored a customer-facing AI reply and was
closed at `2026-07-12T16:05:50.496Z` with `ai_idle_timeout`.

This was not an OpenAI, GPT-5.5, prompt, hotel-vector, pricing, or reservation
failure. The exact case never reached the AI queue. Its AI state remained null,
its reservation state remained empty, and no reservation document was linked
to it.

## Root cause

The single-hotel widget intentionally prefills a localized message such as "I
would like to ask about this hotel." The backend intentionally recognizes that
generated text and does not store it as a real guest turn. It instead schedules
a proactive hotel-reception introduction from the AI.

The full production host rebooted at approximately `2026-07-12T16:01:43Z`, and
the backend process started again at approximately `16:01:45Z`. The proactive
introduction was still an in-memory timer, so the reboot removed it before a
reply was persisted.

Two maintenance assumptions then combined:

1. Unanswered-turn recovery required a real guest conversation row, so it did
   not recognize an introduction-only case.
2. Idle close treated an AI-designated system-only case with no guest row as
   eligible to close, even though no customer-facing AI reply existed.

Production evidence at the close time showed `recovered: 0` and
`idleClosed: 1`. A read-only audit of the preceding 24 hours found this was the
only one of 12 AI client cases with this exact zero-AI-reply idle-close shape.

## Durable fix

Implementation commit:
`f607ac79d61ac68da6eeb24d13483909379fabe7`.

- Maintenance now distinguishes a real non-system, customer-facing AI reply
  from a system hold notice.
- An open AI case with no guest row and no customer-facing AI reply is a pending
  initial-introduction turn.
- That turn receives a stable `intro:<createdAt milliseconds>` recovery key and
  uses the existing atomic claim and retry-cap fields.
- Idle close cannot close an introduction-only case until a real AI reply has
  been persisted.
- Normal unanswered guest recovery, retry caps, duplicate prevention, and
  answered-chat idle close remain intact.
- The AI scheduler now returns an explicit success boolean so maintenance
  recovery metrics accurately report scheduled work.
- Startup still runs the normal immediate maintenance sweep. It also runs one
  recovery-only sweep after the configured stall window plus 250 ms, avoiding
  a possible one-minute delay for a case that was still too fresh during the
  immediate sweep.
- The startup sweep excludes recovery claims made by the new process. It may
  safely reclaim a claim whose timestamp is strictly before the new maintenance
  job started, covering an old process that crashed after claiming a turn.

## Verification

Local and production-host verification both passed:

- Syntax checks for the changed maintenance, orchestrator, and focused test
  files.
- `git diff --check`.
- 156 deterministic chatbot regression checks.
- Three focused maintenance integration tests covering:
  - atomic claim and scheduling of a missing initial introduction;
  - same-cycle protection against premature idle close;
  - exclusion of a claim created by the new process;
  - safe reclamation of a pre-start claim from an old process;
  - normal idle close after a real introduction;
  - unchanged unanswered-guest retry-cap behavior.
- Independent read-only code and production audits agreed on the root cause.
- Independent final diff review reported no blockers.

## Production rollout

- GitHub `origin/master` and production were verified at implementation commit
  `f607ac79d61ac68da6eeb24d13483909379fabe7`.
- Before restart, three guarded reads reported zero open AI cases, zero pending
  or unanswered AI turns, and zero reservations in `creating` state. The last
  two reads were performed immediately before restart.
- Only `hotels-backend` was restarted. Its PID changed from `1164` to `9011`.
- The PMS `hotels-frontend` process stayed on PID `1169`.
- `jannat-ssr` stayed on PID `1188`.
- `hotel-openai-sync` stayed on PID `4212`.
- Loopback and public chatbot health both returned `ok=true`, OpenAI enabled,
  GPT-5.5 for all configured chatbot model roles, Responses enabled, and
  current-hotel-only ready knowledge retrieval.
- The Zad Ajyad public hotel page and the PMS homepage both returned HTTP 200.
- The backend error log was not modified after the new process started; its
  displayed tail contained only historical pre-restart entries.
- The post-deploy guard again reported zero open AI cases, zero pending turns,
  and zero reservations in `creating` state.
- The reported case remained unchanged and closed; it was not reopened or
  rewritten. It still has one system row, zero AI replies, empty AI reservation
  state, and zero linked reservation documents.

## Safety and rollback

No PMS frontend, SSR frontend, hotel, room, vector, calendar, pricing, or
reservation code was changed for this incident. No support case or reservation
was created or deleted for production testing, and no production document was
rewritten.

If rollback is required, revert implementation commit `f607ac7`, fast-forward
production to the revert commit, rerun the regression gate, apply the active-chat
guard twice, and restart only `hotels-backend`. Do not reset the repository,
clean production untracked files, restart the PMS, or modify the reported case.
