# A tool-detail cache miss cannot recreate remote references

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Recover remote details without the raw sync read**: on a miss, resolve from registered remote details or the direct page cache, otherwise run a summary read. Status: open.

### 1. Recover remote details without the raw sync read

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

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): any added lookup structure needs byte and count bounds.
- The pinning at `native-agent-transcript-projection.ts:4189` and `:4200` protects a reference during the refresh. Keep it wherever a refresh remains.

## Needs verification

- How often users reach this error. The mechanism was traced in code; no live miss was observed.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-8)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0150](0150-tx-2-tx-15-post-dispatch-raw-reads.md): the same raw read on other paths
