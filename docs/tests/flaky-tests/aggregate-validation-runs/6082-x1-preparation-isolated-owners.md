# X1 preparation failures whose owners pass alone

- **ID:** 6082
- **Status:** open
- **Observed:** 2026-11-05
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`
- **Commit:** `e6d400a5adecf4c62ce46e35d127053a0eb92ce6`
- **Workers:** preparation's concurrent aggregate; backend and CLI use the tier runner's scheduler-selected worker counts (default 2). No reliable closing aggregate totals were captured.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-cb344dc9-16d4-4c41-980a-8b2fc2a2e3b5/validation-04.stderr.txt` (preserved).

| Exact failing test | Owner | Original failure |
| --- | --- | --- |
| `user skills and commands in containers > the entrypoint imports them where Claude and Grok read user resources` | apps/backend/tests/portable-inputs-user-extensions.test.ts | 5071.14 ms; 5000 ms timeout, child status null instead of 0 |
| `shared skills root (task 1) > the entrypoint imports it into ~/.agents/skills, from the relay when node cannot read the mount` | apps/backend/tests/portable-inputs-shared-skills.test.ts | 5124.55 ms; 5000 ms timeout, child status null instead of 0 |
| `Electron backend command registry > GitHub credential helper > keeps working after setup clears credential.helper, on either order` | apps/backend/tests/commands-container-exec.test.ts | 5001.86 ms; timeout, missing fixture credential-helper output |
| `bounded in-container boot wait > renews an expired shell wait window and accepts readiness in the next exec` | apps/backend/tests/container-readiness.test.ts | 2855.80 ms; ContainerInitializationError, timed-out |

Each unchanged owner passed on 2026-11-05 with one isolated worker, using a separate logged command:

```sh
mise run test:logged -- --name recorded-user-extensions -- bun test --cwd apps/backend ./tests/portable-inputs-user-extensions.test.ts --parallel=1 --only-failures
mise run test:logged -- --name recorded-shared-skills -- bun test --cwd apps/backend ./tests/portable-inputs-shared-skills.test.ts --parallel=1 --only-failures
mise run test:logged -- --name recorded-container-exec -- bun test --cwd apps/backend ./tests/commands-container-exec.test.ts --parallel=1 --only-failures
mise run test:logged -- --name recorded-readiness -- bun test --cwd apps/backend ./tests/container-readiness.test.ts --parallel=1 --only-failures
```

Results: exit 0 in 0.8 s, 1.5 s, 4.6 s and 6.8 s respectively. Passing logs were deleted by the runner; no test totals are inferred. These owner files and their failing implementation locations are absent from `git diff origin/main...HEAD`; preparation classified them related through transitive imports of changed coordinator/mail contracts. The isolated passes establish intermittent failures, not an environmental cause or a repaired aggregate. No assertion or deadline changed. Root cause remains unproven; the original aggregate remains unresolved for verification.

Two other isolated-passing recurrences from the same capture are recorded in existing cases 1102 (hook counter snapshot) and 0080 (packaged CLI readiness). Unrerun root/protocol and browser/Electron failures remain undetermined and are not classified as flakes here.

## Rerun after rebasing onto `4f7ca8231`

On 2026-11-05 the branch was rebased onto `main` at `4f7ca8231` (#1789) and every owner verification blocked on was rerun alone, one worker, on the rebased branch:

| Owner | Command (`mise run test:logged -- --name … --`) | Result |
| --- | --- | --- |
| apps/backend/tests/portable-inputs-user-extensions.test.ts | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/portable-inputs-user-extensions.test.ts --parallel=1 --only-failures` | exit 0; 5 pass, 1 skip (`CLAUDE_CLI_PATH`-gated, not the failing case), 0 fail |
| apps/backend/tests/portable-inputs-shared-skills.test.ts | same form | exit 0; 21 pass, 0 fail |
| apps/backend/tests/commands-container-exec.test.ts | same form | exit 0; 15 pass, 0 fail |
| apps/backend/tests/container-readiness.test.ts | same form | exit 0; 21 pass, 0 fail |
| apps/backend/tests/claude-state-signal-integration.test.ts (case 1102) | same form | exit 0; 7 pass, 0 fail |
| packages/cli/tests/cli.test.ts (case 0080), after `bun run --cwd packages/cli build` | `bun --cwd=packages/cli test tests/cli.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` | exit 0; 13 pass, 0 fail |

None of these owners, nor `commands-container-exec.ts`, `container-readiness.ts` or `docker/entrypoint.sh`, appears in `git diff origin/main...HEAD`, and #1789 did not change them either. Because nothing failed on the branch, no comparison run on `main` was needed. This is still not an aggregate result: the failures were seen only under the concurrent default suite, and their root cause remains unproven.

## 2026-11-06 floating-notice repair recurrence

`mise run test:logged -- --name review-default-suite -- mise run test`
(backend four workers, aggregate workspace allocation six) failed
`user skills and commands in containers > withholds nested credentials before staging and import while preserving safe resources`
in `apps/backend/tests/portable-inputs-user-extensions.test.ts`: child exit was
`null` instead of `0`, then the test exceeded 5000 ms (5157.37 ms).
Backend totals were 16367 pass, 134 skip, 3 fail. Evidence is
`/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.synJsP/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The unchanged owner passed alone with
`mise run test:logged -- --name portable-inputs-isolated -- bun test --cwd apps/backend tests/portable-inputs-user-extensions.test.ts --parallel=1 --only-failures`
(exit 0, 5.9 s; passing output deleted, no counts inferred). The aggregate
failure remains unresolved; no implementation, timeout, assertion or skip was changed.
