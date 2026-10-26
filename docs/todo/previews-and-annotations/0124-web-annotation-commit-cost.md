# Web annotation commit cost grows with the collection

Checked against `main` at `ba7cc8d4` (2026-10-25); code work done on
2026-10-26 on top of `93018933`.

Every write to an environment's web annotations (create, reply, resolve,
request state changes) used to cost CPU in proportion to everything the
environment already held. Found while closing
[0044-web-annotation-qualification.md](0044-web-annotation-qualification.md)
("Create cost grows with the collection"). It is not a correctness problem and
the SQLite writes per commit stay bounded; it matters only once collections
approach the 2,000-note cap.

## Current state

- **Fixed on 2026-10-26.** A commit now serializes only the rows it changed.
  How it works is in
  [web-page-annotations.md](../../architecture/web-page-annotations.md#commit-cost)
  ("Commit cost"); in short:
  - Committed row values and containers are deep-frozen
    (`freezeRowValue`, `web-annotation-store-rows.ts`), so an unchanged
    reference is an unchanged row and an in-place write throws.
  - A transaction works on a copy-on-write manifest
    (`apps/backend/src/core/web-annotation-working-manifest.ts`): a collection
    is shallow-copied on first touch through a proxy that records the keys
    written. Changes replace rows or use `tx.edit(collection, key)`.
  - `planChangedRows` plans only the written rows; `planRows` (the full diff)
    remains for the legacy import and repair, and checks every commit's plan
    under `bun test` (`verifyRowPlans`, `assertSameRowPlan`).
- Before (the 2026-10-25 table, median CPU ms per create, a host at load ~45
  on 18 cores; a quiet host measured 0.34 / 1.34 / 2.84 / 4.11 ms on
  2026-10-17):

  | Notes | Create | Manifest copy | Row diff |
  | --- | --- | --- | --- |
  | 0 | 1.8 | 0.25 | 0.29 |
  | 500 | 8.4 | 4.0 | 3.2 |
  | 1,000 | 15.0 | 7.3 | 6.9 |
  | 1,900 | 21.3 | 11.4 | 10.3 |

- After, 2026-10-26, `bun scripts/web-annotation-commit-profile.ts`, 25
  creates per level, run back to back with the same script on a checkout of
  `93018933` (18 cores, load 10–31 from other workers, so compare
  proportions):

  | Notes | Create before (ms) | Create after (ms) | Rows serialized after |
  | --- | --- | --- | --- |
  | 0 | 1.7–2.8 | 1.3–2.6 | 6 |
  | 500 | 7.9–9.3 | 1.5–2.4 | 6 |
  | 1,000 | 13.8–14.8 | 1.8–3.2 | 6 |
  | 1,900 | 18.1–28.3 | 2.6–3.8 | 6 |

  A `--cpu-prof` run at 1,900 notes puts the SQLite statement execution first
  (about a third of samples); the remaining collection-sized work is pointer
  copies (row maps, the touched collections) and container freezes.
- Payload bench (`web-annotation-payloads.bench.test.ts`, same host, same
  session): the three 60-create batches of the growth case took 47 / 73 /
  111 ms before and 26 / 28 / 30 ms after (median create 0.68 → 1.70 ms
  before, 0.37 → 0.44 ms after). Rows and bytes written per create are
  unchanged (9 rows, 4,174–4,496 bytes). The other cases are within noise.

## Outstanding work

### Code

1. ~~Make a commit cost O(changed rows).~~ Done 2026-10-26: copy-on-write
   working manifest with write-tracking collection copies, frozen committed
   rows as the rule that committed objects are never mutated in place, and a
   row plan driven by the written keys (`planChangedRows`). Every mutation
   site that edited rows in place now replaces the row or edits it through
   `tx.edit` (threads: `requireMutable`/`requireEditable`, `appendEntry`,
   `editEntryIndex`, `referenceAssets`; requests: send, retarget, withdraw,
   handoff, `applyStateInTx`, cancel, response capture; results:
   `settleResultsInTx`, `writeResult`; store: asset GC, evidence cleanup;
   migration: legacy variants). The full diff runs as a debug assertion on
   every commit under `bun test`. Evidence: the 298 annotation tests pass with
   the assertion on; `web-annotation-working-manifest.test.ts` (7 cases);
   `web-annotation-storage.test.ts` "a mutation that writes into a committed
   row is refused and commits nothing".
2. ~~Add a non-timing bound.~~ Done 2026-10-26: each commit reports
   `storage_commit_rows_serialized` and `storage_commit_collections_copied`;
   `web-annotation-payloads.bench.test.ts` "commit CPU per create follows the
   changed rows, not the collection (rows serialized)" asserts a create at
   1,900 notes (9,512 index rows) serializes 6 rows and copies 5 collections,
   exactly as at 1 note.

### Qualification

- Re-run the payload bench and a 1,900-note create profile before and after.
  Done on 2026-10-26 on a loaded shared host (numbers above). **Still owed:**
  the same pair on a quiet host. With nothing else running, from a checkout of
  this change and one of `93018933`:

  ```sh
  bun scripts/web-annotation-commit-profile.ts --json
  WEB_ANNOTATION_BENCH_OUT=/tmp/web-annotation-bench.json \
    bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
    ./src/core/web-annotation-payloads.bench.test.ts --parallel=1
  ```

  Copy `scripts/web-annotation-commit-profile.ts` into the older checkout
  first (it only uses the service and the metrics snapshot). Record the
  tables here, then delete this file.

## Constraints and rationale

- A throwing mutation must never corrupt the committed manifest, and every
  changed row must still be persisted. Frozen committed rows keep both: a
  write the commit would not see throws and rolls back instead.
- No on-disk format change was needed, and none was made.
- Rated low: what remains is a measurement on a quiet host.

## Assumptions and decisions

- **How to find changed rows without a diff.** Options: (a) declare every
  change through `tx.touch`-style calls at the ~85 call sites; (b) a deep
  copy-on-write proxy (immer-like) over every row; (c) freeze committed rows
  and give the transaction write-tracking shallow copies of the collections.
  Chose (c). Pros: no row is copied or serialized unless replaced; reads are
  plain property reads; a missed site fails loudly (TypeError, rollback)
  rather than silently skipping a write, which (a) cannot guarantee. Cons:
  every in-place write had to be converted (done for every `mutate` callback
  in the backend), and a path no test reaches would now throw where it used to
  work; the full-diff assertion in tests and the freeze together make such a
  path visible as soon as any test touches it.
- **Freeze in production too.** Options: freeze only under tests, or always.
  Chose always. Pros: the invariant holds where it matters, and freezing costs
  O(changed rows) per commit (each new row once; parsed rows once on load).
  Cons: code outside a transaction that mutated a manifest object (already a
  latent bug) now throws.
- **What still copies.** Options: share the row maps and collection objects
  between snapshots and mutate them after commit, or copy them. Chose to copy
  (shallow, pointer-only): the previous snapshot stays intact for readers that
  hold `store.manifest` across an `await` and for a commit that rolls back.
  Pros: simple reasoning, no reader sees a half-applied commit. Cons: about
  0.1–0.3 ms of pointer copies at 1,900 notes on a loaded host.
- **Write tracking through a `Proxy` without a `get` trap.** A first version
  diffed every key of each touched collection by reference; at 1,900 notes
  that was the largest remaining cost (about 18% of a create profile). The
  proxy records only `set`/`delete`/`defineProperty`, so lookups stay plain
  reads and iteration costs a little more. Whole-collection assignment
  (`tx.manifest.requests = {}`) falls back to a full key diff of that
  collection.
- **Debug assertion scope.** `verifyRowPlans` defaults to on under
  `NODE_ENV=test` and off elsewhere; it compares rows, JSON, deletions and the
  order within each group, not position numbers (new positions may be
  numbered differently). The bench growth case turns it off because it adds
  O(collection) work to every timed create.
- **Draft commits.** The draft index (256 drafts at most) is still cloned in
  full and every draft row is planned; it is bounded and was not part of the
  growth.
- **Open question from before: JSON round-trip copy as an interim step.**
  Not needed: no copy of the manifest remains, so the `undefined`/`NaN` audit
  it would have required is moot.

## Needs verification

- The before/after tables above were taken on a heavily loaded shared host;
  repeat them on a quiet one (see Qualification).

## Related

- [0044-web-annotation-qualification.md](0044-web-annotation-qualification.md)
- [web-page-annotations.md](../../architecture/web-page-annotations.md)
  ("Commit cost").
- [storage.md](../../architecture/storage.md) (`updateStore`, leases, atomic
  commits).
- Flake [0225](../../tests/flaky-tests/previews-annotations-and-gateway/0225-design-and-bench-aggregate-timeouts.md).

## Replaces

- The "Create cost grows with the collection (low)" item in 0044 (located
  there, moved here as new work).
