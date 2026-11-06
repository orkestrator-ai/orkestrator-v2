# Prompt navigator aggregate run: git and timing tests under host load

- **ID:** 6063
- **Status:** open
- **Date observed:** 2026-11-05

The default suite on the prompt navigator branch (based on `69a3b4ca5`, a change
confined to `apps/web` and one document) failed tests in three groups after
793.6 seconds. No failing test is in `apps/web` (`@orkestrator/web` reported 0
failures) and none imports the changed files. Each owning file below then passed
rerun alone with one worker.

Original command: `mise run test` (default worker plan).

| Test | File | Aggregate duration | Isolated rerun |
| --- | --- | --- | --- |
| `concurrent create checks the joining policy` | bridges/acp-bridge/src/acp-policy-narrowing.test.ts | 565 ms (expected 201, received 409) | passed, 1.9 s |
| `readiness timeout reaps the child and removes copied credentials` | tests/unit/activity-sweep-bridge.test.ts | 152 ms | passed, 0.4 s |
| `a mirror behind the remote costs only the commits it lacks` | tests/unit/workspace-setup-git-mirror.test.ts | 7.9 s | passed, 11.1 s (file) |
| `an object lost from deep in the history, which only the clone can find` | tests/unit/workspace-setup-git-mirror.test.ts | 7.5 s | passed, as above |
| `the script declares the capability the backend gates the mount on` | tests/unit/workspace-setup-git-mirror.test.ts | 5.2 s | passed, as above |
| `remote admission uses completed sync and leaf copy despite unrelated behind status` | apps/backend/src/core/coordinator-node-tickets.test.ts | 5.4 s | passed, 1.3 s |
| `a downgraded command node hands back deferred notices` | apps/backend/src/core/coordinator-notice-hierarchy.test.ts | 5.4 s | passed, 14.4 s |
| `a restarted follow delivers a distinct second failure and retry/reconciliation do not duplicate it` | apps/backend/src/core/coordinator-pipeline-step-actions.test.ts | 6.4 s | passed, 2.3 s |
| `a branch that took in newer target history is measured from where it now leaves it` | apps/backend/src/core/diff-baseline.test.ts | 5.0 s | passed, 2.4 s (file) |
| `a worker reset or fast-forwarded to a newer target has no changes of its own` | apps/backend/src/core/diff-baseline.test.ts | 5.0 s | passed, as above |

Isolated command form:
`mise run test:logged -- --name <name> -- bun --cwd=<package> test <file> --parallel=1 --only-failures`
(`bun test ./tests/unit/<file>` for root tests).

Hypothesis: contention. Eight of the ten ran for 5 seconds or more against the runner's
5-second default, and these files spawn real Git or child processes. Host load
during the run was
not measured and no stress run was made, so this is unconfirmed.

## Not flakes: failing alone on the same base

These fail in the aggregate run, alone, and on an untouched checkout of
`69a3b4ca5`, so they are not recorded as flakes here and were not caused by this
change:

- `tests/unit/flaky-tests-index.test.ts`: the
  native-agents-and-transcripts index has 58 well-formed rows for 59 case files.
- `tests/claude-state-signal-integration.test.ts`: exits 1 (`hook writers
  serialize counters...` in the aggregate run; already registered).
- `apps/backend/src/core/coordinator-node-coordinator-mail.test.ts`: `falls back
  to the leaf's coordinator when the command node has none for the repository`.
- `packages/protocol/src/node/standalone-service-install.test.ts`: `a release
  without a published lockfile still installs, resolving afresh` (ENOENT on
  `node_modules/leaf/package.json`).

## Flow viewport review validation recurrence — 2026-11-06

Observed on `d81fd21ed` in
`mise run test:logged -- --name review-default-tests -- mise run test`.
This branch changes the shared flow viewport and its renderer tests, plus
qualification documentation; it changes none of this owner's implementation.
The aggregate finished in 1615.7 s. Backend used four isolated workers
(16,358 pass, 134 skip, three failures); root used one worker
(3,674 pass, three failures). Web passed with 13,101 pass and ten skips.
Original evidence is under
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.fvkr6h/`;
the outer wrapper is `orkestrator-test-run.OXNmsh` under the same temporary root.

`activity sweep bridge ownership > readiness timeout reaps the child and removes
copied credentials (ignores TERM: %s)` failed at 132.71 ms: cleanup raised
`kill() failed: EPERM` at line 111. Evidence: `root-and-agent-support-tests.log.gz`.

Unchanged complete owner rerun:

```sh
mise run test:logged -- --name activity-sweep-isolated -- bun test tests/unit/activity-sweep-bridge.test.ts --parallel=1 --only-failures
```

Passed with exit 0 in 0.4 s. Passing output was deleted by the logged
runner, so isolated totals are not inferred. The isolated pass establishes
intermittence, not a cause or a repair. No assertion, timeout or skip changed.


## Bridge authority review repairs — 2026-11-06

At `451fccdf1`, `mise run test:logged -- --name repair-default -- mise run test`
reported `activity sweep bridge ownership > readiness timeout reaps the child
and removes copied credentials (ignores TERM: %s)` failing after 135.78 ms:
cleanup's process-group signal at line 111 returned `EPERM`. The root group
used one Bun worker. The outer run ended at its 30-minute deadline after an
approximately 23-minute host-lease wait, so final aggregate totals are unknown.

The complete unchanged owner passed alone (exit 0, 1.1 s):

```sh
mise run test:logged -- --name isolate-activity-bridge -- bun test ./tests/unit/activity-sweep-bridge.test.ts --parallel=1 --only-failures
```

Evidence: host temporary artifacts `orkestrator-test-run.HNKlxf/root-and-agent-support-tests.log`
and `orkestrator-test-run.Iu6GYp/repair-default.log.gz`. This confirms
intermittence; the cause remains unconfirmed. No assertion, timeout or skip
changed.

## Environment-deletion follow-up review recurrence — 2026-11-06

Preparation at `228561646` ran `mise run test:logged -- --name
review-default-tests -- mise run test`, with four isolated backend workers.
Both `diff-baseline.test.ts` cases listed above timed out near 5 s
(5,020.67 ms for the first); late Git failures were also reported between tests.
The workspace group ended at its no-progress watchdog, so its complete totals
are unavailable. Original evidence remains in
`.orkestrator/review-artifacts/review-validation-dd80c812-46c6-4f02-b538-897dbf04bdfd/validation-04.stderr.txt`.

At repair commit `b32cfe416`, the unchanged complete owner passed alone:
`mise run test:logged -- --name recorded-baseline-alone -- bun test --cwd
apps/backend ./src/core/diff-baseline.test.ts --parallel=1 --only-failures`
(exit 0, 13.3 s). Passing raw output was deleted; totals are not inferred.
The repair changes deletion-command termination waiting, not baseline selection
or the Git fixture. This establishes intermittence, not an environmental cause
or a fix for the incomplete aggregate. No assertions, skips or timeouts changed.
