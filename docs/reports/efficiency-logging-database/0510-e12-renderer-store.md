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
