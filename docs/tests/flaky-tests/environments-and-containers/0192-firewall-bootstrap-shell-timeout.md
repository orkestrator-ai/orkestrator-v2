# container firewall policy > firewall uses stored domains and tolerates a repeated GitHub bootstrap range

- **ID:** 0192
- **Status:** open
- **Date observed:** 2026-10-12
- **Owning file:** `tests/unit/firewall-policy.test.ts:269`
- **Original command:** `PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" mise run test:logged -- --name shell-fixtures -- bun test ./tests/unit/migrate-copy.test.ts ./tests/unit/firewall-policy.test.ts ./tests/unit/firewall-refresh.test.ts ./tests/unit/test-diagnostic-bounds.test.ts --parallel=1 --only-failures`
- **Worker configuration:** one isolated Bun worker; the repository suite and browser suite were also running on this host.
- **Failure:** `expect(result.exitCode).toBe(0)` received `null`, followed by Bun's five-second test timeout at 5003.69 ms and `killed 1 dangling process`.
- **Suite counts:** 48 total, 47 passed, 1 failed; 35.50 seconds.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.esofJy/shell-fixtures.log.gz`
- **Isolated rerun:** the same `PATH` prefix with `mise run test:logged -- --name firewall-policy-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed in 13.2 seconds.
- **Hypothesis:** this shell-fixture case exceeded its outer five-second budget while other validation commands were running. The owning file passed with the same GNU tool selection on its isolated rerun. Concurrent load is a possible contributor, but the root cause has not been established. The terminal-toolbar change does not modify the firewall or its fixtures.

## Recurrence during merge validation (2026-10-12)

- **Original command:** the GNU-tool `PATH` prefix above with `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** three isolated root-suite workers; workspace and bridge groups ran concurrently under the aggregate runner.
- **Failures:** the stored-domains/bootstrap-range case again received `null` instead of exit code `0` at line 269 and timed out after 5003.27 ms. The related `policy 2 narrows host access to named ports and records what it applied` case received the same result at line 332 and timed out after 5002.96 ms.
- **Root-suite counts:** 5,035 total, 5,009 passed, 24 skipped, 2 failed; 207.53 seconds.
- **Isolated rerun:** the same GNU-tool `PATH` prefix with `mise run test:logged -- --name merge-firewall-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed in 8.3 seconds.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.zbwgoU/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** both shell-fixture cases exhausted their outer five-second deadline during aggregate validation. Their owning file passed alone; the root cause remains unconfirmed. The merge resolution changes only flake documentation.

## Recurrence 2026-10-13 (GitHub clone review fixes)

- **Original command:** the GNU-tool `PATH` prefix above with
  `mise run test:logged -- --name fix-full-tests -- mise run test`.
- **Worker configuration:** three root workers alongside workspace and bridge
  groups; browser validation was also running.
- **Test:** `GitHub ranges come from a fresh backend seed, else live, else this container's cache`.
- **Failure:** expected exit code `0`, received `null`; outer five-second timeout
  after 5,018.58 ms.
- **Root-suite counts:** 5,047 total, 5,018 passed, 24 skipped, 5 failed;
  221.60 seconds. The other failures were three diff-stat timeouts and a new
  bounded-diagnostics assertion corrected in this change.
- **Isolated rerun:** the same GNU-tool `PATH` prefix with
  `mise run test:logged -- --name isolate-firewall -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`
  passed in 12.1 seconds.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.FOIo01/root-and-agent-support-tests.log.gz`.
- **Hypothesis:** another shell-fixture case exhausted the same outer deadline
  during aggregate validation and passed unchanged alone; root cause unconfirmed.


## Recurrence during dependency-review validation (2026-10-13)

- **Original command:** the same GNU-tool `PATH` prefix with
  `mise run test:logged -- --name review-full-after-fixture-fix -- mise run test`.
- **Worker configuration:** three isolated root workers; workspace and bridge groups ran concurrently under the aggregate runner.
- **Test:** `container firewall policy > policy 2 narrows host access to named ports and records what it applied`.
- **Failure:** expected exit code `0`, received `null` at line 332; outer five-second timeout at 5,004.28 ms.
- **Root-suite counts:** 5,061 total, 5,036 passed, 24 skipped, 1 failed (192.17 seconds).
- **Isolated rerun:** the same GNU-tool `PATH` prefix with
  `mise run test:logged -- --name firewall-policy-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`
  passed unchanged in 12.6 seconds, exit 0.
- **Evidence:** `orkestrator-test-run.DSYU0h/root-and-agent-support-tests.log.gz` and `summary.json` in the macOS temporary directory.
- **Hypothesis:** repeats the previously recorded policy-2 shell-fixture deadline under aggregate load. Root cause remains unconfirmed; no assertion, timeout or skip was changed.

## Recurrence during merge conflict validation (2026-10-13)

- **Original command:** the GNU-tool `PATH` prefix from the testing guide with
  `mise run test:logged -- --name merge-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol used 2/3/2/1 slots;
  root files used three isolated Bun workers. Browser validation also ran.
- **Root-suite counts:** 5,073 total, 5,044 passed, 24 skipped, 5 failed and
  1 additional error across 256 files in 238.08 seconds. Workspace, bridges,
  protocol and browser groups passed.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.6mi44l/root-and-agent-support-tests.log.gz`
  and the adjacent `summary.json`.
- **Test:** `GitHub ranges come from a fresh backend seed, else live, else this container's cache`
  expected exit code `0`, received `null`, and exceeded its five-second
  deadline at 5,010.75 ms.
- **Isolated rerun:** the same GNU-tool PATH with
  `mise run test:logged -- --name merge-firewall-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 8.7 seconds.
- **Hypothesis:** the aggregate deadline failures match earlier observations;
  unchanged owning files pass alone. Contention may contribute, but the root
  cause remains unconfirmed. No assertion, timeout or skip was changed.

## Separate deterministic failure on a BSD tool PATH (2026-10-15)

`docs/2026-10-14/05-real-stack-suite-host-dependencies.md` recorded a case in
this file failing on every run. That was not this timeout. Without the
testing guide's GNU-tool PATH, macOS `date` rejects the `date -d` that
`docker/firewall-domains.sh` uses for range stamps and expiry times. The
fixture now puts Homebrew's GNU tools first on its own PATH
(`tests/unit/gnu-shell-tools.ts`), and the date-dependent case skips with the
install command when they are absent. This open entry still tracks only the
aggregate-load timeouts.

## Execution-policy conformance main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64). Workspace/root/bridge/protocol reservations were 4/1/2/1 slots; browser validation ran alongside it.
- **Failure:** `GitHub ranges come from a fresh backend seed, else live, else this container's cache` exceeded 5000 ms (5011.54 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge-firewall-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 9.7 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IG0vGk/root-and-agent-support-tests.log.gz`.
- **Assessment:** the isolated pass confirms intermittence; root cause remains unconfirmed. No assertion, timeout or skip changed.

## Worktree persistence main merge recurrence — 2026-10-18

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-full-tests -- mise run test`; workspace/root/bridge/protocol reservations of 4/1/2/1 slots, with one isolated root worker on the shared macOS host.
- **Failures:** `policy 3 allowlist  EXAMPLE.COM:443/tcp  chooses blocked HTTPS probe example.net` exceeded five seconds (5028.54 ms); `GitHub ranges come from a fresh backend seed, else live, else this container's cache` also timed out (5085.98 ms).
- **Root counts:** 3050 passed, one skipped, four failed across 140 files (909.82 seconds executing). The other failures were Pi runtime staging and a missing README installer URL, restored in this merge.
- **Owning-file rerun:** the same GNU-tool PATH with `mise run test:logged -- --name merge-firewall-alone -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, 12.7 seconds logged.
- **Evidence:** `orkestrator-test-run.IqZNat/root-and-agent-support-tests.log.gz` below the platform temporary directory.
- **Assessment:** confirmed intermittent fixture timeouts; host contention remains an unconfirmed hypothesis. No assertion, timeout or skip changed.

## Agent-mail main merge recurrence — 2026-10-19

The final root/support run with all GNU prerequisites timed out this case at 5004.45 ms. The unchanged complete owning file then passed sequentially with the flake-index contract owner (35.6 seconds, exit 0). Exact commands, counts and evidence are in [0500](../aggregate-validation-runs/0500-agent-mail-main-merge-validation.md). No implementation, assertion, skip or timeout changed.

## ScheduleWakeup follow-up main merge — 2026-10-21

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-full-tests -- mise run test`.
- **Workers:** workspace/root/bridge/protocol reservations 4/1/2/1; one isolated root worker, alongside component and isolated-stack browser checks.
- **Failure:** `GitHub ranges come from a fresh backend seed, else live, else this container's cache` exceeded five seconds (5003.85 ms), with one dangling process killed.
- **Root counts:** 3186 passed, one skipped, one failed across 3188 tests in 151 files (366.62 seconds).
- **Owning-file rerun:** the same GNU-tool PATH with `mise run test:logged -- --name merge-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 32.3 seconds logged).
- **Evidence:** `orkestrator-test-run.d10zQ4/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Assessment:** confirms another intermittent shell-fixture deadline. Contention remains an unproven hypothesis; no implementation, assertion, timeout or skip changed.

## Service preview rollout full suite — 2026-10-22

- Command: `mise run test:logged -- --name full-tests-0042 -- mise run test` on branch `todo-0042-service-preview-rollout-a6b636a9b237` (`b83ae534` plus the service preview rollout working tree, which does not touch this test's code), macOS 26.6.2 arm64, default `mise run test` groups, host load average 15 to 60 (above 400 earlier in the hour).
- Failure: a different case of the same shell-fixture family, `container firewall policy > policy 3 allowlist example.com:80 chooses blocked HTTPS probe example.com`, at 5007.90 ms (`exitCode` null; "killed 1 dangling process"). Root and agent-support: 3241 passed, 1 skipped, 1 failed across 3243 tests in 155 files (268.62 s).
- Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.iQtiOF/root-and-agent-support-tests.log.gz`.
- Isolated rerun: `mise exec -- bun test tests/unit/firewall-policy.test.ts` passed unchanged (24 passed) at load 11.

Second full suite on the same branch (2026-10-22): `mise run test:logged -- --name full-tests-0042-2 -- mise run test` on branch `todo-0042-service-preview-rollout-a6b636a9b237` (`b83ae534` plus the service preview rollout working tree), macOS 26.6.2 arm64, default groups, load average 10 to 22. `container firewall policy > policy 3 allows address, protocol and port tuples` timed out at 5004.36 ms (`exitCode` null). Root and agent-support: 3240 passed, 1 skipped, 2 failed across 3243 tests in 155 files (283.56 s); the workspace, bridges and protocol groups passed. Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.fDVMln/root-and-agent-support-tests.log.gz`. `mise exec -- bun test tests/unit/firewall-policy.test.ts` passed unchanged (24 passed, 17.6 s).

## MCP external-edit watch review fixes — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`; workspace/root/bridges/protocol reserved 4/1/2/1 slots, with one isolated root worker.
- **Failures:** five-second deadlines in `container firewall policy`:
  - `policy 3 allows address, protocol and port tuples` (5003.75 ms).
  - `policy 2 allowlist example.org,example.com chooses blocked HTTPS probe example.net` (5007.32 ms).
  - `policy 3 allowlist example.org,example.com chooses blocked HTTPS probe example.net` (5002.49 ms).
  - `policy 3 allowlist example.com:443 chooses blocked HTTPS probe example.net` (5003.21 ms).
  - `policy 3 allowlist example.com:443/tcp chooses blocked HTTPS probe example.net` (5004.44 ms).
- **Root counts:** 3218 passed, one skipped and five failed across 3224 tests in 154 files (277.79 s). Complete aggregate exit 1 after 822.1 s. Backend also hit the recorded 0248, 0512 and 0673 timing failures; all other workspace packages, bridges and protocol regeneration passed.
- **Initial owning-file reruns:** `mise run test:logged -- --name firewall-policy-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed all five original failures but timed out `policy 3 allowlist  EXAMPLE.COM:443/tcp  chooses blocked HTTPS probe example.net` (5012.26 ms; 23 passed, one failed, 46.2 s). `mise run test:logged -- --name firewall-policy-owner-final -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` instead timed out `policy capture records policy 3 and refuses an unknown version` (5003.95 ms; 23 passed, one failed, 24.8 s). The aggregate was still running during these reruns.
- **After-aggregate rerun:** `mise run test:logged -- --name firewall-policy-after-aggregate -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed the complete unchanged file (exit 0, 37.9 s logged).
- **Evidence:** `orkestrator-test-run.jhZR27/root-and-agent-support-tests.log.gz`, `orkestrator-test-run.6wl0bW/firewall-policy-owner.log.gz` and `orkestrator-test-run.rhzy0n/firewall-policy-owner-final.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent fixture deadlines. Different cases timed out on successive runs; host load exceeded 50 during validation. Scheduling contention remains an unproven explanation. No implementation, assertion, timeout or skip changed.

## Design canvas qualification recurrence — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` (default PATH, no GNU-tool override) on branch `todo-0036-design-canvas-qualification-1477f37ca3cf`, while other worktrees and a production Orkestrator instance loaded the host (load averages 11–44).
- **Failure:** nine `container firewall policy` cases exceeded five seconds (5003–5006 ms), among them `firewall uses stored domains and tolerates a repeated GitHub bootstrap range`, `policy 2 narrows host access to named ports and records what it applied`, `policy 3 allows address, protocol and port tuples` and six blocked-HTTPS-probe allowlist cases.
- **Root counts:** 3210 passed, one skipped, nine failed across 3220 tests in 154 files (297.1 seconds). Workspace, bridges and codex-lockfile groups passed.
- **Owning-file rerun:** `mise run test:logged -- --name firewall-policy-alone -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1` passed unchanged (exit 0, 37.5 seconds logged).
- **Evidence:** `orkestrator-test-run.9G0J8K/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Assessment:** the same shell-fixture deadlines under host load; the branch does not touch the firewall or its fixtures. No implementation, assertion, timeout or skip changed.

## CI-health branch aggregate — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`
  (with `PORT` unset) on `todo-0030-test-suite-ci-health`, macOS arm64, Bun
  1.4.3, host load average 21–27 from other sessions.
- **Failure:** 11 `container firewall policy` cases timed out at 5,000 ms,
  including `GitHub ranges come from a fresh backend seed, else live, else this
  container's cache` (5,003.98 ms) and `firewall uses stored domains and
  tolerates a repeated GitHub bootstrap range`. Root/support reported 3,209
  passed and 11 failed (234.7 s).
- **Isolated rerun:** `mise run test:logged -- --name firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`
  passed unchanged (22.7 s).
- **Evidence:** orkestrator-test-run.UPlMVd orkestrator-test-run.FNlm01 under the host temporary directory.
- No implementation, assertion, timeout or skip changed.

## Canonical allowlist change — 2026-10-22

- **Original command:** `mise run test:logged -- --name changed -- mise run test:changed`, on a host whose load average was about 69 from other worktrees' suites.
- **Failure:** ten `container firewall policy` cases (including `firewall uses stored domains and tolerates a repeated GitHub bootstrap range` and `root bootstrap records network policy once and ignores later caller values`, which runs no allowlist code) each exceeded five seconds.
- **Root counts:** 1433 passed, one skipped, 22 failed across 1456 tests in 38 files (167.4 seconds); the other twelve failures are 0199's file.
- **Owning-file reruns:** `bun test ./tests/unit/firewall-refresh.test.ts ./tests/unit/firewall-policy.test.ts --parallel=1` through `test:logged` still timed out three policy cases at five seconds (36 passed, 78.98 seconds, load still high). The same command with `--timeout 30000` passed all 39 (39.75 seconds). Before the aggregate run, the same two files passed at the default deadline (27.2 seconds logged).
- **Evidence:** `/tmp/orkestrator-test-run.pQullD/root-and-agent-support-tests.log.gz`.
- **Assessment:** another load-bound shell-fixture deadline; the change touched the firewall's default list, but the timed-out cases include one that never reads it and all pass with a longer deadline. No assertion, timeout or skip changed.

## Egress qualification review observation — 2026-10-22

- **Original command:** `mise run test:logged -- --name complete-tests -- mise run test`, Bun 1.4.3 on macOS arm64; workspace/root/bridges/protocol reservations 4/1/2/1 with one isolated root worker. Other worktrees also ran suites.
- **Failures:** ten existing firewall-policy cases exceeded five seconds (5004–5012 ms): the policy-3 tuple case, eight blocked-probe selection cases (policy 2 and policy 3), and the GitHub seed/live/cache case. Each shell result was `null` instead of exit code zero.
- **Root counts:** 3216 passed, one skipped and 11 failed across 3228 tests in 156 files (305.32 seconds); the remaining failure was Pi vendoring. The new default-boot and egress qualification regressions passed.
- **Owning-file rerun:** `mise run test:logged -- --name firewall-policy-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` still timed out `policy 3 allowlist example.org,example.com chooses blocked HTTPS probe example.net` at 5003.58 ms (23 passed, one failed; 43.8 seconds logged).
- **Evidence:** `orkestrator-test-run.MSqERJ/root-and-agent-support-tests.log.gz` after aggregate completion and `orkestrator-test-run.3n8i8Z/firewall-policy-isolated.log.gz` below the host temporary directory.
- **Assessment:** this observation does not independently confirm a flake because the unchanged owner also failed alone. The registered fixture timeout remains a validation limitation; host contention is a hypothesis. No existing firewall implementation, assertion, timeout or skip changed.
- **After aggregate completion:** `mise run test:logged -- --name firewall-policy-after-aggregate -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` also exceeded five seconds in the uppercase policy-3 blocked-probe case (5018.89 ms; 23 passed, one failed; 47.9 seconds logged). Evidence: `orkestrator-test-run.kK9Fhh/firewall-policy-after-aggregate.log.gz`. This leaves the existing owner unresolved at its unchanged deadline.
- **Aggregate outcome:** exit 1 after 624.2 seconds, with root/support, bridges and workspace groups failing; Codex protocol regeneration passed. All new regressions, static checks, live egress qualification and the isolated Docker scenario suite passed.

## CLI qualification review — 2026-10-22

- `mise run test:logged -- --name review-complete-suite -- mise run test`, with workspace/root/bridges/protocol reservations 4/1/2/1 and one root worker, timed out both `policy 2 allowlist example.org,example.com chooses blocked HTTPS probe example.net` (5005.48 ms) and its policy 3 counterpart (5007.47 ms). Both expected process exit 0 and received null.
- `mise run test:logged -- --name review-firewall-rerun -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 40.1 s).
- Evidence: `orkestrator-test-run.GxEUIl/root-and-agent-support-tests.log.gz` below the host temporary directory after aggregate completion. This confirms intermittent shell-fixture deadlines; no firewall code, assertion, timeout or skip changed.

## Coordinator peer conformance review recurrence — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; one isolated root worker on a shared host running another checkout's aggregate suite.
- **Failures:** `policy 2 narrows host access to named ports and records what it applied` and `policy 3 allows address, protocol and port tuples` returned a null exit code and exceeded five seconds (5003.20 ms and 5005.68 ms).
- **Root counts:** 3216 passed, one skipped and three failed across 3220 tests (298.35 seconds). The other failure was Pi vendoring (0514). Workspace, bridges and protocol groups passed.
- **First owning-file rerun:** `mise run test:logged -- --name firewall-policy-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed both original failing cases, but `firewall uses stored domains and tolerates a repeated GitHub bootstrap range` exceeded its five-second deadline (5025.72 ms): 23 passed, one failed, 45.5 seconds logged. Evidence: `orkestrator-test-run.O9XqXs/firewall-policy-isolated.log.gz` below the host temporary directory.
- **After the aggregate finished:** `mise run test:logged -- --name firewall-policy-after-suite -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed all 24 unchanged cases (exit 0, 27.3 seconds logged).
- **Aggregate evidence:** `orkestrator-test-run.Aiu72Z/root-and-agent-support-tests.log.gz`, with outer summary in `orkestrator-test-run.4usC0x/full-suite.log.gz`, below the host temporary directory.
- **Assessment:** the final isolated pass confirms intermittence. Host contention remains a hypothesis; no firewall implementation, assertion, timeout or skip changed.

## Native-agent collaborator merge recurrence — 2026-10-23

- Initial merge validation: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1, one isolated root worker.
- `container firewall policy > GitHub ranges come from a fresh backend seed, else live, else this container's cache` in `tests/unit/firewall-policy.test.ts` timed out after 5068.08 ms at its unchanged five-second deadline. The aggregate was subsequently interrupted to include newly arrived main commits, so it has no complete root-suite counts; workspace, bridges and protocol passed before interruption.
- Complete unchanged owner rerun: `mise run test:logged -- --name merge-firewall-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed (exit 0, 13.8 s).
- Aggregate evidence: `orkestrator-test-run.JCIgd6/root-and-agent-support-tests.log.gz` below the host temporary directory; wrapper evidence: `orkestrator-test-run.JxjaBc/merge-tests.log.gz`.
- The isolated pass confirms an intermittent shell-fixture deadline. Host contention remains a hypothesis; no firewall implementation, assertion, timeout or skip changed.

## Command-handover repair follow-up — 2026-10-23

`mise run test:logged -- --name handover-tests -- mise run test` timed out
`GitHub ranges come from a fresh backend seed, else live, else this container's
cache` at 5007.56 ms. The root group had 3382 passed and one failed test.
`mise run test:logged -- --name handover-firewall-owner -- bun test
./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed the
complete unchanged owner in 19.6 s. Original group evidence is
`orkestrator-test-run.AW4scv/root-and-agent-support-tests.log.gz` under the host
temporary directory. No firewall implementation, assertion, timeout or skip changed.
- **Recurrence (2026-10-24, node mbp3):** failed again in the todo-0050 aggregate (5005.02 ms) and when the owner was rerun alone under load average 16 to 35; `main` at `71227437` failed the same file the same way under the same load. See case 0632's recurrence for the comparison.

- **Recurrence 2026-10-24 (node mbp3, Control MCP voice branch `todo-0041-control-mcp-voice-4a2c0ccc548b`):** failed in both `mise run test` aggregates (artifacts `orkestrator-test-run.SqxFKk` and `orkestrator-test-run.NcXAI6` under `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/`); the unchanged owner `tests/unit/firewall-policy.test.ts` passed alone (24 pass, 0 fail). The branch does not touch this area.

## Todo 0038 branch — 2026-10-24

`mise run test` on node mbp3 timed out every shell-driven case in
`tests/unit/firewall-policy.test.ts` (13 of 24) at the five-second deadline,
including the cases tracked in 0632. The owner rerun
`mise run test:logged -- --name firewall-owner -- bun test
./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` timed out the
same way, so this observation is not proof of a flake on its own: the host load
average was 27–30 throughout, with two other branches' full suites running
concurrently (verified by process working directory). Original evidence:
`orkestrator-test-run.HJXL9J/root-and-agent-support-tests.log.gz` and
`orkestrator-test-run.BVK8nM/firewall-owner.log.gz` under the host temporary
directory. The branch does not touch `docker/` or the firewall test; no
implementation, assertion, timeout or skip changed. Supports the
host-contention hypothesis.

## Coordinator read-only adapters (0026) — 2026-10-24, node mbp3

`mise run test:logged -- --name full-test -- mise run test` (default
reservations) failed four firewall cases in the root group with `exitCode`
`null` at about 5,003 ms: `firewall uses stored domains and tolerates a
repeated GitHub bootstrap range`, `policy 2 narrows host access to named ports
and records what it applied`, `policy 3 allows address, protocol and port
tuples` and `policy 3 allowlist example.org,example.com chooses blocked HTTPS
probe example.net`. Group evidence:
`orkestrator-test-run.B9wLO2/root-and-agent-support-tests.log.gz` under the
host temporary directory.

Three isolated reruns of the complete owner
(`mise run test:logged -- --name firewall -- bun test ./tests/unit/firewall-policy.test.ts`)
also failed, 12 or 13 of 24 cases, all on the same five-second deadline, with
the host's one-minute load average between 16 and 38 (other agents were
running). The same file at the branch's base commit (`8454d18b`, fresh
worktree, `bun install --frozen-lockfile`) failed 13 of 24 the same way at load
13 to 25. The branch changes nothing under `docker/` or in the firewall tests,
so this run adds no pass-alone evidence; it does strengthen host contention as
the cause. No firewall implementation, assertion, timeout or skip changed.

After rebasing onto `a5d78cfc`, the same `mise run test` run failed only
`GitHub ranges come from a fresh backend seed, else live, else this container's
cache` and `policy 3 allowlist example.com,example.net:443,example.org:443/tcp
chooses blocked HTTPS probe` (root group 3381 passed, 2 failed; every other
group passed) at a one-minute load average of 55. Evidence:
`orkestrator-test-run.2r3jf8/root-and-agent-support-tests.log.gz`. The owner
rerun alone at load 31–46 still timed out (`orkestrator-test-run.yb5lB7`).

## Container state observation (0020) recurrence — 2026-10-24

- **Original command:** `mise run test` on `todo-0020-container-state-observation-5c2ca9cd8360` after rebasing onto `origin/main` `a5d78cfcd`, default worker plan, host load average 15–22 from other work on the node.
- **Failure:** the root group timed out twelve firewall shell-fixture cases across `tests/unit/firewall-policy.test.ts` and `tests/unit/firewall-refresh.test.ts` at about 5003–5010 ms.
- **Owning-file rerun:** `mise run test:logged -- --name firewall-alone -- bun test ./tests/unit/firewall-policy.test.ts ./tests/unit/firewall-refresh.test.ts --parallel=2 --only-failures` still failed the same twelve cases under the same load (27 pass, 12 fail). The same command on a clean `origin/main` worktree failed the identical twelve cases, so the change under test does not cause them. Not rerun at lower load.
- **Evidence:** `orkestrator-test-run.lPZA8F/firewall-alone.log.gz` under the host temporary directory. No firewall implementation, assertion, timeout or skip changed.

## Recurrence during 0016 validation (2026-10-24)

- **Failure:** `GitHub ranges come from a fresh backend seed, else live, else this container's cache` and `policy 2 narrows host access to named ports and records what it applied` timed out at about 5,004 ms.
- **Original command:** `mise run test:logged -- --name full-test-2 -- mise run test`
  on branch `todo-0016-slash-command-catalogue` after rebasing onto `712274379`,
  node mbp3, other worktrees validating on the host.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.CfvSIY/full-test-2.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name firewall-alone -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1` passed (21.1 s).
- **Disposition:** recurrence confirmed by the isolated pass. No assertion,
  deadline or skip was changed.
- **Again after rebasing onto `a5d78cfcd` (full-test-3):** 15 firewall cases hit
  the five-second budget (evidence
  `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.xqyQcT/full-test-3.log.gz`).
  The owning file also failed alone twice while the host load average was 33
  to 98 (3 and more cases at about 5,008 ms), then passed alone (24 passed,
  0 failed) once the one-minute load fell to 10. The branch changes no
  firewall test or `docker/` script.

## Control MCP voice main-merge validation — 2026-10-24

- **Command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-full-tests -- mise run test`; root used one isolated worker alongside other host work.
- **Root result:** 3,368 passed and 15 failed across 162 files (863.15 s execution, after 460.5 s waiting). Twelve failures were in `firewall-policy.test.ts`, including the bootstrap-range, policy-2, policy-3, probe and GitHub seed/live/cache cases at roughly five seconds. The other failures were two firewall-refresh cases and Pi runtime vendoring.
- **Complete unchanged owner rerun:** the same GNU-tool PATH with `mise run test:logged -- --name merge-0041-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` reported 14 passed and ten failed (63.5 s); policy-3 tuples, eight probe cases and GitHub seed/live/cache still exhausted five seconds.
- **Evidence:** host temporary-directory `orkestrator-test-run.LK1I3Y/root-and-agent-support-tests.log` (retained from the interrupted aggregate) and `orkestrator-test-run.bXjwa2/merge-0041-firewall-owner.log.gz`.
- **Assessment:** the owner remains non-green, so this observation does not independently confirm a flake or its cause. Host load exceeded 100 during validation. No firewall implementation, assertion, deadline or skip changed.

- **Aggregate disposition:** the outer logged runner reached its 1800000 ms deadline after the workspace and bridge groups waited 1708.7 s and 1782.4 s for host capacity. Those groups are incomplete; the protocol-lockfile check passed. Outer evidence: `orkestrator-test-run.WDZkGn/merge-full-tests.log.gz`. Static checks and all 28 changed owner test files passed separately on the combined merge.

## Coordinator adapters main merge — 2026-10-24

Original command: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1. GitHub seed/live/cache timed out at 5008.03 ms in the aggregate. `mise run test:logged -- --name merge-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` also failed (21 passed, three different five-second timeouts; 52.7 s). This run adds no independent pass-alone confirmation.

Full failure names, counts, evidence paths and unresolved limitations are in [0724](../aggregate-validation-runs/0724-coordinator-adapters-main-merge-validation.md). No implementation, assertion, timeout or skip changed. The original aggregate remains non-green.

## Recurrence — 2026-10-24 (worktree signal review validation)

- **Original command:** `mise run test:logged -- --name watcher-full-suite -- mise run test`; standard aggregate worker leases, with other checkout validation active on the host.
- **Failures:** root bootstrap (5003.91 ms), stored domains/bootstrap ranges (5004.00 ms), policy 2 host ports (5007.96 ms), and policy 3 address/protocol/port tuples (5014.03 ms) timed out, receiving null subprocess exit codes.
- **Follow-up:** a one-worker rerun of the complete firewall and disk-report owners failed a different firewall probe case (`policy 2 allowlist example.org,example.com chooses blocked HTTPS probe example.net`, 5010.36 ms); the four original firewall cases passed. The disk-report case also timed out again. This rerun is retained as a failed result, without attributing a cause to host load.
- **Evidence:** `orkestrator-test-run.iTzv5K/` under the host temporary directory; the full aggregate remains failed. None of these owning files was changed.
- **Separate complete-owner rerun:** `mise run test:logged -- --name watcher-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` failed again: policy 3 tuples (5240.73 ms), the policy 2/3 example.org/example.com probes (5002.97/5005.95 ms), and the policy 3 example.com:443/tcp probe (5004.92 ms); 20 passed, four failed in 53.46 seconds. No new complete-owner pass was established. Evidence: `orkestrator-test-run.gFLKmk/watcher-firewall-owner.log.gz`.

## Agent accounts and sign-in (0003) validation — 2026-10-24

Recurred in the non-iOS aggregate on node mbp3 (thirteen `container firewall policy` cases at ~5,003 ms); the unchanged owner passed alone (24 passed). Details in [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md). No implementation, assertion, timeout or skip changed.

## Agent accounts main merge — 2026-10-24

The broad run and complete unchanged owner both retained five-second failures. This is not newly classified as a flake. Exact commands, counts and artifacts are in [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md#merge-through-main-8290f2ca9--2026-10-24). No assertion, deadline or skip changed.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 48.4 s: `mise run test:logged -- --name design-links-owner-firewall -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.

## Container state observation main merge — 2026-10-24

- **Parents:** feature `66a9736cc0c663bef147a65fc2d158e1951482dd` and main `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`.
- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`; workspace/root/bridge/protocol reservations 4/1/2/1, alongside component, isolated-browser, Electron and Docker validation on the same host.
- **Aggregate failure:** GitHub seed/live/cache fixture exceeded five seconds (5021.43 ms), receiving null process status.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` failed: 22 passed, two failed in 49.11 s. Seed/live/cache timed out at 5040.02 ms, and the policy-3 address/protocol/port probe timed out at 5024.83 ms.
- **Evidence:** `orkestrator-test-run.bFHIz7/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.ixE6Kq/merge-firewall-owner.log.gz` below the host temporary directory.
- **Assessment:** no new complete-owner pass or cause was established; this observation is not newly classified as flaky. No implementation, assertion, timeout or skip changed.


## Transcript-history refresh through main `95c9cb46` — 2026-10-24

The integrated default suite timed out the stored-domain/repeated-range case at 5020.35 ms (root/support: 3,398 passed, one failed, 260.67 s). The complete unchanged owner retained seven five-second failures, including this case at 5007.20 ms: seventeen passed, seven failed, 60.0 s logged. It is not newly classified as a flake. Exact commands, merge parents, artifacts and the other owner failures are recorded in [0789](../aggregate-validation-runs/0789-transcript-history-main-refresh-validation.md). The test and firewall script are unchanged between the merge parents; no new cause was established and no deadline or assertion changed.

## Control MCP voice merge through `95c9cb46a` — 2026-10-24

- **Parents:** `3f04356fd947464d652e31709ac3c3e8a7c45823` and `95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d`; base `0014505caeed69395b3cc996dd541fcc6df12c23`.
- **Aggregate command:** testing-guide GNU-tool PATH with `ORKESTRATOR_TEST_AREA_BASE=0014505caeed69395b3cc996dd541fcc6df12c23 mise run test:logged -- --name merge95-tests -- mise run test`. Root used one isolated worker: 3,380 passed and two failed across 161 files (241.63 s execution). `policy 2 narrows host access to named ports and records what it applied` timed out at 5006.33 ms; `policy 3 allowlist  EXAMPLE.COM:443/tcp  chooses blocked HTTPS probe example.net` at 5007.44 ms.
- **Complete unchanged owner:** the same GNU-tool PATH with `mise run test:logged -- --name merge95-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` reported 21 passed and three failed (39.0 s). Policy 2 host ports (5004.52 ms), policy 3 tuples (5020.40 ms), and the policy 2 example.org/example.com probe (5007.94 ms) exhausted five seconds. The aggregate's upper-case probe case passed on this rerun.
- **Evidence:** host temporary artifacts `orkestrator-test-run.N9YUtx/root-and-agent-support-tests.log.gz` and `orkestrator-test-run.YEJsXs/merge95-firewall-owner.log.gz`.
- **Assessment:** this complete owner remains non-green; no new flake classification or cause is established. Neither `tests/unit/firewall-policy.test.ts` nor `docker/firewall-domains.sh` differs from the merge base. No implementation, assertion, deadline or skip changed for this observation.

- **Completed aggregate:** workspace (web, backend, desktop, web-public, CLI, protocol, toolchain), bridge and protocol-lockfile groups passed; only the two root firewall timeouts remained. The outer command exited 1 after 638.3 s. Full evidence: `orkestrator-test-run.lyZaoe/merge95-tests.log.gz`; group evidence is under `orkestrator-test-run.N9YUtx/`. Static checks and the flake-index contract test passed on the merged result.
