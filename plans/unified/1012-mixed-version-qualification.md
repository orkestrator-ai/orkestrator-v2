---
id: 1012
title: "Scheduled mixed-version qualification"
phase: 1
plan: "§11.3 step 4"
status: done
depends_on: [1010]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
pr: ""
updated: 2026-11-07
---

# 1012 · Scheduled mixed-version qualification

- **Report:** [§11.3 step 4](../../docs/reports/unified-federation.md#113-manifests-and-ci)
- **Depends on:** [1010](1010-pilot-node-mail-and-ticket-sync.md)
- **Parallel with:** Phase 7 conversions (each adds its domain's scenarios here)
- **Size:** M
- **Track:** C (contract)

## Goal

On a schedule, not per PR, run the current client and backend against the floor release's backend, both directions, for every converted domain.

## Current state (verified 2026-11-07)

- `scripts/qualify-design-mixed-versions.ts` (500 lines) installs a published `orkestrator` npm release (default `--old-version 2.22.3`, `--ignore-scripts`). It runs that backend and the current one over one data directory.
- `scripts/qualify-backend-upgrade-rollback.ts` (1438 lines) runs releases from detached worktrees with their pinned Bun.

## Work

- [x] Generalise the design script into `scripts/qualify-contract-mixed-versions.ts` with per-domain scenario modules. The first module covers the pilot: node mail delivery with and without `steer`, outbox collect/ack, ticket sync, file transfer.
- [x] Default `--old-version` is the computed floor from `contracts/releases/index.json`.
- [x] Two topologies: the current command node with a floor leaf, and the floor command node with a current leaf.
- [x] A scheduled GitHub workflow (weekly). It needs explicit user approval before it is enabled, because it is a repository workflow change.

## Done when

- [x] The script passes locally for the pilot, and the workflow file is ready for the user to enable. (Enabled: adding it was approved by the user on 2026-11-07, in one combined PR.)

## Notes

### Approval (2026-11-07)

- Adding the scheduled workflow approved by the user on 2026-11-07, in one combined PR. The workflow is therefore committed enabled (`schedule` weekly, Tuesday 05:41 UTC, plus `workflow_dispatch`).

### Decisions (2026-11-07)

- **Files.** `scripts/qualify-contract-mixed-versions.ts` (the runner, `mise run qualify:mixed-versions`), `scripts/mixed-version/harness.ts` (processes, environment, ports, npm install), `scripts/mixed-version/scenario.ts` (the module interface and its rules), `scripts/mixed-version/fixtures.ts` (shared per-topology fixtures), `scripts/mixed-version/scenarios/{index,node-mail,ticket-sync,node-files}.ts`, `tests/unit/mixed-version-qualification.test.ts`, `.github/workflows/mixed-version-qualification.yml`. Docs: `version-compatibility.md#the-manifest-the-ratchet-and-ci` ("Mixed-version qualification" bullet) and `docs/development/testing-guide.md` (next to the design mixed-version run).
- **Generalised, not replaced.** `qualify-design-mixed-versions.ts` stays: it is a different topology (one backend at a time over one data directory: upgrade, downgrade fence, export/import). The new runner takes its install path (`bun add --ignore-scripts orkestrator@<v>` into a private `package.json`) and the command-node QA harness's attach and invoke pattern (`qa-command-nodes-support.ts`). Options considered: (a) extend the design script with a pair mode (one 500-line script mixing two topologies); (b) a new runner with pluggable modules (chosen; 7001-7009 add one file each); (c) run old releases from tag worktrees like `qualify-backend-upgrade-rollback.ts` (needs each tag's Bun and a full install; the npm package is what users run).
- **Module interface** (`scenario.ts`): `ScenarioModule = { domain, title, topologies?, requires?: { command?, leaf? }, run(ctx) }`; `ctx` has `topology`, `command`/`leaf`/`old` (`PeerNode`: `invoke`, `refusal`, `has(command)`, `hello` with `capabilities`/`domains`, `build`, `version`, `id`), `fixtures` (`project(node)`, `coordinator(node)`, `worker(node)`, memoised per topology), `scratch`, `check(id, description, ok, detail?)`, `note(step, detail)`, `notApplicable(reason)`, `expectedAdapter(domain)` (0/1 from the leaf's hello `domains`, `null` for an old command node) and `adapterCallsSince(domain, version)` (the `domain-adapter.backend.<domain>.v<n>` counter delta). `requires` names are checked against the release's snapshot (`readReleaseSnapshot`) and this checkout's manifest: missing on the release side is `not-applicable` (recorded with the names), missing on this checkout's side is a failure (a renamed command must update its module; the unit test also pins every `requires` name against the manifest). A scenario with no checks fails; a failed check fails it even if it then stops as not applicable. Modules register in `scenarios/index.ts` (while this item finished, 7002 was adding `terminals`, `files`, `claude-tmux` and a shared `renderer-client` helper, and 7001 `native-sessions`, against it; not checked here).
- **Release choice.** `--old-version floor` (default) uses `contract-ci.ts`'s `supportFloor` on `releases/index.json`; npm lacks v2.21.0 and v2.21.1 (1007), so while the floor is one of those the runner takes the oldest published in-window release npm carries (v2.22.3 today) and says so in the report (`release.note`). `latest-stable` is the newest published Stable release on npm (v2.36.1). `current` runs this checkout on both sides (one topology; a control run for a new module). An exact version must be on npm (`https://registry.npmjs.org/orkestrator`). The workflow's matrix runs `floor` and `latest-stable`; `workflow_dispatch` takes one release instead.
- **Topologies.** `current-command` (this checkout's command node, the release as leaf: the current senders' domain clients pick v0) and `old-command` (the release as command node, this checkout's leaf takes pre-contract requests without envelopes). "Floor client to current backend" is the second topology: the pilot domains are backend to backend (1010), so the floor's backend is the client. A renderer-side direction (a renderer's domain client against each node) is left to the renderer-called domains' modules (7002's `renderer-client` helper does this).
- **Attach baseline** (built in, domain `nodes`): AT-01 attaches over the loopback gateway route and the leaf reports leaf mode; AT-02 a leaf release without command nodes is refused naming the update (current answer: `NodeRefusal:needs-update: This node runs an Orkestrator version without command nodes. Update it first.`); AT-03 a command-node release without `add_node` is recorded. When the pair cannot attach, every module is `not-applicable` with that reason.
- **Isolation and safety.** Each backend: temporary data, worktree and HOME directories, a free loopback port never 34121/34122/45507, a private random gateway token (`ORKESTRATOR_GATEWAY_TOKEN`, never printed; the runner fails if any token appears in any backend's output), a constructed environment (only `LANG`/`LC_*`/`TERM`/`USER`/`LOGNAME`/`SHELL`/`TZ` inherited, no `ORKESTRATOR_*` (the host session's agent MCP variables and `ORKESTRATOR_VERSION` included), no credential-shaped variable, `PATH` = Bun's and Git's directories plus the system ones, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, `GIT_CONFIG_NOSYSTEM=1`), `--runtime-flavor agent-test` (no agent outside a managed toolchain can start, and there is none), `--strict-gateway-port`, an explicit free `--control-port`. Only spawned children are signalled. The release runs under this checkout's Bun (as the design script did), not its pinned one.
- **Fixtures.** Both nodes' projects use the same remote URL (`https://github.com/orkestrator-qualification/mixed-version.git`, a local bare `origin` behind it) so the nodes pair them by repository identity. The coordinator fixture opts the project into `coordinatorOtherEnvironments` (the fixture's workers were not launched by the coordinator; without it `send_coordinator_node_mail` is refused by the origin boundary).
- **Pilot modules.** node-mail: NM-01 delivery to a worker (the leaf's own mailbox), NM-02 retry by `requestId` delivers nothing new, NM-03/NM-04 `deliverNow` (steer taken and its outcome reported when the leaf has `node-mail-steer`, left out otherwise), NM-05/NM-06/NM-07 upward coordinator mail through the leaf outbox, collected into the command coordinator's mailbox (body read with `get_agent_mail_message`; the mailbox lists none) and acked (peeked with `collect_node_outbox` using only keys both sides send), NM-08 the adapter. ticket-sync: TS-01 a command-node ticket reaches the leaf under the same id, TS-02 a leaf edit comes back (leaf outbox), TS-03 the board reports in sync, TS-04 the adapter; for a leaf without ticket sync, `update-required` and nothing sent. node-files: NF-01/NF-02 project root to worker both ways with the same bytes, NF-03 no overwrite fails and leaves the file, NF-04 overwrite completes with the SHA-256, NF-05 the adapter. Return mail (`return_node_outbox_mail`) is not exercised: it needs a collected mail the command node cannot deliver, which no external command can stage.
- **Effect.** Not used: root scripts (the root does not depend on `effect`), child processes and HTTP; nothing needs services, scopes or typed failures beyond the `SetupError`/`NotApplicable` classes the report reads.
- Aggregate suite left to review preparation.

### Live results (2026-11-07, this Mac, from a detached worktree at 8ba4e87e9 plus this item's later script edits)

- **Floor** (`--old-version floor`: floor v2.21.0 is not on npm, ran v2.22.3): exit 0. `current-command`: AT-02 passed (refused with the needs-update message above); `old-command`: AT-03 passed (`Unknown backend command: add_node`). Every pilot module `not-applicable`: v2.22.3 predates command nodes (no `add_node`, `deliver_node_mail`, ticket sync or node files in its snapshot), so the v0 adapters have nothing to carry; the command node's refusal is the compatibility behaviour.
- **latest-stable** (v2.36.1, pre-contract, has `node-mail-steer`, `node-coordinator-mail`, `ticket-sync`; lacks `node-mail-turn-origin`, `coordinator-notices`, `node-mail-attachments`, `node-mail-return`): exit 0. `current-command`: nodes 1/1, node-mail 8/8, ticket-sync 4/4, node-files 5/5, with `domain-adapter.backend.{node-mail,ticket-sync,node-files}.v0` counted (the v0 adapters carried the pre-contract leaf). `old-command`: nodes 1/1, node-mail 6/6, ticket-sync 3/3, node-files 4/4.
- **v2.35.1-beta** (extra data point: no ticket sync, no upward coordinator mail, no `node-coordinator-mail`): exit 0 after the module change below. `current-command`: node-mail 5/5 (upward part skipped: the leaf has no `send_coordinator_command_node_mail`), ticket-sync 2/2 (`update-required`, no ticket sent), node-files 5/5. `old-command`: node-mail 5/5, ticket-sync not applicable (no `sync_node_tickets` on that command node), node-files 4/4.
- **Control** (`--old-version current`): every module passes with v1 (no v0 call).
- **Finding for the orchestrator:** with a command node without `node-coordinator-mail` (v2.35.1-beta), a current leaf coordinator's `send_coordinator_command_node_mail` answers `placement: "node-outbox"`, but the mail is never collected: `LeafNodeMail.collect` filters `fromCoordinator` items unless the command node asks with `coordinatorMail: true` (since #1621, 2026-11-02), and `ack` keeps them. It is held until that command node is updated, not lost. `docs/architecture/coordinator.md` ("Older nodes") says it "arrives as an ordinary worker report from the coordinator's runtime id", and the register has no row for command nodes without `node-coordinator-mail`. NM-06 asserts what the code does (held, not delivered, not dropped) for such a command node; either the doc or the code should change, and the register needs a row if the hold stays.
- Evidence (ignored): `output/agent-testing/1012/{floor,latest-stable,v2.35.1-beta,v2.35.1-beta-old-command-mail,control}.json`.

## Work log

- 2026-11-07 (claude-worker): added the runner, harness, module interface, fixtures, the node-mail, ticket-sync and node-files modules, the `qualify:mixed-versions` task, the weekly workflow (approved), docs (version-compatibility, testing guide) and `tests/unit/mixed-version-qualification.test.ts` (21 pass). Ran it live against the floor (v2.22.3 for v2.21.0), v2.36.1 (latest Stable) and v2.35.1-beta in both topologies, plus a control run: all exit 0 (results above). Ran 1010's live check through `--profiles` on two `dev:test` profiles (`uf-1012-cmd`, `uf-1012-leaf`): passed, recorded in 1010. `actionlint`, `mise tasks validate`, oxlint, `bun fmt`, `bun check -p tests/tsconfig.json` (no error in these files), `ci-workflows`/`mise-tasks`/`monorepo-scripts`/`version-drift` tests pass.
- 2026-11-07 (claude-worker, completeness audit): every registered module (29 plus the attach baseline) run live on this Mac, `--runtime-flavor agent-test`, no agent turns. Control `--old-version current` (one topology): first run 26 passed, 3 failed (docker, pull-requests, accounts), all scenario bugs, fixed in 8bdff7096: docker read the container list unconditionally (the constructed `PATH` has no `docker`, ~/.docker/bin here, so `get_orkestrator_containers` is refused; the module now expects a refusal only when `check_docker` says unavailable), pull-requests expected an arm token for a worker without a pull request (`armPrRecheckAfterAgentCompletion` arms only an open, conflicted PR: `null` is right), accounts wrote the auto-switch tick on an attached leaf (refused by design, naming the command node; now checked as such); rerun: all 30 passed. `--old-version latest-stable` (v2.36.1, floor 2.21.0): `current-command` and `old-command` every module passed except coordinator, not applicable because it required two reads v2.36.1 lacks; the module now skips those by name (8bdff7096) and passed 8/8 in both topologies. Counts (current-command / old-command): node-mail 8/6, ticket-sync 4/3, node-files 5/4, terminals 8/8, files 10/10, claude-tmux 8/8, native-sessions 10/10, nodes 9/9, coordinator 8/8, agent-servers 10/10, system 10/10, previews 10/10, transcripts 10/10, design 6/6, web-annotations 8/8, environments 12/12, docker 6/6, graphs 10/10, pipelines 8/8, multi-review 6/6, git 10/10, pull-requests 8/8, projects 14/14, config 12/12, kanban 14/14, accounts 11/11, mcp 12/12, agent-mail 14/14; v0 counted for node-mail (5), ticket-sync (2), node-files (9) with the release leaf. Gap: Docker was unavailable to every backend (constructed `PATH`), so the container list with Docker running was not exercised. No product bug found. Evidence (ignored): `output/agent-testing/mixed/{current,current2,latest-stable,latest-stable-coordinator}.{log,json}`.
