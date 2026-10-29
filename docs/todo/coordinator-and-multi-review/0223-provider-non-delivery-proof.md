# Provider proof that a prompt never arrived

Checked against `main` at `93018933` (2026-10-26). Code items done on
2026-10-27 against `main` at `863b5782`; recovery review fixes and live
qualification evidence are recorded below. Cursor and Grok qualification
remain open.

## Task analysis (historical)

This analysis predates the completed code and live checks recorded below.
The current state and qualification evidence supersede its task statuses
and proposed choices; Cursor, Grok and OpenCode verification remain as
listed under Needs verification.

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Make Build Pipeline's same-id redispatch at-most-once** (item 3, plus the
   open question): stop a Claude structured stage prompt running twice after
   an ambiguous send and a bridge restart. Status: open.
2. **An `absent` dispatch answer** (item 1): let bridges that can prove an id
   never arrived say so. Status: open.
3. **Re-send on `absent`** (item 2): move a recovered `dispatching` request
   back to `prepared` and send it again under the same id. Status: blocked (on
   task 2).
4. **OpenCode same-id deduplication** (Needs verification): does OpenCode
   deduplicate a `promptAsync` that reuses a message id? Status: open.
5. **Live restart-resend check per bridge** (Qualification). Status: blocked
   (on tasks 1 to 3 and provider credentials; batched with 0031).

### 1. Make Build Pipeline's same-id redispatch at-most-once

**Problem.** A Build Pipeline stage prompt whose acknowledgement was lost is
re-sent under the same request id on every supervisor pass while the stage
session is not running. For a Claude structured-output prompt that has been
through a bridge restart, the bridge no longer knows the id, so the build or
fix turn runs a second time on the same worktree. This is the only item in
the file that can do harm today (a duplicated turn), not just fail a reviewer
closed.

**Context.** Found by the 0112 survey (0112 "Needs verification"). The fan-out,
Multi Review steps and Build Pipeline consolidation already ask `dispatchStatus`
and park; stage prompts do not. The open question (whether a durable claim
for structured prompts changes structured dedupe) belongs to this task.

**Investigation.** Still accurate.
`BuildPipelineSupervisor.dispatchPending`
(`apps/backend/src/core/build-pipeline-service-supervisor.ts:1723`) never reads
`dispatchStatus`; on `AmbiguousPromptDispatchError` it returns and keeps
`pendingPromptAttempt` (`:1844`), and the session pass calls it again whenever
the status is not `running` (`:568-579`) or after a restart with a sent
continuation (`:533-539`). The only `dispatchStatus` call in Build Pipeline is
consolidation (`build-pipeline-review-fanout.ts:854`). The current behaviour is
pinned by `build-pipeline-service-recovery.test.ts:672` ("retains the attempt
and retries the same request id after a lost response"). On the Claude side
the durable claim is still taken only when `outputSchema === undefined`
(`bridges/claude-bridge/src/routes/session.ts:908`); a structured prompt goes
straight to `sendPrompt` (`:986`) and is deduplicated only through the
in-memory `structuredOutputRequestId` (`session-manager-lifecycle.ts:258-261`),
which is not persisted. So the gap applies to stages whose result transport is
structured output, not `tool-v1` (a `tool-v1` prompt has no `outputSchema` and
does take the durable claim). On the open question: a durable claim would make
a restarted bridge restore the id into `restoredDispatchedRequestIds`, so the
route refuses it as lost (`restoredDispatchClaimLost`,
`session-manager-lifecycle.ts:279`) instead of running it; and the claim's
in-process `duplicate` answer (`routes/session.ts:948-953`) returns
`already-processed` with no structured payload, so the backend would have to
read the result through `structured-output` or the workflow result, as it
already does for consolidation.

**Decisions.**

- **How should `dispatchPending` decide whether to re-send?**
  - **Ask `dispatchStatus` first, as consolidation does: clear the attempt on
    `dispatched`/`pending` or a result for the id, fail on `lost`, park within
    the idle bound on `unknown`, and re-send only on a definite non-send
    (recommended).**
    - Pros: same rule as the three other runners (0112 decision 7); works for
      every provider without bridge changes; leaves room for `absent` later.
    - Cons: a reviewer-style "fails closed" now applies to stage prompts whose
      ack was merely lost, so a few pipelines that would have recovered by
      resending will fail instead until `absent` exists; the pinned test at
      `:672` has to change.
  - **Give Claude structured prompts the durable claim and keep the same-id
    resend.**
    - Pros: smallest backend change; dedupe then holds across restarts for
      Claude.
    - Cons: fixes Claude only (Pi and ACP evict, OpenCode has no durable
      journal); changes the duplicate answer for structured prompts, which
      callers must then read differently.
  - **Both.**
    - Pros: defence in depth; Claude structured prompts gain `dispatched` and
      `lost` answers that the parking rule can use.
    - Cons: the most work and two compatibility paths (an older Claude bridge
      without structured claims keeps answering `unknown`).
- **What does "a definite non-send" mean for the re-send branch?**
  - **Only a `ProviderUnavailableError` or `PromptRejectedError` before the
    prompt was written, never an ambiguous error (recommended).**
    - Pros: matches invariant 3 in 0027; no new state.
    - Cons: needs the attempt to remember which error it last hit, a new
      optional field on `PipelinePromptAttempt`
      (`packages/protocol/src/build-pipeline.ts:761`).
  - **Re-send whenever the provider answers `unknown`.**
    - Pros: no new field; keeps today's recovery rate.
    - Cons: `unknown` is exactly the case the survey showed can mean
      "delivered and forgotten", which is the bug.

### 2. An `absent` dispatch answer

**Problem.** No bridge can say "this id never reached me", so a recovered
reviewer whose send provably never happened fails after the idle bound
instead of running.

**Context.** 0112 decision 1 chose to park and fail closed rather than guess.
`absent` must be an assertion, never a default.

**Investigation.** `ProviderDispatchStatus` is now
`"dispatched" | "pending" | "unknown" | "lost"`
(`apps/backend/src/core/agent-provider-contract.ts:346`); "Current state" above
predates `pending` (added by 0112 decision 9). There is a precedent:
`ProviderSteerDispatchStatus` already has `absent` (`:351`). The per-bridge
facts still hold at HEAD: Claude keeps `MAX_DISPATCHED_REQUEST_IDS = 64`
(`bridges/claude-bridge/src/services/session-preferences.ts:151`); Cursor
`MAX_PROMPT_JOURNAL = 256` (`bridges/cursor-bridge/src/config.ts:137`); Pi
`MAX_PROMPT_JOURNAL = 256` with oldest-first eviction
(`bridges/pi-bridge/src/config.ts:168`, `prompt.ts:953`); ACP
`MAX_PROMPT_JOURNAL = 512` and `MAX_PERSISTED_PROMPT_JOURNAL_BYTES`
(`bridges/acp-bridge/src/acp-context.ts:892`, `:906`); OpenCode 64 reservations
per session (`packages/protocol/src/opencode-message-id.ts:17`). Codex's
`/dispatch` route (`bridges/codex-bridge/src/index.ts:1403`) reads only the
in-process journal and never answers `lost`; `reconcileFromThreadTurns`
(`sessions/dispatch-journal.ts:701`) is reached only through
`app-server-engine.ts:2776`, which does a `thread/read` with turns.

**Decisions.**

- **Is `absent` worth building at all?**
  - **Yes, but only after task 1, and only for Cursor first (recommended).**
    Cursor's journal is fsync'd and evicts settled records only, so
    "journal complete" is a small flag.
    - Pros: proves the wire shape and harness on the easiest bridge; the rest
      can follow on evidence.
    - Cons: a reviewer on any other provider still fails closed.
  - **Yes, on every bridge at once.**
    - Pros: uniform behaviour.
    - Cons: Codex needs a non-read-only route (attach plus `thread/read`) that
      breaks the "dispatch reads never re-attach" rule in `AGENTS.md`;
      OpenCode cannot answer soundly at all.
  - **No: keep failing closed and close this item.**
    - Pros: no compatibility work; the failure is rare (a crash between the
      durable write and the send).
    - Cons: those reviewers keep failing; the user must retry by hand.
- **How does a bridge know its journal is complete for a session?**
  - **A per-session "complete since" marker set when the session is created by
    this journal and cleared on any eviction, truncation or unclean load
    (recommended).**
    - Pros: an explicit assertion; easy to test; survives restarts when
      persisted with the journal.
    - Cons: one more persisted field per bridge, with its own downgrade
      handling.
  - **Never evict unresolved entries, and answer `absent` when no entry
    exists.**
    - Pros: no marker.
    - Cons: unbounded unresolved entries violate the bounds invariant (11);
      still wrong after a corrupt load.

### 3. Re-send on `absent`

**Problem.** Without a consumer, `absent` would be dead code (0112 decision 1).

**Context.** The interleaving harness
(`apps/backend/src/core/review-fanout-interleaving-support.ts`) would need a
provider that answers `absent` and deduplicates a late delivery of the same id.

**Investigation.** The fan-out's recovery branch
(`review-fanout.ts:1278-1291`) is the obvious place:
`recoveredDispatchAcceptance` (`:1897`) would gain an `absent` outcome that
moves the reviewer back to `prepared` through the same `commit(transition)`
(`:762`). Multi Review steps (`multi-review-service.ts:4009`) and consolidation
(`build-pipeline-review-fanout.ts:854-860`) have the same parking branch.

**Decisions.**

- **Which runners re-send on `absent`?**
  - **All four, together with task 1's Build Pipeline rule, in one change
    (recommended).**
    - Pros: one rule everywhere, which is what 0112 decision 5 aimed for.
    - Cons: a larger change and more tests at once.
  - **The fan-out only.**
    - Pros: smallest; the fan-out has the interleaving harness already.
    - Cons: the three other runners keep failing closed on the same evidence.

### 4. OpenCode same-id deduplication

**Problem.** The provider retries an ambiguous `promptAsync` with the same
`messageID` (`apps/backend/src/core/opencode-provider.ts:648`, `:684`), trusting
OpenCode to treat it as the same message. If OpenCode instead starts a second
loop, OpenCode prompts are not at-most-once either.

**Context.** OpenCode is pinned at 1.19.4 (`apps/backend/package.json:23`). Only
the client SDK is in `node_modules`; the server ships as a compiled binary in
the toolchain, so the question cannot be settled from this repository.

**Investigation.** The backend test
`opencode-provider-dispatch.test.ts:1753` ("a dropped acknowledgement stays
ambiguous and retries with the same message id") pins the client behaviour
against a fake, not the server. `dispatchStatus` (`opencode-provider.ts:732`)
proves delivery only from an exact transcript marker within the newest 64
messages (`OPEN_CODE_MESSAGE_HISTORY_LIMIT`, `opencode-message-id.ts:9`).

**Decisions.**

- **How to settle it?**
  - **Read the upstream server source at the pinned tag (the session prompt
    handler) and record the answer here (recommended).**
    - Pros: no credentials or live run; exact for 1.19.4.
    - Cons: needs a re-check on every OpenCode bump (0008 moves to 2.x).
  - **A live probe: send the same `messageID` twice to a real `opencode serve`
    in an isolated profile.**
    - Pros: observes the real behaviour, not a reading of code.
    - Cons: needs OpenCode credentials and spends a turn; it is a live
      provider run.

### 5. Live restart-resend check per bridge

**Problem.** The deterministic tests use fakes; nobody has watched a real
bridge refuse or deduplicate a resend after its own restart.

**Context.** Batched with
[0031](../cross-cutting/0031-live-provider-and-platform-qualification.md).

**Investigation.** The nearest existing proof is the real-bridge
`tests/multi-review-claude-bridge-restart.test.ts`, which restarts the real
Claude bridge process without a live model. No equivalent exists for the other
bridges.

**Decisions.**

- **Live run, or real-bridge tests?**
  - **Real-bridge restart tests per bridge (no model needed), with the live run
    kept only for providers whose dedupe lives in the vendor (OpenCode)
    (recommended).**
    - Pros: deterministic, runs in CI, no credentials; the dedupe under test is
      the bridge's journal, not the model.
    - Cons: one harness per bridge to write.
  - **One live run per provider through 0031.**
    - Pros: covers the whole stack.
    - Cons: needs every credential; cannot force the race on purpose, so a pass
      proves little.

Split out of todo 0112 (retired on 2026-10-29; see
[review preparation, "Dispatch recovery"](../../architecture/review-preparation.md#dispatch-recovery)),
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

- [review preparation, "Dispatch recovery"](../../architecture/review-preparation.md#dispatch-recovery):
  the recovery rules this builds on, moved there when todo 0112 was retired
  on 2026-10-29.
- [#1329](https://github.com/orkestrator-ai/orkestrator-v2/pull/1329): the change
  that fixed Build Pipeline's same-id stage re-send (item 3 above). The
  separate todo that first analysed it (coordinator-and-multi-review 0723)
  was deleted on 2026-10-28 as finished.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md):
  where the live check is batched.
- Todo 0059 (retired on 2026-10-28; the lock rule is in
  [agent-engines.md](../../architecture/agent-engines.md#claude-code), "Claude Code"):
  a Claude bridge killed mid-write delayed the re-send of an `absent` request
  until its preference lock aged out. A dead owner's lock is now taken over at
  once, and a lock held by a live owner answers a retryable 503.

## Replaces

- Nothing; split from 0112 item 1 on 2026-10-26.
