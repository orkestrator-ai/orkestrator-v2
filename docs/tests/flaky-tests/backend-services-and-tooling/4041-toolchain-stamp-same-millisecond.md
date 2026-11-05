# Toolchain stamp comparison collides within one millisecond

- **ID:** 4041
- **Status:** resolved
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

## Resolution (2026-11-05)

The cause in 4042 applies here too. The test now waits past a stamp tick
(`nextStampTime` in `manager-stamps.test.ts`, 2 ms) before the second launch; the
assertion is unchanged. It also failed on CI `main` at `e198fd4a7` (run 41887107581).
Fixed on `investigate-ci-f07d88911341-r1`, verified with 40 of 40 passing runs of the file alone on macOS.
