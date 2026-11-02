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
