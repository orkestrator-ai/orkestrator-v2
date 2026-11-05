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
