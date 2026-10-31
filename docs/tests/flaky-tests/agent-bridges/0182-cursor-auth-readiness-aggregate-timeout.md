# Cursor authenticated readiness times out in the aggregate

- **ID:** 0182
- **Status:** open

Observed: 2026-10-06 on macOS with Bun 1.4.2.

- Test: `authentication > reports an authenticated credential as ready`
- File: `bridges/cursor-bridge/src/http.test.ts:133`
- Failure: `this test timed out after 5000ms`, reported duration 5327.42 ms.
- Cursor package counts: 667 passed, 1 failed across 38 files.

The original command was:

```bash
PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" \
  mise run test:logged -- --name full-suite -- mise run test
```

The aggregate ran workspace, root, bridges and protocol groups concurrently,
with 2, 3, 2 and 1 worker slots respectively. Each bridge package used one Bun
worker, with two bridge package tasks active at once. The bridge group failed
in 62.5 seconds. The workspace and protocol groups passed.

The owning file then passed alone, exit status 0, in 2.1 seconds:

```bash
mise run test:logged -- --name cursor-auth-isolated -- \
  bun test ./bridges/cursor-bridge/src/http.test.ts \
  --preload ./tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.WqBC12/bridges.log.gz` (aggregate) and the
logged `PASS cursor-auth-isolated` result. The passing log was removed by the
logged runner, as designed.

The test exercises a loopback HTTP session-status request with a test API key.
No assertion mismatch was reported. Aggregate scheduling or loopback delay is
possible, but not established; the isolated result alone does not identify the
cause. No timeout, assertion or skip was changed.

## Recurrence on 2026-10-07

On macOS with Bun 1.4.2, `mise run test:logged -- --name fix-suite-final --
mise run test` (using the GNU-tool PATH above) reported the same readiness test
as a beforeEach/afterEach hook timeout at 10004.37 ms. The following
`authentication > an attached agent is ready without reading credentials` also
failed at 2777.45 ms with undefined session state; an unhandled error was
reported between tests. Cursor counts were 666 passed, 2 failed and 1 error
across 38 files. Group worker allocations remained 2/3/2/1.

The owning file passed alone in 1.9 seconds, exit 0:

```bash
mise run test:logged -- --name cursor-http-alone -- \
  bun test ./bridges/cursor-bridge/src/http.test.ts \
  --preload ./tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.8uQSSt/bridges.log.gz` and
`/tmp/orkestrator-test-run.8uQSSt/summary.json`. The readiness setup timeout
preceded both undefined-state errors, suggesting a cascading fixture failure;
the underlying timeout cause remains unproven. Assertions and timeouts were
left unchanged.

## Recurrence on 2026-10-12

The environment-move fix validation reproduced `authentication > reports an authenticated credential as ready` under
`mise run test:logged -- --name move-full-suite -- mise run test`, with the GNU
tool PATH documented in the testing guide. Group allocations were 2/3/2/1.
Cursor package: 667 passed, 1 failed and 1 error across 38 files; failure duration 5596.47 ms.

The owning file passed alone, exit 0, in 3.8 seconds:

```bash
mise run test:logged -- --name isolate-cursor-http -- bun test --cwd bridges/cursor-bridge ./src/http.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.tUZZDC/summary.json`
and its compressed group logs. Status remains open; the isolated pass confirms
recurrence but does not establish a root cause. No assertion, timeout or skip
was changed.

## Recurrence on 2026-10-15 during MCP removal validation

On macOS with Bun 1.4.3, the unchanged `src/http.test.ts` reported two
beforeEach/afterEach hook timeouts under:

```bash
mise run test:logged -- --name full-tests -- mise run test
```

- `authentication > reports an authenticated credential as ready`: 10004.15 ms.
- `authentication > an attached agent is ready without reading credentials`: 7364.10 ms.
- Cursor package: 719 passed, 2 failed, 6564 assertions across 39 files in 28.80 s.
- Group allocations: workspace 4 slots, root 1, bridges 2, protocol 1. The
  bridge packages each used one Bun worker. Turbo stopped sibling bridge
  tasks when Cursor failed, so those tasks do not provide completed evidence.

The owning file passed unchanged alone, exit 0, in 1.3 s:

```bash
mise run test:logged -- --name cursor-http-isolated -- \
  bun test --cwd bridges/cursor-bridge ./src/http.test.ts \
  --preload ../../tests/setup-node.ts --parallel=1
```

Evidence: `/private/tmp/orkestrator-test-run.sYaNWH/bridges.log.gz` and
`summary.json` from the aggregate, plus the logged isolated PASS. The passing
log is removed by the runner. The recurrence is consistent with the prior
HTTP fixture cleanup/setup timeouts under aggregate load; its root cause
remains unproven. No assertion, timeout or skip was changed.

The warm full-suite rerun (`full-tests-warm`) subsequently passed every bridge
package: Cursor 721 passed, 0 failed, and all five bridge tasks completed in
77.4 s. The run's only failure was the unrelated agent-account directory
assertion tracked in case 0238. Evidence:
`/private/tmp/orkestrator-test-run.HeXNK8/bridges.log.gz` and `summary.json`.

## Recurrence — 2026-10-16 (mail tiles and launch-defaults main merge)

`mise run test:logged -- --name mail-wakes-latest-tests -- mise run test`
used the testing guide's GNU-tool PATH and reserved 4/1/2/1
workspace/root/bridge/protocol slots. Each bridge used one isolated Bun worker.
The Cursor HTTP file reported four ten-second beforeEach/afterEach hook
timeouts:

- `authentication > reports an authenticated credential as ready`: 10004.19 ms.
- `authentication > an attached agent is ready without reading credentials`: 10004.03 ms.
- `session creation > returns the shared session projection`: 10002.30 ms.
- `session creation > records the read-only boundary before the session is attached`: 10002.18 ms.

A connection-refused error at `src/http.test.ts:158` also appeared between
tests. Cursor reported 718 passed and four failed across 39 files (53.59
seconds); all four other bridge packages passed. The bridge group finished in
99.8 seconds. The aggregate exited 1 after 319.4 seconds; workspace, root
and protocol groups passed. Evidence:
`/tmp/orkestrator-test-run.Oe72br/bridges.log.gz`;
outer artifact `/tmp/orkestrator-test-run.NMr6us/mail-wakes-latest-tests.log.gz`.

`mise run test:logged -- --name mail-wakes-cursor-http-isolated -- bun test --cwd bridges/cursor-bridge ./src/http.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
passed the unchanged owning file (exit 0) in 1.4 seconds after the bridge group
finished, while the aggregate workspace and root groups were still running.
The isolated pass confirms an intermittent recurrence. A fixture setup or
cleanup timeout cascading into later cases is consistent with earlier
observations, but the underlying cause remains unconfirmed. No implementation,
assertion, timeout or skip changed in the Cursor bridge.

## Recurrence — 2026-10-17 (host maintenance review fixes)

The `all-tests` aggregate reported ten-second hook timeouts for
`authentication > reports an authenticated credential as ready` (10004.17 ms)
and `authentication > an attached agent is ready without reading credentials`
(10002.95 ms), with a connection-refused error between them. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Q6mb2y/bridges.log.gz`.
The unchanged owner passed alone in 1.3 s:

```sh
mise run test:logged -- --name cursor-http-rerun-node -- bun test --cwd bridges/cursor-bridge ./src/http.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

No Cursor implementation, timeout, assertion or skip changed.

## Queued-steer further main merge — 2026-10-19

The ten-second readiness timeout recurred; the unchanged HTTP owning file
passed alone in 2.3 seconds. Commands and aggregate evidence are recorded in
[0501](../aggregate-validation-runs/0501-queued-steer-main-merge-validation.md). No implementation, assertion,
timeout or skip changed.

## Container credential rotation qualification — 2026-10-21

`mise run test` failed only this test, at 10,002 ms in the bridges group,
while the workspace, root and protocol groups ran beside it on a host at load
average about 9. The unchanged Cursor bridge suite (`bun run test:bridge` in
`bridges/cursor-bridge`) then passed alone: 775 passed, 0 failed. No Cursor
implementation, assertion, timeout or skip changed.

## CI `main` recurrence — 2026-10-19

CI `main` run 39298647284 (`67a6cc31`, job "Unit and integration tests",
`ubuntu-latest`, one Bun worker per bridge package) timed out three HTTP cases
at 5,000 ms with "a beforeEach/afterEach hook timed out for this test":
`authentication > reports an authenticated credential as ready`,
`authentication > an attached agent is ready without reading credentials` and
`session creation > status exposes token-delta progress while the first model
call is running`. The later red `main` runs did not repeat it. On 2026-10-22,
`mise run test:logged -- --name cursor-http-owner -- bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts ./src/http.test.ts --parallel=1 --only-failures`
passed unchanged on macOS (1.7 s). No implementation, assertion, timeout or
skip changed.


## Node event main merge — 2026-10-23

On macOS with Bun 1.4.3, merging `fc0a64b78d426013e29d1e325455723fea6cc2a4`
and `b36e74b08e8109c3d3f8935ba707ccdfde8d66fa`,
`ORKESTRATOR_TEST_AREA_BASE=6038aec050867deb76f89a0bfe71799ea27a70a6 mise run test:logged -- --name merge-tests -- mise run test`
ran workspace/root/bridge/protocol groups with 4/1/2/1 worker slots, alongside
component-browser, Electron and isolated-browser validation. The Cursor bridge
reported 777 passed and two failed across 43 files (50.18 s):

- `authentication > reports an authenticated credential as ready`: a
  beforeEach/afterEach hook timed out at 10006.14 ms.
- `prompt dispatch > a run that fails to start rolls the turn back rather than wedging it`:
  expected `{ dispatch: "unknown" }`, received `{ error: "Session not found" }`
  at 12.80 ms.

The complete unchanged owner passed in 3.6 s with
`mise run test:logged -- --name merge-cursor-http-owner -- bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts ./src/http.test.ts --parallel=1 --only-failures`.
The original aggregate remains failed; workspace, root and protocol groups
passed. Evidence: host temporary artifacts `orkestrator-test-run.0lon9o/bridges.log.gz`
and `orkestrator-test-run.ROiLL4/merge-tests.log.gz`. The setup timeout followed
by missing session state is consistent with earlier fixture failures; the cause
is unconfirmed. No assertion, timeout, skip or implementation changed.

## Recurrence during 0016 validation (2026-10-24)

- **Failure:** `reports an authenticated credential as ready` and `an attached agent is ready without reading credentials` hit 10-second hook timeouts.
- **Original command:** `mise run test:logged -- --name full-test-2 -- mise run test`
  on branch `todo-0016-slash-command-catalogue` after rebasing onto `712274379`,
  node mbp3, other worktrees validating on the host.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.CfvSIY/full-test-2.log.gz`.
- **Isolated rerun:** `bun test src/http.test.ts --preload ../../tests/setup-node.ts` from `bridges/cursor-bridge`: 77 passed, 0 failed.
- **Disposition:** recurrence confirmed by the isolated pass. No assertion,
  deadline or skip was changed.

## Pi ChatGPT fallback main merge — 2026-10-26

`mise run test:logged -- --name merge-tests -- mise run test` on macOS
with Bun 1.4.4 merged parents `8da8c9cc87779451589b106c228e425ef742aa47`
and `a51045a4a954d49ae388c0f22535e9b28274279f`. Workspace/root/bridge/protocol
groups reserved 4/1/2/1 worker slots; each bridge package used one Bun worker,
with two bridge tasks active. `authentication > reports an authenticated
credential as ready` hit a beforeEach/afterEach hook timeout at 10002.04 ms.
Cursor reported 795 passed and one failed across 45 files in 27.32 s.

The complete unchanged owner passed alone (exit 0, 1.5 s):

```sh
mise run test:logged -- --name merge-cursor-http-isolated -- bun test --cwd bridges/cursor-bridge ./src/http.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: host temporary directory `orkestrator-test-run.2B615e`,
`bridges.log.gz` and `summary.json`; outer logged run
`orkestrator-test-run.Lf5a1a/merge-tests.log.gz`. The aggregate timeout followed
by an isolated pass matches the prior recurrence; the root cause remains
unconfirmed. No Cursor implementation, assertion, timeout or skip changed.

The complete aggregate exited 1 after 568.8 s: workspace and protocol-lockfile
groups passed; root and bridges failed only the four firewall timeouts and
one Cursor hook timeout described above. Backend reported 11,749 passed and
zero failed; Pi reported 649 passed and zero failed. Formatting, lint,
typechecking, and the flake-index contract check passed.

## Codex typed-prompt review fixes — 2026-10-26

During `mise run test` on macOS/Bun 1.4.4, the aggregate reserved 4/1/2/1
worker slots for workspace/root/bridges/protocol; two bridge package tasks ran
concurrently, one Bun worker each. `authentication > reports an authenticated
credential as ready` in `bridges/cursor-bridge/src/http.test.ts` hit a
beforeEach/afterEach hook timeout at 10004.21 ms. Cursor reported 800 passed,
one failed across 46 files (34.21 s). Evidence: host temporary artifact
`orkestrator-test-run.InAFaV/bridges.log` (compressed after aggregate completion).

The unchanged owner passed alone (exit 0, 1.5 s):

```sh
mise run test:logged -- --name cursor-http-isolated -- bun test --cwd bridges/cursor-bridge ./src/http.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

The hook-only aggregate failure and isolated pass match earlier readiness
recurrences under host load. The root cause remains unconfirmed; no Cursor
implementation, assertion, deadline or skip changed. The complete Codex bridge
suite passed both in the aggregate and independently.

## Keyboard shortcuts review fixes — 2026-10-27

`mise run test:logged -- --name shortcuts-unit-suite -- mise run test` on
macOS/Bun 1.4.4 reserved workspace/root/bridge/protocol groups at 4/1/2/1
worker slots. Each bridge package used one worker. The authenticated readiness
case hit a 10003.48 ms hook timeout; the bridge group failed after 126.0 s.

The complete unchanged owner passed alone, exit 0, in 1.5 s:

```sh
mise run test:logged -- --name cursor-http-rerun -- bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts ./src/http.test.ts --parallel=1 --only-failures
```

Evidence: host temporary directory `orkestrator-test-run.RKStpZ/bridges.log.gz`
and outer `orkestrator-test-run.ryekIw/shortcuts-unit-suite.log.gz`. The aggregate
failure followed by an isolated pass matches earlier recurrences; the cause
remains unconfirmed. No Cursor implementation, assertion, deadline or skip changed.

## Coordinator timers/account review — 2026-10-30

Preparation at `574bb14b3` repeated readiness hook timeouts in `reports an
authenticated credential as ready` and `an attached agent is ready without
reading credentials` during `mise run test`. The same owner also returned no
`content-encoding` in its gzip assertion after an unexpected route failure.
The complete unchanged HTTP owner passed alone (exit 0, 2.1 s):

```sh
mise run test:logged -- --name recorded-cursor-owner -- bun test --cwd bridges/cursor-bridge --preload ../../tests/setup-node.ts ./src/http.test.ts --parallel=1 --only-failures
```

Preparation evidence is in
`.orkestrator/review-artifacts/review-validation-af449b96-aec4-419e-90d3-165bd324e649/validation-05.stdout.txt`.
No Cursor implementation, assertion, deadline or skip changed. The isolated
pass supports an aggregate-only recurrence; its cause remains unconfirmed.

The exact default-suite rerun subsequently passed (exit 0, 170.0 s):

```sh
mise run test:logged -- --name review-repaired-default -- mise run test
```

## PR management review validation — 2026-10-31

Preparation's `mise run test` (Bun 1.4.4, workspace/root/bridges/protocol
reservations 6/1/2/1; one worker per bridge) timed out
`authentication > reports an authenticated credential as ready` in
`bridges/cursor-bridge/src/http.test.ts` after 10002.93 ms. Cursor reported
819 passed, one failed across 47 files. Evidence is the preparation record
`.orkestrator/review-artifacts/review-validation-b8ce4ce2-fbd0-4906-a651-a9f5ad5079fd/validation-04.stdout.txt`.

The unchanged complete owner passed alone, exit 0, in 1.7 seconds:

```sh
mise run test:logged -- --name cursor-auth-owner -- bun test --cwd bridges/cursor-bridge ./src/http.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

The exact aggregate rerun's bridge group also passed (46.2 seconds). Its
remaining failures were the existing duplicate flake case IDs and the missing
pinned Codex binary. The readiness timeout remains intermittent with no
confirmed root cause; no assertion, deadline, skip or Cursor code changed.
