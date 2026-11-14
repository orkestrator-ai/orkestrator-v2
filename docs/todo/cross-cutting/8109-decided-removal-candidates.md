# Removals the user decided on 2026-11-14

The removal candidates that [7571](7571-removal-candidates-needing-a-decision.md)
moved to the manual-test checklist on 2026-11-13 were answered by the user
(maintainer) on 2026-11-14. This file holds the removals; the
`envFilePatterns` copy is
[8106](../containers-and-environments/8106-env-file-patterns-copy.md), the
legacy readiness path is [8108](8108-legacy-retirement-sweep.md) task 2, and
the Linear integration stays.

## Task analysis

Analysed 2026-11-14 against `main` at `066992035`. Nothing here has been
built.

### Tasks

1. **Remove the background interaction observer and its two switches**: from 7571 task 5. Status: open.
2. **Remove the four artifact rollout flags**: from 7571 task 6. Status: open.
3. **Delete `NetworkWhitelistDialog.tsx`, `set_workflow_result_tools_rollout` and `graph_capability_ceiling_set`**: from 7571 task 7. Status: open.
4. **Delete the root `conductor.json`**: from 7571 task 11. Status: open.
5. **Port the `import_legacy_build_pipelines` callers to a test-only seed and remove the command**: from 7571 task 15. Status: open.

### 1. Remove the background interaction observer and its two switches

**Problem.** The background observe-only interaction monitor (B08) is off
unless `ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY=1`, and
`ORKESTRATOR_AGENT_INTERACTION_MONITOR_KILL_SWITCH` only stops adoption inside
that opt-in mode. Nothing but a test sets either.

**Context.** Both are read in `apps/backend/src/core/index.ts` (about lines
1018 and 1137) and allowlisted in `apps/desktop/electron/backend-process.ts`
(about lines 134-135). The user decided on 2026-11-14 to remove the
observe-only monitor, its adoption and both variables, including the
allowlist entries, and to keep the core `NativeAgentInteractionTracker`
pending-interaction handling (`native-agent-interaction-tracker.ts`).

**Investigation.** Not started. Separate the monitor and adoption code from
the tracker's pending-interaction path before deleting; `index.test.ts` sets
the variables.

**Decisions.**

- **How to find the boundary?**
  - **Delete from the two environment reads outwards, keeping every path the
    tracker uses when neither variable is set (recommended).**
    - Pros: the default behaviour, the only one users run, is unchanged by
      construction.
    - Cons: the monitor's code may share helpers that need splitting.
  - **Rewrite the tracker without the observer.**
    - Pros: a cleaner file.
    - Cons: risks the pending-interaction handling the user asked to keep.

### 2. Remove the four artifact rollout flags

**Problem.** `ORKESTRATOR_RICH_MARKDOWN`, `ORKESTRATOR_ARTIFACT_PUBLICATION`,
`ORKESTRATOR_ARTIFACT_LIVE_INTERACTIVE` and
`ORKESTRATOR_ARTIFACT_STATIC_PRESENTATION` default on with no recorded end
condition.

**Context.** `readArtifactRolloutFlags` in
`apps/backend/src/core/transcript-artifacts/service.ts`;
[transcript-artifacts-runtime.md](../../architecture/transcript-artifacts-runtime.md)
lists them as "Rollout switches (default on)". The user decided on 2026-11-14
to remove them and their gate checks, so there is no off switch afterwards.

**Investigation.** Not started. Every gate check reads the `rollout` option;
remove the option and the checks, update the runtime doc's table, and remove
the variables from any allowlist or documentation that names them.

**Decisions.**

- **What replaces a disabled surface in tests?**
  - **Nothing: delete the tests that only exercised a flag turned off, keep
    the ones that exercise the surface (recommended).**
    - Pros: tests describe the only behaviour left.
    - Cons: none known.
  - **Keep an injectable gate for tests only.**
    - Pros: tests can still switch a surface off.
    - Cons: a production code path only tests can reach.

### 3. Delete `NetworkWhitelistDialog.tsx`, `set_workflow_result_tools_rollout` and `graph_capability_ceiling_set`

**Problem.** `apps/web/src/components/environments/NetworkWhitelistDialog.tsx`
(and its test) is never mounted, and the two admin commands have no caller.

**Context.** The commands are defined in
`packages/protocol/src/contract/domains/pipelines/commands.ts` and
`packages/protocol/src/contract/domains/graphs/commands-templates.ts`, with
backend handlers and tests (`commands-registry-workflow-results.test.ts`,
`commands-registry-graphs.test.ts`, the workspace-grant scope tests). The user
decided on 2026-11-14 to delete all three with no older-version adapter (the
legacy-retirement decision of the same day,
[8108](8108-legacy-retirement-sweep.md)).

**Investigation.** Not started. A removed command still changes the domain
contract: follow
[How to add a command](../../architecture/version-compatibility.md#how-to-add-a-command)
and the manifest rules for the `pipelines` and `graphs` domains, without an
adapter for the old version.

**Decisions.**

- **Bump the domain versions?**
  - **Yes, as the contract tooling requires for a removed command, with no
    adapter (recommended).**
    - Pros: the manifest and ratchet stay truthful; the user's decision
      removes only the adapter.
    - Cons: a version step for two unused commands.
  - **No bump.**
    - Pros: smaller change.
    - Cons: the contract CI is expected to refuse a removed command without
      one.

### 4. Delete the root `conductor.json`

**Problem.** It configures the Conductor app, which nobody uses (the user,
2026-11-14), and nothing in the repository references it.

**Context.** Last edited 2026-09-09.

**Investigation.** None needed beyond `git grep conductor`.

**Decisions.** None: delete it.

### 5. Port the `import_legacy_build_pipelines` callers to a test-only seed and remove the command

**Problem.** A public command that writes arbitrary pipeline snapshots exists
only for test seeding.

**Context.** Callers: `e2e/agent-testing/container-app-wiring.spec.ts` (about
line 315), `e2e/agent-testing/pipeline-delete.spec.ts` (about line 64) and
`scripts/mixed-version/scenarios/pipelines.ts`, which retires with the
mixed-version sweep ([8108](8108-legacy-retirement-sweep.md) task 4) if that
lands first. The command is in
`apps/backend/src/core/commands-registry-build.ts`, its schema in
`packages/protocol/src/contract/domains/pipelines/schemas.ts` and
`commands.ts`, its tests in `commands-state-sync.test.ts`. The user decided
on 2026-11-14: port the callers to a test-only seed, then remove the command,
its schema and its tests, with no older-version adapter.

**Investigation.** Not started. The two e2e specs are real-stack suites: run
them credential-free on a disposable profile after the port.

**Decisions.**

- **Which seed?**
  - **A `dev:test` fixture seed, or a test-only storage seed through
    `storage-test-support.ts` driven by the profile launcher (recommended:
    whichever the two specs can reach without a public command).**
    - Pros: no public command exists only for tests.
    - Cons: the seed must write the same records the command wrote.
  - **A hidden admin command.**
    - Pros: smallest port.
    - Cons: it is the same public surface under another name.

## Assumptions and decisions

### Tasks 1 to 5: the user's decisions (2026-11-14)

The user (maintainer) answered 7571 tasks 5, 6, 7, 11 and 15 on 2026-11-14,
as recorded in 7571's Assumptions and decisions. Each task above states the
answer. Under the same day's legacy-retirement decision no removed command
keeps an older-version adapter.

## Constraints and rationale

- Domain contract changes follow
  [version-compatibility.md](../../architecture/version-compatibility.md#domain-contracts),
  minus the adapter.
- Keep `NativeAgentInteractionTracker`'s pending-interaction handling
  (task 1).

## Related

- [7571](7571-removal-candidates-needing-a-decision.md): the candidates and
  the decisions.
- [8108](8108-legacy-retirement-sweep.md): the legacy-retirement sweep.
- [8106](../containers-and-environments/8106-env-file-patterns-copy.md): the
  `envFilePatterns` copy.

## Replaces

Nothing; new work from the user's decisions of 2026-11-14 on 7571 tasks 5, 6,
7, 11 and 15.
