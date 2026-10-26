# Provider proof that a prompt never arrived

Checked against `main` at `93018933` (2026-10-26).

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

## Replaces

- Nothing; split from 0112 item 1 on 2026-10-26.
