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
| [`tests/`](#tests) | The flaky-test registry. |
| [`todo/`](#todo) | All outstanding work, one file per concept, with a scored checklist in [`todo/00-index.md`](todo/00-index.md). Pick work from here. |

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
| [coordinator.md](architecture/coordinator.md) | Current Coordinator: ownership, one main plus side agents, tiers, async delegation, MCP actions. Remaining work: [coordinator-read-only-adapters.md](todo/coordinator-read-only-adapters.md), [coordinator-live-conformance.md](todo/coordinator-live-conformance.md), [coordinator-consistency-gaps.md](todo/coordinator-consistency-gaps.md). |
| [rich-transcripts.md](architecture/rich-transcripts.md) | Rich transcript rendering: Markdown pipeline, code/diagram/table/callout/disclosure/media blocks, native charts, workflow snapshots, identities, bounded caches, find and copy, publication placement. |
| [transcript-artifacts-runtime.md](architecture/transcript-artifacts-runtime.md) | Transcript artifacts: ownership and grants, records and storage, receipts and publication, preview worker isolation, interactive preparation and CSP, content serving, desktop live host, configuration. |
| [transcript-artifacts-agent-guide.md](architecture/transcript-artifacts-agent-guide.md) | Agent-facing guide to the seven artifact tools, with chart and interactive examples. |
| [rich-transcripts-user-guide.md](architecture/rich-transcripts-user-guide.md) | User guide: supported content, controls, copy/export, interactive artifacts, snapshots versus live state, platform limits. |
| [design-canvas.md](architecture/design-canvas.md) | HTML/CSS canvas, recoverable operations, private records, history, sync, safe export, design MCP and .orkdes files. |
| [control-mcp.md](architecture/control-mcp.md) | Control MCP operator guide. |
| [mcp-management.md](architecture/mcp-management.md) | Per-provider MCP server management: sources, precedence, safe writes, secrets, apply states, evidence. |
| [remote-gateway.md](architecture/remote-gateway.md) | Standalone backend, Tailscale Serve, flags, troubleshooting. |
| [command-nodes.md](architecture/command-nodes.md) | **Target multi-machine architecture:** command nodes (registry, portal, cross-node coordinators, mail, files) and leaf nodes; control plane via the command node, agent chat, terminals and previews direct from client to leaf where reachable. |
| [federation.md](architecture/federation.md) | Transitional client-side multi-machine federation on this branch, being reworked into command nodes: identities, hello handshake, machine profile and colours, routes/fallback, realm-based panels, known limitations, acceptance-ID map. |
| [host-updates.md](architecture/host-updates.md) | Maintaining the backend's computer from any client: Orkestrator updates (desktop app or standalone service; now or when idle; cancel; 60 s countdown; restart reconciliation; rollback), toolchain repair, gh channel, container image, UI and CLI. Remaining work: [remote-host-upgrades.md](todo/remote-host-upgrades.md). |
| [public-cli.md](architecture/public-cli.md) | `orkestrator` client commands: backend selection, JSON/exit contract, request keys and retention, lifecycle waits, settings, sessions, request-specific completion, exec, scenarios. |
| [event-snapshot-recovery.md](architecture/event-snapshot-recovery.md) | Which sequence each consumer may compare, revisioned view snapshots/outcomes, bounded client hydration, best-effort PR notifications, terminal input recovery. |
| [web-page-annotations.md](architecture/web-page-annotations.md) | Preview notes, capture spool, backend threads, native dispatch, review, migration. Real-stack gates: [web-annotation-qualification.md](todo/web-annotation-qualification.md). |
| [browser-previews.md](architecture/browser-previews.md) | Service previews: registry, desktop tunnel, private HTTPS origins, relay, kill switch, rollback. Rollout: [service-preview-rollout.md](todo/service-preview-rollout.md). |
| [review-preparation.md](architecture/review-preparation.md) | Multi-review pipeline; queue wait is 30 minutes. Auto-fix and auto-PR ordering and recovery. Fan-out budgets and the efficiency benchmark. |
| [native-agent-commands.md](architecture/native-agent-commands.md) | Slash-command descriptors, bridge wire contract, intent resolution, collisions, catalogue lifecycle, per-provider support tables. |
| [bridge-diagnostics.md](architecture/bridge-diagnostics.md) | Shared bridge debug logging. |
| [change-tracking.md](architecture/change-tracking.md) | Backend-owned file and LOC tracking: scopes and CountPolicyV1, provider evidence adapters, ledger and snapshot store, turn/thread boundaries, projections and `changes_*` commands, policies, restore, retention, operator runbook. |
| [storage.md](architecture/storage.md) | Backend SQLite database: stores and layouts, `updateStore`/leases/`atomically`, durability and deletion, migrations and the one-time JSON import. |
| [container-lifecycle.md](architecture/container-lifecycle.md) | Container authority: durable operations, ownership, writer lease, schema floor, recovery; images and readiness; persistent storage, preserving rebuilds, recovery copies and reviewed cleanup; staged inputs, networks, budgets and bounded logs. |
| [environment-deletion.md](architecture/environment-deletion.md) | What deleting an environment removes and in what order, the cleanup ledger and its retries, the branch rules, and the sweeps that remove leftovers. |
| [agent-accounts.md](architecture/agent-accounts.md) | Multiple Claude/Codex logins: account directories and shared links, global switching, backend-driven login and signing in again, plan usage, containers, coordinators, terminals, and Claude Keychain naming. |
| [github-cli.md](architecture/github-cli.md) | Which `gh` the backend runs (managed copy, then PATH), the status command, device-flow sign-in through the account login driver, the startup reminder and its opt-out, and the container GitHub credential source. |
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
| [linting.md](development/linting.md) | oxfmt/oxlint configuration, exclusions, severity policy and disable-directive rules. |
| [releasing.md](development/releasing.md) | Cutting a desktop release, CI secrets, artifact names, how the in-app updater decides to run, Linux/Omarchy notes. |
| [container-qualification.md](development/container-qualification.md) | Real-Docker qualification: C01–C30 scenario matrix, live suites and how to run them, platform dimensions, benchmark harness and regression targets. |
| [efficiency-harness.md](development/efficiency-harness.md) | Running `efficiency:baseline`: options, workloads a–j, counting method and limitations. |
| [ssh-routes.md](development/ssh-routes.md) | Managed SSH routes: `--loopback-client-port`, SSH alias rules, host-key trust and recovery, prompts and BatchMode, platform support, failure codes, real-sshd integration test. |
| [federation-migration.md](development/federation-migration.md) | Catalogue v1→v2 migration, what older clients see, storage-key migration, feature flags and rollback, client/backend compatibility table. |
| [federation-benchmarks.md](development/federation-benchmarks.md) | Synthetic 1/3/10/25-machine runtime benchmark results and what is not measured. |
| [federation-handoff.md](development/federation-handoff.md) | Federated client handoff: architecture summary, schema versions, validation evidence, deviations and untested cases. |
| [flaky-tests.md](development/flaky-tests.md) | Pointer to the flake registry in `tests/`. |

## Tests

| Document | Notes |
| --- | --- |
| [0000-index.md](tests/flaky-tests/0000-index.md) | The only flake registry index. Search it; open a case file only when the row matches. |

Steer probe scripts live in [`scripts/steer-probes/`](../scripts/steer-probes/), not under `docs/`.

## Todo

Each file covers one concept: its purpose, the current state with code
references, outstanding code and qualification work, constraints and
rationale, open questions, items that need verification, and the old docs it
replaced. Every file was checked against `main` at `2459b05c` on 2026-10-15.

[`todo/00-index.md`](todo/00-index.md) lists every outstanding item across
these files as a checklist, scored very high, high, medium or low and ordered
most important first. Tick items there as they are done.

To add work, extend the file that owns the concept, or create a new
kebab-case file with the same headings, then add a scored line to the index.
When a file's work is done, move any durable behaviour into `architecture/` or
`development/`, delete the file and remove its lines from the index.
Name only `mise` tasks that exist: `tests/unit/mise-tasks.test.ts` scans every
Markdown file.

Live-provider and platform runs (macOS, Docker Desktop, Electron, Safari and
iOS, two machines) are the most common open gate. They are batched in
[live-provider-and-platform-qualification.md](todo/live-provider-and-platform-qualification.md).

### Service previews and web annotations

| File | Summary |
| --- | --- |
| [service-preview-rollout.md](todo/service-preview-rollout.md) | Qualify the shipped preview transports (desktop tunnel, private origins, relay) on real platforms, set thresholds, flip defaults, then retire the legacy loopback route and stale partitions. Holds the preview evidence log. |
| [embedded-service-previews.md](todo/embedded-service-previews.md) | Embedded previews in the web client (iframe) and iOS (dedicated `WKWebView`). Not started; top-level handoff is the only path today. |
| [preview-service-discovery.md](todo/preview-service-discovery.md) | Local-worktree service seeding, managed-process ownership, agent links to preview tabs, framework setup hints. |
| [web-annotation-qualification.md](todo/web-annotation-qualification.md) | Real-stack evidence for web-page annotations: native window, live providers, Docker and remote workspaces, web/iOS review, baselines and sign-off. |
| [web-annotation-known-limitations.md](todo/web-annotation-known-limitations.md) | Code gaps in shipped annotations: region crop provenance, pin generation checks, container file checks, producer attestation, Discuss enforcement, missing metrics. |
| [web-annotation-extensions.md](todo/web-annotation-extensions.md) | Deferred annotation capabilities: pixel diffs, automatic after-capture, source hints, shadow/iframe targets, non-desktop capture. |

### CLI and slash commands

| File | Summary |
| --- | --- |
| [cli-command-surface.md](todo/cli-command-surface.md) | CLI features left out of the first release: selected slash commands, enqueue, attachments, cascade remove, local init, event following, worker credentials. |
| [cli-qualification.md](todo/cli-qualification.md) | Make Pi, Cursor and Grok qualifiable for request-specific completion; missing live, macOS and Docker Desktop CLI evidence. Holds the CLI evidence log. |
| [slash-command-catalogue.md](todo/slash-command-catalogue.md) | Retire the legacy command-catalogue routes; decide the deliberately unavailable command classes (Claude session-changing commands, Codex inline-shell templates, Pi UI extensions). |
| [slash-command-qualification.md](todo/slash-command-qualification.md) | Live provider probes at current pins, the inactive-environment browser scenario, container paths, mixed versions and performance. |

### Containers and environments

| File | Summary |
| --- | --- |
| [container-platform-qualification.md](todo/container-platform-qualification.md) | Re-run the live container suites on current `main`; qualify Docker Desktop, rootless, arm64, registry pulls and per-provider session resume. |
| [container-rebuild-state-preservation.md](todo/container-rebuild-state-preservation.md) | Remaining provider-state preservation gaps across rebuilds; retire the legacy writable-layer, host-mount and policy-1 paths. |
| [container-network-and-credential-isolation.md](todo/container-network-and-credential-isolation.md) | Port/protocol-scoped egress, one canonical default allowlist, and external egress that removes the workload's `NET_ADMIN`. |
| [container-resource-budgets-and-performance.md](todo/container-resource-budgets-and-performance.md) | Default per-environment resource budget from measured workloads; deferred container performance options and their evidence bar. |
| [container-state-observation.md](todo/container-state-observation.md) | Replace fixed-interval `docker exec` polling (Claude state, Files panel, tree walks) with container-side change signals. |
| [environment-and-disk-cleanup.md](todo/environment-and-disk-cleanup.md) | Recorded real-stack pass of environment deletion and pre-ledger sweeps, remaining test temp-dir leaks, surfacing permanently failing cleanup. |

### Design canvas

| File | Summary |
| --- | --- |
| [design-canvas-qualification.md](todo/design-canvas-qualification.md) | Live-agent, container export, Electron, accessibility and performance evidence; optimisations deferred until those numbers exist. |
| [design-operation-recovery-edges.md](todo/design-operation-recovery-edges.md) | Operation-receipt and restart-recovery gaps in the design tools and renderer. |
| [design-agent-conversation-links.md](todo/design-agent-conversation-links.md) | Design-to-agent handoff links that survive tab closure, and design context sent as structured input. |

### MCP

| File | Summary |
| --- | --- |
| [mcp-management.md](todo/mcp-management.md) | Keep the per-provider MCP editor faithful to current pins (Claude retained runtime), close apply paths that stop at pending or restart, collect live evidence. |
| [mcp-environment-delivery.md](todo/mcp-environment-delivery.md) | Durable container-private MCP overlay, Cursor delivery, and truthful scope, network and auth behaviour outside the backend host. |
| [control-mcp-voice-surface.md](todo/control-mcp-voice-surface.md) | Control MCP voice profile: small core tools, gateway meta-tools over the public actions, scoped operator credentials, and parity with the CLI. |

### Agent engines and provider SDKs

| File | Summary |
| --- | --- |
| [agent-interactions-and-permissions.md](todo/agent-interactions-and-permissions.md) | Interaction-contract gaps: saved rules, Claude elicitation parking, Grok approval kinds, deprecated execution-policy env overrides. |
| [mid-turn-steer-and-interrupt.md](todo/mid-turn-steer-and-interrupt.md) | Keep the Claude CLI warm across idle turns, retire per-turn task machinery, live model catalogue; OpenCode and Grok steer are blocked upstream. |
| [session-titles-and-history.md](todo/session-titles-and-history.md) | Backend-owned title generation and the remaining fork, rewind and archive semantics per provider. |
| [agent-accounts-and-sign-in.md](todo/agent-accounts-and-sign-in.md) | Auth notices and needs-auth readiness, in-app sign-in where vendors allow it, and the known multi-account switching gaps. |
| [composer-model-parameters.md](todo/composer-model-parameters.md) | Finish moving model axes onto parameter descriptors; resolve forwarded-but-unsourced values (Codex summary/personality, `acceptEdits`, `maxBudgetUsd`). |
| [opencode-v2.md](todo/opencode-v2.md) | Deferred checkpoint for moving from the OpenCode 1.x line to OpenCode 2.x: readiness gate, API mapping, recheck procedure. Not the `/v2/client` import path. |
| [provider-sdk-adoption-backlog.md](todo/provider-sdk-adoption-backlog.md) | Vendor SDK surfaces not adopted yet, the reason for each, and the decisions that keep some out. |
| [session-lifecycle-consistency.md](todo/session-lifecycle-consistency.md) | Live and browser qualification of close, cancel, retention, drafts and steer history across providers; the idle cancel/abort alignment decision. |

### Transcripts, observation and bandwidth

| File | Summary |
| --- | --- |
| [transcript-history-efficiency.md](todo/transcript-history-efficiency.md) | Remaining whole-transcript reads (build-stage supervision, Claude cold hydration), frontend history structure, measurement gaps, live qualification. |
| [remote-client-bandwidth.md](todo/remote-client-bandwidth.md) | Measure remote traffic through the supported proxy before changing compression or terminal transport defaults; decide the client-local data-saving mode. |
| [native-agent-idle-observation.md](todo/native-agent-idle-observation.md) | Event coverage that lets idle Claude, Codex and HTTP-bridge sessions back off, and shared reads across views. |
| [client-reconnect-and-freshness.md](todo/client-reconnect-and-freshness.md) | Jittered reconnect for the remaining transports; visible stale, degraded and disconnected state in event-led views. |
| [recurring-work-qualification.md](todo/recurring-work-qualification.md) | Fix recurring-work instrumentation, collect live freshness and cost evidence against the latency budgets, decide measured candidates, then remove the rollback drivers. |

### Multi Review

| File | Summary |
| --- | --- |
| [multi-review-scale-and-cost.md](todo/multi-review-scale-and-cost.md) | Fix the post-SQLite fence-check regression, retire rollback gates and fallbacks, make the benchmark deterministic, collect scale evidence. |
| [multi-review-panel-value.md](todo/multi-review-panel-value.md) | Prove compact consolidation and prompt-prefix savings, add an overlap metric, then decide presets, lenses and adaptive stopping. |
| [multi-review-flow-graph.md](todo/multi-review-flow-graph.md) | Flow graph follow-ups: live qualification of provisional findings, and gaps found building them. |

### Coordinator and agent mail

| File | Summary |
| --- | --- |
| [coordinator-read-only-adapters.md](todo/coordinator-read-only-adapters.md) | Per-platform decisions and adapter work so the coordinator read-only policy gives the same outcome everywhere. |
| [coordinator-live-conformance.md](todo/coordinator-live-conformance.md) | Opt-in live suite proving read-only enforcement, async delegation and mail wake-ups on every qualified platform. |
| [coordinator-consistency-gaps.md](todo/coordinator-consistency-gaps.md) | Smaller coordinator parity gaps (OpenCode/Grok steer, poll guards, conversation limits) and deliberately deferred product surfaces. |

### Backend structure

| File | Summary |
| --- | --- |
| [storage-service-repositories.md](todo/storage-service-repositories.md) | Replace the `StorageService` inheritance chain with per-store repositories over a shared `StorageContext`, keeping the store writer guard (`storage-writer-guards.test.ts`) passing. Pinned by `tests/unit/inheritance-chains.test.ts`. |
| [native-agent-service-collaborators.md](todo/native-agent-service-collaborators.md) | Turn the six-layer `NativeAgentService` chain into a class composed of collaborators. Pinned by `tests/unit/inheritance-chains.test.ts`. |
| [claude-bridge-prompt-stream-state.md](todo/claude-bridge-prompt-stream-state.md) | Direct tests for `createPromptStreamState`, then split its delta handler and move the plan-mode flags to `TurnState`. |
| [backend-core-domain-folders.md](todo/backend-core-domain-folders.md) | Move `apps/backend/src/core/` prefix groups into lint-enforced domain folders, one domain per PR. |
| [backend-runtime-state-ownership.md](todo/backend-runtime-state-ownership.md) | Move the remaining module-level bindings in `commands-runtime-state.ts` into `BackendRuntime` clusters and delete the test setter seams. |

### Cross-cutting

| File | Summary |
| --- | --- |
| [live-provider-and-platform-qualification.md](todo/live-provider-and-platform-qualification.md) | Shared prerequisites and a batching index for live-provider and platform runs, agent-test profile isolation, and checks with no other home. |
| [mixed-version-compatibility.md](todo/mixed-version-compatibility.md) | Support-window policy for old clients, bridges and backends; renderer–backend skew; dead prompt-queue claim commands; index of compatibility paths awaiting retirement. |
| [test-suite-and-ci-health.md](todo/test-suite-and-ci-health.md) | Slow test owners, a skipped settings test, red CI on `main` and missing branch protection, deferred test-structure candidates. |
| [mobile-layout-gaps.md](todo/mobile-layout-gaps.md) | Narrow-viewport follow-ups: one host for environment settings, focus return from settings, real-phone qualification. |
| [dependency-upgrades.md](todo/dependency-upgrades.md) | Non-agent dependency upgrades still pending: Electron 46, React Compiler lint warnings, update-signing decision, and upgrades blocked upstream or deferred. |
| [remote-host-upgrades.md](todo/remote-host-upgrades.md) | Real-release qualification of remote host maintenance (desktop update between signed releases, the standalone launchd/systemd service with rollback, image and gh updates) and two known limitations. |
