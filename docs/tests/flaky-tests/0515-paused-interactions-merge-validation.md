# Paused-interaction qualification main-merge validation

- **ID:** 0515
- **Status:** open
- **Date observed:** 2026-10-21
- **Merge:** `origin/main` at `d4171748` into `eb9da37a` on
  `qualify-paused-interactions-past-10min-2a03d32f86f4`.
- **Confirmed intermittent owner:** `tests/unit/host-test-scheduler.test.ts`,
  `resource exclusion, queue bounds, cancellation and frozen budgets`.
  `mise run test:logged -- --name merge-tests -- mise run test` reported a
  5090.30 ms timeout against the 5000 ms deadline in the one-worker root group.
  `mise run test:logged -- --name merge-owner-host-test-scheduler -- bun test
  ./tests/unit/host-test-scheduler.test.ts --parallel=1 --only-failures` passed
  the complete unchanged owning file (exit 0, 16.8 seconds logged).
- **Configuration:** the aggregate requested workspace/root/bridges/protocol
  reservations of 4/1/2/1 slots. Every group initially queued behind the host's
  18 reserved worker slots; root/support was admitted after 437.6 seconds.
  Browser, Electron and Docker checks also ran on the host. Host contention is
  a hypothesis, not an established cause.
- **Evidence:** aggregate outer log directory `orkestrator-test-run.qew3QD`,
  root/support directory `orkestrator-test-run.xNKvA2`, below the host temporary
  directory. Passing owner output was removed by `test:logged` as designed.
- **Changes:** evidence only; no implementation, assertion, timeout or skip was
  changed to hide a failure.

## Other validation limitations

These observations do not independently establish flakes:

- Root owners `firewall-refresh`, `firewall-policy`, `pi-bridge-vendor`,
  `test-diagnostic-bounds` and `disk-report` timed out in the aggregate and in
  separate unchanged owning-file reruns with `--parallel=1`. Their logged
  reruns took 36.8, 37.9, 36.2, 40.1 and 7.8 seconds respectively. Failing
  evidence directories: `orkestrator-test-run.yhO7yd`, `.RCCqFb`, `.2vR2O9`,
  `.OJWdSR` and `.lgnb1M` (each suffix uses the `orkestrator-test-run` prefix).
- `mise run test:agent:browser:isolated`, through `test:logged` as
  `merge-browser`, reached its 15-minute browser deadline (948.4 seconds
  including lifecycle). It reported narrow host-picker, capped-file-tree and
  both host-maintenance viewport failures before stopping at case 24/70.
  Its disposable `qa-browser-308ee3d5-6b9` profile was stopped/reset.
  Evidence: `orkestrator-test-run.L04OZf`.
- `mise run test:agent:electron`, logged as `merge-electron`, finished with
  19 passed, one skipped and three failed in 1204.5 seconds: both regular
  `electron-main.spec.ts` window scenarios timed out, and terminal resume
  could not find its project/environment entry. Evidence:
  `orkestrator-test-run.edAmg1`.
- `mise run test:agent:docker`, logged as `merge-docker` against credential-free
  profile `merge-main-validation`, finished with seven passed, two skipped and
  two failed in 750.0 seconds. The new access-only Codex/Grok import test
  reached its `docker rm --force` cleanup, which exceeded 30 seconds; a later
  exact-owner inventory found no remaining test container. The rebuild case
  could not find `Before a rebuild` after reload. Artifact sanitization also
  rejected that case's trace above its 16 MiB limit. The new withheld-login
  summary passed, including environment switching and reload. Evidence:
  `orkestrator-test-run.Hb55Bk`.
- The complete unchanged rebuild owner repeated its missing recovery-copy
  label failure (177.9 seconds logged, `orkestrator-test-run.sQipza`).
- The unchanged terminal-resume Electron owner repeated its missing
  project/environment entry failure (132.0 seconds logged,
  `orkestrator-test-run.7a9v3y`).
- The unchanged Electron-main owner repeated both regular window failures
  (two failed, one passed, one skipped; 285.6 seconds logged,
  `orkestrator-test-run.cJSkfv`). The first exceeded 120 seconds; the
  nickname case timed out waiting for the persisted remote label.
- The complete gateway owner rerun used the same disposable profile with
  Docker enabled and one worker. It finished with 16 passed, four skipped
  and three failed (664.0 seconds): narrow host picker, capped file tree and
  narrow host maintenance. Trace sanitization also exceeded its 16 MiB bound.
  The new access-only import test passed unchanged in this rerun. This does
  not establish that the complete owning file is intermittent. Evidence:
  `orkestrator-test-run.aoiFNv`.
- The aggregate's outer logger reached its configured 1800000 ms deadline
  (1801.0 seconds logged) and terminated the process tree. Workspace tests
  remained queued and were reported incomplete. Root/support had recorded
  failures but did not finish. Protocol regeneration passed after waiting
  1652.0 seconds; bridges were admitted after 1781.7 seconds and the runner
  reported them passed during shutdown. The overall result was exit 1, not
  a passing complete suite. No aggregate pass is claimed.

Formatting, lint, typechecking, the desktop build, the development Docker image
build and focused backend, desktop, renderer and protocol tests passed. Local
Markdown link targets and conflict-marker/whitespace checks passed. CLI scenario,
iOS and billed provider suites were not selected because those implementations
were unchanged; ordinary isolated browser, Electron and Docker scenarios were
selected for the incoming renderer and container changes.

Cleanup: `dev:stop` and `dev:reset` both exited 0 for
`merge-main-validation`; reset removed three exact-owner containers, six
volumes, one network and the disposable profile state.
