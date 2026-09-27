# 01 — Establish the baseline and coverage inventory

Status: Implemented; pending review and integration. Depends on: nothing.
Next: [Gateway fixture](02-gateway-expiry-fixture.md) and
[settings time](03-settings-autosave-time.md).

## Implementation result

The aggregate runner now owns the offline OpenCode compatibility probe, and
the desktop workspace script owns `agent-platform-selection.test.ts`. A new
repository inventory test enumerates tracked and untracked test files, assigns
each to one default or explicit suite, checks the real runner/package selectors,
and preserves the browser, agent-browser and diagnostic-fixture exclusions.
Runner contract tests cover the added selections. The historical 401.9-second
contended observation remains the comparison point; focused before/after
measurements are recorded in the relevant steps because they are more useful
than summing overlapping aggregate timings.

## Goal

Make performance and coverage changes attributable. Capture what the default
runner actually executes, identify the owning command for every test file, and
establish comparable measurements before reducing work.

## Files and existing mechanisms

- [scripts/test-all.ts](../../../../scripts/test-all.ts): selection, worker
  plan, group completion, log summaries and timing directory creation.
- [scripts/test-admission.ts](../../../../scripts/test-admission.ts): queued
  versus executing state and scheduler integration.
- [turbo.json](../../../../turbo.json), root/package Bun configurations,
  package scripts and `mise.toml`: actual discovery and dependencies.
- [tests/unit/test-all.test.ts](../../../../tests/unit/test-all.test.ts) and
  [monorepo-scripts.test.ts](../../../../tests/unit/monorepo-scripts.test.ts):
  current runner contracts.
- The source review and existing private summary/Turbo/Bun timing artifacts.

Prefer a small inventory utility and a focused ownership test over a new test
management framework. Proposed helper/test names must be chosen during this
step and documented once implemented.

## Tasks

### 1. Record an unchanged-source observation

- [ ] Record HEAD, working-tree changes, Bun version, operating system, logical
  CPUs, physical memory, aggregate capacity, active development profiles and
  whether other test commands are running.
- [ ] Save one current aggregate outcome with its build-cache hit/miss state.
  Preserve the failed 401.9-second review run as historical evidence rather
  than replacing its result with the isolated gateway pass.
- [ ] Extract per-package execution from Turbo summaries and per-file time from
  Bun profiles. Keep group time from submission separate from execution time;
  `CompletedGroup.elapsedMs` currently includes admission wait.
- [ ] Identify the actual final critical path. Do not sum overlapping package
  durations or treat the protocol group's long queue delay as generator cost.

### 2. Create explicit coverage ownership

- [ ] Enumerate repository-owned test/spec files without traversing installed
  dependencies, build output or Git internals. Include newly added, untracked
  source tests during local validation so a missing `git add` does not hide one.
- [ ] Assign each file to a default runtime suite, browser/agent suite,
  explicitly enabled live suite, compiler-only contract, or intentional
  fixture exclusion. A live test collected but skipped by default needs both
  its default collection owner and its enabled execution command recorded.
- [ ] Detect accidental overlap between default discovery roots, and distinguish
  that from an intentional additional live invocation of the same file.
- [ ] Give `apps/desktop/electron/agent-platform-selection.test.ts` an owner.
  The existing desktop package script lists three Electron files and a dev
  directory, so simply adding another sibling file does not collect it.
- [ ] Give `scripts/opencode-live-compatibility-probe.test.ts` an owner after
  verifying whether it uses offline fakes or needs explicit live prerequisites.
  Do not run live, authenticated compatibility checks implicitly.
- [ ] Keep the two deliberately failing diagnostic fixtures excluded from
  ordinary discovery; their parent diagnostic tests exercise them deliberately.
- [ ] Add one inexpensive guard against unowned files and accidental duplicate
  default collection. Validate the real selectors, not only a separately
  maintained manifest that could agree with itself while scripts drift.

Do not hard-code 898 files or 19,609 cases as a perpetual expected count.
Record the initial numbers and explain deltas. Test-row expansion, skipped
cases and compilation-only contracts make a raw declaration count unsuitable
as the sole assurance check.

### 3. Establish the comparison method

- [ ] Correct discovery ownership before the performance baseline used for
  implementation comparisons, or run the exact same corrected selection on
  both base and candidate. Adding assurance must not be mislabeled regression.
- [ ] Use a quiet warm run for the normal developer path, followed by a second
  observation if variability would change the decision. For final acceptance,
  collect the bounded repeated sample specified in step 11.
- [ ] Measure build-cache misses separately. Use a controlled disposable
  worktree/cache scope or targeted rebuild method verified for pinned Turbo;
  do not purge the user's shared cache or force-install dependencies merely
  to manufacture a cold result.
- [ ] Keep timing-profile state comparable: a newly created profile and a
  learned slowest-first profile are different scheduling conditions.
- [ ] Collect relevant peak process-tree memory with an available local
  measurement tool; identify whether the metric is sampled RSS, summed child
  RSS or another estimate. Never label parent RSS as total suite memory.
- [ ] Record spawned bridge/control/Git counts for the targeted fixtures when
  needed, using bounded counters rather than payload or command-content logs.

A broad telemetry/schema change is not required to start. Existing admission
messages and summaries can establish the baseline. Add machine-readable
queue/execution fields only if missing data repeatedly prevents comparison;
then test backward compatibility and overlapping interval accounting.

## Validation

For changes to discovery or scripts, run the focused runner checks:

```bash
mise run test:logged -- --name streamlining-runner-contracts -- \
  bun test ./tests/unit/test-all.test.ts ./tests/unit/monorepo-scripts.test.ts \
  ./tests/unit/mise-tasks.test.ts --parallel=1 --only-failures
```

Run the new ownership guard and each newly collected suite explicitly, then
the default suite. Validate an unowned sample path and overlapping selector
in the guard's synthetic fixtures; do not add a deliberately failing file to
the real repository tree just to test detection.

If package metadata changes, follow the repository lockfile procedure with
pinned Bun and verify both tracked lockfiles. Do not assume script-only edits
permit stale recorded workspace metadata.

## Completion and rollback

- [ ] Every file has an explainable owner or exclusion, and aggregate evidence
  agrees with the inventory.
- [ ] Baseline commands, configuration, timings and limitations are recorded.
- [ ] Discovery gaps are fixed or assigned an explicit follow-up that the final
  acceptance step treats as unresolved assurance.
- [ ] Inventory verification is cheap and does not launch the whole suite.

Keep instrumentation separate from discovery fixes so either can be reverted
without dropping newly assigned test coverage. No assertion removal belongs
in this step.
