# Documentation catalog

`AGENTS.md` is the agent source of truth. The root file holds repository-wide
rules and an index of area-specific instruction files (`bridges/AGENTS.md`,
`bridges/<bridge>/AGENTS.md`, `docker/AGENTS.md`), each paired with a
`CLAUDE.md` that imports it. This file is the living catalog of `docs/` only:
what each folder is for, and which document to open. Do not copy invariants
from any `AGENTS.md` here.

Refreshed 2026-10-15 against `main` at `2459b05c`.

## Layout

| Folder | What it holds |
| --- | --- |
| [`architecture/`](#architecture) | Living guides to how shipped features work. Keep them aligned with the tree. |
| [`development/`](#development) | Living contributor guides: testing, upgrades, releases, disk usage. |
| [`tests/`](#tests) | The flaky-test registry, grouped into folders by area. [`tests/flaky-tests/0000-index.md`](tests/flaky-tests/0000-index.md) points to each folder's index, which tracks its cases. |
| [`todo/`](#todo) | All outstanding work in numbered files, grouped into folders by area. [`todo/0000-index.md`](todo/0000-index.md) points to each folder's index, which ranks its files by criticality. Pick work from here. |

There are no other plan, review or dated-note folders, and nothing else
belongs at the top of `docs/`. Durable content goes into `architecture/` or
`development/`; anything still to do goes into `todo/`. Completed plans are
deleted once their behaviour is in a living doc; git history keeps them. The
2026-10-15 consolidation removed everything under `docs/improvements/`,
`docs/imrovements/`, `docs/plans/`, `docs/2026-10-14/`, `docs/2026-10-15/` and
`docs/reviews/`. Read those files at commit `2459b05c` if you need the history.

## Architecture

| Document | Notes |
| --- | --- |
| [agent-engines.md](architecture/agent-engines.md) | Six-engine architecture. Coordinator tiers match `coordinator-providers.ts`. |
| [agent-messaging.md](architecture/agent-messaging.md) | Durable mailbox, routes (coordinator / peer / isolated), budgets, automatic retry, idle injection. |
| [agent-registry.md](architecture/agent-registry.md) | Every agent tab and what it is doing: `get_agent_registry`, Control MCP `list_agents`, sidebar hover counts. |
| [native-agent-service.md](architecture/native-agent-service.md) | `NativeAgentService` as one class wiring collaborators: what each owns, host wiring, lifecycle order, invariants kept, and how tests reach collaborator state. Follow-up: [0057-native-agent-service-size.md](todo/backend-structure/0057-native-agent-service-size.md). |
| [backend-runtime.md](architecture/backend-runtime.md) | Per-backend process state in `BackendRuntime`: terminal, local-server and environment-operation clusters, the rules for reaching them, test construction options, shutdown order. Residue: [0066-backend-residual-module-state.md](todo/backend-structure/0066-backend-residual-module-state.md). |
| [coordinator.md](architecture/coordinator.md) | Current Coordinator: ownership, one main plus side agents, tiers, async delegation, MCP actions. Remaining work: [0026-coordinator-read-only-adapters.md](todo/coordinator-and-multi-review/0026-coordinator-read-only-adapters.md), [0024-coordinator-live-conformance.md](todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md), [0142-coordinator-product-surfaces.md](todo/coordinator-and-multi-review/0142-coordinator-product-surfaces.md). |
| [native-transcripts.md](architecture/native-transcripts.md) | Native transcript pipeline: v1/v2 bridge reads and capability discovery, summaries and detail locators, history pages and the two cursor namespaces, revised rows, row boundaries, deltas and patches, display-tail checkpoints, progress probes, pipeline transcript store, ceilings, retained fallbacks. |
| [transcript-scroll.md](architecture/transcript-scroll.md) | Transcript scrolling: one controller per viewport, follow intent, cancellation at every layer (Virtuoso patch), measured convergence, semantic anchors and history paging, activation policy, bounded tool-group viewports, streaming Markdown prefix reuse, diagnostics, limitations. |
| [rich-transcripts.md](architecture/rich-transcripts.md) | Rich transcript rendering: Markdown pipeline, code/diagram/table/callout/disclosure/media blocks, native charts, workflow snapshots, identities, bounded caches, find and copy, publication placement. |
| [transcript-artifacts-runtime.md](architecture/transcript-artifacts-runtime.md) | Transcript artifacts: ownership and grants, records and storage, receipts and publication, preview worker isolation, interactive preparation and CSP, content serving, desktop live host, configuration. |
| [transcript-artifacts-agent-guide.md](architecture/transcript-artifacts-agent-guide.md) | Agent-facing guide to the seven artifact tools, with chart and interactive examples. |
| [rich-transcripts-user-guide.md](architecture/rich-transcripts-user-guide.md) | User guide: supported content, controls, copy/export, interactive artifacts, snapshots versus live state, platform limits. |
| [design-canvas.md](architecture/design-canvas.md) | HTML/CSS canvas, recoverable operations, private records, history, sync, safe export, design MCP and .orkdes files. |
| [control-mcp.md](architecture/control-mcp.md) | Control MCP operator guide: credentials and profiles, tool tiers, confirmation, authority. |
| [control-mcp-voice.md](architecture/control-mcp-voice.md) | Control MCP for voice clients: the voice profile's tools, spoken confirmation, the attention relay, the local relay for hosted platforms, qualification (scripted harness, approval run, recording relay and scoring). |
| [mcp-management.md](architecture/mcp-management.md) | Per-provider MCP server management: sources, precedence, safe writes, secrets, apply states, evidence. |
| [version-compatibility.md](architecture/version-compatibility.md) | Mixed-version support window (published releases from the floor: the newest Stable at least 60 days old, v2.21.0 today), supported pairings, data upgrade and downgrade rules, compatibility-path usage counters, and the register of paths with owners and removal conditions. |
| [remote-gateway.md](architecture/remote-gateway.md) | Standalone backend, Tailscale Serve, flags, troubleshooting. |
| [command-nodes.md](architecture/command-nodes.md) | **Target multi-machine architecture:** command nodes (registry, portal, cross-node coordinators, mail, files) and leaf nodes; control plane via the command node, agent chat, terminals and previews direct from client to leaf where reachable. |
| [federation.md](architecture/federation.md) | Transitional client-side multi-machine federation on this branch, being reworked into command nodes: identities, hello handshake, machine profile and colours, routes/fallback, realm-based panels, known limitations, acceptance-ID map. |
| [host-updates.md](architecture/host-updates.md) | Maintaining the backend's computer from any client: Orkestrator updates (desktop app or standalone service; now or when idle; cancel; 60 s countdown; restart reconciliation; rollback), toolchain repair, gh channel, container image, UI and CLI. Remaining work: [0033-remote-host-upgrades.md](todo/cross-cutting/0033-remote-host-upgrades.md). |
| [public-cli.md](architecture/public-cli.md) | `orkestrator` client commands: backend selection, JSON/exit contract, request keys and retention, lifecycle waits, settings, sessions, request-specific completion, exec, scenarios. |
| [event-snapshot-recovery.md](architecture/event-snapshot-recovery.md) | Which sequence each consumer may compare, revisioned view snapshots/outcomes, bounded client hydration, best-effort PR notifications, terminal input recovery. |
| [web-page-annotations.md](architecture/web-page-annotations.md) | Preview notes, capture spool, backend threads and their copy-on-write commits, native dispatch, review, migration. Real-stack gates: [0044-web-annotation-qualification.md](todo/previews-and-annotations/0044-web-annotation-qualification.md). |
| [browser-previews.md](architecture/browser-previews.md) | Service previews: registry, local-environment discovery and listener ownership, desktop tunnel, private HTTPS origins, relay, kill switch, rollback. Rollout: [0042-service-preview-rollout.md](todo/previews-and-annotations/0042-service-preview-rollout.md). |
| [review-preparation.md](architecture/review-preparation.md) | Multi-review pipeline; queue wait is 30 minutes. Auto-fix and auto-PR ordering and recovery. Fan-out budgets and the efficiency benchmark. |
| [native-agent-commands.md](architecture/native-agent-commands.md) | Slash-command descriptors, bridge wire contract, intent resolution, collisions, catalogue lifecycle, per-provider support tables. |
| [bridge-diagnostics.md](architecture/bridge-diagnostics.md) | Shared bridge debug logging. |
| [change-tracking.md](architecture/change-tracking.md) | Backend-owned file and LOC tracking: scopes and CountPolicyV1, provider evidence adapters, ledger and snapshot store, turn/thread boundaries, projections and `changes_*` commands, policies, restore, retention, operator runbook. |
| [storage.md](architecture/storage.md) | Backend SQLite database: the `StorageService` facade, its area fields (`storage.kanban`, …) and per-store repositories (agent mail split into store, directory, injects and budgets), stores and layouts, `updateStore`/leases/`atomically` and the writer guard, durability and deletion, migrations and the one-time JSON import. Size follow-up done in [0163-storage-facade-size.md](todo/backend-structure/0163-storage-facade-size.md). |
| [container-lifecycle.md](architecture/container-lifecycle.md) | Container authority: durable operations, ownership, writer lease, schema floor, recovery; images and readiness; persistent storage, preserving rebuilds, recovery copies and reviewed cleanup; staged inputs, networks, budgets and bounded logs. |
| [environment-deletion.md](architecture/environment-deletion.md) | What deleting an environment removes and in what order, the cleanup ledger and its retries, the branch rules, and the sweeps that remove leftovers. |
| [agent-accounts.md](architecture/agent-accounts.md) | Multiple Claude/Codex logins: account directories and shared links, global switching, backend-driven login and signing in again, plan usage, containers, coordinators, terminals, and Claude Keychain naming. |
| [github-cli.md](architecture/github-cli.md) | Which `gh` the backend runs (managed copy, then PATH), the status command, device-flow sign-in through the account login driver, the startup reminder and its opt-out, and the container GitHub credential source. |
| [github-pull-requests.md](architecture/github-pull-requests.md) | In-app pull request viewer backend: commands, REST vs GraphQL split, Settings credential, mapping rules, ETag conditional-request cache, PR monitor refresh after merges. |
| [scheduled-jobs.md](architecture/scheduled-jobs.md) | Backend-timed scheduled jobs: one-shot, cron and interval triggers with DST rules, missed-fire catch-up, exactly-once claims, owner authority (operator, MCP credential, agent, coordinator), surfaces and decisions. |
| [recurring-work.md](architecture/recurring-work.md) | Recurring background work: job catalogue and diagnostics, scheduler/admission/read-coordinator primitives, rollback switches, B/C/L inventory with current cadences, latency budgets. |
| [cursor-usage.md](architecture/cursor-usage.md) | Cursor usage mapping. |
| [cursor-diagnostics.md](architecture/cursor-diagnostics.md) | Historical: September 9 and 14 stall investigations. Current logging is in `bridge-diagnostics.md`. |
| [platform-inconsistencies.md](architecture/platform-inconsistencies.md) | Historical: 2026-08-16 inventory plus later current-state notes. Not a backlog. |

## Development

| Document | Notes |
| --- | --- |
| [command-nodes-handoff.md](development/command-nodes-handoff.md) | What was built for command nodes, where it lives, migration, deviations and what was not verified. |
| [command-nodes-plan.md](development/command-nodes-plan.md) | Build plan for command nodes: contracts, milestones, requirement matrix with evidence and status, and the final verification procedure. |
| [testing-guide.md](development/testing-guide.md) | How to choose and run tests. Commands live here. |
| [agent-testing.md](development/agent-testing.md) | Isolated profiles and real-stack QA. |
| [cli-testing.md](development/cli-testing.md) | Driving a `dev:test` profile with the `orkestrator` CLI: setup from a worktree, scripting output, recipes, UI rehydration checks. Contract stays in `public-cli.md`. |
| [upgrade-agents.md](development/upgrade-agents.md) | SDK/CLI bump runbook. Pins are test-enforced. "Other dependencies" covers non-agent packages, runtimes and image tools. |
| [credentials-and-models.md](development/credentials-and-models.md) | Credential and catalogue inventory. |
| [test-logs.md](development/test-logs.md) | Diagnostic-bounds rationale. Operator commands stay in `testing-guide.md`. |
| [disk-usage.md](development/disk-usage.md) | Where Orkestrator work leaves disk state, who prunes each location, `disk:report`, `dev:prune`, Docker build-cache limit. |
| [linting.md](development/linting.md) | `bun fmt`/oxlint/`bun check` configuration, exclusions, severity policy and disable-directive rules. |
| [releasing.md](development/releasing.md) | Cutting a desktop release, CI secrets, artifact names, how the in-app updater decides to run, Linux/Omarchy notes. |
| [container-qualification.md](development/container-qualification.md) | Real-Docker qualification: C01–C30 scenario matrix, live suites and how to run them, platform dimensions, benchmark harness and regression targets. |
| [preview-two-machine-runbook.md](development/preview-two-machine-runbook.md) | Two-machine tailnet run for service previews: `scripts/preview-latency-baseline.ts` (route baselines, client decoy, userspace throttle, diagnostics watch, slow reader), whole-link throttling, loss and reconnect, publication, cleanup, what to record. Thresholds are not set yet. Gate: [0042-service-preview-rollout.md](todo/previews-and-annotations/0042-service-preview-rollout.md). |
| [efficiency-harness.md](development/efficiency-harness.md) | Running `efficiency:baseline`: options, workloads a–j, counting method and limitations. |
| [ssh-routes.md](development/ssh-routes.md) | Managed SSH routes: `--loopback-client-port`, SSH alias rules, host-key trust and recovery, prompts and BatchMode, platform support, failure codes, real-sshd integration test. |
| [federation-migration.md](development/federation-migration.md) | Catalogue v1→v2 migration, what older clients see, storage-key migration, feature flags and rollback, client/backend compatibility table. |
| [federation-benchmarks.md](development/federation-benchmarks.md) | Synthetic 1/3/10/25-machine runtime benchmark results and what is not measured. |
| [federation-handoff.md](development/federation-handoff.md) | Federated client handoff: architecture summary, schema versions, validation evidence, deviations and untested cases. |
| [flaky-tests.md](development/flaky-tests.md) | Pointer to the flake registry in `tests/`. |

## Tests

| Document | Notes |
| --- | --- |
| [0000-index.md](tests/flaky-tests/0000-index.md) | The flake registry's top-level index. It lists the ten group folders and what each covers; each group's own `0000-index.md` table tracks its cases. Search the group indexes; open a case file only when the row matches. |

Steer probe scripts live in [`scripts/steer-probes/`](../scripts/steer-probes/), not under `docs/`.

## Todo

Each file covers one piece of work: its purpose, the current state with code
references, outstanding code and qualification work, constraints and
rationale, open questions, items that need verification, and the old docs it
replaced. The individual items live only in these files.

Files are grouped into ten folders by area. [`todo/0000-index.md`](todo/0000-index.md)
points to the folders, and each folder's `0000-index.md` lists its files in a
table ranked by criticality, most critical first, with a **Finished** column
that says whether every item in the file is done. Criticality rates a file as
a whole, never its individual items. Pick work from the top of a folder index.

Every file is named `NNNN-kebab-case-name.md`. The four-digit number is the
file's permanent ID, unique across all folders: it is an identifier, not a
rank, and the folder index carries the ranking. A new file takes the next
number after the highest one in use under `todo/`. Numbers are never reused,
and a file keeps its number if it moves to another folder.

### Rating a file

Rate the **impact of leaving the file's remaining work undone**, not the effort
to do it. Take the most serious open work in the file, walk down the
questions, and use the first rating that answers yes.

1. **Very high.** Could leaving it lose or corrupt user data, leak a
   credential or cross an isolation boundary, break shipped behaviour for most
   users or every run today, or let a broken release ship unguarded?
2. **High.** Does a user hit it in normal use (even with a workaround)? Does it
   waste significant time, compute or money on every run? Is it a feature that
   is on by default but has never been proved on the real stack, or a gate that
   must pass before a shipped capability can be enabled? Is it security
   hardening against a real, reachable exposure?
3. **Medium.** Is it a functional gap or a provider-parity difference, a
   qualification run for a secondary provider or platform, a refactor that
   removes a real risk, a compatibility path to retire, or a missing
   measurement?
4. **Low.** Everything else: optional or deferred features, extensions,
   optimisations that should wait for a measurement, cosmetic fixes, comment
   and doc hygiene, and work blocked upstream.

Rules of thumb:

- A file whose remaining work is all `blocked` or `deferred` usually rates
  low; re-rate it when it is unblocked or the stated measurement arrives.
- Qualifying something that is on by default rates higher than qualifying
  something behind a flag or off by default.
- A prerequisite keeps its own rating; say in the owning file what it
  unblocks rather than raising it.
- If torn between two ratings, pick the higher one when data, credentials or
  release safety are involved, otherwise the lower one.
- Within a rating, rank files by how many users or runs their remaining work
  reaches, then by how much of it there is.

### Maintaining the folders

- Once a file exists, never add new todos to it. New work always goes into a
  new numbered file, even when an existing file covers the same area; link
  the two from each other's related sections if that helps. Editing an
  existing item is still fine: tick or remove it, correct it, record evidence
  or a decision against it, or narrow it.
- Update or remove an item in its file in the same change that finishes it.
  If the file's most serious remaining work changed, re-rate it and move its
  row in the folder index.
- When the last item in a file is done, set its **Finished** column to Yes
  in the folder index in the same change. Then move any durable behaviour into
  `architecture/` or `development/`, delete the file and remove its row from
  the folder index. Its number is not reused.
- To add work, create a new file with the next number and the same headings
  in the folder that fits, and add a rated row (Finished: No) to that
  folder's index. A new
  folder also needs its own `0000-index.md` and a row in
  [`todo/0000-index.md`](todo/0000-index.md).
- Name only `mise` tasks that exist: `tests/unit/mise-tasks.test.ts` scans
  every Markdown file.

Live-provider and platform runs (macOS, Docker Desktop, Electron, Safari and
iOS, two machines) are the most common open gate. They are batched in
[0031-live-provider-and-platform-qualification.md](todo/cross-cutting/0031-live-provider-and-platform-qualification.md).
