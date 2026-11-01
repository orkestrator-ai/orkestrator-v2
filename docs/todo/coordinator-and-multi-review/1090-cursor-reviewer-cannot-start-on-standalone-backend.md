# A Cursor reviewer fails every round on a standalone backend without its bridge

A Build Pipeline on the `beelink` host (standalone backend 2.34.4-beta) ran a Cursor reviewer in both review rounds of the `docker-settings-tab` pipeline (2026-10-31). Both times it failed before a session existed: `cursor bridge directory not found: <data-dir>/backend/releases/2.34.4-beta/node_modules/orkestrator/resources/cursor-bridge`. The installed release ships only `claude-bridge` and `codex-bridge`. #1491 (on demand bridge runtimes) has since changed what the package ships; this file is to confirm that it fixes reviewers and to decide what a reviewer should do when its agent cannot start.

## Task analysis

Analysed 2026-10-31 against `main` at `12b222fe`.

### Tasks

1. **Confirm a Cursor reviewer starts on a release that includes #1491**: run a Build Pipeline with a Cursor reviewer on a standalone backend. Status: open (depends on a release with #1491).
2. **Measure the first-use bridge install inside a reviewer start**: how long the on-demand install takes when a reviewer is the first Cursor use on a host. Status: open (depends on 1).
3. **Decide what happens when a reviewer's agent cannot start**: today it fails silently in every round. Status: done (2026-11-01). The reviewer is marked as unable to start and named, with its reason, above the review and pipeline graphs; the rest of the panel carries on. See "Assumptions and decisions".

### 1. Confirm a Cursor reviewer starts on a release that includes #1491

**Problem.** A pipeline whose panel includes Cursor loses that reviewer in every round on a standalone backend, so the panel is one reviewer short each time and nobody is told why except on the failed node.

**Context.** The failure is thrown by `apps/backend/src/core/commands-servers.ts:1160` when the bridge directory is missing. The reviewer never gets a session, so the pipeline keeps only a `sessionlessReviewers` entry on the consolidation session (`apps/backend/src/core/build-pipeline-review-fanout.ts:905`), which is what the flow graph shows on the Reviewer 3 node. The pipeline record is `3ad6fddb-143b-419f-b867-803430b61fb3` in that host's `orkestrator.sqlite` (`build-pipelines` store).

**Investigation.** The 2.34.4-beta release on that host has `resources/claude-bridge` and `resources/codex-bridge` only. On `main`, #1491 (`d9b260fb9`) makes `packages/cli/scripts/build.ts` ship the Cursor and Pi bridge bundles with a pinned runtime under `resources/<bridge>/runtime/`, and `prepareBridgePath` (`commands-servers.ts:380`) installs the runtime into `<data-dir>/bridge-runtimes/` on first start (`apps/backend/src/core/bridge-runtime-install.ts`). The Cursor start path calls `prepareBridgePath(context, "cursor-bridge")` (`commands-servers.ts:1103`). Not yet run on a published release.

**Decisions.**

- **How to confirm it?**
  - **One Build Pipeline with a Cursor reviewer on a standalone backend after the next release (recommended).**
    - Pros: exercises the exact path that failed, including the reviewer fan-out.
    - Cons: needs a release and a signed-in Cursor account on that host.
  - **Rely on `smoke-packed.ts`, which starts the packed Cursor bridge.**
    - Pros: already runs; no account needed.
    - Cons: does not go through the reviewer fan-out or the installed release layout.

### 2. Measure the first-use bridge install inside a reviewer start

**Problem.** The first Cursor start on a host now runs `bun install --frozen-lockfile` before the bridge starts. If that first start is a reviewer, the install time counts against the reviewer's start.

**Context.** Reviewers start in parallel at the start of each review round. The install is per host and per runtime digest, so only the first start after an upgrade pays it.

**Investigation.** Not measured. Whether the reviewer start has its own timeout that an install could exceed was not checked.

**Decisions.**

- **Is anything needed?**
  - **Measure once on a fresh data directory; act only if it approaches a start timeout (recommended).**
    - Pros: no speculative work.
    - Cons: one more manual run.
  - **Install the bridge runtimes when the backend upgrades, before any session needs them.**
    - Pros: no first-use delay anywhere.
    - Cons: installs runtimes for agents a host may never use.

### 3. Decide what happens when a reviewer's agent cannot start

**Problem.** A reviewer whose agent cannot start on the host fails in every round with the same error, and the pipeline carries on with a smaller panel. The user only sees it on the failed node.

**Context.** Any missing bridge, a missing CLI or a broken toolchain fails the same way, not only Cursor's. Agent choice for reviewers is made when the pipeline is configured, before any round starts.

**Investigation.** No backend capability reports which bridges a host can start; nothing in `apps/` or `packages/` names one. Whether the reviewer picker offers only agents the host can run was not checked.

**Decisions.**

- **What should happen?**
  - **Check each reviewer's agent can start when the pipeline starts, and refuse or warn there (recommended).**
    - Pros: the user learns once, up front, and can swap the reviewer.
    - Cons: needs a cheap "can start" check per agent, which does not exist yet.
  - **Hide agents the host cannot start in the reviewer picker.**
    - Pros: the bad choice cannot be made.
    - Cons: needs the same capability check, and a configuration saved on another host can still name one.
  - **Leave it: the failed node already shows the error.**
    - Pros: no work.
    - Cons: every round repeats the failure and the panel silently shrinks.

## Assumptions and decisions

Made 2026-11-01 against `main` at `93b99bfb`. Tasks 1 and 2 stay open: they need a release that includes #1491.

### Task 3: what was still true on `main`

- **Found:** all of it. `startLocalServerAttempt` still throws `<kind> bridge directory not found` (`commands-servers.ts:1160`). A reviewer that fails before its session exists becomes `failed` with only an `error`, in the shared runner (`AgentBranchRunner.advanceIsolated`) used by both Multi Review and the pipeline. Only a pipeline consolidation session keeps it, in `sessionlessReviewers` (`build-pipeline-review-fanout.ts:905`). Nothing recorded that the agent never started, and the only place it showed was the failed node. Each pipeline round rebuilds its panel from the configuration (`BuildPipelineReviewFanout.start`), so the same reviewer fails again every round. Still no backend check of which agents a host can start. The reviewer pickers offer the agents enabled in Settings (`enabledAgentPlatforms`), not the agents the host can run.

### Task 3: what should happen

- **Chose:** record the start failure and show it at panel level when it happens. Do not add a "can start" check when the pipeline starts. This departs from the recommended option, for these reasons in the code:
  - There is no cheap check to call. The only faithful one is to start the agent's bridge (`start_local_<agent>_server_cmd` / `start_<agent>_server`), and that is what starting the reviewer already does. A start fails for many reasons: a missing bridge directory or entrypoint, unavailable bridge authentication, no container, or a broken toolchain. A file-existence probe would catch only the missing bridge, and #1491 fixes that case.
  - In Multi Review the reviewers start the moment the review starts, so a check "up front" would run at the same moment as the start it checks.
  - In a pipeline, a check at pipeline start would start every reviewer agent's bridge before the build stage, and keep it running through the build. It would be a second background writer on the pipeline record, and its answer could be out of date by review time, because bridge auth and host load change. The panel cannot be edited after the pipeline starts either, so a warning there lets the user do nothing except cancel.
- **What it does:**
  - A reviewer that fails before it has an agent session gets `startFailed: true` (`ReviewerRecord`, `packages/protocol/src/review-fanout.ts`). `AgentBranchRunner.advanceIsolated` sets it, so the bespoke Multi Review, its graph engine and pipelines all get it. The graph projection sets it on a failed activation that has no provider session. Retry and restart clear it. So does a workflow-level failure that fails a pending reviewer, because that reviewer's error is the workflow's own error and not a start failure.
  - The Multi Review overview and the pipeline flow view, which includes a pipeline review opened as a Multi Review, show a notice above the graph (`ReviewerStartFailureNotice`). It reads, for example, "Reviewer 3 (Cursor Agent) could not start, so this review is missing its findings. The other reviewers carried on." Below that, each failed reviewer gets a line with its agent and the error. In the pipeline view the notice has a "Show reviewer" button that selects the node.
  - The node and the inspector read "Could not start" instead of "Failed".
  - In a pipeline, the notice covers the newest review pass. A pass whose whole panel started clears it. Earlier passes keep their nodes marked as history.
- **The rest of the review still runs:** unchanged. The existing all-settled fan-in (`minSuccessful: 1`) consolidates the reviewers that reported. If no reviewer could start, the review fails as before ("No reviewer produced a valid report: …"), and the notice says no reviewer could start.
- **Every round tries the reviewer again:** kept. The cause may be gone by the next round (auth, load, a first-use install), and skipping the reviewer would shrink the panel for good on a fault that was only temporary. A start failure costs no provider turn, and each round now reports it.
- **Not built:** a backend capability that reports which agents a host can start, and the picker filter or pipeline-start warning that would use it. If wanted later, it belongs in its own to-do, with the cost of starting bridges early weighed against the benefit.

## Related

- [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md) task 6: which bridges the published package carries.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md): live runs batched across providers.
