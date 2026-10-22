# Design operation replay event count under aggregate load

- **ID:** 0215
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `design operations: prepare, execute, status and cancel > a lost execute response is answered by status and a repeated execute changes nothing`.
- **File:** `apps/backend/src/core/design-operations.test.ts:268`.
- **Failure:** expected `harness.events.length` to remain 3, received 4; case duration 59.98 ms.
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU host utilities preferred in PATH.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers.
- **Aggregate counts:** backend reported 7,731 passed, 39 skipped and 3 failed across 424 files; the root, bridge and protocol groups passed. The shutdown cleanup failure also reproduced alone and is not classified as a flake.
- **Evidence:** `/tmp/orkestrator-test-run.yeOzQY/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-design-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design-operations.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 3.6 seconds.
- **Hypothesis:** asynchronous event delivery may race the event-count observation under aggregate load. The cause remains unconfirmed; neither the owning test nor design-operation code changed in this merge. No assertion, timeout or skip was changed.

## OpenCode model-selection validation — 2026-10-15

`mise run test:logged -- --name repository-tests -- mise run test` failed
with an event count of 4 instead of 3, after 42.95 ms. The owning source and
test were unchanged by the OpenCode model-selection fixes.

The unchanged owning file passed alone in 7.4 seconds with:

```bash
mise run test:logged -- --name design-operations-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design-operations.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `/tmp/orkestrator-test-run.lhp1N0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The extra event's source is not established. No assertions, timeouts, or
production behavior were changed to hide this failure.

## CI health validation — 2026-10-15

The test now lives in `apps/backend/src/core/design/operations.test.ts:268`.
`mise run test:logged -- --name full-tests -- mise run test` on macOS arm64
(18 cores; workspace two package tasks with two Bun workers each, root three,
bridges two) failed it with an event count of 4 instead of 3, after 51.17 ms.
Backend reported 7,904 passed, 39 skipped and 1 failed across 433 files
(297.62 s); the root, bridge and protocol groups passed. The change under
validation touched the aggregate runner's Turbo flags and unrelated backend
tests, not design operations.

The unchanged owning file passed alone (20 tests) in 4.2 seconds with:

```bash
mise run test:logged -- --name rerun-design-operations -- bun --cwd=apps/backend test src/core/design/operations.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

Aggregate evidence: `/tmp/orkestrator-test-run.D7RbFz/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No assertions, timeouts, or production behavior were changed.

## Recurrence — 2026-10-16 (live coordinator branch second main merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees were validating on the same host.
- **Failure:** `a lost execute response is answered by status and a repeated execute changes nothing` expected 3 events but received 4 (202.63 ms).
- **Suite counts:** backend 8,342 passed, 40 skipped and four failed across 445 files (599.23 seconds). All other workspace packages, root, bridges and protocol passed; aggregate exited 1 after 622.4 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.zOMprl/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.TYkzGQ/merge-tests.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-design-operations-isolated -- bun test --cwd apps/backend ./src/core/design/operations.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0) in 6.2 seconds. Each owning file ran in its own process; other focused reruns were active on the host.
- **Disposition:** intermittent failure confirmed by the owning-file pass; the cause remains unconfirmed. No product code, assertion, timeout or skip was changed.

## Mobile layout merge validation recurrence — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU host utilities preferred in PATH, on `mobile-layout-gaps` while merging `origin/main`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers. Other worktrees and component browser validation were active on the host.
- **Failure:** The repeated-execute case expected 3 events but received 4 at operations.test.ts:268 (232.67 ms).
- **Suite counts:** backend 8,320 passed, 40 skipped and 4 failed; root/support 2,998 passed, 1 skipped and 1 failed. All other workspace packages, bridges and protocol verification passed. The logged aggregate exited 1 after 544.1 s.
- **Isolated rerun:** `mise run test:logged -- --name merge-design-operations-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design/operations.test.ts --parallel=1 --only-failures` passed the unchanged owning file in 3.7 s (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.Z1q1Ht/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.fZgI1l/merge-tests.log.gz`.
- **Disposition:** recurrence confirmed by the isolated pass; shared host contention remains an unconfirmed hypothesis. No assertions, deadlines or skips changed.

## Resolution (2026-10-16)

Not an ordering bug; the test raced legitimate background work. The extra
event is the `status` hint from the background validation of the *first*
execute, not anything the repeated execute did.

- `append_frame_html` (like `replace_element_html` and `move_element`)
  commits the new HTML as `unvalidated` and adds the frame to
  `validateAfter`. After the commit, `execute` schedules
  `validation.schedule` (`core/design/service.ts`, after `commit` in the
  execute path). That job renders outside the lane, then re-enters the lane,
  bumps `statusVersion` and commits with a `kind: "status"` hint
  (`core/design/validation.ts`).
- Alone, the happy-dom validation usually lands after the test's last count.
  Under aggregate load it sometimes landed between the `events` baseline and
  the `toBe(events)` assertion: 3 hints (create, create frame, execute) became 4.
- Deterministic reproduction: hold `validation`-priority render jobs, take
  the baseline, replay status and execute, then release the hold and join the
  job with `validate(...)`. The unchanged assertion fails with `Expected: 3,
  Received: 4` every time.
- Product behaviour is correct. The hint is published inside the canvas lane
  after its own commit, carries the same document revision and a higher
  `statusVersion`, and a result for replaced content is discarded without a
  hint.

**Fix (test only).** The case now holds the validation job with
`harness.renderer.block` before measuring, so the replay is counted against a
fixed baseline. It then releases the job and asserts that the only later hint
is exactly one `status` hint for the first commit's revision, with no extra
render job. A new regression case in `core/design/sync.test.ts` ("live hints
follow per-canvas commit order and stale validation publishes nothing") pins
the hint order. A mutation that drops the content-identity check in
`validation.ts` fails it.

**Verification.** `operations.test.ts`, `service.test.ts`, `sync.test.ts` and
`history.test.ts` passed with `--rerun-each 20` in three concurrent copies
(3 × 1,040 runs). The changed cases passed `--rerun-each 10` beside 24 busy
loops on 18 cores.
