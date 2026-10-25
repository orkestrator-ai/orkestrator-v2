# Web annotation commit cost grows with the collection

Checked against `main` at `ba7cc8d4` (2026-10-25).

Every write to an environment's web annotations (create, reply, resolve,
request state changes) costs CPU in proportion to everything the environment
already holds. Found while closing
[0044-web-annotation-qualification.md](0044-web-annotation-qualification.md)
("Create cost grows with the collection"). It is not a correctness problem and
the SQLite writes per commit stay bounded; it matters only once collections
approach the 2,000-note cap.

## Current state

- Measured on 2026-10-25 (median CPU ms per create, a host at load ~45 on 18
  cores, so read the proportions rather than the absolute values; a quiet host
  measured 0.34 / 1.34 / 2.84 / 4.11 ms on 2026-10-17):

  | Notes | Create | Manifest copy | Row diff |
  | --- | --- | --- | --- |
  | 0 | 1.8 | 0.25 | 0.29 |
  | 500 | 8.4 | 4.0 | 3.2 |
  | 1,000 | 15.0 | 7.3 | 6.9 |
  | 1,900 | 21.3 | 11.4 | 10.3 |

- Two steps account for essentially all of the growth, each about half:
  - `structuredClone(base.manifest)` in `commitManifest`
    (`apps/backend/src/core/web-annotation-storage.ts`, the transaction's
    working copy) copies every annotation, capture index, entry index,
    `changedAt` entry and receipt, so a `work` callback that throws leaves the
    committed manifest untouched.
  - `planRows` (`apps/backend/src/core/web-annotation-store-rows.ts`) runs
    `JSON.stringify` on every index row (about 8,300 rows, 2.6 MB of JSON at
    1,900 notes), compares each with the stored row, rebuilds its row and
    value maps, and walks all previous rows for deletions. It exists because
    some mutations change rows without declaring them through `tx.touch` (for
    example asset GC only calls `markDirty`).
- Flat or trivial: `liveAnnotationCount`, receipt lookups (capped at 512),
  draft removal (capped at 256), `refresh`/`adopt`/`observe`, and the SQLite
  writes themselves. The bench case
  `SQLite writes per create stay bounded as the collection grows (no
  whole-history rewrite)` (renamed from "creation cost stays flat …") bounds
  rows and bytes written per create, not CPU.

## Outstanding work

### Code

1. Make a commit cost O(changed rows): a copy-on-write working manifest (or a
   per-collection change journal) instead of `structuredClone`, and a row plan
   driven by declared changes instead of a full diff. That needs every
   mutation that changes rows to declare them (about 85 `tx.manifest` call
   sites, starting with asset GC's `markDirty`) and a rule that committed
   objects are never mutated in place. Keep the full diff as a debug-build
   assertion while migrating.
2. Add a non-timing bound that would catch a regression back to O(collection):
   count rows serialized or objects copied per create at 0 and 1,900 notes.

### Qualification

- Re-run the payload bench and a 1,900-note create profile before and after,
  on a quiet host.

## Constraints and rationale

- A throwing mutation must never corrupt the committed manifest, and every
  changed row must still be persisted. Those are why the copy and the full
  diff exist; any replacement must keep both guarantees.
- No on-disk format change is needed.
- Rated low: about 20 ms of CPU per write at the cap on a loaded host, with
  bounded I/O. Raise it if collections near the cap become common or a
  profile shows annotation commits on a hot path.

## Open questions

- Is a JSON round-trip copy (about 15% cheaper than `structuredClone` in a
  noisy measurement) an acceptable interim step? It changes edge cases
  (`undefined`, `NaN`), so it would need its own audit.

## Needs verification

- The 2026-10-25 table was taken on a heavily loaded host; repeat it quietly.

## Related

- [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md)
- [storage.md](../../architecture/storage.md) (`updateStore`, leases, atomic
  commits).
- Flake [0225](../../tests/flaky-tests/previews-annotations-and-gateway/0225-design-and-bench-aggregate-timeouts.md).

## Replaces

- The "Create cost grows with the collection (low)" item in 0044 (located
  there, moved here as new work).
