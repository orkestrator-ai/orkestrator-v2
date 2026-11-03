# The native session hook subscribes to whole cache entries it reads only at mount

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Narrow the hook's store subscriptions**: stop re-rendering the agent tab when a cache entry changes. Status: open.

### 1. Narrow the hook's store subscriptions

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

## Current state

- An unchanged poll keeps the identity object (`useNativeAgentSession.ts:1501`).
- `setProgressiveCache` returns the same state when an entry is unchanged, with no recency condition (`apps/web/src/stores/nativeAgentProjectionStore.ts:150-159`, `:244-246`).

So the report's main cost, a re-render on every unchanged poll, has gone.

## Constraints and rationale

The renderer cache stays a cache: the backend projection remains authoritative. A remount must still restore what the cache held.

## Needs verification

- The size of the remaining benefit. The React Profiler run with two visible tabs that 1202 lists is still outstanding.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
