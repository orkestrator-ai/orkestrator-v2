# `FeaturesView` owning-file worker crash (`tests/unit/components/FeaturesView.test.tsx`)

- **ID:** 0137
- **Status:** open
- **Date observed:** 2026-08-18
- **Original command:** `bun run test:logged -- --name full-tests-rebased -- bun run test`, at `8c1dc1f3` on `questions-ui-layout` after rebasing the web-only native-agent question change onto `origin/main`.
- **Worker configuration:** the full four-group `scripts/test-all.ts` run; the root and agent-support group used six parallel Bun workers while sharing the host with the workspace, bridges, and protocol-lockfile groups.
- **Failure:** Bun reported `tests/unit/components/FeaturesView.test.tsx (worker crashed: SIGTERM)` without an assertion failure or individual test duration. The root and agent-support group finished in 85.13 s.
- **Suite counts:** root and agent-support group `3741 pass, 1 skip, 1 fail, 16681 expect() calls. Ran 3743 tests across 181 files.` The workspace, bridges, and protocol-lockfile groups all passed.
- **Isolated rerun:** `bun run test:logged -- --name features-view-isolated -- bun test tests/unit/components/FeaturesView.test.tsx --only-failures` → passed in 2.7 s.
- **Attribution:** the change in flight touches native-agent and chat-shell components plus their tests; it does not touch `FeaturesView`, its tests, or their dependencies. The isolated owner passed against the same immutable head.
- **Hypothesis:** the evidence establishes an aggregate-only worker termination, but not why the worker received `SIGTERM`. A recurrence should capture the runner's process/resource diagnostics and the test reached immediately before termination before changing test budgets or assertions.

## Triage note (2026-11-15)

Not changed; stays `open`. A worker `SIGTERM` is the runner terminating the process, not a test deadline, and nothing in the file's timing can cause or prevent it; the single observation has no diagnostics. If it recurs, capture the runner's reason for the signal.

## Review — 2026-11-19 (stays open)

No recurrence has been recorded since the single 2026-08-18 observation
(`mise run flaky:recurrence -- 0137`: open, no resolving commit). One known way
a Bun test worker received a stray `SIGTERM` was removed on 2026-11-06
(`ee2cc8423`): fixtures that handed plausible fake pids to real termination
code (`process.kill(-pid, "SIGTERM")`, then `SIGKILL`) could signal unrelated
host processes or process groups, which could include a sibling test worker.
Fake pids now come from `@orkestrator/protocol/testing/fake-pids`, above every
`pid_max`. Nothing ties this observation to that mechanism, so the case is not
closed. Nothing in `FeaturesView.test.tsx` can cause or prevent a signal from
outside. If it recurs, record which process sent the signal before changing
the test.
