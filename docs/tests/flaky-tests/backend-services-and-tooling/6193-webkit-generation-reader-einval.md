# WebKit generation reader intermittently receives EINVAL

- **ID:** 6193
- **Status:** open
- **Observed:** 2026-11-05 on macOS
- **Test:** `review regressions > exported paths reuse and force refresh; concurrent publishers preserve readers; idle pruning removes retired revisions`
- **File:** `tests/unit/playwright-webkit-host-libs.test.ts:651`

During `mise run test:logged -- --name merge-default-tests -- mise run test`,
the root group (one worker, alongside five workspace and two bridge slots)
failed opening `private/webkit-1/INSTALLATION_COMPLETE` with `EINVAL` in its
concurrent reader. The test took 41.10 ms and also produced an unhandled error.
Root totals: 3,635 passed, four failed, one error, 185 files, 178.24 seconds.
Two failures were flake-register integration issues subsequently corrected;
the remaining sidebar failure reproduced alone.

The complete owner passed alone (exit 0, 0.4 seconds) with:

```sh
mise run test:logged -- --name merge-webkit-alone -- bun test ./tests/unit/playwright-webkit-host-libs.test.ts --parallel=1 --only-failures
```

It also passed in a three-owner serial rerun. The owner matches `origin/main`
at `df4445371740bf3099c5c50876b2dff397b69758`. A race around publishing or
retiring a generation is a hypothesis; the precise filesystem operation that
caused EINVAL is unproved. No implementation, assertion, timeout or skip changed.

Original group evidence is under
`/private/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.o1RGn7/`
(`root-and-agent-support-tests.log`, compressed on aggregate completion).
The outer logged command uses `orkestrator-test-run.Bg16TH/merge-default-tests.log.gz`
under the same temporary root. Passing rerun output was deleted by the runner.

## Reobserved during the projection-hashing merge, 2026-11-05

`mise run test:logged -- --name merge-default -- mise run test` reproduced
the same `EINVAL` at line 651 in 56.54 ms. The root group used one worker
alongside five workspace and two bridge slots: 3,642 passed, two failed,
22,252 assertions across 185 files in 187.42 seconds. The other failure was
`HierarchicalSidebar > bulk-deletes a selected environment that still carries
a stale merge-cleanup error`, which reproduced alone (101 passed, one failed)
because `Delete selected` was absent; it is not classified as a flake. Its
owner and the sidebar implementation match `origin/main` at
`1a66d95c3912708a4b89dc88fa5c80c2e9653381`.

The complete WebKit owner passed alone (exit 0, 0.5 seconds) with:

```sh
mise run test:logged -- --name merge-webkit-rerun -- bun test ./tests/unit/playwright-webkit-host-libs.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `orkestrator-test-run.dmrQu6/root-and-agent-support-tests.log.gz`
under the macOS temporary root recorded above. The isolated sidebar evidence
is `orkestrator-test-run.QkzK4Z/merge-sidebar-rerun.log.gz`. No test assertion,
implementation, timeout or skip was changed.

## Launch override review recurrence — 2026-11-05

Preparation at `2c3a5e7e7a1d8d37d6c95486ac5ee3f2b0cdda73` repeated the same
`EINVAL` at line 651 (44.33 ms), also reported as an unhandled error between
tests. The root group used one worker; the retained aggregate output has no
complete closing root summary, so per-group totals cannot be established.
The original command was
`mise run test:logged -- --name review-default-tests -- mise run test`.
Evidence is preserved in
`.orkestrator/review-artifacts/review-validation-da7187d5-86f1-423c-aa0c-4b906bd32d12/validation-04.stderr.txt`
(lines 478–519). The preparation package marked this failure `undetermined`
(`known-flaky`, `global-change`), because this branch adds a protocol package
export. No WebKit publication, pruning, or owner test code changes in the
branch diff against `origin/main`.

The unchanged complete owner passed alone (exit 0, 2.2 s):

```sh
mise run test:logged -- --name recorded-webkit -- bun test ./tests/unit/playwright-webkit-host-libs.test.ts --parallel=1 --only-failures
```

Passing output was deleted by the logged runner; no per-test totals were
retained. This is another observation of the existing flake, not a root-cause
fix. No assertions, skips, timing budgets, or WebKit implementation changed.

## Environment-deletion main merge — 2026-11-06

`mise run test:logged -- --name merge-default -- mise run test` repeated
`review regressions > exported paths reuse and force refresh; concurrent publishers preserve readers; idle pruning removes retired revisions`
at line 651 with `EINVAL` opening `INSTALLATION_COMPLETE` (11.45 ms).
The root group used one isolated worker; the component browser suite and
isolated gateway smoke were also running. Original evidence is
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.HtWRHT/root-and-agent-support-tests.log.gz`.

The complete unchanged owner passed alone in 1.5 s, exit 0:
`mise run test:logged -- --name merge-webkit-reader-alone -- bun test ./tests/unit/playwright-webkit-host-libs.test.ts --parallel=1 --only-failures`.
Passing output was deleted by the logged runner; no isolated totals are inferred.
No implementation, assertion, timeout or skip changed. The cause remains unproved.

## Coordinator transcript review recurrence — 2026-11-06

At commit `decf86b98`, `mise run test:logged -- --name review-default-tests -- mise run test`
ran the root group with one worker alongside five workspace and two bridge
slots; a five-worker component-browser suite was also active. The same concurrent reader failed with EINVAL at line 651 in 177.14 ms.
The root group finished with 3,638 passed, 10 failed and two errors across
185 files in 821.36 s. Its other failures are not attributed to this case.
Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.JSZUOY/root-and-agent-support-tests.log.gz`.

The unchanged complete owner passed alone with exit 0 in 2.2 s:

```sh
mise run test:logged -- --name review-webkit-owner -- bun test tests/unit/playwright-webkit-host-libs.test.ts --parallel=1 --only-failures
```

Passing output was deleted by the logged runner, so individual passing case
counts were not retained. This branch changes neither this owner nor its
implementation. No assertion, timeout or skip changed. The isolated pass
establishes intermittence; it does not establish the underlying cause.
