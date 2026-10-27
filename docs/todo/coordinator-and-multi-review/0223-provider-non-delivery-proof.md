# Provider proof that a prompt never arrived

Checked against `main` at `93018933` (2026-10-26). Code items done on
2026-10-27 against `main` at `863b5782`; recovery review fixes and live
qualification evidence are recorded below. Cursor and Grok qualification
remain open.

Split out of
[0112-review-fanout-dispatch-recovery.md](0112-review-fanout-dispatch-recovery.md),
whose first item asked the fan-out to re-send a recovered `dispatching`
request under the same id "when the provider says it never arrived". No
provider could say that soundly, so 0112 parked such a request and failed it
closed instead. This file held the provider work that lets it be re-sent, and
an at-most-once gap in Build Pipeline's same-id redispatch that the same survey
found.

## Current state

- `ProviderDispatchStatus` is `dispatched | pending | unknown | lost | absent`
  (`apps/backend/src/core/agent-provider-contract.ts`), and the bridge wire
  type `BridgePromptDispatchStatus` (`packages/protocol/src/native-agent.ts`)
  gained `absent`. `HttpBridgeProvider.dispatchStatus` maps it; an older
  backend reads it as `unknown`, and an older bridge never sends it.
- **All five HTTP bridges answer `absent`**, only while the session's journal
  is complete and holds no record of the id. OpenCode (backend-side provider)
  never does. The durable rule is in
  [`bridges/AGENTS.md`](../../../bridges/AGENTS.md) and
  [platform inconsistencies](../../architecture/platform-inconsistencies.md);
  each bridge's `AGENTS.md` names its marker.
  - **Claude:** `dispatchJournalComplete` in memory and in the session
    preferences beside `dispatchedRequestIds`. Set for a fresh random-id
    session, for a client-key session with no preferences file, or restored
    from a file that says so; cleared for good when the 64-id bound drops an
    id, or when parsing drops an entry. Answered for a resident session
    (`dispatchJournalProvesAbsent`) and for one not yet registered after a
    restart (`persistedDispatchStatus`, file read only).
  - **Cursor, Pi, ACP:** `promptJournalComplete` on the session record, set
    only when `createSession` makes a new session (never on resume, fork or
    `session/load` adoption), restored only from a record whose journal came
    back whole, and cleared on eviction (and, for ACP, when an entry exceeds
    the journal byte budget). Each also answers `unknown` while a prompt claim
    is open or the id is not in the form the prompt route stores.
  - **Codex:** a `completeness` block in the process-wide journal file:
    fresh-session markers (256, oldest first) and a fixed 16 KiB Bloom filter
    of every id whose record was ever removed, or that was steered. A journal
    file written by an older bridge stays untracked for good. `/dispatch`
    stays read-only (no `thread/read`).
- **Structured Claude prompts take the durable claim** (item 3). Every prompt
  with a request id goes through `claimPromptDispatch`, so a restarted bridge
  refuses a resent structured id (410 `dispatch-outcome-lost`) instead of
  running it again.
- **The workflow runners re-send on `absent`** (item 2). `ReviewFanoutRunner`,
  the Multi Review step runner and Build Pipeline consolidation move an
  `absent` recovered `dispatching` request back to `prepared`; the next pass
  sends it again under the same id. A result for the exact request outranks
  `absent`, `lost`, and `unknown` in all recovery paths, including stage
  prompts, through the shared `provider-dispatch-recovery.ts` helper.
- **Build Pipeline's stage redispatch is at-most-once** (item 3). A
  `pendingPromptAttempt` gets `dispatchingAt` durably just before each send,
  and loses it when the send is refused before the prompt was written. An
  attempt with the mark is re-sent only on `absent`; new attempts also carry
  `dispatchVersion: 1`, so only a versioned, unmarked attempt is known to be
  prepared. Unversioned legacy attempts require reconciliation even without
  the mark, using their original `startedAt` for the deadline. An exact-request
  result or `dispatched`/`pending` settles the attempt as sent; otherwise `lost`
  fails the stage and anything else waits within the
  reconnect deadline and then fails closed. Recorded in
  [review preparation, "Dispatch recovery"](../../architecture/review-preparation.md#dispatch-recovery).

## Outstanding work

### Code

1. ~~**An `absent` dispatch answer.**~~ Done on 2026-10-27 (decisions 1–5,
   9–13). Tests: each bridge's new `*dispatch-absent.test.ts`
   (`bridges/cursor-bridge/src/http-dispatch-absent.test.ts`,
   `bridges/pi-bridge/src/dispatch-absent.test.ts`,
   `bridges/acp-bridge/src/acp-dispatch-absent.test.ts`,
   `bridges/codex-bridge/src/app-server-runtime-dispatch-absent.test.ts`),
   the Codex `dispatch-journal.test.ts` and `index-routes.test.ts`, the Claude
   `session-manager-lifecycle.test.ts` ("a complete journal proves an
   unclaimed id absent…", "a client-key session is complete only…", "the
   preferences parse drops the marker…"), `session-manager-persistence.test.ts`
   ("restores journal completeness only from a marked journal…") and
   `routes/session.test.ts` ("answers absent only from a resident session…");
   `http-bridge-provider.test.ts`; and the shared contract scenario
   `dispatch-probe-absent` (it replaces `dispatch-probe-unknown`), which all
   five bridges pass. The real-bridge test
   `apps/backend/tests/claude-cold-dispatch-restart.test.ts` now kills and
   restarts a real Claude bridge process: an unseen id answers `absent` from
   disk, its resend is accepted once and then answers `dispatched`, and the
   claimed id answers `lost` and is refused with 410.
2. ~~**Re-send on `absent`.**~~ Done on 2026-10-27 (decisions 6 and 7). The
   interleaving harness has a provider that answers `absent` for an id it
   never took and is not mid-send, lets a crash leave a send on the wire to
   land later, and deduplicates any second delivery of an id
   (`provesAbsence`); the "a provider that proves an id never arrived" suites
   run the restart and chaos flavours with it and require an `absent` answer,
   a late delivery and a deduplicated one among their seeds. A sweep of seeds
   1–400 in all five flavours with it broke no invariant and deduplicated 40
   deliveries; with the fan-out's `absent` branch disabled, 9 of those suites'
   tests fail. Tests: `review-fanout-dispatch.test.ts` ("an absent request is
   re-sent once under the same id…", "a result for the exact request outranks
   an absent answer"), `multi-review-service.test.ts` ("`prepare`/`consolidate`/
   `fix` re-sends a recovered dispatch the provider proves never arrived,
   once"), `build-pipeline-result-reminder.test.ts` ("consolidation re-sends a
   recovered dispatch the provider proves never arrived, once").
3. ~~**Make Build Pipeline's same-id redispatch at-most-once.**~~ Done on
   2026-10-27, both halves (decision 8). Tests:
   `build-pipeline-service-recovery.test.ts` ("a stage prompt is marked
   durably before it is sent, and cleared when refused", "does not resend a
   stage prompt the provider cannot prove never arrived", "fails a stage
   prompt whose acceptance stays unconfirmed past the deadline", "fails a
   stage prompt the provider lost in a restart…", "settles a stage prompt the
   provider confirms…"); the existing same-id retry cases now run against a
   scripted provider that proves absence. Claude: the route test "forwards a
   structured schema and stable request id" asserts the claim.

4. **Recovery review regressions addressed on 2026-10-27.** Structured Claude
   preparation stopped before launch now rejects its startup promise and rolls
   back the durable claim. `routes/session-dispatch-cancellation.test.ts`
   holds real query preparation and separately stops and deletes the session,
   asserting settled HTTP requests, zero SDK query starts and claim rollback.
   Backend regressions cover legacy pending attempts with `unknown`, `lost`,
   `dispatched`, and `absent`; the legacy deadline; a dispatch mark reloaded
   through fresh storage and service instances; and same-id tool and structured
   results overriding contradictory journal answers for Multi Review prepare,
   consolidate and fix, Build Pipeline consolidation, and stage prompts.
   `provider-dispatch-recovery.test.ts` also checks mismatched request ids and
   failed reads do not manufacture proof.

### Qualification

Live checks ran on 2026-10-27 in disposable `dev:test` profile
`qa-dispatch-0223-review`, with a fixture local environment and explicitly
authorized Claude, Codex, Pi, Cursor and Grok credential sources. Grok seeding
was refused because its host login had expired. Each passing check:

1. Created a fresh session and observed `absent` for an unseen id.
2. Received an authenticated reply to a unique prompt, stopped that bridge
   through `stop_local_*_server_cmd`, and restarted it through the matching
   start command.
3. Retried the accepted id after restart and counted exactly one user prompt.
4. Observed `absent` for the unseen id after restart, sent it, received the
   authenticated reply, and retried that id. Its dispatch became `dispatched`
   and the transcript still contained exactly one user prompt.

| Provider | Live result |
| --- | --- |
| Claude 2.1.309 | Passed. Accepted id restored as `lost`; retry refused. The absent id ran once and its retry was deduplicated. |
| Codex 0.164.0 | Passed. Accepted id restored as `dispatched`; retries deduplicated. |
| Pi 1.4.0 | Passed. Accepted id restored as `dispatched`; retries deduplicated. |
| Cursor | Incomplete. Bridge reported signed-in and the fresh id was `absent`, but the first send returned HTTP 500 (`AmbiguousPromptDispatchError`), before an authenticated reply or restart could be established. |
| Grok | Blocked. Profile credential seeding reported the host login expired; the first send was rejected for authentication. |

Only content-free statuses and prompt counts were retained. No credential,
prompt or transcript content was logged. Bridges were stopped after each
check; the disposable profile was stopped and reset afterwards. This live
check uses bridge process stop/start; the deterministic SIGKILL tests cover
the interrupted handoff. Remaining live checks stay batched with
[0031](../cross-cutting/0031-live-provider-and-platform-qualification.md).

## Constraints and rationale

- The fan-out invariants in
  [0027](0027-multi-review-scale-and-cost.md) apply: never re-send an
  ambiguous request under a new id, and fail closed when unsure.
- `absent` must be an assertion, never a default: a provider that cannot tell
  answers `unknown`, exactly as `dispatched` and `lost` are assertions today.
- A dispatch-status read must stay cheap and must not touch session liveness
  (the reconciler calls it). Every bridge's answer is an in-memory read, except
  Claude's for a session not yet registered after a restart, which reads its
  preferences file as the `lost` answer already did.

## Assumptions and decisions

1. **Which bridges answer `absent`.** Options: only the cleanest journals
   (Cursor, Pi); every bridge whose survey row allowed it; none (0112's
   choice). Chosen: all five HTTP bridges, each behind its own completeness
   marker, and never OpenCode. Why: a runner path with no producer is dead
   code, and Claude and Codex are the usual reviewers. Pros: the re-send works
   on every bridge. Cons: five markers to keep honest; the shared contract and
   each bridge's tests guard them.
2. **Threat model.** Options: also cover an OS crash (fsync every journal
   write) or only a bridge process restart. Chosen: a process restart, the
   same as the existing `lost` answer. Why: only Cursor fsyncs today, and an
   fsync on every Claude, Pi, ACP and Codex prompt adds latency for a power-loss
   case. Cons: after an OS crash an older file could still say "complete" while
   missing the newest id. Stated in each bridge's docs.
3. **Claude: completeness on creation.** Options: mark any fresh in-memory
   session complete; require a preferences read for client-key ids. Chosen:
   random ids are complete at once; a client-key id reads its preferences in
   `createOrRecoverSession` and is complete only with no file or a marked one,
   restoring the file's ids as lost. Why: a claim written before its turn
   reached the CLI leaves preferences but no rollout, and `createSession` used
   to start such a session with an empty journal (it would even have run that
   id again). Pros: also closes that gap. Cons: one file read on a first
   launch.
4. **Claude: encoding.** Options: a boolean always written; `true` only,
   cleared by writing `undefined`. Chosen: `true` only, beside every journal
   write. Why: `parsePreferences` whitelists fields, so any write by an older
   bridge drops it, and every turn start writes the in-flight mark through that
   path; a downgrade cannot leave a stale `true`. A parse that drops or
   truncates an id drops the marker too.
5. **Claude: deleted sessions.** A durably deleted client-key session (its
   rollout and preferences removed) that is created again starts complete.
   Options: tombstone deleted ids; accept. Chosen: accept. Why: deletion is a
   user action that removes the conversation, close paths never delete
   (invariant 13), and no workflow re-creates a reviewer or stage session
   under its old key and then asks about a request sent to the old one. Cons:
   the claim rests on that backend behaviour. The Cursor, Pi and ACP agents
   noted the same dependency for a lost state file.
6. **When the fan-out re-sends.** Options: send in the same pass; return to
   `prepared` and send next pass. Chosen: next pass. Why: admission
   (`beforeAdmission`) runs at the start of a pass only for reviewers that need
   evidence, and a `dispatching` reviewer does not. Pros: the resend goes
   through exactly the path of a first send. Cons: one pass of delay.
7. **Result proof versus `absent`.** Chosen: a result for the exact request
   still promotes the request to `sent` even when the provider says `absent`.
   Why: only that request's turn can produce it; a contradiction means the
   journal is wrong, and running the turn again would be the worse error.
8. **Build Pipeline: which half of item 3.** Options: the Claude durable claim
   alone; `absent`-only resend alone; both. Chosen: both. Why: the claim fixes
   Claude for every caller, but Pi, ACP and OpenCode could still run a resend
   twice after eviction or restart; the gate covers every provider. The mark
   is written just before the send (one extra save per stage prompt), not with
   the attempt, so attach and preparation failures stay retryable; a definite
   send failure clears it. An `unknown` answer waits within the existing
   reconnect deadline (5 minutes) and then fails closed. Pros: at-most-once on
   every provider. Cons: a provider that cannot prove absence (OpenCode, an
   older bridge, a Codex journal from before this change) now fails a stage
   after an ambiguous send instead of re-sending; older backends ignore the
   mark and re-send, as before.
9. **Claude: structured prompts through the claim** (answers the open
   question). The claim stores the id before `sendPrompt`, waits for the query
   to start, and answers a duplicate `already-processed`, as plain prompts do.
   `admitPrompt` now treats a claimed structured id as owned and skips its
   `structuredOutputRequestId` dedupe, which would otherwise have refused the
   claim's own turn; the structured-output slot and its dedupe are unchanged.
   Behaviour changes: a structured prompt is refused (409) while the
   preferences file is unreadable, exactly as a plain one; a resend after a
   restart is refused (410) instead of run. Build Pipeline depended on the
   old re-run only for the at-most-once gap this file fixes.
10. **Cursor and ACP: `/dispatch` racing an open claim.** Options: answer
    `absent` (the resend gets a 409 anyway); answer `unknown`. Chosen:
    `unknown` while a claim is open. Why: a 409 on the resend while the
    original still sends would fail a request that actually runs. Codex does
    the same with a per-id in-flight count.
11. **Pi: withdrawals that keep completeness.** A record removed because the
    attempt never reached Pi (a failed preparation or barrier write, a
    follow-up whose run ended first, `followUp` throwing before it queues, a
    preflight refusal) keeps the session complete, matching the route's
    existing same-id retry. Cons: Pi extensions' input handlers may already
    have seen the text in the last two cases; no run started. The Pi agent
    also fixed a real double delivery: two follow-ups under one id could both
    reach Pi, because the journal write came after the attachment reads.
12. **Codex: per-id filter, not a watermark.** Options: a journal watermark
    compared with each session's creation time; a bounded filter of removed
    ids. Chosen: the filter. Why: Codex session ids are deterministic from the
    client key, so a re-created session would answer `absent` for an id its
    previous life took once that record aged out; a watermark would also void
    every older session the first time any record aged out. Pros: only removed
    ids go `unknown`. Cons: about 22 KB per journal file, and slowly rising
    false positives (safe: more `unknown`) after roughly 14,000–20,000 removed
    ids per working directory. A journal file written before this change is
    untracked for good, so existing environments answer `absent` only in new
    working directories.
13. **Codex: steers and the double-send race.** Steered ids join the filter
    with an awaited write before `turn/steer`, so a steer now pays one journal
    write and is refused (409) when that write fails. The Codex agent also
    fixed a race where two prompts for one id could both write `turn/start`
    while the first was still creating the session's thread: the claim now
    re-checks for an active turn and an unchanged journal entry with no await
    in between.
14. **Shared contract scenario.** `dispatch-probe-unknown` (a fresh session
    answers `unknown`) became `dispatch-probe-absent` (a fresh session answers
    `absent`, never `dispatched` or `lost`); the incomplete-journal half is
    each bridge's own tests. The Codex contract test now loads the journal as
    the real bridge does at start.

## Open questions

- ~~Whether durable claims for Claude structured prompts change their
  structured-output dedupe in a way Build Pipeline depends on.~~ Answered on
  2026-10-27: they do not; see decision 9.

## Needs verification

- Complete Cursor and Grok live qualification once Cursor can complete its
  first prompt and a current Grok login can be seeded. Claude, Codex and Pi
  passed signed-in bridge restart checks above; deterministic fake-CLI checks
  remain separate evidence.
- Whether OpenCode deduplicates a `promptAsync` that reuses a message id.
  OpenCode still never answers `absent`, so nothing here depends on it.

## Related

- [0112-review-fanout-dispatch-recovery.md](0112-review-fanout-dispatch-recovery.md):
  the recovery rules this builds on.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md):
  where the live check is batched.
- [0059-claude-preference-lock-after-restart.md](../agent-engines/0059-claude-preference-lock-after-restart.md):
  a Claude bridge killed mid-write delays the re-send of an `absent` request
  until its preference lock ages out (safe, but slow).

## Replaces

- Nothing; split from 0112 item 1 on 2026-10-26.
