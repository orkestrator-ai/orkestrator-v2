# The live-head merge serialises parts with no identity shortcut

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Identity shortcut**: return early when the local and incoming copies are already the same object. Status: open.
2. **Cache part serialisation**: stop re-serialising unchanged part objects. Status: open.

### 1. Identity shortcut

**Problem.** Each transcript update serialises the head row's parts, even when nothing in them changed.

**Context.** The report's fix is to return early when `local === head` or `local.parts === head.parts`.

**Investigation.** `preferCompleteLiveHead` has neither check (`apps/web/src/hooks/useNativeAgentSession.ts:260-307`). Its callers are at `:1316`, `:1608` and `:3563`. It compares serialised parts at `:298` to decide whether it can keep the held row. Whether freshly parsed views ever share objects with the held copy decides how often the shortcut fires, and an incoming parsed part has a new identity.

**Decisions.** None: a cheap guard with no behaviour change. The early return must give the same result as the path at `:301`.

### 2. Cache part serialisation

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

## Constraints and rationale

Incoming parts stay authoritative for everything they cover (`:249-253`). The report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) on incremental live events and on cache bounds apply: a WeakMap's size follows its keys, but its strings add to what the projection store's byte ceiling does not count.

## Needs verification

- How much time this takes while streaming; 1202 lists a React Profiler run as still outstanding, and the report's impact is reasoned.

## Related

- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
