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
| [`debugging/`](#debugging) | Runbooks for diagnosing failures on a running install: crashes, killed processes, blank windows. |
| [`tests/`](#tests) | The flaky-test registry, grouped into folders by area. [`tests/flaky-tests/0000-index.md`](tests/flaky-tests/0000-index.md) points to each folder's index, which tracks its cases. |
| [`number-claims/`](number-claims/README.md) | One file per to-do or flake number, so two branches that take the same number conflict in Git. |
| [`todo/`](#todo) | All outstanding work in numbered files, grouped into folders by area. [`todo/0000-index.md`](todo/0000-index.md) points to each folder's index, which ranks its files by criticality. Pick work from here. |
| `reports/` | [unified-federation.md](reports/unified-federation.md), the design report behind `plans/unified/`, and its [measurements](reports/unified-federation-measurements.md). A completed plan: what it built is described in the living docs (node scopes in [federation.md](architecture/federation.md#node-scopes-one-scope-per-node-in-the-windows-tree)). It stays only while open plan items still use it as their reference (7013, retiring the version-0 adapters, waits for its date), and is deleted by the rule below when they close. |

`number-claims/` holds no prose; it backs the numbering of `todo/` and
`tests/flaky-tests/`.

There are no other plan, review or dated-note folders (`reports/` is the one
temporary exception above), and nothing else belongs at the top of `docs/`. Durable content goes into `architecture/`,
`development/` or `debugging/`; anything still to do goes into `todo/`. Completed plans are
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
| [backend-runtime.md](architecture/backend-runtime.md) | Per-backend process state in `BackendRuntime`: terminal, local-server, environment-operation, tmux and account clusters and the smaller owners, the rules for reaching them, test construction options, shutdown order, and the state that is process-wide on purpose. |
| [coordinator.md](architecture/coordinator.md) | Current Coordinator: ownership, one main plus side agents, tiers, async delegation, MCP actions. Remaining work: [0026-coordinator-read-only-adapters.md](todo/coordinator-and-multi-review/0026-coordinator-read-only-adapters.md), [0024-coordinator-live-conformance.md](todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md), [0142-coordinator-product-surfaces.md](todo/coordinator-and-multi-review/0142-coordinator-product-surfaces.md), [0395-coordinator-worker-surfaces-follow-ups.md](todo/coordinator-and-multi-review/0395-coordinator-worker-surfaces-follow-ups.md). |
| [native-transcripts.md](architecture/native-transcripts.md) | Native transcript pipeline: v1/v2 bridge reads and capability discovery, summaries and detail locators, history pages and the two cursor namespaces, revised rows, row boundaries, deltas and patches, display-tail checkpoints, progress probes, pipeline transcript store, ceilings, retained fallbacks. |
| [transcript-scroll.md](architecture/transcript-scroll.md) | Transcript scrolling: one controller per viewport, follow intent, cancellation at every layer (Virtuoso patch), measured convergence, semantic anchors and history paging, activation policy, bounded tool-group viewports, streaming Markdown prefix reuse, diagnostics, limitations. |
| [rich-transcripts.md](architecture/rich-transcripts.md) | Rich transcript rendering: Markdown pipeline, code/diagram/table/callout/disclosure/media blocks, native charts, workflow snapshots, identities, bounded caches, find and copy, publication placement. |
| [transcript-artifacts-runtime.md](architecture/transcript-artifacts-runtime.md) | Transcript artifacts: ownership and grants, records and storage, receipts and publication, preview worker isolation, interactive preparation and CSP, content serving, desktop live host, configuration. |
| [transcript-artifacts-agent-guide.md](architecture/transcript-artifacts-agent-guide.md) | Agent-facing guide to choosing a visual and to the seven artifact tools, with chart, static report and interactive examples. |
| [rich-transcripts-user-guide.md](architecture/rich-transcripts-user-guide.md) | User guide: supported content, controls, copy/export, static reports, interactive artifacts, snapshots versus live state, platform limits. |
| [design-canvas.md](architecture/design-canvas.md) | HTML/CSS canvas, recoverable operations, private records, history, sync, safe export, design MCP and .orkdes files. |
| [control-mcp.md](architecture/control-mcp.md) | Control MCP operator guide: credentials and profiles, tool tiers, confirmation, authority. |
| [control-mcp-voice.md](architecture/control-mcp-voice.md) | Control MCP for voice clients: the voice profile's tools, agent voice chat (short two-way talk that can interrupt the coordinator), spoken confirmation, the attention relay, the local relay for hosted platforms, qualification (scripted harness, approval run, recording relay and scoring). |
| [mcp-management.md](architecture/mcp-management.md) | Per-provider MCP server management: sources, precedence, safe writes, secrets, apply states, evidence. |
| [version-compatibility.md](architecture/version-compatibility.md) | Mixed-version support window (published releases from the floor: the newest Stable at least 60 days old, v2.21.0 today), supported pairings, data upgrade and downgrade rules, compatibility-path usage counters, the register of paths with owners and removal conditions, and [domain contracts](architecture/version-compatibility.md#domain-contracts) for backend commands (`defineCommand`, the invoke envelope, typed errors, adapters, the manifest and the untyped-command ratchet). |
| [remote-gateway.md](architecture/remote-gateway.md) | Standalone backend, Tailscale Serve, flags, troubleshooting. |
| [renderer-security.md](architecture/renderer-security.md) | The renderer's Content Security Policy and where it is delivered, the design frame document, CommonJS preloads under `sandbox: true`, default-deny permissions, and why Trusted Types and an invoke allowlist were not adopted. |
| [command-nodes.md](architecture/command-nodes.md) | **Multi-machine architecture:** command nodes (registry, portal, cross-node coordinators, mail, files) and leaf nodes; control plane via the command node, agent chat, terminals and previews direct from client to leaf where reachable; another node's workspace on its node scope in the window. |
| [federation.md](architecture/federation.md) | The multi-machine client: identities, hello handshake, machine profile and colours, routes/fallback, summaries and relayed events, node scopes (one per node in the window's tree: opening, tiers, byte and memory budgets, snapshots, the summary floor), the retired workspace realms, sidebar and search, storage namespacing, known limitations, acceptance-ID map. |
| [host-updates.md](architecture/host-updates.md) | Maintaining the backend's computer from any client: Orkestrator updates (desktop app or standalone service; now or when idle; cancel; 60 s countdown; restart reconciliation; rollback), toolchain repair, gh channel, container image, UI and CLI. Remaining work: [0033-remote-host-upgrades.md](todo/cross-cutting/0033-remote-host-upgrades.md). |
| [public-cli.md](architecture/public-cli.md) | `orkestrator` client commands: backend selection, JSON/exit contract, request keys and retention, lifecycle waits, settings, sessions, request-specific completion, exec, scenarios. |
| [event-snapshot-recovery.md](architecture/event-snapshot-recovery.md) | Which sequence each consumer may compare, revisioned view snapshots/outcomes, bounded client hydration, best-effort PR notifications, terminal input recovery. |
| [web-page-annotations.md](architecture/web-page-annotations.md) | Preview notes, capture spool, backend threads and their copy-on-write commits, native dispatch, review, migration. Real-stack gates: [0044-web-annotation-qualification.md](todo/previews-and-annotations/0044-web-annotation-qualification.md). |
| [tab-launches.md](architecture/tab-launches.md) | When a tab takes focus: a user's launch at once with shimmer outlines, nothing else, and the setup terminal's handoff to the job tab. |
| [keyboard-shortcuts.md](architecture/keyboard-shortcuts.md) | App-level shortcuts (⌘K search, ⌘⇧/ / Ctrl+Shift+/ dialog, ⌘, settings, ⌘T new agent tab, ⌘⇧D sidebar group-by rotation) that work wherever focus is: the one routing path (renderer key router, workspace-owned shortcuts for the shown node, design frames, Electron main), what terminals and text fields keep, decisions, the View › Keyboard Shortcuts… and Settings… items and their IPC, the Windows/Linux menu layout and key caps, browser-client limits. |
| [narrow-layout.md](architecture/narrow-layout.md) | The phone layout below 768 px: stable hosts moved with `moveBefore` (and the `appendChild` fallback) across the breakpoint, panes the switcher hides kept laid out, settings from the projects drawer through `AppDialogHost` and the focus trap, the title tooltip's touch dismissal, and the tests. |
| [browser-previews.md](architecture/browser-previews.md) | Service previews: registry, local-environment discovery and listener ownership, desktop tunnel, private HTTPS origins, relay, kill switch, rollback. Rollout: [0042-service-preview-rollout.md](todo/previews-and-annotations/0042-service-preview-rollout.md). |
| [build-pipeline-view.md](architecture/build-pipeline-view.md) | The terms build pipeline, pipeline environment and prompt environment; the build pipeline tab's flow graph and inspector, and the flow-graph components it shares with Multi Review: the projection of the record (passes unrolled to the right, faded definite steps, the reviewer fan-out, Ticket and PR nodes), node actions including retrying one reviewer, restarts that rewind to a step's round with the superseded run kept as a previous attempt (Address rerunning on its round's kept report, a package-only restart), the confirmed "Rewind code to here" reset, the header toolbar and key information panel with its agent tools, and the read and view-state constraints. |
| [goals.md](architecture/goals.md) | The `/goal` loop as built: statuses, delivery, limits, `report_goal`, attention, and how to write a goal. |
| [graphs.md](architecture/graphs.md) | Composable graphs as built (Phases 0–2, Phase 4 items 401–405): the template model, types and schema subset, predicates, prompt templates and the locked system contract, capability profiles and enforcement tiers, the compiler and plan digest, storage, trust and sharing, the runtime (supervisor, scheduling, executors, result slots, human and system nodes, guards, isolated worktrees, restart and rewind, mock runs), launch surfaces, the designer and the run view, a table of every bound, the invariants and known gaps. Plan and work items: retired on 2026-11-07 (`git show 2b876486b:plans/composable-graphs.md`, `git show 2b876486b:plans/graphs/000-index.md`). |
| [graphs-user-guide.md](architecture/graphs-user-guide.md) | User guide to Graphs: designing in the library and canvas (duplicating a built-in, prompts, types, capabilities, sub-graphs), testing with mock runs and pins, launching (dialog, Kanban, CLI, coordinator, schedules), watching runs and answering human nodes, restarting and rewinding, sharing and trusting project templates. |
| [tickets.md](architecture/tickets.md) | Kanban tickets: kinds (feature ticket, work brief), typed optional sections stored as JSON, the markdown form and its round-trip rules, criteria ids and Verify results, text mirrors and on-read migration, the tool inputs, the Verify contract, how a merged pull request moves its ticket to done, and the tiled views. |
| [review-preparation.md](architecture/review-preparation.md) | Multi-review pipeline; queue wait is 30 minutes. Auto-fix and auto-PR ordering and recovery. Fan-out budgets and the efficiency benchmark. |
| [user-commands.md](architecture/user-commands.md) | Composer `!` commands run as the user (worktree, container, coordinator checkout) with live output, input and cancel, given to the agent on its next turn; detection of shell prompts that need the user (sign-in links, device codes, ENTER, passwords, host keys) and where they surface, including the coordinator. |
| [suborks.md](architecture/suborks.md) | `/subork` and `ask_agents`: asking other agents from a native tab, the results delivery choice, read-only tiers, limits and lifecycle. |
| [native-agent-commands.md](architecture/native-agent-commands.md) | Slash-command descriptors, bridge wire contract, intent resolution, collisions, catalogue lifecycle, per-provider support tables. |
| [bridge-diagnostics.md](architecture/bridge-diagnostics.md) | Shared bridge debug logging. |
| [logging.md](architecture/logging.md) | The shared application logger: areas, events, restricted fields, error formatting, output formats, the Electron relay and the raw `console` lint rule. |
| [change-tracking.md](architecture/change-tracking.md) | Backend-owned file and LOC tracking: scopes and CountPolicyV1, provider evidence adapters, ledger and snapshot store, turn/thread boundaries, projections and `changes_*` commands, policies, restore, retention, operator runbook. |
| [storage.md](architecture/storage.md) | Backend SQLite database: the `StorageService` facade, its area fields (`storage.kanban`, …) and per-store repositories (agent mail split into store, directory, injects and budgets), stores and layouts, `updateStore`/leases/`atomically` and the writer guard, durability and deletion, migrations and the one-time JSON import. |
| [container-lifecycle.md](architecture/container-lifecycle.md) | Container authority: durable operations, ownership, writer lease, schema floor, recovery; images and readiness; persistent storage, preserving rebuilds, recovery copies and reviewed cleanup; staged inputs, networks, budgets and bounded logs. |
| [environment-deletion.md](architecture/environment-deletion.md) | What deleting an environment removes and in what order, the cleanup ledger and its retries, the branch rules, and the sweeps that remove leftovers. |
| [local-start-git-remote-failures.md](architecture/local-start-git-remote-failures.md) | Why a local environment's start could not reach the git remote, as the user sees it: the SSH connect, SSH authentication and timeout messages, and the checked "Use HTTPS for this project" remedy (`lifecycleRemedy`, `use_https_git_remote`). |
| [git-scan-caches.md](architecture/git-scan-caches.md) | Git scan caches for environment worktrees: the untracked cache, what one diff scan costs (one combined diff, per-worktree untracked line counts), why fsmonitor is off (latency, hangs, leaked daemons), removing the legacy setting, stopping daemons before removal, and timed-out reads retried without the daemon. The Windows checks still open are in the [manual-test checklist](todo/manual-test/7568-manual-test-checklist.md) (0735 tasks 4 and 6). |
| [agent-accounts.md](architecture/agent-accounts.md) | Multiple Claude/Codex logins: account directories and shared links, global switching, backend-driven login and signing in again, plan usage, containers, coordinators, terminals, and Claude Keychain naming. |
| [bug-report.md](architecture/bug-report.md) | The sidebar Bug button's Report a bug sheet: the `bug-report:<id>` synthetic runtime, its sandboxed ask-first policy, the shared `--fix` instructions, draft and filing (gh, else prefilled URL), machine routing through node scopes, and the context it collects. |
| [github-cli.md](architecture/github-cli.md) | Which `gh` the backend runs (managed copy, then PATH), the status command, device-flow sign-in through the account login driver, the startup reminder and its opt-out, and the container GitHub credential source. |
| [github-pull-requests.md](architecture/github-pull-requests.md) | In-app pull request viewer backend: commands, REST vs GraphQL split, Settings credential, mapping rules, ETag conditional-request cache, PR monitor refresh after merges. |
| [setup-approval.md](architecture/setup-approval.md) | The trust gate for a local environment's `setupLocal` commands: default-branch and approved-hash trust, the held state, the approval panel, approving on every machine, who can approve. |
| [agent-approvals.md](architecture/agent-approvals.md) | What an `ask` approval promises and where: the backend's signature on every bridge request that changes an agent's authority, the root-owned bridge launcher (`bridge-launch=1`) and OpenCode’s start through it (`opencode-launch=1`, and for 2.x, the package caches and filtered project configuration `opencode2-launch=1`), approvals on an unsandboxed host as a prompt rather than a boundary, provider rule files the agent's uid can write, the listener check that refuses a bridge the agent started in place of the backend's, and what the shared uid still allows. |
| [permission-rules.md](architecture/permission-rules.md) | Orkestrator-owned "always allow" rules: model and canonical patterns, the fail-closed matcher, where the backend applies them (activity sweep, projection reads) and when it never does, bridge eligibility, creation from the card only, Settings, transcript note, CLI. Remaining work: [0723-orkestrator-permission-rules.md](todo/agent-engines/0723-orkestrator-permission-rules.md). |
| [self-improvement.md](architecture/self-improvement.md) | Experimental, off by default (Settings → Experimental). Settings → Self-improvement: the backend ranks this machine's diagnostics and, optionally, has Claude Code (Sonnet 5.5 notes, Opus 5.5 themes, on the active account) review Claude Code and Codex conversations; it files `[improvement]` and `[insight]` tickets with matching labels, follows them on the board, and confirms each fix or reopens its ticket from the app versions that carry it. What is sent, cost, signals, verdicts, commands and public actions, state, rules and limits. |
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
| [worktree-watcher-validation.md](development/worktree-watcher-validation.md) | Watcher review snapshot attribution, complete available failure inventory, isolated owner results and the canonical qualification receipt. |
| [agent-testing.md](development/agent-testing.md) | Isolated profiles and real-stack QA. |
| [source-hint-emitter.md](development/source-hint-emitter.md) | The Babel plugin a project copies to emit web annotation source hints in development builds, and how to add it to Vite. The plugin text is run by a test. |
| [cli-testing.md](development/cli-testing.md) | Driving a `dev:test` profile with the `orkestrator` CLI: setup from a worktree, scripting output, recipes, UI rehydration checks. Contract stays in `public-cli.md`. |
| [effect-usage.md](development/effect-usage.md) | Where Effect (`effect` 4.1.2) is used, where it is deliberately not, and why. |
| [upgrade-agents.md](development/upgrade-agents.md) | SDK/CLI bump runbook. Pins are test-enforced. "Other dependencies" covers non-agent packages, runtimes and image tools. |
| [credentials-and-models.md](development/credentials-and-models.md) | Credential and catalogue inventory. |
| [test-logs.md](development/test-logs.md) | Diagnostic-bounds rationale. Operator commands stay in `testing-guide.md`. |
| [disk-usage.md](development/disk-usage.md) | Where Orkestrator work leaves disk state, who prunes each location, `disk:report`, `dev:prune`, Docker build-cache limit. |
| [node-scopes.md](development/node-scopes.md) | Per-node stores, services and workspaces: `defineScopedStore` and the strict `scopedStoreHook` (no statics, no provider-less fallback), imperative sites, scoped services and change handlers, a node's workspace in the window's tree, tests with `renderInNodeScope` and `renderInAppCommandScope`, the window-store registry and the guards (`lib-backend-command-default`, `workspace-command-bound-call`). |
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

## Debugging

| Document | Notes |
| --- | --- |
| [process-crashes-and-kills.md](debugging/process-crashes-and-kills.md) | Why part of the desktop app stopped (Linux): reading the app log, core dumps and journal; correlating agent activity; catching the sender of a SIGKILL/SIGTERM with an audit trail; AppImage mount failures; the 2026-10-26 incidents and their fixes. |

## Tests

| Document | Notes |
| --- | --- |
| [0000-index.md](tests/flaky-tests/0000-index.md) | The flake registry's top-level index. It lists the ten group folders and what each covers; each group's own `0000-index.md` table tracks its cases. Search the group indexes; open a case file only when the row matches. |

## Todo

Each file covers one piece of work: its purpose, the current state with code
references, outstanding code and qualification work, constraints and
rationale, open questions, items that need verification, and the old docs it
replaced. The individual items live only in these files.

Files are grouped into area folders, plus one `manual-test/` folder.
[`todo/0000-index.md`](todo/0000-index.md) points to the folders and counts
each folder's files by status, and each folder's `0000-index.md` lists its
files in a table ranked by criticality, most critical first. Its columns are
**Rank**, **File**, **Criticality**, **Status**, **Needs you**, **Covers** and
**Why this rating**. Criticality rates a file as a whole, never its individual
items; Status says who can act on it (see
[Choosing a status](#choosing-a-status)). An area to-do holds only work an
agent can build, or work that is blocked: an agent picks work from the top of
a folder index among the `backlog` rows, and `blocked` rows wait on another
to-do, a release, a CI run or a recurrence.

Everything that needs the user lives in one place instead: the
[manual-test checklist](todo/manual-test/7568-manual-test-checklist.md). Each
of its `- [ ]` items says what to do and what result to record, and names its
source to-do and task; manual tests and live checks come first, decisions,
approvals and outward actions last (see
[Human-only work](#human-only-work)).

Every file is named `NNNN-kebab-case-name.md`. The four-digit number is the
file's permanent ID, unique across all folders: it is an identifier, not a
rank, and the folder index carries the ranking. A new file takes the next
number after the highest one in use under `todo/` or
[`number-claims/todo/`](number-claims/README.md), and adds its claim there.
Numbers are never reused, and a file keeps its number if it moves to another
folder.

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

### Human-only work

A task, or part of a task, is human-only when an agent cannot start and finish
it on its own in an isolated worktree on a headless Linux node (rootless
Docker available) or a macOS node, with loopback fake models, throwaway
profiles, the iOS simulator or two dev profiles on one host. Typical reasons:

- manual testing or checking by the user (a person looking, speaking or
  judging);
- a real or billed provider login, or paid model turns;
- the user's real install, data directory, store or logs;
- hardware or accounts the fleet lacks (a physical iOS device, a signed build,
  Windows, arm64, a rootful Docker node, real DNS or certificates), two real
  machines or a tailnet;
- a decision the file reserves to the user or maintainer ("user's decision",
  "product call", "scope call", "needs approval", "maintainer action");
- an outward action (GitHub settings or rulesets, publishing, deploying the
  site or cutting a release, filing an upstream report, firewall or network
  changes or destructive cleanup on nodes).

A task whose own text says it needs one of these (for example "needs a
Windows host", "needs a host where the user may use the rootful daemon",
"needs the deploy and the next Stable release") is human-only, whatever its
status line says. A task that only waits for a release or a CI run to happen,
with agent work to do afterwards, is `blocked`.

Human-only work never goes into an area to-do. It is a `- [ ]` item in the
[manual-test checklist](todo/manual-test/7568-manual-test-checklist.md),
under its area, in the "Manual tests and live checks" section or, for
decisions, approvals and outward actions, the last section. Each item starts
with its source in bold (`**[NNNN](../<area>/NNNN-name.md) task N: ...**`, or
`**NNNN (retired) task N: ...**` once the source is gone), says exactly what
to do, and ends with `Record:` and the result to write down. A mixed task is
split: the agent part stays in its to-do, the user part becomes a checklist
item, and the to-do's **Related** section points to the checklist.

When the user records a result, the agent that picks it up acts on it in the
source to-do (unblocking its waiting task, or recording the evidence or
decision) and removes the item from the checklist in the same change. Agent
work that cannot start until an item is done is `blocked` with
`Waits on: 7568 (<source> task N)`.

### Choosing a status

An area to-do's **Status** is `backlog` or `blocked`, judged on the file's
still-open tasks (finished tasks do not count):

1. **`backlog`**: at least one open task an agent can start and complete on
   its own now (see [Human-only work](#human-only-work) for what that rules
   out). A task whose decision has a (recommended) option counts, because the
   recommendation exists so that a later worker can act without asking,
   unless the file reserves that decision to the user; a reserved decision is
   a checklist item.
2. **`blocked`**: no open task can start now, and each waits on another to-do
   (name its number; a checklist item is `7568`), an upstream release, a
   release or CI run, a flake or failure recurring, or a time window. Once
   that clears, an agent could do it.

The manual-test checklist's own row is the only one rated
**`requires user input`**. There is no `done` row: a file whose last task is
finished, or whose remaining tasks all moved to the checklist, is retired in
the same change (see [Maintaining the folders](#maintaining-the-folders)).
The top-level index keeps a `requires user input` and a `done` column so the
counts stay comparable; `done` is always 0.

**Needs you** is one short line:

- for a `blocked` row, `Waits on: <to-do number, release, CI run, recurrence
  or date>`;
- for a `backlog` row, `—`;
- for the checklist's row, what the user must work through.

Update a file's Status and Needs you in the same change that alters its tasks
(finishes, adds, narrows or unblocks one, or records evidence that changes who
can act), just as its rating is, and keep the counts in
[`todo/0000-index.md`](todo/0000-index.md) matching.

### Maintaining the folders

- Once a file exists, never add new todos to it. New work always goes into a
  new numbered file, even when an existing file covers the same area; link
  the two from each other's related sections if that helps. Editing an
  existing item is still fine: tick or remove it, correct it, record evidence
  or a decision against it, or narrow it. The one exception is the
  manual-test checklist: every new human-only item is added there, never to
  an area to-do or a new file.
- Update or remove an item in its file in the same change that finishes it.
  If the file's most serious remaining work changed, re-rate it and move its
  row in the folder index.
- Keep the row's **Status** and **Needs you** current in every change that
  alters the file's tasks ([choosing a status](#choosing-a-status)), and keep
  the counts in [`todo/0000-index.md`](todo/0000-index.md) matching the folder
  indexes.
- When the last open task in a file is done, or every remaining one moved to
  the manual-test checklist, retire the file in the same change: move any
  durable behaviour into `architecture/` or `development/`, delete the file,
  remove its row from the folder index, point links and paths that named it
  at the durable doc in every file, `AGENTS.md` included (the root
  `AGENTS.md`, "Keep references current": a ticket that bars edits to a file
  never covers this), renumber the remaining ranks to `1..n` in row order and update
  the counts. Checklist items whose source is retired cite it as
  `NNNN (retired)`. Its todo number is not reused.
- To add work, create a new file with the next number and the same headings
  in the folder that fits, and add a rated row with its Status and Needs you to
  that folder's index, then update the counts. A new folder also needs its own
  `0000-index.md` and a row in [`todo/0000-index.md`](todo/0000-index.md).
  The layout example the repository instructions name is a live one-task
  to-do in that format:
  [`7500-agent-tools-port-auto-choice.md`](todo/containers-and-environments/7500-agent-tools-port-auto-choice.md).
  The example they named before it, to-do 0241, was retired on 2026-11-10
  (read it with
  `git show 53340356c:docs/todo/containers-and-environments/0241-leaked-reach-probe-networks.md`).
- After any row removal, insertion, or move, renumber that folder's ranks to
  `1..n` in row order. Ranks express priority; todo numbers remain permanent IDs.
- Name only `mise` tasks that exist: `tests/unit/mise-tasks.test.ts` scans
  every Markdown file.
- `tests/unit/todo-index.test.ts` fails when two files share a number or a
  folder index is missing a rated row for a file, has a Criticality value
  outside the allowed set, a Status other than `backlog` or `blocked` in an
  area folder (or other than `requires user input` in `manual-test/`), an
  empty Needs you cell, a `backlog` row whose Needs you is not `—`, a
  `requires user input` row whose Needs you is `—`, a `blocked` row whose
  Needs you does not start with `Waits on:`, a `Waits on:` note on a row that
  is not `blocked`, or ranks other than `1..n` in row order. It requires
  `manual-test/` to hold exactly one checklist, every checkbox in it to open
  with a closed bold label naming its source to-do, the task (or named check)
  and a title (`**[NNNN](...) task N: title.**`, or `**NNNN (retired) task N:
  title.**`) followed by what to do, and every relative link in it to
  resolve: the
  file must exist, and an `#anchor` must name a heading in it whose text the
  file does not repeat (a repeated heading's bare anchor lands on the first
  one). It also requires every folder to be linked from the top-level index,
  with status counts that match the folder index and a total row that matches
  their sum. Two numbers were already shared when it was added and stay
  allowlisted: 0054 (two files; the third was retired on 2026-11-10) and 0723
  (two). Neither may gain another file.
- Two open pull requests can each pick the same next number and each pass CI.
  The claim file each adds under `number-claims/todo/` then conflicts, so the
  second cannot merge until it renumbers (`tests/unit/number-claims.test.ts`
  requires a claim for every number from 7500). If a clash still reaches
  `main`, fix forward: the file that merged first keeps the number, the newer
  one moves to the next free number with its claim, every link to it is
  updated, and its "Replaces" section records the old number.

Live-provider and platform runs that need a login, real hardware or two
machines are the most common open gate. They are batched, with every other
human-only item, in the
[manual-test checklist](todo/manual-test/7568-manual-test-checklist.md).
