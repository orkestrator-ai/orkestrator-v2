# Design service, design history and annotation bench: aggregate-load failures (`apps/backend`)

- **ID:** 0225
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Tests and files:**
  - `design service (legacy adapters over prepare/execute) > missed events, expired replay and generation changes reset through changes()`
    (`apps/backend/src/core/design-service.test.ts`): failed at 7,968.31 ms.
  - `design history: per-actor undo/redo, checkpoints and budgets > the per-canvas entry budget prunes the oldest entries and their checkpoint files`
    (`apps/backend/src/core/design-history.test.ts`): failed at 5,058.19 ms, past
    Bun's five-second default.
  - `large collections > creation cost stays flat as the collection grows (no whole-history rewrite)`
    (`apps/backend/src/core/web-annotation-payloads.bench.test.ts:448`):
    `expect(batchMs[2]!).toBeLessThan(Math.max(batchMs[0]! * 4, 2_000))`
    received 2,171.66 against a 2,000 bound.
- **Original command:** `mise run test:logged -- --name full-suite-2 -- mise run test`
  on the default PATH, with the standard group slots. Other workers' suites
  were running on the same host; the backend package took 318 s here against
  237 s in a run earlier the same day.
- **Suite counts:** backend 7,703 passed, 39 skipped, 3 failed (7,745 tests,
  423 files). The root group's one failure was a contract violation in a new
  test, fixed in the same change; bridges and protocol passed.
- **Isolated reruns:** `bun test --preload ../../tests/setup-node.ts ./<file> --parallel=1`
  from `apps/backend`: `design-service.test.ts` 10 passed (3.52 s),
  `web-annotation-payloads.bench.test.ts` 6 passed (0.59 s),
  `design-history.test.ts` 13 passed (1.07 s).
- **Evidence:** `/tmp/orkestrator-test-run.UxUv6S/` and `/tmp/orkestrator-test-run.vdLl4e/`.
- **Hypothesis:** host contention. Two of the cases exceeded their timeout and
  the third is a wall-clock benchmark. All three run SQLite-backed design or
  annotation storage introduced by #969. Not confirmed.

## Design parts resolved (2026-10-16)

The two design timeouts are fixed; the annotation bench stays open here, owned
by [0044-web-annotation-qualification.md](../../todo/previews-and-annotations/0044-web-annotation-qualification.md).

- The design service replay case is [0218](0218-design-service-replay-aggregate-timeout.md),
  resolved by reaching the change-log bound in 12 commits instead of 260.
- The history entry-budget case made 55 sequential fsynced edits (about
  0.36 s alone). It now lowers `historyEntriesPerCanvas` to
  `PROTECTED_HISTORY_ENTRIES + 3` with `withDesignLimit` and makes 11 edits.
  A new in-memory case ("the shipped entry budget keeps exactly the newest
  entries") checks the shipped 50-entry bound through `appendEntry`. Neither
  case is an ordering bug, and no deadline was raised.

## Annotation bench resolved (2026-10-17)

The last open part, the creation-cost bound in
`web-annotation-payloads.bench.test.ts`, is fixed. The case compared whole-batch
totals: 60 sequential, fully synced creates per batch, so a few writes stalled
by a contended disk could push the third batch past `max(first * 4, 2 s)` even
though the typical create had not changed. It now times each create and compares
the median create of the third batch with the first (`max(first * 4, 2 s / 60)`).
A whole-history rewrite would still fail, because it slows every create. A burst
of stalled fsyncs moves the median only when it hits more than half the batch.
No bound was raised, and the 60-second total bound stays.

- Measured alone on macOS (`main` at `31d0fb06`): medians 0.50 ms (first batch)
  and 1.47 ms (third), totals 34 ms and 92 ms.
- Eight concurrent copies of the quota and bench files, twice, on a host with
  load average about 13 (18 cores): all passed, 2.2 to 2.7 s each.
- The measurement also shows that the cost of a create grows linearly with the
  collection (median 0.34 ms empty, 1.34 ms at 500, 2.84 ms at 1,000 and
  4.11 ms at 1,900 annotations). That is not quadratic and not a flake. It is
  recorded as a follow-up in
  [0044-web-annotation-qualification.md](../../todo/previews-and-annotations/0044-web-annotation-qualification.md).

## Review correction (2026-10-17)

The median gate above retained a `2 s / 60` floor (33.33 ms per create), so
it did not reliably detect the named whole-history rewrite. The benchmark now
uses temporary SQLite triggers on its real storage connection to count inserted
and updated rows and their UTF-8 bytes for every create, including the store's
document envelope. Later creates must write no more rows than the first and
stay within a fixed 2 KiB byte allowance. Rewriting unchanged history therefore
fails independently of fsync stalls. Median timings remain diagnostic and the
60-second total deadline remains a stalled-run guard. The known in-memory
collection cost remains the separate follow-up above.

Negative control: a temporary copy that executes `UPDATE store_rows SET value = value`
after every create failed on the second create (25 writes against the initial
18-write allowance). The probe was removed. Its expected-failure evidence is
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.FVOrgp/annotation-rewrite-negative.log.gz`.
The unmodified benchmark passed all six cases with the new gate.
