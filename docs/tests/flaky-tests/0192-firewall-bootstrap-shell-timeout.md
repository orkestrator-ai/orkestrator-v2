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

The final root/support run with all GNU prerequisites timed out this case at 5004.45 ms. The unchanged complete owning file then passed sequentially with the flake-index contract owner (35.6 seconds, exit 0). Exact commands, counts and evidence are in [0500](0500-agent-mail-main-merge-validation.md). No implementation, assertion, skip or timeout changed.

## ScheduleWakeup follow-up main merge — 2026-10-21

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-full-tests -- mise run test`.
- **Workers:** workspace/root/bridge/protocol reservations 4/1/2/1; one isolated root worker, alongside component and isolated-stack browser checks.
- **Failure:** `GitHub ranges come from a fresh backend seed, else live, else this container's cache` exceeded five seconds (5003.85 ms), with one dangling process killed.
- **Root counts:** 3186 passed, one skipped, one failed across 3188 tests in 151 files (366.62 seconds).
- **Owning-file rerun:** the same GNU-tool PATH with `mise run test:logged -- --name merge-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 32.3 seconds logged).
- **Evidence:** `orkestrator-test-run.d10zQ4/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Assessment:** confirms another intermittent shell-fixture deadline. Contention remains an unproven hypothesis; no implementation, assertion, timeout or skip changed.

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
