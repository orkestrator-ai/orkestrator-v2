# Public API test-support harness cases time out under host load

- **ID:** 1245
- **Status:** resolved
- **Observed:** 2026-10-28, todo 0724 branch validation
- **Tests:**
  - `failed lifecycle drain still shuts down tracking and removes the fixture`
    (`apps/backend/src/core/public-api/test-support.test.ts:107`)
  - `restart releases the old runtime while the replacement tracks and emits`
    (`apps/backend/src/core/public-api/test-support.test.ts:79`)
- **File:** `apps/backend/src/core/public-api/test-support.test.ts`

Each case builds a full tracked backend harness and exceeds Bun's default
5,000 ms per-test timeout when the host is saturated. Load averages were
100 to 118 throughout (other worktrees held all 18 test-lease slots).

- `mise run test` on the 0724 branch (`d692a7b51`, default lease workers):
  the drain case timed out at 6,427.83 ms; its last assertion then saw the
  fixture root still present (`fs.exists(harness.root)` was `true`, because
  the case was cut short before cleanup finished). Backend: 9,905 pass,
  87 skip, 1 fail across 651 files (135.78 s). Every other group passed.
  Evidence: `orkestrator-test-run.HkUWbY` under the host temporary directory.
- The owner alone on the branch
  (`bun test --cwd apps/backend --parallel=1 ./src/core/public-api/test-support.test.ts`):
  first run failed the restart case at 7,073.06 ms (2 pass, 1 fail), the next
  three runs passed (3 pass).
- The same command on a clean clone of `origin/main` at `1d1f0a87` (own
  install): passed twice, then failed the restart case at 7,449.43 ms
  (2 pass, 1 fail). So the failure is on main as well, not from the 0724
  change, which touches only Multi Review and Build Pipeline dispatch.

Hypothesis: harness start and shutdown (runtime construction, diff-stats
tracking, temporary-root removal) take seconds under this load, so cases
that build two harnesses (restart) or wait for a rejected drain are the first
past 5 s. Not established. No assertion, timeout, skip or implementation
changed.

## Resolution (2026-11-15)

- **Root cause:** the default five-second Bun test/hook budget was spent while the process was starved of CPU on a loaded host; the body is milliseconds to seconds of work when the host is idle and waits on no signal that could be made explicit. The file's gauge case (9993) is a different, signal-based fix recorded there.
- **Fix:** `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`) now sets the default per-test and per-hook budget to 60 s, a hang watchdog that a slow host does not trip. `apps/backend/src/core/public-api/test-support.test.ts` has no smaller explicit budget (no `setDefaultTimeout`, third-argument or hook timeout, and no wall-clock deadline of its own), so the new default applies to it. No assertion, skip or production code changed.
- **Reproduced:** no. Not reproduced here (the host load average was 100 to 180 from other workers' runs, and a contention run of the owner did not finish); the class is established from the recorded timeouts at the 5 s default with the owner passing alone, not from a local failure.
- **Stress:** none specific to this case; the owner passes unchanged in this tree.
