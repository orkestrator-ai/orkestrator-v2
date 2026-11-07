# Measure the retention pass on a large real store

From efficiency report (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`) ST-20, part `0550` of batch E4 (Object store), its "Needs verification" item ("Real sweep duration on a large store; the report's impact is reasoned, not measured"). The batch file was deleted when E4 was built; it is in Git history at the base commit named in [Related](#related).

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`, with the E4 change applied.

### Tasks

1. **Measure a retention pass on a large real store**: pass and sweep duration, captures' wait during a sweep, manifests parsed against reachability hits. Status: open.
2. **Size the reachability cache from that measurement**: keep, raise or lower its 4,096-manifest and 32 MiB bounds. Status: open (depends on 1).

### 1. Measure a retention pass on a large real store

**Problem.** Every number for the hourly pass after ST-20 comes from a generated fixture: 400 snapshots over at most 10,400 objects. A real store after weeks of use can hold far more objects, larger and fewer-shared manifests, and a different mix of reachable and orphaned objects, so the pass duration and the sweep's effect on captures there are unknown.

**Context.** ST-20 changed three things (`apps/backend/src/core/change-tracking/object-store.ts`, `retention.ts`, `reachability-cache.ts`): the store keeps its byte count instead of retention walking for it twice per pass; `sweep` walks without the store lock and removes under it, 64 candidates per hold; and retention keeps the object ids each manifest names between passes. The fixture (`bun scripts/benchmark-change-tracking.ts --only=retention`) measured a second pass at 2,000 files falling from 565 ms to 87 ms, at 10,000 files from 2,760 ms to about 1.7 s, and a put issued during a sweep from about 400 ms to 1 to 2 ms; results are in [change tracking](../../architecture/change-tracking.md#benchmarks). The rule that no agent runs against the real data directory stands, so this needs a copy of a real store or a long-lived throwaway profile, and no billed provider turn.

**Investigation.** Not run. The fixture's objects are all small and its snapshots all referenced, so it removes nothing; a real pass that removes many objects takes the lock once per 64 removals, which the fixture does not exercise at scale. `ChangeRetentionService.reachabilityStats()` and `ObjectStore.manifests.snapshot()` give the counts without content.

**Decisions.**

- **Which store to measure?**
  - **A copy of a real `<dataDir>/change-tracking/` and its ledger rows, opened by the benchmark with `durable: true` on a real disk (recommended).**
    - Pros: real object counts, manifest sizes and sharing; repeatable; never touches the live data directory.
    - Cons: the copy holds file contents, so it must stay on the machine it came from and be deleted after; a maintainer has to make it.
  - **A long-lived `dev:test` profile driven by fake-provider turns.**
    - Pros: no real user data.
    - Cons: weeks of history are slow to build, and a generated history is close to what the fixture already measures.

### 2. Size the reachability cache from that measurement

**Problem.** The cache's bounds (4,096 manifests, 32 MiB, so 1.6 million object ids) were chosen against the fixture. At 10,000 files a manifest costs 200 KB there, so the bound held 167 of 400 manifests and a pass still parsed the rest.

**Context.** Admission is "while there is room", and entries a completed pass did not walk are dropped, so a history larger than the bound gets a stable fraction of hits rather than none. The parsed-manifest cache (`manifest-cache.ts`, 128 MiB estimated) serves live views and is not filled by a pass.

**Investigation.** Not run; depends on task 1.

**Decisions.**

- **What to change if real histories outgrow the bound?**
  - **Raise the byte bound to cover the measured history (recommended if the pass still parses most manifests).**
    - Pros: one constant; the memory is 20 bytes per object id per manifest.
    - Cons: memory held all the time for an hourly job.
  - **Store each manifest's ids as a delta against an earlier one of the same worktree.**
    - Pros: consecutive snapshots differ by a few files, so the cache would hold most histories in a few MiB.
    - Cons: a chain to rebuild on a hit and to repair when a base is dropped; more code for a Low-rated cost.
  - **Leave it.**
    - Pros: no change; the pass is hourly and its parse work no longer blocks captures behind the store lock.
    - Cons: large histories keep parsing most manifests every hour.

## Needs verification

- Whether the store's running byte count drifts from a walk over weeks; nothing but the sweep removes objects, and a sweep that finds a candidate already gone recounts, but nothing checks the figure against a walk periodically.

## Related

- Batch file E4: `docs/reports/efficiency-logging-database/0430-e4-object-store.md` at base commit `5ba05c977c2b8affdfdeab52e47b962a4965e828` (`git show 5ba05c977:docs/reports/efficiency-logging-database/0430-e4-object-store.md`); its outcome table is at the end.
- [Change tracking](../../architecture/change-tracking.md#retention-and-backup)
- [1202 efficiency follow-ups](1202-efficiency-review-follow-ups.md), task 7
- E3 (retention and deletion) changed what a pass retires, not how it walks the store: [change tracking](../../architecture/change-tracking.md#age-based-retention), and its table sizes are [5821](5821-ledger-retention-live-evidence.md)
