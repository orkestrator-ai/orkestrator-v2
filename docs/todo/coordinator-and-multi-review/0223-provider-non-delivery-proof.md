# Provider proof that a prompt never arrived

Checked against `main` at `93018933` (2026-10-26).

## Task analysis

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

Split out of
[0112-review-fanout-dispatch-recovery.md](0112-review-fanout-dispatch-recovery.md),
whose first item asked the fan-out to re-send a recovered `dispatching`
request under the same id "when the provider says it never arrived". No
provider can say that soundly today, so 0112 parks such a request and fails
it closed instead. This file holds the provider work that would let it be
re-sent, and an at-most-once gap in Build Pipeline's same-id redispatch that
the same survey found.

## Current state

- `ProviderDispatchStatus` is `dispatched | lost | unknown`
  (`apps/backend/src/core/agent-provider-contract.ts`). Neither assertion means
  "never sent": every bridge answers `unknown` for an id it has no record of,
  because "no record" can also mean delivered and then evicted, closed, lost
  or never saved durably.
- The fan-out (`ReviewFanoutRunner`), the Multi Review steps and Build
  Pipeline consolidation park an unconfirmed `dispatching` request until the
  idle-poll bound fails it ("dispatch acceptance could not be confirmed").
  The fan-out also fails a `lost` request at once and accepts a result for the
  exact request id as proof that it ran (0112).
- **Build Pipeline's stage prompts re-send under the same id.** A pending
  `pendingPromptAttempt` is redispatched with the same request id whenever the
  stage session is not running (`build-pipeline-service-supervisor.ts`,
  `dispatchPending`), trusting the bridge to deduplicate. That holds only
  while the bridge still has a record of the id:
  - **Claude never journals structured prompts durably.** The prompt route
    takes the durable claim only when `outputSchema === undefined`
    (`bridges/claude-bridge/src/routes/session.ts`, the
    `if (requestId && outputSchema === undefined)` branch); structured turns
    get only the in-memory record. After a Claude bridge restart a resent
    structured id is new to the bridge and runs again.
  - Pi evicts its 256-record journal oldest first whatever the state, ACP
    (Grok) evicts at 512 in memory and silently leaves a journal entry over its
    byte budget off disk, and OpenCode has no durable journal (its message id
    is derived from history, which `dispatchStatus` reads only 64 messages of).
  - Only an ambiguous acknowledgement followed by a bridge restart (or that
    many later prompts) reaches it, so it is rare; when it happens a build or
    fix turn can run twice on the same worktree.

Survey of each provider (2026-10-26, file references at `93018933`):

| Provider | Journal written before the prompt is handed over | Bounds | Could answer "never arrived" when |
| --- | --- | --- | --- |
| Claude | Plain prompts: yes (session preferences, last 64 ids, no fsync). Structured: no | 64 ids per session on disk; memory cleared on close | Plain prompts only, the session not deleted, fewer than 64 later prompts |
| Codex | Yes, and a failed write blocks the send (no fsync) | Terminal records dropped after 24 h or past 500 records / 1 MiB; unresolved never dropped | Via `thread/read`: no live `prepared`/`accepted` record for the id and no persisted `userMessage` with that `clientId`. The `/dispatch` route is read-only and attaches no thread today |
| Cursor | Yes, fsync'd | 256 records; only settled ones evicted | A state directory is set, the file loaded cleanly, the session is loaded, fewer than 256 later records |
| Pi | Yes (no fsync) | 256 records, oldest first, any state | As Cursor, and only while nothing was evicted |
| ACP (Grok) | Mostly; an entry over the byte budget is skipped | 512 in memory, any state; disk byte budget | Only if the byte budget was never reached and nothing was evicted |
| OpenCode | No durable journal | 64 reservations per session | Not soundly after a backend crash |

## Outstanding work

### Code

1. **An `absent` dispatch answer.** Add `absent` to `ProviderDispatchStatus`
   and the bridge wire type: "this provider can prove the id never reached it,
   and a send under it will be its first delivery". Answer it only where the
   table's condition holds, which needs each bridge to track whether its
   journal is complete for the session (loaded cleanly, never evicted or
   truncated an entry since the session began). Codex can use its existing
   `reconcileFromThreadTurns` lookup, but that is not a read-only route today.
2. **Re-send on `absent`.** In `ReviewFanoutRunner`, the Multi Review step
   runner and Build Pipeline consolidation, move an `absent` recovered
   `dispatching` request back to `prepared` and dispatch it again under the
   same id. The interleaving harness (`review-fanout-interleaving-support.ts`)
   then needs a provider that answers `absent` and deduplicates a late
   delivery of the same id.
3. **Make Build Pipeline's same-id redispatch at-most-once.** Either give
   Claude structured prompts the same durable claim as plain ones, or have
   `dispatchPending` re-send only on `absent`, and park like the fan-out
   otherwise.

### Qualification

- A live check per bridge that a resend after a bridge restart is refused or
  deduplicated rather than run twice: needs each provider's credentials
  (batched with
  [0031](../cross-cutting/0031-live-provider-and-platform-qualification.md)).

## Constraints and rationale

- The fan-out invariants in
  [0027](0027-multi-review-scale-and-cost.md) apply: never re-send an
  ambiguous request under a new id, and fail closed when unsure.
- `absent` must be an assertion, never a default: a provider that cannot tell
  answers `unknown`, exactly as `dispatched` and `lost` are assertions today.
- A dispatch-status read must stay cheap and must not touch session liveness
  (the reconciler calls it).

## Open questions

- Whether durable claims for Claude structured prompts change their
  structured-output dedupe in a way Build Pipeline depends on.

## Needs verification

- Whether OpenCode deduplicates a `promptAsync` that reuses a message id.

## Related

- [0112-review-fanout-dispatch-recovery.md](0112-review-fanout-dispatch-recovery.md):
  the recovery rules this builds on.
- [0723-build-pipeline-resend-without-dispatch-check.md](0723-build-pipeline-resend-without-dispatch-check.md):
  Build Pipeline's same-id stage re-send (task 1 and code item 3), split out.

## Replaces

- Nothing; split from 0112 item 1 on 2026-10-26.
