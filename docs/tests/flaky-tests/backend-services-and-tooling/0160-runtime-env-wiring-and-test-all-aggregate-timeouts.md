# Runtime environment wiring and test-all aggregate timeouts

- **ID:** 0160
- **Status:** open
- **Date observed:** 2026-09-23
- **Tests:** 19 cases in `container runtime environment wiring` (for example
  `Codex configuration copy helpers enforce file and directory bounds` and
  `runtime helper creates a bash env file with expected contents and
  permissions`) and 5 in `scripts/test-all.ts` (for example `serializes full
  suites across linked worktrees and cleans stale leases`)
- **Files:** `tests/unit/runtime-env-wiring.test.ts`,
  `tests/unit/test-all.test.ts`
- **Original command:** `mise run test` (first full run on branch
  `slash-commands-support-3b13a4bc3b08-r1`)
- **Worker configuration:** the root and agent-support group ran concurrently
  with the bridge and workspace groups.
- **Failure:** every case failed with "this test timed out after 5000ms"
  (one after 15,000 ms). Root group: 4,317 pass, 4 skip, 26 fail; the other two
  failures in that run were real regressions, fixed before the rerun.
- **Isolated rerun:**
  `bun test tests/unit/runtime-env-wiring.test.ts tests/unit/test-all.test.ts`
  passed 106 of 106. A second full `mise run test` passed the root group
  entirely.

## Current assessment

Shell-spawning cases hitting Bun's default five-second budget together, then
passing alone and in the next aggregate run, points to host contention rather
than a defect in the tests. Related history: 0078 (a single runtime-env-wiring
timeout) and 0055 (test-all concurrency). Keep open until a recurrence narrows
the cause.

## Recurrence on GitHub Actions `main` (2026-10-15)

- **Test:** `container runtime environment wiring > Claude setup block copies
  the allowlist, skips history, and drops only the symlinked command`
  (`tests/unit/runtime-env-wiring.test.ts:1928`).
- **Original command:** `mise run test` in the `Unit and integration tests` job
  of `lint.yml` on `ubuntu-latest` (four vCPUs). It failed in 4 of the 15
  completed `main` runs on 2026-10-14 and 2026-10-15: runs 38709501165
  (`404b1f3b`), 38713152559 (`0e48ad38`), 38719540712 (`1369ea7b`) and
  38748749506 (`9fb4e6a8`).
- **Worker configuration:** root group one Bun worker, bridges two, the
  workspace group one package task at a time with one Bun worker.
- **Failure:** `expect(result.exitCode).toBe(0)` received `null` after
  5,007.21 ms; Bun reported `killed 1 dangling process`, the harness's `bash`.
  It was the only case from this file to fail.
- **Suite counts:** root group 2,958 pass, 1 skip, 1 fail across 135 files
  (run 38709501165) up to 2,978 pass, 1 skip, 1 fail across 137 files
  (run 38748749506).
- **Isolated rerun (macOS arm64):** `mise run test:logged -- --name
  rerun-runtime-env-wiring -- bun test ./tests/unit/runtime-env-wiring.test.ts
  --parallel=1 --only-failures` passed all 63 tests, wrapper duration 5.6 s. The
  case alone takes 0.3 s.
- **Assessment:** the same five-second budget as the original entry, now on a
  single case and repeatedly on a four-vCPU runner. The Claude block runs many
  short shell commands, so it is the most exposed to process-spawn contention.
  No test or production code was changed.

## Recurrence on pull request #999 and an explicit budget (2026-10-15)

The same case failed again at 5,007.22 ms on pull request #999's first CI run
(run 38764110814), the only failure in a run where every other group passed,
which makes 5 of 16 CI runs. It is always this one case, always killed exactly
at Bun's five-second default, and it passes in the other runs, so it is a slow
case under load rather than a hang. The block evaluates the whole copy-helper
set and runs dozens of short processes, like the Codex copy-helper case in the
same file that already carries a 15-second budget. It now carries the same
budget. The assertions are unchanged. Keep this entry open until CI shows the
case passing consistently.

## Unread-toast main merge recurrence — 2026-10-16

- **Original command and workers:** `mise run test:logged -- --name merge-tests -- mise run test`, with system Python and the testing guide's GNU utilities available in PATH. Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated workers and root used one. Component and isolated-stack browser validation ran alongside it.
- **Test:** `container runtime environment wiring > Codex configuration copy failures warn and do not stop startup`.
- **Failure:** `copyResult.exitCode` was null instead of 0 at the 5000 ms deadline (5004.79 ms).
- **Suite counts:** root/support 2,997 passed, one skipped, three failed and one error across 3,001 tests (402.27 s).
- **Isolated rerun:** `mise run test:logged -- --name merge-runtime-env-isolated -- bun test ./tests/unit/runtime-env-wiring.test.ts --parallel=1 --only-failures` passed the unchanged owning file in 12.0 s with the same PATH preference.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.Gj6LAK/root-and-agent-support-tests.log.gz`.
- **Assessment:** recurrence confirmed; shared-host process contention remains a hypothesis. No assertion, timeout or skip changed.

## Idle-observation main merge recurrence — 2026-10-21

`container runtime environment wiring > Codex setup copies the complete allowlist, secures auth, and excludes plugin runtime state`
exceeded the five-second deadline at 5056.80 ms in the three-file, one-worker
`merge-root-owners` run (124 passed, one failed, 86.7 seconds). The entire
unchanged `runtime-env-wiring.test.ts` passed alone in 20.8 seconds. Exact
commands and evidence are in
[0515](../aggregate-validation-runs/0515-idle-observation-main-merge-validation.md). No assertion, deadline
or skip changed; shared-host contention remains a hypothesis.

## Preview qualification main merge, 2026-10-21

`mise run test:logged -- --name merge-tests -- mise run test` repeated a
five-second timeout in `Codex setup copies the complete allowlist, secures auth,
and excludes plugin runtime state` (5,374.65 ms; shell exit status was null).
The complete unchanged owner passed with `mise run test:logged -- --name
preview-main-merge-runtime-owner -- bun test ./tests/unit/runtime-env-wiring.test.ts
--parallel=1 --only-failures` (exit 0, 51.4 s). The aggregate used one root
worker beside workspace and bridge groups and other host validation. No timeout
or assertion changed. Full-run evidence and other unresolved failures are in
[0623](../aggregate-validation-runs/0623-preview-main-merge-validation.md).

## Coordinator adapters main merge — 2026-10-24

Original command: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1. `Codex setup copies the complete allowlist, secures auth, and excludes plugin runtime state` timed out at 5043.80 ms. `mise run test:logged -- --name merge-owner-runtime-env -- bun test ./tests/unit/runtime-env-wiring.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (16.0 s).

Full failure names, counts, evidence paths and unresolved limitations are in [0724](../aggregate-validation-runs/0724-coordinator-adapters-main-merge-validation.md). No implementation, assertion, timeout or skip changed. The original aggregate remains non-green.
