# Bridge build startup times out in aggregate validation

- **ID:** 1202
- **Status:** resolved
- **Observed:** 2026-10-27 during first-prompt transcript-confirmation validation.
- **Test:** `dev:test bridge builds > a successful start records bridges before launching the runtime and accepts backend readiness`
- **File:** `apps/desktop/scripts/dev/bridge-builds.test.ts`
- **Original command:** `mise run test:logged -- --name confirmation-repository -- mise run test`.
- **Workers:** aggregate budget of eight slots; workspace ran two package tasks with two Bun workers each, root one worker, bridges two workers, protocol one slot. Other worktrees were also validating; the host capacity queue reported 18/18 slots reserved.
- **Failure:** the test exhausted its 15,000 ms budget at 15,013.58 ms and Bun killed one dangling process. The desktop package reported 1,364 passed, 16 skipped and 13 failed; the other desktop failures concerned missing backend storage exports and known macOS profile-cleanup warnings.
- **Isolated rerun:** `mise run test:logged -- --name unrelated-bridge-builds-rerun -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures` passed unchanged in 1.2 s. The passing logged runner discarded its detailed output.
- **Evidence:** compressed aggregate workspace log at `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.co7PYh/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. The complete aggregate finished in 436.8 s with workspace, root and bridge failures; protocol regeneration passed.
- **Hypothesis:** fixture subprocess startup or shutdown was delayed under concurrent host load. The root cause is not established. No assertion, timeout, or skip was changed.


## Queued-prompt keyboard review recurrence — 2026-10-28

Preparation at `91513d96d` repeated the 15-second startup deadline
(15,021.68 ms), followed by an `EEXIST` between-test error in
`atomicWriteJson`. `mise run test` ran with default workspace/root/bridge/
protocol reservations of 6/1/2/1 alongside nine Playwright workers, failed
its workspace group and finished after 332.2 s. Other aggregate groups passed.
Evidence: `.orkestrator/review-artifacts/review-validation-23a7a6f9-6912-45a3-b66d-327817cf8f1d/validation-04.stdout.txt`.

The complete unchanged owner passed (exit 0, 0.9 s):

```sh
mise run test:logged -- --name recorded-desktop-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures
```

The passing runner discarded detailed output. No bridge-build implementation,
assertion, deadline or skip changed. Concurrent startup contention remains a
hypothesis, not an established cause.

The exact original aggregate command then passed (exit 0, 274.7 s):

```sh
mise run test:logged -- --name review-repair-tests -- mise run test
```

The successful rerun does not establish a flake fix; this case remains open.


## Coordinator timers/account review — 2026-10-30

Preparation at `574bb14b3` repeated the successful-start deadline at
15,010.85 ms during `mise run test`. The complete unchanged owner passed
alone (exit 0, 1.0 s):

```sh
mise run test:logged -- --name recorded-desktop-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures
```

Preparation evidence is in
`.orkestrator/review-artifacts/review-validation-af449b96-aec4-419e-90d3-165bd324e649/validation-05.stdout.txt`.
No desktop implementation, assertion, deadline or skip changed. The cause
remains unconfirmed.

The exact default-suite rerun subsequently passed (exit 0, 170.0 s):

```sh
mise run test:logged -- --name review-repaired-default -- mise run test
```


## Development source-hint coverage validation — 2026-10-30

`mise run test` repeated the same 15-second bridge startup deadline
(15,004.95 ms), followed by an `ENOENT` renaming the temporary profile's
`status.json` after timeout cleanup. The root, bridges and protocol groups
passed; workspace also had the separate settings sign-in case 1317.
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.7r8HZm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The complete unchanged owner passed in 1.5 s:

```sh
mise run test:logged -- --name bridge-builds-owner -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures
```

No bridge implementation, test assertion, timeout or skip changed.

## Pipeline validation-history review, 2026-10-30

`mise run test:logged -- --name repaired-unit-suite -- mise run test` repeated
this unchanged owner failure. The startup case exhausted its 15-second budget (15005.18 ms); desktop totals were 1,363 passed, 16 skipped and one failed.
The complete unchanged owner then passed alone with exit 0 in 1.2 s:

```sh
mise run test:logged -- --name recorded-bridge-builds -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures
```

Aggregate evidence is `orkestrator-test-run.jn7K1f/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. Passing output was removed by the runner.
No owner implementation, assertion, timeout or skip changed; the cause remains
unconfirmed.


## Goal review repair — 2026-10-31

The full `mise run test` rerun repeated the successful-start timeout at
15,010.34 ms. The complete unchanged owner passed alone in 0.9 s:

```sh
mise run test:logged -- --name goal-bridge-owner -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: `orkestrator-test-run.Zau4wx/review-tests.log.gz` in the host temporary
directory. No assertion, timeout or skip changed; the cause remains unconfirmed.

## Settings layout review — 2026-10-31

- **Original command:** `mise run test`, at implementation commit `d639571b2`; workspace reservation six slots with two isolated Bun workers for web/desktop and four for backend, bridges reservation two slots with one worker per provider. The component browser suite also ran on the shared host. The aggregate waited about 658 seconds for capacity and exited 1 after 1461 seconds.
- **Failure:** `dev:test bridge builds > a successful start records bridges before launching the runtime and accepts backend readiness`, `apps/desktop/scripts/dev/bridge-builds.test.ts`, exceeded its 15-second deadline (15006.02 ms). The owning package reported 1393 passed, 16 skipped, two failed across 98 files.
- **Complete unchanged owner rerun:** the following one-worker command passed (exit 0, 1.7 seconds logged). Multi-file commands ran the two complete owners sequentially with Bun isolation. Passing raw output was removed by the bounded logger.

```sh
mise run test:logged -- --name desktop-review-failures-isolated -- bun test --cwd apps/desktop ./tests/preview-partition-retention.test.ts ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures
```

- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.4NhQjk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** recurrence confirmed by the unchanged owner pass. Shared-host scheduling pressure is a hypothesis, not an established cause. No implementation, assertion, deadline or skip in the owning file changed; the aggregate remains non-green.

## Project checkout review recurrence — 2026-10-31

`mise run test:logged -- --name review-default-rerun -- mise run test`
repeated the startup deadline at 15,004.37 ms. Desktop reported 1,382
passed, 16 skipped and one failed across 97 files (33.92 s). The aggregate
reserved workspace/root/bridge/protocol worker budgets of 6/1/2/1, with
concurrent component-browser validation. The complete aggregate failed in
448.2 s, also retaining a missing checkout-local Codex binary and case
0791. Evidence: `orkestrator-test-run.sdHQzL/` and enclosing
`orkestrator-test-run.2RPkIW/` in the host temporary directory.

The complete unchanged owner passed with the required Node preload
(exit 0, 1.6 s):

```sh
mise run test:logged -- --name desktop-bridge-builds -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures
```

An initial exploratory owner command omitted the preload and timed out at
15,007.54 ms (22 passed, one failed; `orkestrator-test-run.OjVhGT`).
That command did not reproduce the aggregate's preload configuration. No
implementation, deadline, assertion or skip changed. Startup contention
remains a hypothesis; the passing owner does not make the aggregate pass.

## Goal main-merge validation — 2026-10-31

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
  The default aggregate reserved workspace/root/bridge/protocol worker budgets
  of 6/1/2/1; web and desktop used two isolated file workers and backend used
  four. No browser suite ran alongside it in this worktree. The logger reported
  679.9 s total, including about 342 s waiting for the shared-host scheduler.
- **Failure:** the successful-start test exceeded its 15-second deadline
  (15010.15 ms). Desktop reported 1,485 passed, 16 skipped and one failed.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-bridge-startup-owner -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed, exit 0, in 0.9 s.
- **Evidence:** `orkestrator-test-run.Am7yHz/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and `orkestrator-test-run.lhybBa/merge-tests.log.gz` below the host temporary
  directory. The aggregate remained non-green. The complete unchanged owner
  passed separately; no owning implementation, assertion, deadline or skip
  changed. The cause remains unconfirmed.

## Automatic account switching validation — 2026-11-01

- **Original command:** `mise run test` at `aefd1d122`, beside `mise run test:browser` with six workers, worktree on `/Volumes/Lexar`, after about 815 s waiting at 18/18 host slots.
- **Failure:** the successful-start test exceeded its deadline (15,005.08 ms), and Bun killed one dangling process. The desktop package task took about 40 s. Case [1652](../aggregate-validation-runs/1652-automatic-account-switching-validation.md) has the rest of the run.
- **Complete unchanged owner:** `bun test scripts/dev/bridge-builds.test.ts` from `apps/desktop` passed, 23 of 23, in 1.0 s.
- **`origin/main` `93b99bfba`: not reproduced.** Five `mise run test` runs in a `/tmp` worktree; two more on `/Volumes/Lexar`, the first beside the full browser suite with six workers; six runs of the desktop package alone; 12 runs of the owner alone under 36 busy loops on 18 CPUs; 22 runs of the desktop package on `/Volumes/Lexar` under 18 busy loops and six disk writers, about 13 to 16 s each against 12 s unloaded.
- **Assessment:** CPU and disk contention produced at this scale do not explain it, so "scheduling pressure" is weaker than earlier entries assumed. The aggregate's parallel file scheduling, or the other worktrees' load at 18/18 slots, were not reproduced here and remain possible. The cause is not established. The branch changes nothing under `apps/desktop`, and this case was first recorded on 2026-10-27, before the branch existed.

## Live logging review repair validation — 2026-11-02

`mise run test:logged -- --name review-repair-default-final -- mise run test`
used workspace/root/bridges/protocol reservations 5/1/2/1 and two desktop workers.
The same successful-start case reached 15,008.42 ms; cleanup then removed the
profile before a late status-file write, producing a secondary ENOENT.
The complete unchanged owner passed alone in 1.5 s:
`mise run test:logged -- --name dev-bridge-builds-owner -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures`.
Evidence: `orkestrator-test-run.haynoB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. No implementation, deadline, assertion or skip
changed. The timing cause remains unconfirmed.

### Final default-suite verification — 2026-11-02

`mise run test:logged -- --name review-repair-default-controlled -- mise run test`
passed all four groups (exit 0, 741.9 seconds including a 540.5-second capacity
wait) at code commit `1144ea780`. The logging shutdown clock fix is in that
commit; the other owners listed here were unchanged. This green aggregate
does not establish a root cause for the still-open intermittent cases.

## CI-failure branch main-merge validation — 2026-11-03

- **Original command:** `mise run test:logged -- --name merge-default-suite -- mise run test`, merging `6ae99a3ed42ccc05ebd85d26289b5b4672712197` into `b949c7bd66b17bfc0914a8c87ebd799c02127284`.
  Workspace/root/bridges/protocol reservations were 6/1/2/1; desktop used two
  parallel workers. The run took 335.8 seconds, including about 127 seconds
  waiting for shared-host capacity.
- **Failure:** `dev:test bridge builds > a successful start records bridges before launching the runtime and accepts backend readiness`
  timed out after 15,003.77 ms (15,000 ms limit). Desktop reported 1,656 passed,
  16 skipped and one failed across 113 files in 30.36 seconds. All other
  aggregate groups passed; the workspace failed only its desktop task.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-desktop-rerun -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed (exit 0) in 0.9 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.EYlHGQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and enclosing `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.qT9K2W/merge-default-suite.log.gz`.
- **Assessment:** another occurrence of the recorded aggregate-only timeout;
  the cause remains unconfirmed. No owning implementation, assertion,
  deadline or skip changed. The aggregate remains non-green despite the
  passing isolated rerun.

## tmux container polling main-merge validation — 2026-11-03

- **Original command:** `mise run test:logged -- --name merge-default-suite -- mise run test`, merging `38ac308448d28ccc592b6add876be3996938a25b` into `b5f221e6305c98f1ccbf46346c6a3a1b251c2f82`.
  Workspace/root/bridges/protocol reservations were 6/1/2/1; desktop used two
  parallel workers. The aggregate took 692.7 seconds, including about 337 seconds
  waiting for shared-host capacity.
- **Failure:** `dev:test bridge builds > a successful start records bridges before launching the runtime and accepts backend readiness`
  timed out at 15,005.14 ms against its 15,000 ms limit. Desktop reported
  1,664 passed, 14 skipped and one failed across 113 files (27.30 seconds).
  All other aggregate groups passed; workspace failed only its desktop task.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-bridge-builds-isolated -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed (exit 0) in 1.1 seconds. Passing raw output was removed by the logger.
- **Evidence:** `/tmp/orkestrator-test-run.UCmFXn/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and `/tmp/orkestrator-test-run.d1a2GX/merge-default-suite.log.gz`.
- **Assessment:** recurrence of the recorded aggregate-only startup timeout;
  the cause remains unconfirmed. No owning implementation, assertion, deadline
  or skip changed. The aggregate remains non-green despite the isolated pass.

## Subagent model review validation — 2026-11-04

- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`
  at `484a44dab`; desktop used two parallel workers.
- **Failure:** `dev:test bridge builds > a successful start records bridges before launching the runtime and accepts backend readiness`
  timed out at 15,011.58 ms (15,000 ms limit). Workspace reported 12 successful
  tasks out of 13; root, bridges, and protocol groups passed. Aggregate duration
  was 1,006.2 seconds.
- **Unchanged owner rerun:** `mise run test:logged -- --name bridge-builds-isolated -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed in 0.9 seconds.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-d7f27449-c867-4416-bd19-f6d8eaa84d93/validation-04.stderr.txt`;
  aggregate artifact `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.lbuwN0`.
- **Assessment:** recurrence of the aggregate-only startup timeout; no owning
  code, assertions, deadlines, or skips changed. Root cause remains unconfirmed.

The exact original aggregate command was rerun after the model fixes. The
bridge-startup owner passed; workspace instead failed the unrelated preview
metrics (3571) and zsh completion (1250) cases. Root, bridges and protocol
passed. The aggregate remains non-green; both newly failing owners passed
unchanged when rerun alone.

## Agent-mail ownership repair validation — 2026-11-05

- Aggregate: `mise run test:logged -- --name address-findings-default-tests -- mise run test`
  at `54f06a272`, exit 1 after 332.0 s. Workspace/root/bridges/protocol
  reservations: 6/1/2/1 slots; desktop used two parallel workers.
- The successful-start case timed out at 15,010.84 ms (limit 15,000 ms).
  Desktop totals were not retained in the aggregate output.
- Complete unchanged owner:
  `mise run test:logged -- --name bridge-builds-preloaded-rerun -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed (exit 0, 0.7 s; passing counts removed by the logger).
  An earlier focused run without the explicit preload also passed in 0.6 s.
- Evidence: `/tmp/orkestrator-test-run.XXv3u7/address-findings-default-tests.log.gz`
  and `/tmp/orkestrator-test-run.QiwA36/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Neither this owner nor its exercised implementation appears in
  `git diff --name-only origin/main...HEAD`. Known open flake recurrence;
  cause remains unconfirmed. No implementation, assertion or timeout changed.
  The ownership repair passed; the aggregate remains non-green.

## Multi-client backend main merge — 2026-11-06

- Original command: `mise run test:logged -- --name merge-warm-full -- mise run test:full`
  on `multi-client-backend-fe80afce6c0c-r1`, merging `dafdb26ef` into
  `e1641446c`. Desktop ran with two workers alongside the other workspace tasks.
- The successful-start case timed out at 15,016.08 ms against its 15,000 ms
  deadline. Desktop reported 2,032 pass, 15 skip and one fail. The complete
  aggregate exited 1 after 1,360.2 s, including a 242.8 s admission wait.
- Complete unchanged owner rerun:
  `NODE_ENV=test mise run test:logged -- --name merge-desktop-bridges-isolated -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --parallel=1 --only-failures`
  passed with exit 0 in 0.7 s. Passing counts were removed by the logged runner.
- Evidence: `/tmp/orkestrator-test-run.N4koTI/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and `/tmp/orkestrator-test-run.Zs7WCC/merge-warm-full.log.gz`.
- This is another aggregate-only timeout observation; the cause remains
  unconfirmed. No owning code, timeout, assertion or skip changed. The aggregate
  also retained unrelated backend timer and missing WebKit-library failures.


## Disposable Docker review recurrence — 2026-11-06

Preparation at `8867918058550640e000f05d7a738f3f92a9a0be` repeated the
15-second startup timeout (15009.59 ms) with two desktop workers. The default
aggregate was incomplete: root, bridges and protocol groups expired waiting
for host capacity. Original output is preserved in
`.orkestrator/review-artifacts/review-validation-04a61cfc-0131-4ca9-9fd6-8cf53e5d25f9/validation-04.stdout.txt`.
The complete unchanged owner passed alone (exit 0, 1.6 s):

```sh
mise run test:logged -- --name bridge-build-triage -- bun test ./apps/desktop/scripts/dev/bridge-builds.test.ts --preload ./tests/setup-node.ts --parallel=1 --only-failures
```

No desktop implementation, timeout or assertion changed. The cause remains
unconfirmed. A fresh aggregate rerun is recorded separately by this repair stage.

The fresh `mise run test` rerun finished after 574.9 s (exit 1). It repeated
the desktop deadline at 15006.81 ms (1870 pass, 14 skip, 1 fail); bridges and
protocol passed, and root reported the two repository guard failures. Evidence:
`/tmp/orkestrator-test-run.RZrNux/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
and `/tmp/orkestrator-test-run.xej5WW/repaired-full-test.log.gz`.
The timeout remains undetermined; it is not excused as an environmental cause.

## Legacy host-mount coverage review — 2026-11-06

- **Commit:** `b8ff1848b` (coverage repair `5279014f9`).
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`.
  Desktop used two isolated workers alongside the other workspace packages.
  The successful-start case timed out at 15,006.59 ms (15,000 ms limit).
  Desktop totals: 1,868 passed, 16 skipped, one failed across 1,885 tests.
  The aggregate exited 1 after 1,708.7 s; its workspace group was incomplete
  after the backend stopped producing output for 300,000 ms.
- **Complete unchanged owner:** `mise run test:logged -- --name review-desktop-bridge-owner -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed with exit 0 in 1.7 s. Passing output was removed, so isolated case
  counts are not inferred.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YdSBOn/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer wrapper: `orkestrator-test-run.GlSHmN/review-default-tests.log.gz`
  under the same temporary root.
- **Disposition:** open recurrence; cause unconfirmed. Neither this owner nor
  its implementation changed in the branch. No assertion, timeout or skip changed.

## Investigation — 2026-11-06

A mechanism that produces exactly this signature is confirmed; that it is
what happened in the aggregates is not.

`startDevelopment` reserves the renderer and gateway ports with
`reserveLoopbackPorts(2)` (`apps/desktop/scripts/dev/profile-io.ts`), which
binds port 0 on `127.0.0.1` and closes the socket again, then spends the
profile, Electron-compile and bridge-build steps before the Vite stand-in
binds the renderer port. Anything else on the host that takes that port in the
gap, including the ephemeral local port of an outbound loopback connection,
makes the stand-in's `Bun.serve` fail and exit. The launcher does not watch
the Vite child while it waits: `waitForUrl(rendererUrl)`
(`apps/desktop/scripts/dev/lifecycle.ts`) keeps polling for 45 s, so the test
hits its 15 s budget.

Probe: a temporary copy of the test whose `reserveLoopbackPorts` returned a
port held by a TCP listener that drops every connection timed out at
15,002.43 ms, the recorded signature. Without the probe, 40 repeats of the
case under six CPU burners all passed (0.75 s each), so CPU load alone does
not trigger it.

Possible fixes, not applied: (1) race `waitForUrl` against the Vite child's
exit so a lost port fails at once with Vite's own error, which also stops a
real `dev:test` launcher hanging 45 s; (2) on such an early exit, reserve new
ports and respawn Vite before the profile's ports are published; (3) in the
test only, stub `waitForUrl` and keep the stand-in off the network, which
gives up coverage of real renderer readiness. (1) alone turns the hang into a
fast, explained failure; (2) is what removes the flake.

## Resolution (2026-11-10)

- **Root cause:** a real race in the `dev:test` launcher
  (`startDevelopment`, `apps/desktop/scripts/dev/lifecycle.ts`). It added its
  listener for Electron's `exit` only after readiness, the `ready` status
  write and fixture seeding had finished. The test's Electron stand-in exits
  as soon as it reads `ready` from the status file, so when the launcher's
  continuation after that write was delayed, the exit was emitted before the
  listener existed and the launcher waited forever with Vite still running.
  That is the recorded signature: the 15-second timeout, "Bun killed one
  dangling process" (the Vite stand-in, which only the launcher's shutdown
  stops), and late `ENOENT`/`EEXIST` status writes after the test removed
  the profile. A real launcher whose Electron quits during fixture seeding
  hung the same way. Stage tracing of the unchanged path caught it directly:
  `electron exit event` was logged before `status ready written`, and
  nothing followed until the test's cleanup killed Vite; 6 of 57
  fresh-process runs at host load about 34 timed out this way.
  The 2026-11-06 investigation's mechanism is a second, separate gap: the
  renderer port is reserved by binding and closing it long before Vite binds
  it, and a Vite that then loses the port exits while `waitForUrl` polls
  the dead URL for 45 s.
- **Fix:** `lifecycle.ts` attaches each child's exit promise right after
  spawning it (`childExit`) and races those promises at the end, so an early
  exit is never missed. It also waits for the renderer URL only while Vite is
  alive (`waitForUrlWhileRunning`; `waitForUrl` takes an abort signal); when
  Vite exits first, the launcher reserves a new renderer port, rewrites the
  profile and the status `rendererUrl`, and starts Vite again, up to three
  attempts, then fails at once with Vite's output instead of after 45 s.
  `apps/desktop/scripts/dev/bridge-builds.test.ts` runs the successful-start
  case twice, the second time with the first reserved renderer port held by
  another listener, and checks that Vite, the status and the stored profile
  moved to a new port.
- **Reproduced:** yes, both mechanisms. A temporary `await Bun.sleep(300)`
  after the `ready` status write in the unchanged launcher made the original
  case time out at 15,006.23 ms with `killed 1 dangling process`; with the fix
  and the same delay both cases passed. Holding the first renderer port in
  the unchanged code timed the case out at 15,006.99 ms; with the fix it
  retried on a new port and finished in about 1.2 s.
- **Stress:** `mise run test:logged -- --name stress-1202-loop -- bash -c 'cd apps/desktop && for i in $(seq 40); do bun test ./scripts/dev/bridge-builds.test.ts ./scripts/dev/lifecycle.test.ts --preload ../../tests/setup-node.ts || exit 1; done'`
  passed 40 of 40 fresh processes (exit 0, 420.5 s), and
  `mise run test:logged -- --name stress-1202 -- bun scripts/test-under-contention.ts -- bun test --cwd apps/desktop ./scripts/dev/bridge-builds.test.ts ./scripts/dev/lifecycle.test.ts --preload ../../tests/setup-node.ts --parallel=2 --rerun-each=10`
  passed (exit 0, 105.2 s) with the port retry; the stage tracing that found
  the exit race ran after that, and the loop above covers the final code.
