# 10 — Observe completion of a particular run

Status: Verified — Claude, Codex, OpenCode qualified; Pi, Cursor, Grok withdrawn as `unsupported`; see record.
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

`run get/wait` reports what happened to one request. It cannot be satisfied by
an idle environment, another tab's completion, a dropped connection, or a
provider's natural-language success claim. Waiting can resume from another CLI
process without altering or repeating execution.

## Owners and starting points

- [Native-agent protocol](../../../../packages/protocol/src/native-agent.ts).
- [Dispatch](../../../../apps/backend/src/core/native-agent-service-dispatch.ts),
  [projection](../../../../apps/backend/src/core/native-agent-service-projection.ts),
  and [reconciliation](../../../../apps/backend/src/core/native-agent-service-reconciliation.ts).
- [HTTP bridge provider](../../../../apps/backend/src/core/http-bridge-provider.ts)
  and [OpenCode provider](../../../../apps/backend/src/core/opencode-provider.ts).
- The bridge session/turn owners and step-05 public operation store.

## Work

1. Audit completion evidence separately for Claude, Codex, OpenCode, Pi, Cursor,
   and Grok. Record request → provider-session → provider-turn correlation,
   terminal events/snapshots, error/cancel outcomes, restart behavior, and whether
   the evidence survives a missed event. Use pinned code/types and required
   documentation; a shared HTTP route does not prove equal semantics.
2. Define durable correlation at dispatch admission/acknowledgement. Capture
   fast turns that finish before the acknowledgement returns, later provider ID
   materialization, and session resume/fork identity changes. A mutable "latest
   turn" pointer is not sufficient when another request can start immediately.
3. Project execution as pending, running, waiting-for-input, completed, failed,
   cancelled, or explicit interrupted/unknown where proof is missing. Keep
   dispatch uncertainty separate. State updates carry a revision and cannot
   move a terminal run backwards because a delayed earlier frame arrived.
4. Persist terminal evidence before advertising a terminal result. Complete
   backend-owned reconciliation even without CLI/UI subscribers. Inspect bridge
   activity/history through the existing non-touching paths; add a bounded
   request-result snapshot where activity alone cannot prove completion.
5. Make a provider capability conditional on the complete evidence path. If the
   adapter cannot prove completion after a disconnect/restart, expose that
   limitation and return unknown/unsupported. Do not paper over missing provider
   data by scanning prose, assuming all idle turns succeeded, or redispatching.
6. Implement `run wait ID --timeout …` with the shared bounded observer from
   step 07. Check an immediate snapshot, then poll with a bounded cadence and
   backoff. Coalesce backend provider reads for concurrent waiters. Do not hold
   one long gateway mutation open for the duration of a model turn.
7. Define observation results: terminal success/failure, interaction-required,
   unknown requiring recovery, deadline, signal, and connection failure. Default
   waiting returns interaction-required promptly with safe interaction IDs;
   an explicit option can continue waiting for another client to answer it.
   It must never auto-answer or mutate the provider state.
8. Timeout/Ctrl+C only stops observation. Preserve/print the run receipt and
   make subsequent `run get/wait` possible. Parent scripts can explicitly call
   session stop; interruption must not be reported as confirmed cancellation.
9. Ensure multiple overlapping sessions and subsequent turns cannot change the
   result of an earlier operation. Retain enough outcome metadata for the
   step-05 history contract while transcript pages expire independently.

## Verification

For each adapter contract, drive: completion before ack; delayed start while
environment is idle; two sessions; consecutive turns; question/approval; tool
error; cancellation; recovery; missed event; bridge/backend restart; and a dead
generation. Assert the exact request ID/result and submission count.

Use real persisted state for restart and a controlled provider for race timing.
Verify polling does not hydrate transcripts, refresh idle-detach timestamps,
or create one provider poll per CLI waiter. Test terminal regressions from
late frames and result expiry. Live qualification remains in step 14.

## Acceptance and handoff

- [x] Completion is positively correlated to the selected request.
- [x] State/results survive the documented restart and disconnected-client cases.
- [x] Missing provider evidence remains unknown/unsupported.
- [x] Wait deadlines/signals leave work running and recovery identity available.
- [x] Multi-session and fast-turn cases cannot produce false success.

Publish a provider completion matrix with evidence and limitations. If one
mapping fails qualification, withdraw that capability alone and preserve its
run evidence; do not downgrade uncertainty into successful idle status.

## Implementation record

Revision: working tree on `a9337716`, 2026-09-26.

- Observer: [`run-observer.ts`](../../../../apps/backend/src/core/public-api/run-observer.ts)
  settles a run only from evidence about its own request (dispatch journal,
  turn activity, per-request turn outcome, one coalesced provider read).
  Providers without a qualified mapping end `unknown`/`unsupported`.
- Qualification found that OpenCode reads idle both after a failed turn and
  just after a prompt is accepted. Both were settled as success. Fixed with a
  request-scoped `turnTerminalError` provider read (failed/aborted → failed,
  no finished answer → pending).

| Provider | Completion | Evidence |
| --- | --- | --- |
| Claude | qualified | live local + container runs, file assertion + follow-up |
| Codex | qualified | live local + container runs (model pinned) |
| OpenCode | qualified | live local ×2 + container after the fix; unit tests for failed/aborted/unfinished |
| Pi, Cursor, Grok | unsupported | not live-qualified; `capabilities` reports it |

- Waiting: `client-waits.test.ts` (exit 0 only on success, 6 interaction,
  7 unknown, 5 deadline keeps the receipt), `public-api-sessions.test.ts`
  (multi-session, consecutive runs).
