# Testing review

Status: Review — recommendations only; no implementation changes.

Reviewed: 2026-09-21, against commit `88c2f9cc`.

## Scope and method

This review covers both testing Orkestrator's own codebase and the validation
Orkestrator executes for projects inside its environments. It examines the
checked-in tasks, CI workflows, runner, test setup, representative tests,
isolated application profiles, review worker, evidence packaging, and UI.

This is a static review. No test suite, application profile, live provider,
Docker fixture, or iOS simulator was run. Historical CI results, branch
protection settings, measured coverage, and current flake rates were not
inspected. Findings below distinguish directly observable behavior from design
risks and follow-up opportunities; they do not claim new runtime reproductions.

## Current approach

| Area | What exists today |
| --- | --- |
| Repository tests | `mise run test` runs workspace tests, root/support tests, five bridge suites, and a Codex protocol check. Workspace tests depend on builds. Bun files run in bounded, isolated worker pools. |
| Fast feedback | Focused logged tests and `test:changed`; the latter is explicitly not final validation. |
| Static checks | Separate formatting, lint, and typechecking tasks and PR jobs. |
| Browser tests | Component fixtures at desktop/mobile sizes, plus separate real-stack browser and Electron suites. Docker and live review paths require additional opt-in. |
| Platform checks | Architecture-specific packaged-backend and Docker-image build workflows; optional iOS tests through `test:all`. |
| Resource management | Shared host admission, queue deadlines, process-group cancellation, output bounds, execution watchdogs, and persistent failure artifacts. |
| In-app validation | An agent discovers a repository-specific command plan. An environment-owned worker executes it, persists progress, and seals shared evidence for reviewers. |
| In-app feedback | Per-command state, queue/execution timing, limitations, output inspection, and restart controls. UI remounts do not own execution. |

The foundations are strong. In particular, preserve backend ownership, explicit
`incomplete` results for infrastructure failures, dependency-aware scheduling,
shared evidence across reviewers, artifact hashes, and uncached execution of
the aggregate test tasks. The implementation already addresses many common
problems with agent-driven testing; replacing the runner is not the first
priority.

Primary references:
[testing guide](../development/testing-guide.md),
[agent testing guide](../development/agent-testing.md),
[aggregate runner](../../scripts/test-all.ts),
[Turbo tasks](../../turbo.json), and
[review preparation](../architecture/review-preparation.md).

## Findings: testing the Orkestrator codebase

### T1 — High: browser and real-application tests have no checked-in CI execution

**Evidence.** The PR test job in
[lint.yml](../../.github/workflows/lint.yml#L67) runs `mise run test`.
The aggregate runner intentionally excludes Playwright component and real-stack
suites. None of the checked-in workflows invokes `test:browser`,
`test:agent:browser`, `test:agent:electron`, `test:agent:docker`, or `test:ios`.
[Runtime validation](../../.github/workflows/validate-bun-runtime.yml) builds
packages/images and exercises the packaged backend, but does not replace those
user-flow tests.

**Impact.** A PR can pass every checked-in automatic test job while breaking
browser layout, native integration, or an inactive-environment workflow. This
matters especially because the repository explicitly requires real-browser
verification for frontend behavior. The tests already exist, but enforcement
depends on the contributor running and reporting them.

**Recommendation.** Add an automatic component-browser job and a small,
credential-free isolated-stack smoke job. Include environment creation,
background completion, reload, and cleanup. Add native Electron, container,
and iOS lanes on appropriate change scopes or a scheduled/release cadence.
Keep live-provider qualification separately identified so a passing smoke job
does not imply every provider was exercised.

**Acceptance target.** A deliberately broken covered browser interaction fails
a PR job. The job reports exactly which suites ran or were skipped and retains
failure evidence. Isolated profiles are cleaned up even after failure.

### T2 — Medium: CI discards the runner's detailed failure artifacts

**Evidence.**
[`finalizeTestLogs`](../../scripts/test-all.ts#L495) saves compressed group logs
and `summary.json`; the runner prints bounded failure tails. The test job in
[lint.yml](../../.github/workflows/lint.yml#L90) ends after `mise run test` and
has no artifact upload. The upload in the container-publishing workflow is
unrelated to test diagnostics.

**Impact.** The saved temporary-directory path is useful locally but disappears
with an ephemeral CI runner. A failure outside the printed tail can require a
rerun to investigate, losing the original evidence of a timing-sensitive bug.

**Recommendation.** Give the job a unique artifact directory and upload its
bounded summary and failure logs after unsuccessful execution. Retain the
existing privacy constraints and define a short retention period. Use the same
pattern for browser reports and appropriately sanitized traces.

**Acceptance target.** Force an early failure followed by enough output to
truncate the console tail; the original failure remains downloadable from
that run without rerunning it.

### T3 — Medium: the documented root-unit shortcut changes isolation semantics

**Evidence.** [`test:unit`](../../mise.toml#L223) invokes
`bun test tests/unit` without an explicit relative path or `--parallel`.
The [testing guide](../development/testing-guide.md) recommends this task for
root-unit testing, while the aggregate
[root group](../../scripts/test-all.ts#L680) uses explicit paths and a bounded
parallel worker count. The repository's guidance explicitly relies on that
mode for per-file isolation. [Shared setup](../../tests/setup.ts) installs
module mocks, and individual suites also replace modules.

**Impact.** The shortcut is not equivalent to the root portion of normal
validation. It exposes tests to a different module/global lifetime and uses
discovery-filter syntax where the guide calls for a path. A result can therefore
depend on which documented entrypoint a developer chooses. This review did not
reproduce a particular failure under the shortcut.

**Recommendation.** Align the shortcut with the aggregate's explicit path and
bounded per-file isolation, retaining `test:logged` for evidence. Prefer stable
file-scoped mocks or narrower injected boundaries when touching affected tests.

**Acceptance target.** An owning file, the root-unit task, and the aggregate
root group use consistent preload/isolation rules and select the intended files.
Exercise a representative set containing both real-adapter and mocked-adapter
tests when making the change.

### T4 — Medium: component-browser tests can reuse another worktree's server

**Evidence.** [Playwright component configuration](../../e2e/playwright.config.ts#L5)
uses the fixed URL `127.0.0.1:1422`, a strict fixed port, and
`reuseExistingServer: !process.env.CI`. There is no worktree identity check in
that configuration. The
[scheduler profile](../../.orkestrator-test-scheduler.json) reserves this port
for in-app validation, but that does not prove an already-running server serves
the current checkout.

**Impact.** With two worktrees, a local run can target a fixture server from
the other worktree and report a pass against different frontend code. Resource
serialization alone cannot establish server identity.

**Recommendation.** Allocate a run-specific port/server, or verify an explicit
worktree/build identity before permitting reuse. Apply the same ownership rule
to manual, logged, and in-app invocations.

**Acceptance target.** Start a fixture server from worktree A, then run a
changed fixture test from B. B must launch its own server or reject the identity
mismatch, rather than silently testing A.

## Findings: testing inside Orkestrator

### T5 — High: a commit ID does not identify the actual source tested

**Evidence.** The
[worker](../../apps/backend/src/core/review-validation-worker.ts#L74) checks
HEAD, but `noteWorktreeDrift()` records dirty paths without invalidating command
results. The existing
[drift regression](../../apps/backend/src/core/review-validation-worker.test.ts#L214)
explicitly expects a changed tracked `source.txt` before validation to produce
a completed run with a passed command. The
[service](../../apps/backend/src/core/review-validation-service.ts#L246) carries
these paths into evidence, and
[package generation](../../apps/backend/src/core/commands-review.ts#L861)
ties the committed diff to HEAD.

**Impact.** A user or another agent can alter tracked source without committing;
tests execute that altered source while the review package names the original
commit. The path note discloses drift, but cannot establish which file contents
each command actually tested. Log hashes establish log integrity, not source
identity. This is an intentional current policy with a certification risk,
not a newly reproduced implementation regression.

There is also a direct documentation mismatch:
[review-preparation.md](../architecture/review-preparation.md#evidence-and-sealing)
says clean Git status is checked before and after execution and a changed
snapshot cannot be certified. The current implementation permits tracked-file
drift as well as generated/untracked files.

**Recommendation.** Define the evidence guarantee explicitly. Prefer validation
in an isolated snapshot of the intended commit. If execution must use the live
worktree, distinguish tracked source changes from permitted generated output,
mark affected evidence as unable to certify the commit, and show that limitation
prominently. Update the architecture guide to match the chosen policy.

**Acceptance target.** Change a tracked source file after discovery without
moving HEAD. A passing command must not be presented as certification of the
unchanged commit. Also cover mutation during execution and permitted generated
outputs; before/after checks alone cannot detect every transient mutation.

### T6 — Medium: an empty plan can receive a successful Tests indicator

**Evidence.** The
[plan validator](../../packages/protocol/src/review-validation.ts#L104)
legitimately accepts zero commands when a limitation is supplied.
[`validationOutcome`](../../apps/web/src/components/build-pipeline/BuildChatTab.tsx#L157)
defaults to `passed` when no result is failed or incomplete; an empty completed
run satisfies that condition. The
[icon](../../apps/web/src/components/build-pipeline/BuildChatTab.tsx#L364)
then renders a success checkmark. Plan limitations are shown inside collapsed
[Notes](../../apps/web/src/components/review/ReviewValidationStatus.tsx).

**Impact.** A repository with no runnable validation, or missing prerequisites
that cause discovery to return only limitations, can display a success icon
next to `0 checks`. Similarly, passing selected commands does not communicate
that a required suite was omitted and mentioned only in the plan's limitations.
The UI already distinguishes failed and incomplete command results correctly;
the gap is overall coverage of requirements.

**Recommendation.** Separate execution completion, command success, and
validation completeness. Render zero executed checks as not validated. Give
omitted required checks a structured reason/severity so harmless advisory notes
do not have to block success. Keep repository-declared covered skips distinct
from checks that could not run.

**Acceptance target.** Cover empty-with-limitation, passed-with-required-suite-
missing, advisory-only notes, covered skips, and failed prerequisites. Each must
have an unambiguous overview status without opening Notes.

### T7 — Medium: the real-worker browser test does not prove restored validation UI

**Evidence.** The
[inactive validation test](../../e2e/agent-testing/browser-gateway.spec.ts#L596)
creates real environments, runs commands, switches environments, reloads, and
compares the returned `status_review_validation` snapshot. This is valuable
backend/gateway coverage. It starts the validation directly and checks the
restored result through `invoke`; it does not assert restored command rows,
output controls, or the Tests status in a persisted review/build workflow.
The separate
[coordinator review test](../../e2e/agent-testing/browser-gateway.spec.ts#L306)
does exercise workflow UI, but is gated by `ORKESTRATOR_AGENT_TEST_REVIEW=1`.

**Impact.** The ordinary browser suite can pass if the worker survives correctly
but the validation view fails to rehydrate or displays stale controls. Unit
tests and component fixtures cover portions of this behavior, but do not join
the real worker, persisted workflow, and restored renderer in one assertion.

**Recommendation.** Add a deterministic, credential-free full-workflow fixture
that supplies a validation plan through the workflow boundary and uses the real
worker. Assert visible queued/running/completed results and output after switching
away and reloading. Include cancellation and an incomplete result.

**Acceptance target.** Break the renderer's snapshot restoration while leaving
the status API healthy; the browser regression must fail.

### T8 — Medium, design gap: per-run evidence bounds do not bound retained history

**Evidence.** The
[worker](../../apps/backend/src/core/review-validation-worker.ts#L42) bounds
output to 32 MiB per stream and 256 MiB per run, storing each run below
`.orkestrator/review-artifacts/<run-id>/`. Restarts and later rounds create new
IDs. I found no age/count/total-byte pruning policy for those directories in the
review worker, service, package, or workflow lifecycle paths inspected. This is
separate from the repository runner's implemented seven-day temporary-log
retention.

**Impact.** Repeated validations in a long-lived environment can accumulate
substantial disk usage despite each run respecting its limits. Environment
deletion is not a retention strategy for an environment kept for ongoing work.
No disk-exhaustion incident was reproduced in this review.

**Recommendation.** Define environment-level evidence retention and a total
budget. Protect active runs and evidence referenced by retained review packages;
prune superseded/unreferenced runs and make expiration explicit. Preserve
immutable package integrity rather than silently deleting referenced logs.

**Acceptance target.** Many completed/restarted runs remain within the retained
budget; active and pinned evidence survives; expired evidence has an explicit
state. Check both local and container environments.

## Further improvements and measurement

- **Turn the existing flake registry into a prioritized maintenance queue.**
  The [index](../tests/flaky-tests/0000-index.md) records open timing, process,
  and historical investigation cases. Some rows lack an owning file or precise
  symptom. Add owner, last observed date, recurrence count, and next reproduction
  step to actionable cases. Historical open entries are not proof that the
  current pinned runtime still flakes; do not infer a rate from the index.
- **Measure test quality by behavior and risk.** Source-text contract tests such
  as [completion-status wiring](../../tests/unit/components/BuildCompletionStatusWiring.test.ts)
  can protect a narrow wiring invariant, but matching an import and JSX string
  does not prove visibility or interaction. Preserve useful architectural checks
  and pair critical ones with behavior assertions. Start with missed-event
  recovery, approval handling, cancellation, and workflow completion rather than
  adding a repository-wide coverage percentage target without a baseline.
- **Make validation requirements reviewable.** Discovery is fresh and flexible,
  but the plan schema has commands plus free-text limitations, not a structured
  mapping from required checks to executed/omitted checks. Add optional
  requirement provenance and test-suite categories before introducing stronger
  completeness gates. This would also make browser/native omissions visible.
- **Report optional suite scope explicitly.** `test:all` succeeds without an iOS
  group on unsupported hosts, as documented. Its
  [runner branch](../../scripts/test-all.ts#L874) does not add an explicit skipped
  iOS entry to the summary. Record requested, executed, and unavailable suites
  so in-app validation can explain exactly what an aggregate command covered.
- **Keep command success distinct from test-case results.** Current in-app
  evidence records process exit status, timing, logs, and hashes. Optional
  structured result adapters could add test counts, skipped cases, failure names,
  and links without guessing from console text. This is a product enhancement,
  not evidence that the current process-result model is incorrect.

## Suggested order

1. Resolve source identity and completeness semantics (T5, T6), including the
   architecture-document mismatch.
2. Run existing browser coverage automatically and retain CI failure evidence
   (T1, T2).
3. Align local test isolation and browser-server ownership (T3, T4).
4. Add deterministic restored-workflow UI coverage and evidence retention
   (T7, T8).
5. Use measured failures, duration, queue time, and resource usage to prioritize
   the flake backlog and later reporting improvements.

These are proposed follow-ups only. This review changes no application code,
test code, runner configuration, or CI workflow.
