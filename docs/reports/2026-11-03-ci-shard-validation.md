# CI shard validation follow-up

The review of `8665fc6a42342a8fbd6551613a51134dcb731bb8` identified missing
execution evidence for the slow-tier aggregate-runner owner and fresh CI shards.
This follow-up ran the omitted owner directly, without repeating the already
passing repository-wide static checks.

## Coverage added

`tests/unit/test-all.test.ts` now reads the actual CI matrix and calls
`runAllTests` with each shard's selection, the `all` tier used by `test:full`,
and four logical cores. Eight scenarios cover successful dispatch and failure
of each constituent group. Assertions check the selected groups, tier forwarding,
backend exclusion from the other workspace shard, the backend two-worker ceiling,
and root and bridge worker allocation. Group execution is stubbed: these scenarios
exercise orchestration, not the complete package suites or GitHub infrastructure.

## Observed validation

On 2026-11-03 in worktree `orkestrator-v2-20261103-005711-a629816c8619`,
each command below exited zero after the test addition:

```bash
mise run test:logged -- --name runner-slow-owners -- bun test ./tests/unit/test-all.test.ts ./tests/unit/ci-workflows.test.ts ./tests/unit/monorepo-scripts.test.ts --parallel=2 --only-failures
mise run test:logged -- --name runner-lint -- bunx oxlint tests/unit/test-all.test.ts
mise run test:logged -- --name runner-tests-typecheck -- bun check -p tests/tsconfig.json
```

The focused owner command took 1.2 seconds; lint took 0.1 seconds and typechecking
took 2.1 seconds. Passing raw output was deleted by `test:logged` as designed.
Formatting is checked separately before commit. No UI or live profile was used.

## Not done / needs live evidence

Fresh three-shard `mise run test:full` results on clean GitHub runners are still
outstanding. At inspection, `gh pr status` reported no PR for this branch and
`gh run list --branch debug-ci-failures-a629816c8619-r1` returned no runs.
The CI workflow triggers only on PRs and pushes to `main`; pushing this feature
branch alone cannot start it. Repository policy leaves PR creation to the
pipeline/coordinator and merging to a human.

After the pipeline opens the PR, retain the run URL, tested SHA and the results
of `Tests (backend)`, `Tests (workspace)`, `Tests (root-bridges)` and the
`Unit and integration tests` gate. A local stubbed matrix pass is not evidence
that those clean-runner jobs passed. No claim is made here about repairing the
separate failures in the preparation's default or browser suite runs.
