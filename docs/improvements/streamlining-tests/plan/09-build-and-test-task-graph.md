# 09 — Separate source-test readiness from artifact builds

Status: Implemented; pending review and integration. Depends on:
[01](01-baseline-and-coverage-inventory.md),
[06](06-runtime-preloads.md).

## Implementation result

Web, public-web, desktop and protocol source-test tasks now override the root
build dependency. Backend and CLI keep it because their selected tests consume
built artifacts. The authoritative workspace group explicitly requests both
`build` and `test:workspace` in one Turbo invocation, preserving every build
while allowing independent source tests to overlap them. Static graph contracts
and Turbo dry-run output verify these exact edges. In the final aggregate, the
web source tests started 3.6 seconds into the workspace group and overlapped the
136.3-second web build; they no longer waited for that build to finish. The
workspace group completed in 283.3 seconds with every requested build and test
task successful.

## Goal

Allow source-only tests to run without first producing their package's
production bundle, while preserving every build and artifact check required by
authoritative validation. Improve cold-build feedback and useful overlap without
claiming that retained compilation work has disappeared.

In the reviewed sample, the web build took 160.6 seconds before its source tests
took another 240.7 seconds. Public web spent 98.3 seconds building before a
sub-second test suite. These are contended timings; the amount recoverable by
removing dependency edges depends on actual scheduling and host capacity.

## Files and contracts

- [turbo.json](../../../../turbo.json) and workspace package manifests.
- [scripts/test-all.ts](../../../../scripts/test-all.ts),
  [test-admission.ts](../../../../scripts/test-admission.ts) and `mise.toml`.
- [CI workflow](../../../../.github/workflows/lint.yml) and
  [.orkestrator-test-scheduler.json](../../../../.orkestrator-test-scheduler.json).
- [Backend standalone tests](../../../../apps/backend/tests/standalone.test.ts)
  and [CLI tests](../../../../packages/cli/tests/cli.test.ts): actual artifact users.
- Runner and package wiring tests under `tests/unit`, plus step 01 inventory.

## Target responsibilities

| Work | Needs a package production build before it runs? | Must remain in authoritative validation? |
| --- | --- | --- |
| Web source tests | No, after import/artifact audit | Yes |
| Public-web source tests | No, after audit | Yes |
| Protocol source tests | No emitted artifact required | Yes |
| Desktop source/script tests | Audit each selected file; current selected tests are source-oriented | Yes |
| Backend source unit tests | Generally no | Yes |
| Backend standalone tests | Yes: built backend and runtime closure | Yes |
| CLI package/launch tests | Yes: CLI and bundled bridge resources | Yes |
| Production builds currently reached by default graph | Independent of source tests that do not consume them | Yes |
| Codex generated-protocol verification | Its own pinned-binary check | Yes, retaining existing fallback reporting |
| Extra browser/agent/iOS workflows | Their existing prerequisites | Preserve existing opt-in scope |

For the first change, keep the backend package as one build-dependent task
because it mixes source and standalone tests. Splitting it is a later refinement
only if the remaining build dependency is material. Do not broaden the first PR
into relocating all backend tests.

## Tasks

### 1. Audit and draw the actual graph

- [ ] Inspect all selected package scripts, exported source entrypoints,
  generated-file imports and tests reading `dist` or package resources.
- [ ] Record the current build closure, including transitive protocol builds
  and work performed inside CLI/backend build scripts. Preserve that closure
  rather than replacing it with a narrower-sounding task name.
- [ ] Verify the declared cache outputs cover the artifacts the retained smoke
  tests consume. A cache hit must restore required files in a fresh worktree;
  the original warm filesystem is not adequate evidence.
- [ ] Check pinned Turbo documentation before using package-specific task
  overrides or changing multi-target invocation syntax. Confirm behavior with
  its task-graph/dry-run output rather than assuming dependency inheritance.

### 2. Implement the smallest useful graph change

- [ ] Retain build prerequisites for backend and CLI tests in the first pass.
- [ ] Remove only the proven-unnecessary build edges from web, public-web,
  protocol and qualifying desktop source tasks, using package-specific task
  configuration or explicitly named source tasks as supported by pinned Turbo.
- [ ] Explicitly request the retained build targets as well as tests in the
  authoritative workspace graph. Prefer one Turbo invocation for the workspace
  so shared build tasks are deduplicated and artifact producers cannot race.
- [ ] Keep the workspace group's current reserved slots and Turbo concurrency.
  Source tests and builds share that capacity; do not add a parallel build
  command outside admission to manufacture a faster result.
- [ ] Preserve all-group completion and failure reporting. A passing source
  suite plus a failed required production build must fail the aggregate.
- [ ] Measure readiness and completion: removing a dependency edge makes a
  task eligible earlier but does not prove Turbo will schedule it earlier.
  If scheduling still puts both long builds ahead of source tests, document
  that outcome before adding a more complicated scheduler.

Do not claim a 160-second total saving just because the web test no longer has
that predecessor. The build still consumes CPU, memory and a task slot. Report
time to first source-test result separately from time to full validation.

### 3. Preserve command semantics and changed-code selection

- [ ] Keep `mise run test` authoritative: the same required build/test coverage
  must be reachable and its failures visible in a single result.
- [ ] Keep `mise run test:all` behavior, including iOS last and only after the
  non-iOS checks succeed.
- [ ] Ensure `test:changed` selects affected source tests and required artifact
  prerequisites from the actual package graph, preserving its documented
  limitations for shared configuration and stale local `main`.
- [ ] Check backend-only, web-only, protocol-only, package-manifest, root-preload
  and no-relevant-change scenarios. No selected test may use a stale build
  because its source was omitted from the dependency graph.
- [ ] If a separate source-only developer command is added, label it as narrower
  feedback and give it an exact scheduler profile. Do not let it satisfy a
  complete-suite requirement or inherit an incorrect `covers` relation.
- [ ] Retain default standalone/CLI smoke behavior; no hidden opt-in switch may
  remove it from ordinary handoff validation.

### 4. Preserve caching, setup and CI

- [ ] Keep test tasks `cache: false`; retain cacheable builds and shared-worktree
  cache behavior. Do not add a relative cache directory to the normal command.
- [ ] Keep worker count and timing-directory variables passed through without
  changing build task hashes through Turbo argument passthrough.
- [ ] Update shared configuration/preload inputs for any new test task name.
- [ ] Retain CI typechecking. Where compilation is duplicated, remove it only
  after mapping every tsconfig's coverage to an explicit retained gate. Do not
  couple unrelated typecheck optimization to the initial dependency-edge PR.
- [ ] Update runner tests, package wiring assertions, task definitions,
  scheduler profiles and the testing guide together.
- [ ] Regenerate and verify tracked lockfiles when package metadata changes.

## Required validation

Start with runner/package contracts and static checks. Use the real full command
for aggregate validation; do not run it inside an unconfigured outer scheduler
reservation that would wait for its own child capacity.

```bash
mise run test:logged -- --name streamlining-task-graph -- \
  bun test ./tests/unit/test-all.test.ts ./tests/unit/monorepo-scripts.test.ts \
  ./tests/unit/mise-tasks.test.ts --parallel=1 --only-failures

mise run test:logged -- --name streamlining-check -- mise run check

mise run test
```

Additional graph tests must demonstrate:

1. Source suites can execute when their unrelated package output is absent.
2. Standalone and CLI tests wait for, then consume, correct built artifacts.
3. A required build failure fails validation even if its source suite passed.
4. Required artifacts restore correctly on a build-cache hit in a fresh
   disposable worktree with the same inputs.
5. Affected selection and tiny-host admission do not create deadlocks,
   duplicate builds, missing tests or unreserved work.

Use synthetic runner fixtures for failure/dependency checks where possible.
Never remove the user's active `dist` directory to test an absent-artifact path.

## Completion and rollback

- [ ] The old and new required assurance closures match, apart from explicit
  additions from step 01 and case changes already approved in earlier steps.
- [ ] Source readiness or aggregate duration improves under recorded conditions.
- [ ] Cold-enough and warm aggregate outcomes are recorded, including memory
  and any queue effects.
- [ ] Packaged artifact, protocol and typecheck gates remain mandatory.

Keep the graph/configuration changes as one reversible unit with their wiring
tests and documentation. If the simplified dependency graph gives no useful
benefit under the bounded scheduler, retain the measured finding and defer
further orchestration work rather than increase concurrency silently.
