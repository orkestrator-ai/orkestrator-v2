# Backend event-stream keepalive fixture reaches its watchdog in the aggregate

- **ID:** 2409
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `a stream that stops its keepalives, or an attempt nothing answers, is given up on`
- **File:** `apps/desktop/tests/backend-event-stream.test.ts:196`
- **Original command:** `mise run test:logged -- --name review-repair-default-final -- mise run test`, workspace/root/bridges/protocol reservations 5/1/2/1, two desktop workers.
- **Failure:** enqueueing a keepalive threw `ERR_INVALID_STATE: Controller is already closed` at 120.13 ms.
- **Owning-file rerun:** `mise run test:logged -- --name backend-event-stream-owner -- bun test --cwd apps/desktop ./tests/backend-event-stream.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 0.3 s.
- **Evidence:** `orkestrator-test-run.haynoB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** intermittent keepalive/watchdog timing failure; exact scheduling cause is unconfirmed. No event-stream implementation, assertion, timeout or skip changed.

### Final default-suite verification — 2026-11-02

`mise run test:logged -- --name review-repair-default-controlled -- mise run test`
passed all four groups (exit 0, 741.9 seconds including a 540.5-second capacity
wait) at code commit `1144ea780`. The logging shutdown clock fix is in that
commit; the other owners listed here were unchanged. This green aggregate
does not establish a root cause for the still-open intermittent cases.


## Task 1202 background-work review repair — 2026-11-02

The exact default-suite retry used `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1
mise run test:logged -- --name address-default-suite-concurrent -- mise run test`
with workspace/root/bridge/protocol grants of 6/1/2/1. The ordinary retry was
cancelled while queued behind another worktree; the documented concurrency
option admitted all groups. Original preparation artifacts were preserved.
Aggregate evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.WXZCOJ/`
(group logs; compressed on failure), outer log in `orkestrator-test-run.Vufyx3`.

Keepalive enqueue hit a closed controller at line 196 (70.41 ms).
`mise run test:logged -- --name address-desktop-stream-rerun -- bun test --cwd apps/desktop ./tests/backend-event-stream.test.ts --parallel=1 --only-failures`
passed the unchanged owner (0.4 s). Detached main at `38d55ee14`, with its own
frozen install, passed 20 repeats (`address-main-stream`, 3.8 s). No root cause
or target-branch failure reproduction is claimed.

Final aggregate counts: desktop 1,580 pass / 16 skip / 2 fail; backend
13,138 pass / 97 skip / 3 fail; web 11,230 pass / 10 skip / 7 fail; root
3,418 pass / 3 fail. Bridges and Codex protocol verification passed.
The aggregate exited 1 after 1,152.1 seconds; no watchdog or output limit fired.


## Backend logger main merge — 2026-11-02

`mise run test:logged -- --name merge-default-tests-recheck -- mise run test`
while merging `d7054dace` into `8f174e4db` repeated the closed-controller
keepalive failure (61.09 ms). Default workspace/root/bridges/protocol
reservations were 5/1/2/1. The aggregate exited 1 in 282.9 s; this workspace
also retained four shifted-link failures and one fsmonitor timeout.

The complete unchanged owner passed alone, exit 0 in 0.3 s:
`mise run test:logged -- --name merge-rerun-desktop-keepalive -- bun test --cwd apps/desktop ./tests/backend-event-stream.test.ts --parallel=1 --only-failures`.
No assertion, timeout, skip, or event-stream code changed. Evidence:
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.LvO7CJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Renderer-migration merge recurrence, 2026-11-02

The merge of `0ec784293` into `08038e814` repeated the closed-controller
failure at line 196 in
`mise run test:logged -- --name merge-default-tests -- mise run test`.
The failing test took 91.52 ms; the desktop group reported 1,615 pass,
16 skip and 1 fail under the default scheduler.
The complete unchanged owner passed alone in 0.3 seconds through
`mise run test:logged -- --name merge-event-stream-alone -- bun test --cwd apps/desktop ./tests/backend-event-stream.test.ts --parallel=1 --only-failures`.
No assertion or timeout changed. The known wall-clock scheduling hypothesis
remains unproven by this recurrence.

Aggregate evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.6dWJ96/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.


## Feature-plan wake review repair — 2026-11-03

- **Original command:** `mise run test` at `409c2ec81`; Bun 1.4.4, 2
  isolated parallel worker(s) for this package in the saved output.
- **Failure:** ERR_INVALID_STATE: Controller is already closed (126.41 ms).
- **Suite counts:** partial observed totals: 34,621 passed, 9 distinct failures,
  186 skipped; some closing summaries were absent.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-c93bd96c-443b-41fa-a4a1-00fe777fe19a/validation-04.stdout.txt`.
- **Isolated rerun:** `mise run test:logged -- --name fix-recorded-stream -- bun test --cwd apps/desktop ./tests/backend-event-stream.test.ts --parallel=1 --only-failures` passed the unchanged owning file, exit 0
  in 0.3 seconds. No assertion, deadline, skip or implementation changed.
- **Assessment:** recurrence matches the existing open case; the isolated pass
  establishes intermittency, not a root cause. The original aggregate remains
  failed. Triage marked it related through a shared protocol import; this
  observation does not override that verdict.
