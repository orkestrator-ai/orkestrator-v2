# A Cursor reviewer fails every round on a standalone backend without its bridge

A Build Pipeline on the `beelink` host (standalone backend 2.34.4-beta) ran a Cursor reviewer in both review rounds of the `docker-settings-tab` pipeline (2026-10-31). Both times it failed before a session existed: `cursor bridge directory not found: <data-dir>/backend/releases/2.34.4-beta/node_modules/orkestrator/resources/cursor-bridge`. The installed release ships only `claude-bridge` and `codex-bridge`. #1491 (on demand bridge runtimes) has since changed what the package ships; this file is to confirm that it fixes reviewers and to decide what a reviewer should do when its agent cannot start.

## Task analysis

Analysed 2026-10-31 against `main` at `12b222fe`.

### Tasks

1. **Confirm a Cursor reviewer starts on a release that includes #1491**: run a Build Pipeline with a Cursor reviewer on a standalone backend. Status: open (depends on a release with #1491).
2. **Measure the first-use bridge install inside a reviewer start**: how long the on-demand install takes when a reviewer is the first Cursor use on a host. Status: open (depends on 1).
3. **Decide what happens when a reviewer's agent cannot start**: today it fails silently in every round. Status: open.

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

## Related

- [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md) task 6: which bridges the published package carries.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md): live runs batched across providers.
