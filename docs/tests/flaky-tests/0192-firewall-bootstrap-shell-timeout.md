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
