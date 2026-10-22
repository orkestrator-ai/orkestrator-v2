# Cursor bounded-recovery contract scenario times out at saturation (bridges/cursor-bridge/src/conformance-bridge-contract.test.ts)

- **ID:** 0270
- **Former branch ID:** 0265; renumbered when merging main to avoid its command-fixture case ID.
- **Status:** resolved
- **Date observed:** 2026-10-16
- **Test:** `bridge HTTP contract: cursor > bounded-recovery-summary: runtime-health reports bounded recovery state within its limits at saturation`
- **Owner:** `bridges/cursor-bridge/src/conformance-bridge-contract.test.ts` (adapter), scenario in `tests/conformance/bridge-contract/scenarios.ts`
- **Original command:** `bun run test:bridge` in `bridges/cursor-bridge` (`bun test src --preload ../../tests/setup-node.ts --only-failures --parallel=${ORKESTRATOR_TEST_WORKERS:-1}`), run by Turbo inside the bridges group of the CI "Unit and integration tests" job.
- **Worker configuration:** GitHub Actions Linux runner; the aggregate test groups ran concurrently, with the other bridge packages running alongside the Cursor bridge.
- **Failure:** `this test timed out after 5000ms` (5000.11 ms in run 38900879850, 5000.07 ms in run 38904091991).
- **Suite counts:** both runs 719 pass, 1 fail, 724 tests across 39 files (31.66 s and 38.85 s).
- **Runs:** 38900879850 (`fix/coordinator-hosted-network-lockdown`, 24eef339) and 38904091991 (`main`, d00f2a07). Neither change touches `bridges/cursor-bridge`.
- **Isolated rerun:** `bun test ./src/conformance-bridge-contract.test.ts --preload ../../tests/setup-node.ts` from `bridges/cursor-bridge` passed unchanged: 10 pass, 0 fail in 0.63 s. On its own the scenario took 0.38 to 0.43 s (JUnit reporter, three runs).

## Hypothesis

The Cursor adapter's `saturateBoundedState` hook fills the steer journal to
its production limit (`MAX_STEER_JOURNAL`, 256) through the real steer route.
Each accepted steer publishes the state file when it is admitted and again
when it is delivered. Every publication fsyncs both the temporary file and
the state directory. This is the same cost as cases 0216 and 0240.

## Root cause

The scenario's time went on durable flushes. A temporary copy of the
unchanged adapter counted the persistence-seam calls. The saturation scenario
made **1,028 fsyncs**, about 514 publications. The other nine contract
scenarios made 44 in total. On macOS, `handle.sync()` is cheap, so the scenario
finishes in about 0.4 s. On a loaded Linux runner disk, each fsync can take
milliseconds. With a simulated 10 ms fsync and no other change, the same
copy failed locally with the CI signature,
`bounded-recovery-summary … [5000.65ms]` / timed out after 5000 ms.

The work is legitimately bounded: 257 HTTP steers and about 514 state-file
writes. It does not hang and it does not miss a wakeup. The time is all in
flushes, which this scenario does not assert.

## Fix

This branch changes `bridges/cursor-bridge/src/conformance-bridge-contract.test.ts`.
`saturateBoundedState` replaces only `fsyncFile` and `fsyncDirectory` with
no-ops through `usePersistenceFsForTests`. The adapter's `stop()` restores
them in a `finally` after `harness.close()` drains persistence. This follows
the 0216 and 0240 approach. The production limits, the real steer route and
admission stay unchanged. Writes, renames, the publication queue and
runtime-health also stay real. `persistence-durability.test.ts` still owns
flush ordering. The shared scenario is unchanged: according to
`capabilities.ts`, only Cursor supports `bounded-recovery-summary`. Codex,
Claude, Pi and ACP mark it not applicable and have no saturation hook.

## Verification

- Simulated 10 ms fsync (temporary instrumented copy, since deleted):
  before, 1,028 fsyncs and the scenario timed out at 5000.65 ms. After, the
  whole file made 46 fsyncs and passed 10/10 in 1.10 s.
- Simulated 10 ms fsync, 10 reruns, with 18 `yes` busy loops and the Codex,
  Claude and Pi bridge suites running concurrently: 100/100 passed. The
  slowest scenario run was 0.60 s.
- CPU stress with 18 busy loops and concurrent Codex/Claude suites, real
  fsync, `-t bounded --rerun-each 10`: before, the slowest run was 1.25 s.
  After, it was 1.16 s. The slowest of the other runs were 0.88 to 0.93 s.
- `bun test ./src/conformance-bridge-contract.test.ts --preload ../../tests/setup-node.ts --rerun-each 30`:
  300 pass, 0 fail, 11.56 s. Under stress, `--rerun-each 20`: 200 pass, 0 fail.
  The slowest saturation run was 0.82 s.
- Full package suite: `bun run test:bridge` in `bridges/cursor-bridge`
  passed 724, 0 fail, in 26.57 s.
