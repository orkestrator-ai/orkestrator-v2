# Toolchain stamp comparison collides within one millisecond

- **ID:** 4041
- **Status:** open
- **Observed:** 2026-11-04
- **Test:** `verified stamps across launches > an explicit full verification ignores stamps`
- **File:** `packages/toolchain/src/manager-stamps.test.ts`

`NODE_ENV=test mise run test` failed this test at line 257 (`expect(received).not.toBe(expected)`,
`Expected: not "1793753123435000000"`, 2.61 ms), the only failure in that run
(backend 14,030 passed, web 11,785 passed, toolchain 123 passed and 1 failed; root
and bridge groups passed).

Run alone it is also intermittent: 2 of 5 under `test:logged`, then 7 of 20 with
`bun test --cwd packages/toolchain ./src/manager-stamps.test.ts --parallel=1 --only-failures`,
on a 16-core Linux host. The change under test at the time touched nothing in
`packages/toolchain`, and the package does not import the backend's `shell.ts`.

Likely cause, from reading the code and not from a fix: `file-stamps.ts:231` sets
`stampedAtNs` to `BigInt(now()) * 1_000_000n`, so it has millisecond resolution,
and the test asserts that a re-stamp changed the value. Two launches inside one
millisecond produce equal values even though the file was verified again; the
failing value ends in `000000`, which fits. The `Tests (workspace)` shard passed in
the recent `main` runs checked, so CI runners may rarely be this fast. No test or
source changed for this case.

## Recurrence on 2026-11-05 (C7 review fixes)

`mise run test:logged -- --name fixes-aggregate-stable -- mise run test` failed
this case in the toolchain's two-worker parallel run (1.94 ms):
`Expected: not "1793877007271000000"`. Backend passed 15,530 tests, web passed
12,607, and root, bridges and protocol-lockfile groups passed. The run finished
in 200.3 seconds with this sole failing test. Evidence:
`/tmp/orkestrator-test-run.M5e9Ab/fixes-aggregate-stable.log.gz` (outer log),
`/tmp/orkestrator-test-run.Obd3SP` (aggregate group artifacts).

Isolated rerun:
`NODE_ENV=test mise run test:logged -- --name fixes-toolchain-triage -- bun test --cwd packages/toolchain ./src/manager-stamps.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
passed the whole owner (exit 0, 0.1 seconds). The branch diff does not change
`packages/toolchain` or this test. The equal millisecond-derived stamp matches
the existing hypothesis; no implementation or assertion was changed.
