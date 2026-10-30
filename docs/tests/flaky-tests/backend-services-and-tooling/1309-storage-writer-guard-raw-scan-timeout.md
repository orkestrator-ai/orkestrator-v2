# Storage writer guard's backend-wide raw-writer scan times out under host load

- **ID:** 1309
- **Status:** open
- **Observed:** 2026-10-26 to 2026-10-28 in aggregate runs on the shared Linux host;
  diagnosed 2026-10-29 on the todo 0214 follow-up branch
  (`todo-0214-storage-file-split-2054bfb3bc39`, docs only, on `main` at
  `79f3bc97e`).
- **Test:** `raw StorageDatabase writers outside StorageService > name the store they write`
  (`apps/backend/src/core/storage-writer-guards.test.ts:1904`)
- **File:** `apps/backend/src/core/storage-writer-guards.test.ts`

## Symptom

The test passes the 5,000 ms default only when the host is lightly loaded. The
recorded failures are all from the shared Linux host, at load averages from
about 11 to over 190 on 12 cores, and the slow times show up both in the aggregate and
when the file runs alone. A clean `origin/main` checkout times out the same way,
so the failures don't come from any of the branches being validated:

| Case | Aggregate | Owner alone |
| --- | --- | --- |
| [1003](../aggregate-validation-runs/1003-legacy-migration-0058-validation.md) | 6,324 ms and 6,450 ms (load 11–22) | passed (2.2 s) |
| [1010](../aggregate-validation-runs/1010-environment-disk-cleanup-0023-validation.md) | 5,550 ms and 5,513 ms (load 40–52) | passed once (4.9 s), then timed out three times at load 44–52, on `main`'s files too |
| [1166](../aggregate-validation-runs/1166-session-titles-0006-validation.md) | 5.4 s | passed |
| [1195](../aggregate-validation-runs/1195-backend-module-state-0133-validation.md) | deadline under load | passed |
| [1200](../aggregate-validation-runs/1200-coordinator-worker-surfaces-0142-validation.md) | deadline (load 58–79) | failed at load 194+, passed on a second run |
| [1247](../aggregate-validation-runs/1247-pending-rename-recovery-validation.md) | 5,109 ms | passed (1.6 s) |
| [1248](../aggregate-validation-runs/1248-project-landing-tab-review-validation.md) | 5,297 ms | timed out again (12.3 s for the file) |
| [1290](../aggregate-validation-runs/1290-idle-spec-sidebar-probe-0199-validation.md) | 7,312 ms and 8,126 ms (load 37–44) | 7,203 ms and 5,146 ms; clean `origin/main` 6,088 ms |
| [1295](../aggregate-validation-runs/1295-keyboard-shortcuts-windows-linux-validation.md) | 5,000 ms (load ~46) | 7.8 s; clean `origin/main` 12.1 s |

Case 1285 lists no failure from this owner. The test is reported to pass on
macOS developer machines, which aren't shared by several worktrees' aggregate
runs.

## Cause

This test pays for the whole backend-wide scan, and it gets that scan done in
time only when it has a CPU core to itself.

- The `describe` block builds `rawDatabaseWrites(backendSources(), …)` lazily
  (`scanned ??=`, `storage-writer-guards.test.ts:1902`). Because
  `name the store they write` is the block's first test, it absorbs all of the
  cost and the other three tests reuse the result.
- The scan reads every non-test `.ts` file under `apps/backend/src` (820 files,
  12.9 MB at `79f3bc97e`), parses each one with `oxc-parser`'s `parseSync`,
  keeps every tree alive in one map, builds line tables, and then walks every
  tree looking for raw `StorageDatabase` writes. When a store argument is a
  helper parameter, the scan resolves it by walking every importer of that
  helper (`callsOf`).
- The work is single-threaded and CPU-bound, with no I/O wait. It also grows
  linearly with the size of the backend source.

Measured on this host at load average about 2. The breakdown is from a
throwaway timed copy of the test file, deleted afterwards:

| Phase | Time |
| --- | --- |
| Read 820 sources | 21 ms |
| `analyzeStorageService()` (only when the test runs alone; otherwise an earlier test has already cached it) | 231 ms |
| `parseSync` of all sources, every tree kept alive | 950 ms |
| Line tables | 67 ms |
| Walk and store-name resolution | 665 ms |

The same `parseSync` loop takes 203 ms in a standalone script that drops each
tree straight away. Keeping 820 trees alive at once is most of the parse cost,
so the likely culprit is garbage-collection pressure.

The whole file alone takes 2.5 s, and this test 1.44 s. In the 111-file focused
storage run with `--parallel=6` (load about 4–6) this test took 3.02 s, 60% of
its budget. At the recorded loads of 34–46, with `mise run test` running other
worktrees' workers on the same 12 cores, a 3–5× slowdown takes it past 5 s. That
matches the 5.1–12.1 s figures above. Nothing about it is specific to Linux. It
only shows up here because this host is shared and oversubscribed.

At load average about 3.5–7 on the same host, a full `mise run test` passed on
2026-10-29 with this test green (4 min 26 s, `orkestrator-test-run.dY5sW1`).

On 2026-10-30, validating todo 0830 (branch
`todo-0830-playwright-temp-leaks-3cee21cf7a2e`, no storage changes), the
backend workspace group of a full `mise run test` failed on this test alone:
`timed out after 5000ms` at 6174.56 ms, with every other workspace package at
0 failures and the root and bridge groups passing. The load average was about
19 just after the run. Rerun alone with
`bun test --cwd apps/backend ./src/core/storage-writer-guards.test.ts
--parallel=1`, the file passed in 6.3 s.

## Status

The test is unchanged: no assertion, timeout or skip was changed. Raising the
budget would only loosen the test without making it any cheaper. The fix belongs
in the test design: parse the backend once per file, share the trees, and parse
files lazily when an import needs them. It is tracked as task 4 of
[0930](../../../todo/backend-structure/0930-storage-test-files-over-size-limit.md).
