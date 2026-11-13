# Design canvas: optimisations deferred until a measurement asks for them

## Task analysis

Analysed 2026-11-13 against `main` at `17d28238c`. Moved from to-do 0036 task 9
(0036 retired 2026-11-13; `git show f2c4cee71:docs/todo/design-canvas/0036-design-canvas-qualification.md`,
"Deferred until measured"), as that task recommended, so the qualification
file could close while these stay gated on evidence.

### Tasks

1. **Library and offscreen thumbnails**: bounded capture jobs behind interactive work. Status: blocked (waits on 7568: 0036 (retired) task 9, whether thumbnails are wanted).
2. **Capture and inspection cache**: only once thumbnails or a measurement show repeated identical captures. Status: blocked (depends on 1, or on a measurement of repeated captures).
3. **Second render worker**: raise `DESIGN_LIMITS.renderWorkers` only after measuring several environments rendering at once. Status: blocked (waits on a measurement of render-worker contention).
4. **Warm browser-context pool**: only if context setup dominates once the rest is done. Status: blocked (depends on 3, or on a measurement where context setup dominates).
5. **Storage redesign**: only if full-record rewrites dominate at high edit frequency on near-limit documents. Status: blocked (waits on a measurement of rewrite cost).

### 1. Library and offscreen thumbnails

**Problem.** The saved-designs library lists facts only, and a culled frame shows a placeholder. A visual library is harder to scan once there are many canvases.

**Context.** Nothing in `apps/web/src/components/design/DesignLibrary.tsx` or the backend design code mentions thumbnails. The library's first page paints in about 35 ms at 256 canvases on the M5 Max (2026-10-22) and 103–153 ms p50 on a loaded Linux host (2026-11-06), because it renders 50 rows at a time. Thumbnails are the feature that would create the repeated-capture workload task 2 needs.

**Investigation.** None since 0036. If built: low-priority, bounded capture jobs behind interactive work in the render queue, invalidated by content, viewport and runtime identity. A stale thumbnail is labelled, a missing renderer gives a placeholder, and a thumbnail is never a hit-test target.

**Decisions.**

- **Build them?** Reserved to the user (7568, decisions, "Design canvas").
  - **No, not until users ask (recommended).**
    - Pros: no render-queue workload that would then justify task 2's cache.
    - Cons: a long library stays text only.
  - **Yes, as a product feature.**
    - Pros: a better saved-designs experience.
    - Cons: brings in tasks 1 and 2 together (bounded capture jobs, invalidation, a cache).

### 2. Capture and inspection cache

**Problem.** Every capture and inspection renders afresh in a new isolated browser context.

**Context.** No measurement since 2026-09-24 has touched repeated captures. The 2026-10-22 and 2026-11-06 client numbers made no case for it.

**Investigation.** If built: key on canvas and frame incarnation, content identity, viewport, runtime and sanitiser version, scale, colour scheme and parameters. 64 entries and 64 MiB with LRU eviction, counting PNG and base64 copies. Single-flight identical requests without coupling their cancellation; authorise the environment on every read; never cache animated content as a permanent result.

**Decisions.**

- **When to start?**
  - **Only after task 1 ships or a measurement shows repeated identical captures (recommended).**
    - Pros: no cache invalidation to get right for a workload that does not exist.
    - Cons: repeated agent captures, if they happen, pay full renders until then.
  - **Build it now.**
    - Pros: ready if captures grow.
    - Cons: a cache with authorisation and invalidation rules and nothing to measure it against.

### 3. Second render worker

**Problem.** One render worker serves every environment.

**Context.** `DESIGN_LIMITS.renderWorkers: 1` (`packages/protocol/src/design-operations.ts`); `DesignRenderer` accepts a `workers` option (`apps/backend/src/core/design/renderer.ts`).

**Investigation.** No measurement of several environments rendering at once exists.

**Decisions.**

- **How to decide?**
  - **Measure memory and p95 latency with several environments rendering before raising it (recommended).**
    - Pros: the change is one constant once the evidence exists.
    - Cons: needs a multi-environment load harness that does not exist yet.
  - **Raise it to 2 now.**
    - Pros: trivial.
    - Cons: a second Chromium's memory on every host, unmeasured.

### 4. Warm browser-context pool

**Problem.** Each render job creates a fresh isolated context.

**Context.** Context setup has not been measured as a dominant cost.

**Investigation.** If built, the pool must prove a full reset of DOM, origin storage, listeners, routes, permissions and request state between jobs, pass adversarial tests, and be compared with fresh contexts, memory included.

**Decisions.**

- **When to start?**
  - **Only if context setup dominates once tasks 2 and 3 are settled (recommended).**
    - Pros: a reused context is a security boundary to prove; skip it unless it pays.
    - Cons: none measured.
  - **Build it now.**
    - Pros: lower per-job latency if setup is costly.
    - Cons: cross-job leakage risk for an unmeasured gain.

### 5. Storage redesign

**Problem.** Each commit rewrites the whole record atomically.

**Context.** `write` and `writeAtomically` in `apps/backend/src/core/design/records.ts`. The 2026-09-24 baseline (`bun scripts/benchmark-design.ts`) measured durable receipts at 2–15 ms per edit, dominated by the record fsync, which did not justify a redesign. Cross-process leases already use the backend database since #969 (`core/design/coordination.ts`); records stay files.

**Investigation.** Baseline (one Linux x64 host, Bun 1.4.0, synthetic content, 20 samples; "before" is `2aec227b`, before #844):

| Fixture | Catch-up bytes before → after | Edit p50/p95 ms before → after | Commit bytes before → after |
| --- | --- | --- | --- |
| 1 frame, small | 2478 → 1034 | 0.41/0.77 → 2.41/5.2 | 2487 → 17074 |
| 64 frames, small | 143777 → 1034 | 1.29/2.28 → 4.46/5.7 | 148448 → 249551 |
| 64 frames, near-limit document | 3969491 → 1035 | 18.51/26.45 → 34.09/39.85 | 3974162 → 4075391 |

**Decisions.**

- **When to start?**
  - **Only if full-record rewrites dominate at high edit frequency on near-limit documents, and then with a separate storage decision first (manifest indirection versus a journal or database) that keeps document and receipt atomicity, crash recovery, history and v1 export (recommended).**
    - Pros: protects the recovery guarantees that the current design gets from whole-record writes.
    - Cons: near-limit documents keep paying about 35 ms per edit.
  - **Redesign now.**
    - Pros: lower commit cost on large documents.
    - Cons: a storage migration with no measured need.

## Constraints and rationale

- Each optimisation must be removable on its own without reverting a safety fix, and none may log design content.
- Rollback restores full snapshots or fresh contexts without touching stored documents. A storage change is a separate explicit conversion; reverting a binary is not enough once records are migrated.
- Single-machine timings are host evidence, not thresholds.

## Related

- [`design-canvas.md`](../../architecture/design-canvas.md) ("Renderer", "Bounds", "Tests").
- `scripts/benchmark-design.ts` (backend) and `e2e/perf/design-canvas-perf.ts` (client) are the measurements these tasks wait on.
- 0036 (retired 2026-11-13): the client performance runs that made no case for these (`git show f2c4cee71:docs/todo/design-canvas/0036-design-canvas-qualification.md`).

## Replaces

- To-do 0036 task 9 and its "Deferred until measured" section.
