# E9: Transcript reads

This file combines 3 reports into one batch to build together. `0200` and `0110` link to `0150`.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0150](#0150-dispatches-and-control-changes-trigger-an-unlimited-raw-transcript-read) | Low | TX-2, TX-15: Dispatches and control changes trigger an unlimited raw transcript read |
| [0200](#0200-the-messages-fallback-ignores-the-limit-it-has-in-scope) | Low | TX-18: The `/messages` fallback ignores the limit it has in scope |
| [0110](#0110-a-tool-detail-cache-miss-cannot-recreate-remote-references) | Medium | TX-8: A tool-detail cache miss cannot recreate remote references |

## 0150: Dispatches and control changes trigger an unlimited raw transcript read

### Task analysis

#### Tasks

1. **Capture the baseline**: measure bridge read bytes per prompt send before changing anything. Status: open.
2. **State-only read for `messageLimit: 1` callers**: stop reading the transcript for callers that want the phase or interactions. Status: open (task 4 cut these reads to two rows; they still run the composer, catalogue and MCP reads).
3. **State-only post-dispatch refresh**: make the refresh after dispatch, settle and retire read state only. Status: done differently on 2026-11-04: those refreshes read a 32-row tail (`refreshProjectionState`); see 1202's Assumptions and decisions.
4. **Pass `limit` through the raw read**: make `interactiveSnapshot` and `legacy` honour a limit for the callers that remain. Status: done 2026-11-04.
5. **Re-check the duplicate row cache (TX-15)**: confirm the legacy and summary paths no longer cache the same rows in normal use. Status: open (depends on 3).

#### 1. Capture the baseline

**Problem.** The report measured nothing, and the maintainer gated this work on numbers.

**Context.** Decided 2026-11-01 in 1202 task 1: structural tasks, including TX-2, need a baseline first.

**Investigation.** The method is 1202 task 1's. No baseline for this path was found in 1202.

**Decisions.** None: the decision was made in 1202, and the method is recorded there.

#### 2. State-only read for `messageLimit: 1` callers

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

#### 3. State-only post-dispatch refresh

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

#### 4. Pass `limit` through the raw read

**Problem.** Callers that stay on `interactiveSnapshot` cannot ask for less.

**Context.** `legacy(sessionId, limit)` already supports `?limit=` (`http-bridge-transcript-reader.ts:41`), and `provider.messages` uses it (`http-bridge-provider.ts:567`). Every bridge reads the parameter.

**Investigation.** `interactiveSnapshot(sessionId)` takes no options (`http-bridge-provider.ts:632`), and the call at `native-agent-transcript-projection.ts:4843` passes none. `sync-v1` refreshes project up to the maximum window (`:5028`) to fill `projectionHistory`, so they must stay unlimited.

**Decisions.** None: pass the resolved `messageLimit` for non-`sync-v1` reads. A bridge that ignores the parameter still answers, and the projection bounds the result itself.

#### 5. Re-check the duplicate row cache (TX-15)

**Problem.** The legacy and summary paths cache the same rows separately.

**Context.** The report's only fix for TX-15 is that fixing TX-2 removes most of it, which is why it shares this file.

**Investigation.** The row cache is keyed by `remoteSessionId` (`native-agent-projection-entries.ts:40`, `:206-207`). The legacy path passes `undefined` (`native-agent-transcript-projection.ts:5032`), and the summary path passes the provider session (`:2137`), so two entries are kept per row by design.

**Decisions.** None: this is a check after task 3; open a new item only if duplicates still matter.

### Current state

Tasks 3 and 4 landed on 2026-11-04 without the baseline, at the ticket's request: no read other than `sync-v1` is unlimited now, and a refresh whose result is dropped reads a 32-row tail. `getNativeAgentSession` no longer decodes the store (see [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) task 2).

### Constraints and rationale

- Decided 2026-11-01 (1202 task 1): baseline first.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): live events stay incremental, and a state-only read must not skip what an invalidation relies on.

### Needs verification

- Which side effects of a full refresh something depends on: the projection cache, composer selection persistence, the sync revisions. Each must be checked before task 3 lands.
- The real share of Claude sessions that reach large `/messages` bodies.

## 0200: The `/messages` fallback ignores the limit it has in scope

### Task analysis

#### Tasks

1. **Pass the limit to the fallback read**: request only the rows the caller will keep. Status: open.

#### 1. Pass the limit to the fallback read

**Problem.** When `/transcript` is unavailable, the fallback reads the whole `/messages` body (up to 16 MiB) and then slices it to the limit it already knew.

**Context.** This path stays until the support window passes a release whose Claude bridge materialises sessions on `/transcript` (see the comment in `readHttpBridgeTranscriptSnapshot`). A small fix, with no baseline needed under the maintainer's hybrid rule in 1202 task 1.

**Investigation.** `apps/backend/src/core/http-bridge-transcript-reader.ts:66` passes `readLegacy: () => this.legacy(sessionId)`, though `legacy` takes a `limit` (`:41`) and `options.limit` is in scope. The fallback slices afterwards (`http-bridge-progressive.ts:119-122`), so a bridge that predates `?limit=` still gives the right answer. Claude, Codex, Cursor, Pi and ACP all parse the parameter (for example `bridges/claude-bridge/src/routes/session.ts:704`).

The `complete` flag needs care. It is `!legacy.truncated && legacy.messages.length <= limit` (`http-bridge-progressive.ts:123`). Today a longer transcript fails the length check. With the limit passed, the length check always succeeds, so `complete` depends on the bridge setting `messageWindow.truncated` when the limit cut rows.

**Decisions.** None: the change is one argument, once the check below has passed.

### Constraints and rationale

- A wrong `complete: true` would make a client treat a tail as the whole history, so the check in Needs verification must come first.

### Needs verification

- That each bridge sets `messageWindow.truncated` when `?limit=` cuts rows. The route code was read, but the flag was not traced through every bridge's window helper.

## 0110: A tool-detail cache miss cannot recreate remote references

### Task analysis

#### Tasks

1. **Recover remote details without the raw sync read**: on a miss, resolve from registered remote details or the direct page cache, otherwise run a summary read. Status: open.

#### 1. Recover remote details without the raw sync read

**Problem.** When a detail reference has been evicted, the backend runs a whole `sync-v1` refresh to rebuild it. For a summary-backed session that refresh cannot produce the reference, so it costs a full raw transcript read and the request still fails with "no longer available".

**Context.** Summary rows carry a locator, and their references are minted by `cacheRemoteToolDetails` from a hash that includes the locator. Raw rows have no locator and get a reference hashed from their body. The two hashes never match.

**Investigation.** `getProjectionToolDetails` (`apps/backend/src/core/native-agent-transcript-projection.ts:4175`) calls `refreshProjection` with `representation: "sync-v1"` on a miss (`:4194`) and throws at `:4205` if the entry is still absent. That refresh passes `undefined` for `remote` to `projectionMessages` (`:5025-5032`), while the summary path passes the provider session (`:2130-2138`). `projectionPart` mints a remote reference only when `remote` is set and the part has a summary detail (`:990-991`). The hashes are at `:808` (local) and `:852` (remote).

Two pieces of what is needed already exist: `restoreDetailRegistrations` (`:890`) re-registers a remote reference from a reused row's registrations, and the direct history page cache (`this.directHistoryPages`, `:3996`) holds paged rows. Neither is consulted on this path. The cache holds 4,096 entries or 64 MiB (`native-agent-service-shared.ts:777-778`), so a miss needs a long session or many open sessions.

**Decisions.**

- **What should a miss do for a summary-backed session?**
  - **Look in the registered remote details and the direct page cache, then run a summary read; keep the sync refresh only for providers without summaries (recommended).**
    - Pros: the report's fix; a row in the live window or a cached page recovers with no raw read; OpenCode and other inline-body providers keep working, because their references do come from the raw rows.
    - Cons: a row in neither place still fails, and needs a clear "reload this page" path rather than a retry.
  - **Pass `remote` to the sync refresh's projection.**
    - Pros: one argument.
    - Cons: it does not help. Raw `/messages` rows carry no `detail` locator, so `bridgePartDetail` finds nothing and the local reference is still what gets minted.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): any added lookup structure needs byte and count bounds.
- The pinning at `native-agent-transcript-projection.ts:4189` and `:4200` protects a reference during the refresh. Keep it wherever a refresh remains.

### Needs verification

- How often users reach this error. The mechanism was traced in code; no live miss was observed.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-2, TX-15, TX-18, TX-8)
- [1202 tasks 1 and 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0200](#0200-the-messages-fallback-ignores-the-limit-it-has-in-scope): the same limit on the `/messages` fallback, which needs no baseline
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0150](#0150-dispatches-and-control-changes-trigger-an-unlimited-raw-transcript-read): the wider limit work
- [0150](#0150-dispatches-and-control-changes-trigger-an-unlimited-raw-transcript-read): the same raw read on other paths

## Outcome

Built 2026-11-05 from base commit `69a3b4ca5`. Every task and check above, checked back against the code before this file was deleted. The baseline was taken on the base commit with a provider fake (no provider turn): `apps/backend/src/core/native-agent-transcript-read-bytes.test.ts`, 400 rows of about 8 KB (3,292,561 bytes).

| Part | Task | Outcome | Code, test, evidence or to-do |
| --- | --- | --- | --- |
| 0150 | 1. Capture the baseline | Done with fakes; live figures moved to a to-do | Before E9: a prompt send read 33 raw rows (271,676 bytes); a one-message turn check 2 rows (16,466 bytes); an evicted remote detail all 400 rows (3,292,561 bytes) and still failed; the `/messages` fallback received 3,292,610 bytes to keep 100 rows. The fixture test now asserts the after figures. Live numbers need a real turn: [5340](../../todo/transcripts-and-observation/5340-transcript-reads-live-evidence.md) task 1. |
| 0150 | 2. State-only read for `messageLimit: 1` callers | Done | `coordinator-checkout-turn.ts`, `worker-surface-runs.ts` (`nativeTurnPhase`), `worker-question-relay.ts` (`readPendingInteraction`), and a fifth caller found on re-check, the waiting-blocker read (`index.ts` `waitingBlocker`, `nodes/node-coordinator-remote.ts`), now use `getSessionStateUpdate` / `get_native_agent_session_state_update` (served by every node since #670). A turn check reads 0 transcript bytes (was 16,466). `control-mcp-tools.ts` `get_tab_state` keeps the projection: it returns the whole state, not just the phase or interactions, and task 4 already cuts it to two rows. Tests: `coordinator-checkout-turn.test.ts`, `coordinator-surface-actions.test.ts` (`native close handles … safely`), `worker-question-relay*.test.ts`, `index.test.ts`, `node-coordinator-remote.test.ts`, and the read-bytes fixture. |
| 0150 | 3. State-only post-dispatch refresh | Done earlier (2026-11-04) | `refreshProjectionState`, a 32-row tail; the fixture measures 33 rows per send. |
| 0150 | 4. Pass `limit` through the raw read | Done earlier (2026-11-04) | `interactiveSnapshot(sessionId, { limit })` in `http-bridge-provider.ts`. |
| 0150 | 5. Re-check the duplicate row cache (TX-15) | Done: no new item | After a summary view, a send and a turn check, the row cache holds 100 summary-context rows and 32 inline-context rows: only the dispatch tail duplicates, bounded by the per-session cache limits (4,096 rows, 24 MiB). The turn checks no longer add any. Asserted in the read-bytes fixture. |
| 0150 | Needs verification: side effects of a full refresh | No longer holds | Task 3 kept a full refresh, on a shorter tail, so no side effect was removed (1202, "Task 5: how post-dispatch reads are bounded"). |
| 0150 | Needs verification: share of Claude sessions with large `/messages` bodies | Moved to a to-do | [5340](../../todo/transcripts-and-observation/5340-transcript-reads-live-evidence.md) task 2. |
| 0150 | Constraint: a state-only read must not skip what an invalidation relies on | Done | Only callers that read the phase or interactions moved. An unreadable session still counts as busy where the projection's error view did. |
| 0200 | 1. Pass the limit to the fallback read | Done | `readLegacy: () => this.legacy(sessionId, options.limit)` in `http-bridge-transcript-reader.ts`; the legacy read reports its own cut as `truncated` (`http-bridge-progressive.ts`), so a bridge that ignores `?limit=` never yields `complete: true` for a tail. 3,292,610 bytes became 823,299 on the fixture. Tests: `http-bridge-transcript-reader.test.ts`. |
| 0200 | Needs verification: each bridge sets `truncated` on a `?limit=` cut | Done | Claude and Codex through `boundTranscriptResponse` (`transcript-window.test.ts`, "keeps only the newest messages and counts the rest as omitted"); Codex route (`index-routes.test.ts`); Cursor (`http.test.ts`); Pi (`http.test.ts`); ACP's `messageWindow` sets it when `baseIndex > 0` (`acp-public.ts`). |
| 0110 | 1. Recover remote details without the raw sync read | Done | Remote references carry an `r` prefix (`native-agent-remote-detail-recovery.ts`). A miss re-registers from the cached row's or page's registration (`ProjectedMessageCache.sessionDetails`, `DirectHistoryPageCache.sessionValues`), else runs one summary read of the live window (`recoverRemoteToolDetails`); inline references keep the `sync-v1` refresh. An evicted remote detail now reads 0 raw bytes. Tests: `native-agent-service-summary-transcripts.test.ts`, "after eviction". |
| 0110 | Con: a row held nowhere needs a clear reload path | Done | The error says to reload the conversation; reloading the page makes the reference resolve again. Test: "an older row held nowhere asks for a reload, without a raw read". |
| 0110 | Constraint: added lookups need byte and count bounds | Done | No structure was added; the lookup reads the two existing bounded caches. |
| 0110 | Constraint: keep the pinning wherever a refresh remains | Done | The reference is pinned around both recovery paths. |
| 0110 | Needs verification: how often users reach the error | Moved to a to-do | [5340](../../todo/transcripts-and-observation/5340-transcript-reads-live-evidence.md) task 3. |
