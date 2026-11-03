# Dispatches and control changes trigger an unlimited raw transcript read

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Capture the baseline**: measure bridge read bytes per prompt send before changing anything. Status: open.
2. **State-only read for `messageLimit: 1` callers**: stop reading the transcript for callers that want the phase or interactions. Status: open (depends on 1).
3. **State-only post-dispatch refresh**: make the refresh after dispatch, settle and retire read state only. Status: open (depends on 1).
4. **Pass `limit` through the raw read**: make `interactiveSnapshot` and `legacy` honour a limit for the callers that remain. Status: open (depends on 1).
5. **Re-check the duplicate row cache (TX-15)**: confirm the legacy and summary paths no longer cache the same rows in normal use. Status: open (depends on 3).

### 1. Capture the baseline

**Problem.** The report measured nothing, and the maintainer gated this work on numbers.

**Context.** Decided 2026-11-01 in 1202 task 1: structural tasks, including TX-2, need a baseline first.

**Investigation.** The method is 1202 task 1's. No baseline for this path was found in 1202.

**Decisions.** None: the decision was made in 1202, and the method is recorded there.

### 2. State-only read for `messageLimit: 1` callers

**Problem.** A caller asking for one message still gets a read of the whole transcript, because the limit is applied after the fetch.

**Context.** The provider has a cheaper route: the progressive state read uses `sessionStateSnapshot` (`apps/backend/src/core/native-agent-transcript-projection.ts:3099`).

**Investigation.** The callers are `apps/backend/src/core/index.ts:1280`, `control-mcp-tools.ts:1156`, `worker-question-relay.ts:116` and `worker-surface-runs.ts:293`. `getProjection` always forces a refresh (`native-agent-service.ts:1733`), and `refreshProjectionOnce` then calls `interactiveSnapshot` (`native-agent-transcript-projection.ts:4842`). In `http-bridge-provider.ts`, `interactiveSnapshot` (`:632`) calls `transcripts.legacy(sessionId)` with no limit (`:648`, `:771`). The body limit is 16 MiB (`http-bridge-progressive.ts:75`). Each refresh also fetches the MCP inventory (`native-agent-transcript-projection.ts:4871`).

**Decisions.**

- **What do these callers call?**
  - **A new read returning the session state view only (recommended).**
    - Pros: the report's fix; the callers read `turn.phase` and interactions, and the view exists.
    - Cons: `control-mcp-tools.ts` and `worker-surface-runs.ts` must be checked for what else they read from the projection.
  - **Keep `getProjection` and pass the limit down (task 4).**
    - Pros: one path.
    - Cons: still runs the composer, catalogue and MCP reads.

### 3. State-only post-dispatch refresh

**Problem.** Sending a prompt re-reads up to 16 MiB of rows that clients do not render from, because they use the summary path.

**Context.** The report says this read "mostly refreshes side caches".

**Investigation.** The fire-and-forget refreshes are in `native-agent-service.ts:2023-2121`, `native-agent-prompt-queue-dispatcher.ts:333` and `:355`, and `native-agent-session-operations.ts:713`, `:745` and `:779`. Other sites await and return the projection (`native-agent-service.ts:1779`, `:1822`; `native-agent-session-operations.ts:190-217`, `:359`, `:579`, `:687`), so they cannot simply drop the transcript.

**Decisions.**

- **How far to go?**
  - **Change the fire-and-forget sites first; leave those that return a projection for task 4 (recommended).**
    - Pros: nothing reads the result of these calls, so the only risk is the side caches.
    - Cons: fork, stop and control changes keep paying until task 4.
  - **Build the projection from the summary representation everywhere.**
    - Pros: removes the raw read altogether, and TX-15 with it.
    - Cons: `sync-v1` needs the whole history for `projectionHistory` until joined paging retires ([0385](0385-tx-10-joined-history-pages.md)).

### 4. Pass `limit` through the raw read

**Problem.** Callers that stay on `interactiveSnapshot` cannot ask for less.

**Context.** `legacy(sessionId, limit)` already supports `?limit=` (`http-bridge-transcript-reader.ts:41`), and `provider.messages` uses it (`http-bridge-provider.ts:567`). Every bridge reads the parameter.

**Investigation.** `interactiveSnapshot(sessionId)` takes no options (`http-bridge-provider.ts:632`), and the call at `native-agent-transcript-projection.ts:4843` passes none. `sync-v1` refreshes project up to the maximum window (`:5028`) to fill `projectionHistory`, so they must stay unlimited.

**Decisions.** None: pass the resolved `messageLimit` for non-`sync-v1` reads. A bridge that ignores the parameter still answers, and the projection bounds the result itself.

### 5. Re-check the duplicate row cache (TX-15)

**Problem.** The legacy and summary paths cache the same rows separately.

**Context.** The report's only fix for TX-15 is that fixing TX-2 removes most of it, which is why it shares this file.

**Investigation.** The row cache is keyed by `remoteSessionId` (`native-agent-projection-entries.ts:40`, `:206-207`). The legacy path passes `undefined` (`native-agent-transcript-projection.ts:5032`), and the summary path passes the provider session (`:2137`), so two entries are kept per row by design.

**Decisions.** None: this is a check after task 3; open a new item only if duplicates still matter.

## Current state

No part of the fix has landed. `getNativeAgentSession` no longer decodes the store (see [0230](0230-tx-4-lease-held-session-loads.md)), but the bridge read described here is unchanged.

## Constraints and rationale

- Decided 2026-11-01 (1202 task 1): baseline first.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): live events stay incremental, and a state-only read must not skip what an invalidation relies on.

## Needs verification

- Which side effects of a full refresh something depends on: the projection cache, composer selection persistence, the sync revisions. Each must be checked before task 3 lands.
- The real share of Claude sessions that reach large `/messages` bodies.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-2, TX-15)
- [1202 tasks 1 and 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0200](0200-tx-18-messages-fallback-limit.md): the same limit on the `/messages` fallback, which needs no baseline
