# E12: Renderer store

This file combines 3 reports into one batch to build together. Same hook and projection store.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0510](#0510-the-live-head-merge-serialises-parts-with-no-identity-shortcut) | Medium | WEB-6: The live-head merge serialises parts with no identity shortcut |
| [0590](#0590-the-native-session-hook-subscribes-to-whole-cache-entries-it-reads-only-at-mount) | Low | WEB-2 (rest): The native session hook subscribes to whole cache entries it reads only at mount |
| [0640](#0640-projection-store-writes-copy-four-maps-even-when-one-changes) | Low | WEB-14: Projection store writes copy four Maps even when one changes |

## 0510: The live-head merge serialises parts with no identity shortcut

### Task analysis

#### Tasks

1. **Identity shortcut**: return early when the local and incoming copies are already the same object. Status: done (2026-11-04; [1202 task 3](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)). The early return matches the incoming-only path, not the path at `:301` as task 1 below says.
2. **Cache part serialisation**: stop re-serialising unchanged part objects. Status: done (2026-11-04), by comparing without serialising rather than with the WeakMap recommended below; 1202 records why.

#### 1. Identity shortcut

**Problem.** Each transcript update serialises the head row's parts, even when nothing in them changed.

**Context.** The report's fix is to return early when `local === head` or `local.parts === head.parts`.

**Investigation.** `preferCompleteLiveHead` has neither check (`apps/web/src/hooks/useNativeAgentSession.ts:260-307`). Its callers are at `:1316`, `:1608` and `:3563`. It compares serialised parts at `:298` to decide whether it can keep the held row. Whether freshly parsed views ever share objects with the held copy decides how often the shortcut fires, and an incoming parsed part has a new identity.

**Decisions.** None: a cheap guard with no behaviour change. The early return must give the same result as the path at `:301`.

#### 2. Cache part serialisation

**Problem.** `locateIncomingParts` serialises local and incoming parts through `JSON.stringify`, and again without identity fields (`useNativeAgentSession.ts:172-191`, `:198`, `:203`).

**Context.** The report suggests a per-part WeakMap. The renderer already measures per-message sizes this way (`encodedArrayBytes`, `apps/web/src/stores/nativeAgentProjectionStore.ts:199`).

**Investigation.** `serialize` memoises per call only (`:178-182`), so nothing carries over between updates. The per-call arrays do bound the work within one merge.

**Decisions.**

- **Cache, or compare differently?**
  - **A WeakMap from part object to its serialised string (recommended).**
    - Pros: held parts keep their identity across updates, so they cost one serialisation; no explicit eviction because it is weak.
    - Cons: holds a second copy of the text while the part lives, and incoming parts still miss.
  - **Compare incoming to held by length and a cheap field check before serialising.**
    - Pros: no extra memory.
    - Cons: more match logic in a function whose past bugs froze the row (see its comment at `:255-258`).

### Constraints and rationale

Incoming parts stay authoritative for everything they cover (`:249-253`). The report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) on incremental live events and on cache bounds apply: a WeakMap's size follows its keys, but its strings add to what the projection store's byte ceiling does not count.

### Needs verification

- How much time this takes while streaming; 1202 lists a React Profiler run as still outstanding, and the report's impact is reasoned.

## 0590: The native session hook subscribes to whole cache entries it reads only at mount

### Task analysis

#### Tasks

1. **Narrow the hook's store subscriptions**: stop re-rendering the agent tab when a cache entry changes. Status: done (2026-11-04) as recommended below.

#### 1. Narrow the hook's store subscriptions

**Problem.** A write to a session's progressive or sync cache entry re-renders `useNativeAgentSession` and so `AgentNativeTab.controller`, even if render uses nothing that changed.

**Context.** The report's third fix for this finding is to subscribe to the fields actually read. 1202 task 3 confirms this half is not done.

**Investigation.** The hook subscribes to three whole entries (`apps/web/src/hooks/useNativeAgentSession.ts:825-833`), and the controller uses the hook at `apps/web/src/components/native-agent/AgentNativeTab.controller.tsx:526`. All 13 uses of `matchingProgressiveCache` are `useState` and `useRef` initial values (`useNativeAgentSession.ts:885-1010`), and `sharedSyncCache` is used the same way up to `:1038`. A change of session key resets from `useNativeAgentProjectionStore.getState()` (`:2871`, `:2891`), not from the subscription. `sharedProjection` is different: an effect follows it (`:3174-3184`), so it has to stay.

**Decisions.**

- **How to read the two caches?**
  - **Read them once without subscribing, with `getState()` when the hook first runs, and keep the projection subscription (recommended).**
    - Pros: an entry write no longer re-renders the tab; removes a subscription rather than narrowing it.
    - Cons: a later render relying on the value would silently see a stale one, so a test should pin the render count.
  - **Select individual fields with `useShallow`.**
    - Pros: no change to how the values are read.
    - Cons: subscribes to fields that are only used as initial values, and a token that moves still re-renders.

### Current state

- An unchanged poll keeps the identity object (`useNativeAgentSession.ts:1501`).
- `setProgressiveCache` returns the same state when an entry is unchanged, with no recency condition (`apps/web/src/stores/nativeAgentProjectionStore.ts:150-159`, `:244-246`).

So the report's main cost, a re-render on every unchanged poll, has gone.

### Constraints and rationale

The renderer cache stays a cache: the backend projection remains authoritative. A remount must still restore what the cache held.

### Needs verification

- The size of the remaining benefit. The React Profiler run with two visible tabs that 1202 lists is still outstanding.

## 0640: Projection store writes copy four Maps even when one changes

### Task analysis

#### Tasks

1. **Copy only the Maps that change**: make `setProjection` copy on demand. Status: open.

#### 1. Copy only the Maps that change

**Problem.** Each `setProjection` copies four Maps, up to 128 entries each.

**Context.** The projection and its size change on every write; the sync and progressive Maps usually do not.

**Investigation.** `apps/web/src/stores/nativeAgentProjectionStore.ts:173-240` creates `next`, `nextBytes`, `nextSync` and `nextProgressive` up front and returns all four. `nextSync` changes only on a drop or a new sync cache, and `nextProgressive` only when a projection is dropped or evicted (`:208`, `:217-220`, `:228-229`).

**Decisions.** None: copy `nextSync` and `nextProgressive` on first write. Selectors read `.get(key)` from the Map, so keeping the old Map object is safe. The LRU re-insertion in `next` (`:202-203`) stays.

### Constraints and rationale

The count and byte ceilings at `:224` must keep applying to the same three Maps.

### Needs verification

- Whether this shows in a profile at all; 128-entry Map copies are cheap, and the report rates it Low.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3

## Outcome

Checked back item by item on 2026-11-05 against `main` at `fbb6c7560` (base commit of branch `renderer-store-report-cf7c05d19868-r1`), before this file was deleted. Every task was already built when the check started: 0510 and 0590 as this file says, and 0640 too, though its status above still read open. #1754 (`bfac1f577`, 2026-11-04) built it as WEB-14, and [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) records it. This batch added tests that pin 0640's constraints and took the Profiler run. No to-do was needed.

**Profiler run.** Two real `AgentNativeTab`s side by side (1600×1000) in headless Chromium, React's development build, served by the component-browser fixture server with a fake backend in the page. No backend process, profile or provider was involved. Each tab held a 60-row fixture transcript (assistant rows carry a tool call and prose). While streaming, a live assistant row gained a sentence every 200 ms and the turn reported `running`. Reads came from the hook's own coordinated schedule. Each `<Profiler>` wrapped one tab, and each window was 20 s. Variants: the current code; 0590 reverted (the hook subscribes to its whole sync and progressive entries again); and 0640 reverted (the store as of `bfac1f577^`). Seven runs were taken in two sets. The first `current` run and the first 0590-reverted run ran while the host was loaded: their commits matched the others (170 to 173), but their means were 17 to 23 ms, so they are left out of the timings below.

| Variant | Idle: commits per tab, store writes | Streaming: commits per tab | Streaming: store writes, transcript reads (both tabs) | Mean per commit | p95 per commit |
| --- | --- | --- | --- | --- | --- |
| Current (3 runs) | 0, 0 | 170 to 172 | 160, 80 | 5.16 to 5.78 ms | 11.0 to 12.8 ms |
| 0590 reverted (1 quiet run) | 0, 0 | 170 | 160, 80 | 5.56 and 6.00 ms | 12.6 and 13.4 ms |
| 0640 reverted (2 runs) | 0, 0 | 170 | 160, 80 | 5.41 to 5.77 ms | 11.2 to 13.5 ms |

Idle tabs commit nothing in any variant: an unchanged poll writes nothing to the store, which is 0590's "Current state". While streaming, each tab commits about 8.5 times a second. The cache write that 0590 stopped subscribing to lands in the same React batch as the transcript state change, so removing the subscription does not change the commit count in this scenario. The per-commit difference is within run-to-run noise. 0640 does not show in a profile, as the file expected. A Bun micro-benchmark gives its size: with 128 sessions holding sync and progressive entries, a streaming `setProjection` took 8.86 to 9.34 µs before and 3.97 to 4.17 µs after (three runs each, 200,000 writes). At 4 store writes a second for two streaming tabs, that saves about 20 µs a second. For 0510 the merge cost was already measured in 1202 task 3: before the fix, at most 0.3 ms per update on a 700 KB row, against the 5 to 6 ms commit above. The fixed merge took 0.03 to 0.06 ms.

These numbers come from development React with a fake read cadence. Production React and a real bridge's streaming cadence were not measured. Neither question is open in this file: every task is built, and the Profiler question was whether the work shows, which it does not at this scale.

| Part | Item | Outcome | Code and test, evidence, or to-do |
| --- | --- | --- | --- |
| 0510 | Task 1: identity shortcut | Done (2026-11-04, #1754) | `preferCompleteLiveHead` returns the incoming rows early when held and incoming share their parts (`apps/web/src/hooks/native-agent-live-head.ts:127`). Test: "returns the incoming rows without comparing anything when the row is the held row" (`native-agent-live-head.test.ts:204`). Callers are now `useNativeAgentSession.ts:1205`, `:1508` and `:3560`. |
| 0510 | Task 1 decision: the early return matches the path at `:301` | No longer holds | Identical parts reach the incoming-only path (`restoredPrefix: false`), not the restored-prefix path. 1202 task 3 records this, and the random-head test pins it. |
| 0510 | Task 2: stop re-serialising unchanged parts | Done (2026-11-04, #1754), by comparing without serialising | `sameTranscriptJson` (`apps/web/src/lib/chat/same-transcript-json.ts`), used at `native-agent-live-head.ts:54` and `:151`. Tests: "does not serialize the parts of an unchanged trimmed head" (`:215`), "does not serialize parts when a bridge reissued their source ids" (`:229`), and "gives the old merge's answer for random heads" (`:253`, 4,000 heads against a verbatim copy of the old merge). |
| 0510 | Task 2 decision: WeakMap cache (recommended) or compare differently | The other option was taken; 1202 task 3 gives the reason | With no cached strings, the constraint about memory the projection store's byte ceiling does not count no longer applies. |
| 0510 | Constraint: incoming parts stay authoritative | Holds | The same random-head test, which also checks which row object survives. |
| 0510 | Needs verification: streaming cost, Profiler run | Answered above | Merge before the fix: at most 0.3 ms per update. After: 0.03 to 0.06 ms (1202). A streamed commit: 5.2 to 5.8 ms per tab. |
| 0590 | Task 1: narrow the hook's store subscriptions | Done (2026-11-04, #1754), recommended option | `useSessionCacheSeeds` reads both caches with `getState()` (`apps/web/src/hooks/useNativeAgentSession.ts:660`). The shared projection stays subscribed (`:718`). Tests in `useNativeAgentSession.store-subscriptions.test.tsx`: "a progressive cache write does not re-render the hook" (`:151`), "a sync cache write that keeps the projection does not re-render the hook" (`:170`), "a new shared projection still reaches the hook" (`:189`) and "a remount still restores what the caches hold" (`:210`). |
| 0590 | Current state: an unchanged poll keeps identity; `setProgressiveCache` returns the same state for an unchanged entry | Holds | `sameProgressiveEntry` (`nativeAgentProjectionStore.ts:178`) and its early return (`:293`). Test: "measures discovery once per object and ignores unchanged patches" (`nativeAgentProjectionStore.test.ts:342`). In the Profiler run above, idle tabs wrote nothing. |
| 0590 | Constraint: a remount restores what the cache held | Holds | "a remount still restores what the caches hold". |
| 0590 | Needs verification: size of the remaining benefit, two visible tabs | Answered above | No difference in commits (170 per tab per 20 s streaming, 0 idle) in this scenario. The isolated-write benefit is the hook test's one render to none. |
| 0640 | Task 1: copy only the Maps that change | Done (2026-11-04, #1754, as WEB-14), not by this batch | `copyOnWrite` (`apps/web/src/stores/nativeAgentProjectionStore.ts:130`). `setProjection` (`:201-286`) creates `nextSync` and `nextProgressive` lazily and writes them only on a drop, a new sync entry or an eviction. Tests: "changed messages also change the byte Map, and nothing else" (`nativeAgentProjectionStore.test.ts:426`) and, added here, "a projection write keeps the sync and progressive Maps while both hold entries" (`:447`), which fails on the store as of `bfac1f577^`. |
| 0640 | Decision: keep LRU re-insertion in `next` | Holds | `:245-248`. Test: "a new projection with the same messages changes only the projections Map" (`:414`) asserts the order moves, and `:447` does too. |
| 0640 | Constraint: count and byte ceilings apply to the same three Maps | Holds | Ceiling loop at `:270-276`. Tests added here: "the count ceiling still evicts the oldest session from all three Maps" (`:469`) and "the byte ceiling still evicts the oldest session from all three Maps" (`:502`). Each checks projections, projection bytes and sync caches, the dropped progressive token and exact totals. |
| 0640 | Needs verification: whether it shows in a profile | Answered above: it does not | Commits and per-commit time match the current code. The store write itself went from about 9.1 µs to 4.1 µs. |
