# Testing improvements — implementation plan

Status: Proposed — implementation has not started.

Prepared: 2026-09-21. Source: [testing review](../../testing.md), based on
commit `88c2f9cc`. Recheck the current implementation before starting each step;
the review was static and did not establish a runtime failure baseline.

## Intended result

Make test results trustworthy, reproducible, recoverable, and useful both when
developing Orkestrator and when Orkestrator validates another repository.
The first delivery corrects misleading evidence and status. Subsequent steps
make existing browser coverage automatic, prove background UI recovery, and
bound the lifetime of retained evidence.

This directory is a plan, not an instruction to start implementation during
the planning task. Proposed types, files, defaults, and workflow names below
do not exist unless explicitly identified as current. No code, configuration,
dependency, or CI change is included in this planning delivery.

## Numbered steps

All steps are **not started**. Mark a step complete only after its acceptance
criteria and applicable verification are satisfied; record implementation and
human-merged PR references in the step and this index together.

| Step | Plan | Findings | Prerequisites | Delivery |
| --- | --- | --- | --- | --- |
| 01 | [Define validation evidence and completeness](01-validation-contract.md) | T5, T6; requirement provenance | None | Shared contracts, compatibility, outcome rules |
| 02 | [Qualify source identity during execution](02-source-identity.md) | T5 | 01 | Worker-owned observations and honest package claims |
| 03 | [Present validation outcomes consistently](03-validation-status-and-ui.md) | T6 | 01, 02 | Discovery, controllers, packages, and visible UI states |
| 04 | [Align test entrypoints and report suite scope](04-runner-consistency-and-scope.md) | T3; optional-suite reporting | None | Isolated root-unit shortcut and explicit suite inventory |
| 05 | [Own component-browser fixture servers](05-browser-fixture-ownership.md) | T4 | None | Prevent wrong-worktree browser results |
| 06 | [Retain useful CI failure evidence](06-ci-failure-evidence.md) | T2 | 04 for scope fields | Bounded artifact collection and verified sanitization |
| 07 | [Exercise persisted workflows in the browser](07-real-workflow-browser-tests.md) | T7 | 01–03; 06 for artifact handling | Credential-free tests through real workflow/worker/UI boundaries |
| 08 | [Run browser checks in pull requests](08-browser-ci.md) | T1 | 05–07 | Component and isolated-stack CI jobs |
| 09 | [Add native, container, and platform qualification](09-platform-qualification.md) | T1; optional-suite scope | 04, 06, 08 | Electron, Docker, iOS, and provider qualification policy |
| 10 | [Bound retained validation evidence](10-evidence-retention.md) | T8 | 01–03 | Ownership-aware retention, expiration, storage admission |
| 11 | [Improve flake handling and behavioral coverage](11-flakes-and-test-quality.md) | Review follow-ups | 04, 06; 08 for browser baseline | Actionable flake records and risk-based regressions |
| 12 | [Add structured reporting and complete rollout](12-results-and-rollout.md) | Review follow-ups; all acceptance | 01–11 for final rollout | Optional case reports, compatibility audit, final evidence |

The numbering gives a safe reading order, not a requirement to hold every
independent improvement behind step 03. Steps 04 and 05 can be delivered while
the contract work is underway; initial failure-log upload in step 06 need not
wait for the new scope metadata. This is dependency guidance, not a request to
delegate work to agents.

## Decisions used throughout the plan

1. **Keep Bun, mise, Turbo, and the existing worker.** Correct their integration;
   do not introduce a replacement runner or rebuild scheduling.
2. **Separate facts.** Process exit status, run lifecycle, required-check
   completeness, and source identity are different facts. Preserve each one.
3. **Use conservative source language.** Live-worktree observations can detect
   drift but cannot prove that source was immutable throughout execution.
   An unchanged observed tree is described as such. It is never labeled an
   immutable certification of the commit.
4. **Preserve live-worktree usefulness.** Dirty or generated output can still
   produce diagnostic evidence. Do not silently clean the user's tree, stop
   their agent, install dependencies, or create a new worktree to obtain a pass.
5. **A completed run is not necessarily successful or complete validation.**
   An empty plan is not validated; a missing required suite is incomplete;
   failed commands remain failed even if review continues to help diagnose them.
6. **Keep review useful on failure.** Reviewers may inspect failed/incomplete
   evidence. Do not add an unconditional stop-before-review rule. Any existing
   final verification/completion gate must consume the same normalized facts.
7. **Preserve history.** Read existing plans, snapshots, and sealed packages
   without inventing new evidence or modifying their hashed bytes.
8. **Prefer deterministic browser fixtures.** Replace the provider boundary
   when necessary, while keeping storage, gateway, worker, scheduler, and
   renderer real. Live-provider tests remain a separately reported layer.
9. **Stage CI enforcement.** Prove jobs on real runners before a human changes
   required-check settings. No plan step authorizes direct pushes or merges to
   `main` or remote repository-administration changes.

## Preserved invariants

- Backend/environment processes own execution, cancellation, evidence, and
  retention. React unmount and inactive tabs do not cancel work.
- Snapshots recover missed events; restart/reconnect never duplicates an
  ambiguous dispatch. Do not replace the existing idempotency boundary.
- Command dependencies, resource exclusions, cooperative scheduling, and host
  capacity admission retain their current semantics.
- Every new list, report, probe, artifact traversal, and IPC payload has byte,
  count, and time bounds. Do not buffer whole diffs or logs in the renderer.
- Raw command output belongs in private evidence. Operational metrics and
  logs contain no prompts, credentials, contents, or attachments.
- Fixture cleanup verifies exact ownership. Never kill broad process names,
  reuse production profiles, or retag the production Docker image.
- Approvals and authentication keep their existing fail-closed behavior.
- Test task execution stays uncached. A stored passing result is not a new run.

## Delivery and verification conventions

Each step contains file ownership, implementation tasks, edge cases, acceptance
criteria, verification, and rollout notes. Named new files are suggestions;
reuse an existing owner when that is clearer and avoid files over 2,000 lines.

Use [the testing guide](../../../development/testing-guide.md) before selecting
tests and [the isolated profile guide](../../../development/agent-testing.md)
before browser/native QA. All commands below are existing repository tasks:

```bash
# Iteration: choose an explicit owning file and its documented preload.
mise run test:logged -- --name focused -- \
  bun test ./path/to/owner.test.ts --parallel=1 --only-failures

# Handoff for an implementation change, after owning checks pass.
mise run test:changed
mise run test:logged -- --name check -- mise run check
mise run test
```

The focused path is a placeholder, not a file to create. Backend tests use the
Node-only preload and package working directory specified in the guide. Run
relevant browser, Electron, Docker, and iOS checks separately; the aggregate
command does not claim to include them. Do not rerun passing suites without a
new change, failure, or unresolved concern.

For each PR record the exact commit, commands, statuses/counts where available,
artifact paths for failures, skipped scope with reasons, and profile cleanup.
When aggregate failure passes in isolation, update the existing flake registry
with both observations instead of weakening the assertion.

## Completion matrix

| Scenario | Required proof | Owning steps |
| --- | --- | --- |
| Zero commands or missing required browser suite | No successful-validation indicator; reason is visible | 01, 03, 07 |
| Tracked file changed without moving HEAD | Command outcome preserved; source qualification cannot claim the original commit was tested immutably | 02, 03 |
| Two worktrees run component tests | Each run owns the intended server, or conflicts explicitly | 05 |
| Early failure absent from console tail | Original evidence available from the CI run | 06 |
| Workflow finishes while hidden, then page reloads | Correct visible commands, summary, output, and controls; no duplicate process | 07, 08 |
| Requested platform cannot run | Explicit unavailable/skipped scope, not an implied pass | 04, 09 |
| Many review rounds in one environment | Bounded storage or explicit admission refusal; no deletion of pinned evidence | 10 |
| Old persisted run/package loads | Readable history, honest unknown metadata, unchanged package digest | 01–03, 10, 12 |

## Limits and deferred work

Immutable snapshot execution, distributed/container CPU quotas, a universal
test-report parser, automatic flake retries, and a new global test dashboard
are not required to close the review findings. Step 02 documents what would
be required before adding snapshot execution. Step 12 treats structured
test-case reports as an optional follow-up that must not delay correctness.

No performance gain or CI duration is claimed before measurement. Timing
budgets and retention defaults in the steps are proposed initial settings,
to be checked against representative fixtures and current runner constraints.
