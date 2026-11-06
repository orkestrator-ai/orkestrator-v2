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

## Legacy host-mount coverage review — 2026-11-06

- **Commit:** `b8ff1848b` (coverage repair `5279014f9`).
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`.
  The backend workspace group used four isolated workers alongside the other
  packages. `a worker reset or fast-forwarded to a newer target has no changes of its own`
  in `apps/backend/src/core/diff-baseline.test.ts` timed out at 5,032.69 ms
  (5,000 ms limit), interrupting a fixture `git fetch origin` with SIGTERM.
- **Aggregate result:** exit 1 after 1,708.7 s. Backend totals are unavailable:
  its group was terminated after 300,000 ms without output. Root reported
  3,746 passed and four failed; desktop reported 1,868 passed, 16 skipped and
  one failed. The backend also reported two other test timeouts.
- **Complete unchanged owner:** `mise run test:logged -- --name review-diff-baseline-owner -- bun test --cwd apps/backend ./src/core/diff-baseline.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed with exit 0 in 10.1 s. Passing output was removed, so isolated counts
  are not inferred.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YdSBOn/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer wrapper: `orkestrator-test-run.GlSHmN/review-default-tests.log.gz`
  under the same temporary root.
- **Disposition:** open recurrence; cause unconfirmed. Neither this owner nor
  its implementation changed in the branch. No assertion, timeout or skip changed.
