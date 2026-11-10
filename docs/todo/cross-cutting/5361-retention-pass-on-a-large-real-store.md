# Measure the retention pass on a large real store

From efficiency report (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`) ST-20, part `0550` of batch E4 (Object store), its "Needs verification" item ("Real sweep duration on a large store; the report's impact is reasoned, not measured"). The batch file was deleted when E4 was built; it is in Git history at the base commit named in [Related](#related).

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`, with the E4 change applied.

### Tasks

2. **Size the reachability cache from that measurement**: keep, raise or lower its 4,096-manifest and 32 MiB bounds. Status: blocked (waits on 7568: 5361 task 1).

### 2. Size the reachability cache from that measurement

**Problem.** The cache's bounds (4,096 manifests, 32 MiB, so 1.6 million object ids) were chosen against the fixture. At 10,000 files a manifest costs 200 KB there, so the bound held 167 of 400 manifests and a pass still parsed the rest.

**Context.** Admission is "while there is room", and entries a completed pass did not walk are dropped, so a history larger than the bound gets a stable fraction of hits rather than none. The parsed-manifest cache (`manifest-cache.ts`, 128 MiB estimated) serves live views and is not filled by a pass.

**Investigation.** Not run; depends on task 1, the measurement on a copy of a real store, which is in the manual-test checklist (7568: 5361 task 1). The fixture's numbers are in [change tracking](../../architecture/change-tracking.md#benchmarks) (`bun scripts/benchmark-change-tracking.ts --only=retention`).

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
- to-do 1202 efficiency follow-ups, task 7 (retired 2026-11-10)
- E3 (retention and deletion) changed what a pass retires, not how it walks the store: [change tracking](../../architecture/change-tracking.md#age-based-retention), and its table sizes are [5821](5821-ledger-retention-live-evidence.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, measuring a retention pass on a copy of a real store) moved there on 2026-11-10.
