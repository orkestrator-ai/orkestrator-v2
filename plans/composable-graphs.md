# Composable agent graphs plan

Status: proposed 2026-10-29; all decisions confirmed with the maintainer on
2026-10-29. Nothing is built yet.

Work items and their status: [`plans/graphs/000-index.md`](graphs/000-index.md).
Each Pn.m section below is one numbered file there (P1.7 is `107`).

Source: [`docs/reports/2026-10-28-composable-graphs.md`](../docs/reports/2026-10-28-composable-graphs.md)
(the report). The report explains why each decision below was taken; section
references (§) point to it.

## Objective

Let users design their own agent graphs, save them as templates and run them.
A graph is made of agent steps and backend steps, joined by typed handoffs, with
fan-out, consolidation, conditions and bounded loops. Each node states what it
may do and how strongly that is enforced on the chosen provider.

Multi Review and the Build Pipeline stay on their own engines. They are first
*described* as templates, so users can duplicate and customise them. Multi
Review moves onto the graph runtime only once the runtime matches its
robustness. The Build Pipeline may never move.

## Decisions

All decisions below were confirmed with the maintainer on 2026-10-29. They
cover the report's open questions (§11), the plan's own open questions and the
core design choices. The last column records what was considered and turned
down, so a later change of mind starts from the same options. Changing a
decision means editing its row and saying why.

| # | Question | Decision | Rejected alternatives |
| --- | --- | --- | --- |
| D1 | How is the designer built? | A real canvas designer, built in two steps. Phase 1 ships a read-only canvas, JSON import and export, and the compile panel. Phase 2 adds drag-and-drop editing and the "describe a graph" agent. | Full editor in Phase 1 (built while the model is still settling); forms and JSON only, with a display-only canvas; AI-first authoring as the main path. |
| D2 | Where do templates live? | Three scopes. *Built-in* templates ship in code, are read-only and can be duplicated. *User* templates live in app data, and new templates go there by default. *Project* templates in `.orkestrator/graphs/*.graph.json` are read too, but stay untrusted until the user approves their digest (§6.9). | Repository first (new templates saved into the repo); app only, with no repository templates. |
| D3 | Parallel writers? | Not in version 1. At most one writing activation per workspace, and replicated nodes must be read-only or have no workspace access. Isolated per-branch worktrees, with select or merge, come in Phase 4. | Plan for them in version 1 (adds worktree lifecycle, disk and container work to the first release). |
| D4 | Enforcement floor | A node whose profile denies writes defaults to `minEnforcement: "provider-configured"`, so model pickers hide advisory providers (Grok today). The user can lower the floor per node, with an explicit acknowledgement. This mirrors the coordinator safety setting. | Require `enforced` (rules out OpenCode, Cursor, and Claude without its sandbox); warn only, offering every provider. |
| D5 | Built-in flows | They stay on their engines and are described as read-only templates. "Duplicate to customise" produces a user template that runs on the graph runtime. Multi Review is ported in Phase 3 behind a flag once the parity tests pass. Porting the Build Pipeline is optional (Phase 5). | One engine for everything (commit to porting both); never port (two engines for good). |
| D6 | Coordinator | It can list, launch, read and cancel saved templates over Control MCP. It gets a status wake when a run ends or waits for a person. It cannot create or edit templates. | Launch and author (drafts the user approves); no coordinator access. |
| D7 | Scope of a run | One environment per run, either newly created or existing. Work across several environments or machines stays with the coordinator, which can launch several runs. | Runs that span environments (handoffs between worktrees, cross-environment rewinds, container networking). |
| D8 | Edges | Every edge is typed and carries an immutable, content-addressed artifact. There are no untyped edges. "Run B after A" is a `workspace@1` edge carrying the git commit A left (§4.3, §5). | Plain "then" edges for simple cases (the engine could not tell which commit a node saw or what a restart must invalidate). |
| D9 | Fan-out and fan-in | Fan-out is a `replicate` setting on a node: over a panel, lenses, samples, and later list items. It draws as a stacked card with "×N", and its outputs become lists. Fan-in is a `collect` policy on the receiving `list<T>` input port (§4.2, §4.4). | Explicit Split and Join nodes around the repeated node (three nodes for every panel). |
| D10 | Control flow | Agents produce data only. Gates, loops and per-item fan-out (bounded by `maxBranches`) turn that data into control flow, using JSON predicates. Agents never add nodes or branches at run time (§4.4). | A bounded `spawn_branch` tool (cost and the run view would only be known as the run goes). |
| D11 | Default fan-in merge | A newly drawn fan-in defaults to a deterministic `dedupe` merge, which costs nothing and keeps every source ID. An agent consolidator, which must cite its sources (`cite` or `accountForAll`), is added when model judgement is wanted (§5.9). Other merges: `concat`, `vote`, `best`, `collect`. | Always an agent consolidator (a session every time); pass the list through unmerged. |
| D12 | Side effects | Side effects are backend **system nodes**, run idempotently: push, open or update a PR, wait for checks, move tickets. An agent writes the PR description. In version 1 **agent nodes never hold `git.push` or `github.write`**, so there is no `shipper` profile. Conflict resolution is an agent node with the `builder` profile: it commits locally, and a system node pushes. | Agent nodes with push and GitHub permission, like today's Ship; both, at the user's choice. |
| D13 | Prompts | A locked system contract, then a user template. The template is logic-less (variables and list sections only). Inputs render in one of five modes: `json-frame`, `markdown`, `summary`, `file`, `on-demand` (§5.6). | A sandboxed expression language (CEL, JSONata); user JavaScript. |
| D14 | Transforms and conditions | Edge transforms come from a fixed, declarative set (`pick`, `filter`, `limit`, `flatten`, built-in adapters), and conditions are JSON predicates. No user code runs in the backend; anything more complex is a node (§5.7). | As for D13. |
| D15 | Human input | Agents run unattended by default. People take part through `human` nodes (approve, edit, choose). A node may opt into an `ask_human` tool that pauses the run until the user answers (§6.5, §6.8). | Human nodes only, with no questions mid-turn; interactive by default (runs could stall silently). |
| D16 | Canvas library | A time-boxed spike in Phase 1 compares React Flow (`@xyflow/react`) with extending the in-house renderer, and the choice is recorded. Either way, the run view stays on the existing `flow-graph/` renderer (§7.8). | Adopt React Flow without a spike; extend the in-house renderer without a spike. |
| D17 | Name in the UI | **Graphs**: "Graphs" in menus and tabs, "Run graph…" in action menus, `orkestrator graph …` in the CLI. | Flows; Workflows (clashes with Multi Review's `workflowId` in the CLI); Pipelines (clashes with the Build Pipeline). |
| D18 | Default per-project capability ceiling | All agent capabilities: file writes, shell, network and web search, up to the environment's own policy. The user can tighten it per project. Push and GitHub writes are outside the ceiling altogether, because only system nodes do them (D12). | No network by default; a stricter ceiling for repository templates only. |
| D19 | Reviewer lens presets (P0.5) | Editable in Settings. Five presets ship (Security, Performance, Tests and coverage, API and compatibility, Maintainability), and the user can edit, delete and add to them. Free text is always available at launch. | Fixed presets plus free text; free text only. |
| D20 | Waiting for CI | In version 1. A `wait-for-checks` system node ships in Phase 2. It reads the PR monitor's check status, waits within a bound, and emits a typed result, so graphs can do "open PR → wait for CI → fix if red". | Defer to Phase 4. |
| D21 | Clean panel review (P0.3) | When a reviewer panel's consolidated report has no issues and no coverage gaps, the Build Pipeline skips Address and goes to Verify, as the single-reviewer path already does. | Always run Address on both paths. |

## Non-goals

- Agents changing the graph at run time.
- User-supplied JavaScript or expression code running in the backend.
- Graphs that span environments or machines.
- Porting the Build Pipeline before Multi Review has been ported and measured.
- Agent nodes that can push or write to GitHub (D12).
- Coordinator-authored templates (D6).
- Per-node user MCP servers before Phase 4. They need bridge work on every
  provider.

## Invariants

These come on top of every invariant in `AGENTS.md`.

1. **The run record and its artifacts are the authority.** The designer, the run
   view and the CLI rehydrate from revisioned snapshots. Unmounting a view never
   cancels a run.
2. **A compiled plan is frozen into the run at launch.** Editing or deleting a
   template, or one of its custom types, never changes a run in progress or
   makes an old run unreadable.
3. **Artifacts are immutable.** A retry or rewind adds artifacts and supersedes
   old ones. Nothing is overwritten or deleted while its run exists.
4. **Results are validated when submitted.** A downstream node never receives
   an artifact that failed its type's validation.
5. **Upstream content is untrusted.** It reaches prompts only inside evidence
   frames.
6. **Everything is bounded.** Bounds apply to artifact bytes, string and item
   counts, branches per node, activations per run, rendered prompt size, run
   history and designer undo history.
7. **Capabilities only narrow.** A profile, a project template or a node
   override can never widen a session beyond the environment's own policy, or
   beyond the user's per-project ceiling.
8. **Guards fail closed.** A read-only node whose git guard cannot establish a
   baseline fails before dispatch. A violation fails the activation and keeps
   the evidence.
9. **Logs and metrics never carry payloads.** They hold counts, bytes, states
   and IDs only, never prompts, artifact payloads, file contents or template
   prompt text.

## Module map

New code follows the existing layout: shared contracts in `packages/protocol`,
backend logic in `apps/backend/src/core`, and UI in `apps/web/src`.

| Area | New files (proposed names) |
| --- | --- |
| Protocol | `packages/protocol/src/graphs/` with `template.ts` (schema and guards), `types.ts` (type library and custom types), `schema-subset.ts`, `predicates.ts`, `prompt-template.ts`, `capability-profiles.ts`, `compile.ts`, `lint.ts`, `cost.ts`, `run.ts` (run, activation and artifact types), `builtins/multi-review.ts`, `builtins/build-pipeline.ts`, `builtins/looped-review.ts` |
| Result kinds | `apps/backend/src/core/workflow-result-registry.ts`, which replaces the `switch` statements in `workflow-result-contracts.ts` |
| Templates | `graph-template-service.ts`, `storage-graph-templates.ts`, `graph-project-templates.ts` (reads `.orkestrator/graphs/` and records trust) |
| Runtime | `graph-run-service.ts`, `graph-run-supervisor.ts`, `graph-run-scheduling.ts` (ready set and workspace locks), `graph-node-agent.ts`, `graph-node-system.ts`, `graph-node-human.ts`, `graph-artifacts.ts`, `graph-run-rewind.ts`, `graph-guards.ts`, `graph-mock-provider.ts`, `storage-graph-runs.ts` |
| Shared executor | `agent-branch-runner.ts`, the generic part extracted from `review-fanout.ts` |
| Commands and MCP | `commands-registry-graphs.ts`, plus graph tools in the Control MCP coordinator tool set |
| CLI | `packages/cli/src/client/commands/graphs.ts` |
| Web | `apps/web/src/components/graph-designer/`, `apps/web/src/components/graph-run/`, `apps/web/src/stores/graphDesignerStore.ts`, and the tab types `graph-designer` and `graph-run` in `contexts/TerminalContext.tsx` |
| Docs | `docs/architecture/graphs.md` (living), and the user guide `docs/architecture/graphs-user-guide.md` |

Storage adds three record stores to `STORE_LAYOUTS` in `storage-stores.ts`:
`graph-templates`, `graph-runs` and `graph-artifacts`. Reference artifacts live
on disk under `.orkestrator/graph-artifacts/<run-id>/` in the environment,
hash-verified like review packages.

---

## Phase 0: parameterise today's flows and fix the findings

This phase is small and low-risk, and it needs nothing from later phases. It
fixes the four findings in §2.7 and tests whether users want custom prompts and
lenses before the larger build starts.

### P0.1 Pipeline reviewers run read-only, with a generic git guard

- When a review package exists, the Build Pipeline fan-out host sets
  `reviewerMode: "plan"`, as Multi Review does (`build-pipeline-review-fanout.ts`;
  the host field is `review-fanout.ts:534`). The single-review session is
  created and prompted with `readOnly: true` (`build-pipeline-service-supervisor.ts`,
  `startStage` for `review`).
- Turn the worktree baseline in `build-pipeline-validation-worktree.ts` into a
  general **read-only guard**:
  - capture HEAD and the git-visible paths before dispatch;
  - check them at submit time and again when the result is consumed;
  - apply this to pipeline review, consolidation and Verify.
- `WorkflowResultService.setAcceptanceCheck` keeps one check per kind. Change it
  to a list of checks per kind, so a pipeline review check and a future graph
  check do not replace each other. Each check skips attempts it does not own.
- Correct the launcher note in `BuildLaunchDialog.tsx:571-574` so it describes
  what is actually enforced.

Tests: pipeline review and fan-out tests assert that `readOnly` and `mode` are
passed through. A guard test commits during review and expects the result to be
refused, then repaired within the turn.

### P0.2 Align the iteration limit

`control-mcp-coordinator-tools.ts:300` uses `MAX_BUILD_PIPELINE_ITERATIONS`
instead of a literal `20`. A test pins the tool schema maximum to the protocol
constant.

### P0.3 Same routing after single and panel review

Decided in D21. When the fan-out path's consolidated report has no issues and
no coverage gaps, it goes to Verify, as the single-review path already does
(`advanceReviewFanout` against `finishReview`). The pipeline flow projection's
placeholders stay as they are, because Address is never drawn ahead. Update
`docs/architecture/build-pipeline-view.md` if it describes the old behaviour.

### P0.4 A typed Address report

- Address submits a `fix-result`. The schema already exists: `complete`,
  `summary`, `filesChanged`, `commandsRun`, `notes`, `limitations`.
- `verificationPrompt` renders it as an evidence frame.
- `latestAddressReport` stays as the fallback for Address turns started before
  the upgrade, and for any provider without a tool or structured result
  transport.
- The missing-result reminder and stage failure apply to Address as they do to
  the other stages.

### P0.5 Reviewer lenses

- Add `lens?: { label: string; instruction: string }` to `ReviewerModelSelection`
  (`packages/protocol/src/review-fanout.ts`). Bounds: a label of at most 64
  characters and an instruction of at most 4 KiB.
- The lens goes into the trailing panel section, after `reviewerPanelSection`,
  so the shared prompt prefix stays byte-identical across the panel.
- Consolidation evidence carries each reviewer's lens label, so the consolidator
  knows why coverage differs. Overlap metrics are unchanged.
- **UI.** Both launch dialogs (`MultiReviewLaunchDialog.tsx` and the
  `BuildLaunchDialog.tsx` reviewer rows) get an optional "Focus" field per
  reviewer. It offers the saved lens presets and a free-text option.
- **Presets** (D19). An app-level setting `reviewLensPresets` holds a list of
  `{ id, label, instruction }`, with at most 20 presets and the same bounds as a
  lens. It ships with five presets: Security, Performance, Tests and coverage,
  API and compatibility, Maintainability.
  - A Settings editor beside the Multi Review defaults lets the user edit,
    delete, reorder and add presets, and restore the shipped five.
  - A launch copies the chosen preset's text into the reviewer's `lens`, so a
    later edit or deletion never changes a running or recorded review.
- **Defaults and callers.** Saved Multi Review defaults (`MultiReviewAgentSettings`)
  keep lenses per position. Coordinator launch tools and the CLI accept `lens`.
- **Compatibility.** Records without lenses read as before. An older backend
  ignores the field.

### P0.6 Per-stage instructions in the Build Pipeline

- Add `instructions?: string` to `BuildStepConfig` (at most 16 KiB).
- It is rendered as a framed "Additional instructions from the user" section
  after each stage's system contract. Fix inherits Build's instructions, as it
  inherits Build's model.
- The instructions are stored on the pipeline record, so restarts and rewinds
  reuse them.
- The UI is a collapsible text field on each step card in `BuildLaunchDialog.tsx`.
- The CLI round trip (a Phase 0 exit criterion) is delivered by work item
  [007](graphs/007-cli-build-pipeline-launch.md): no public action launched a
  Build Pipeline, so it adds `build.*` actions and `orkestrator build` commands.

### Phase 0 exit criteria

Ticked only in [`graphs/000-index.md`](graphs/000-index.md); this list is the
definition.

- The pipeline review is read-only on every provider that supports it. The
  guard refuses a review that commits.
- The coordinator cannot request more iterations than the protocol accepts.
- Clean reports skip Address on both review paths.
- Verify reads a typed Address report for new runs, and still reads old
  runs.
- Lenses and per-stage instructions round-trip through launch, record,
  restart, the coordinator tools and the CLI. Lens presets can be edited in
  Settings, and editing one leaves recorded reviews unchanged.
- `build-pipeline-view.md`, `review-preparation.md` and `coordinator.md`
  match the new behaviour.

---

## Phase 1: model, compiler and read-only designer

This phase delivers pure code with heavy unit tests, plus one read-only UI. It
does not change how anything runs.

### P1.1 Template schema

`GraphTemplateV1` and its parts, as sketched in the report (§4.5): parameters,
roles, types, inputs, workspace, nodes (`agent`, `system`, `gate`, `merge`,
`human`, `subgraph`), edges, loops, limits and layout. It comes with
hand-written guards in the protocol's existing style, and an ID and label
grammar.

Two notes:

- `subgraph` is in the schema from the start, but the compiler rejects it until
  Phase 4.
- A role's `defaultsFrom` names `ActionDefaultKey` values (`review`, `review2`,
  `reviewPreparation`, `fixReviewIssues`, `verify`, `pr`, `resolve`). Panel
  positions beyond the second come from `MultiReviewAgentSettings.additionalReviewers`.

### P1.2 Type library and custom types

- **Built-in types**, mapped to existing schemas and domain validators (§5.3):
  `text`, `markdown`, `ticket`, `workspace`, `validation-plan`,
  `review-package`, `review-report`, `finding`, `verification-verdict`,
  `fix-result`, `pr-result`, `pr-description`, `check-summary` (D20), `decision`
  and `file-list`, plus `error` for routed failures.
- **Custom types**: `ArtifactTypeDef` with a schema, a storage class (value or
  reference), budgets, an `items` declaration for provenance, `sharedFields`,
  markdown and summary renderers, and an `example`.
- **`schema-subset.ts`** accepts only the keywords
  `validateWorkflowJsonSchema` supports. It also enforces the cross-provider
  structured-output rules: every property is listed in `required`, optional
  values are expressed as nullable, and there is no `pattern`, `$ref` or
  `oneOf`. Unknown keywords are errors.
- **"Schema from example"** builds a first draft schema from a sample JSON
  value.

### P1.3 Result-kind registry

- Replace the `switch` statements in `workflowResultJsonSchema` and
  `validateWorkflowResult` with a registry. Each kind maps to
  `{schema, validator?, contextValidator?, toolName, acceptanceChecks[]}`, and
  the existing kinds register themselves without changing behaviour.
- Add a `graph-output` kind. Its schema and tool name come from the slot
  (`WorkflowResultSlotInput.schema`, plus a new `toolName`), so each port gets
  its own `submit_<port>` and `validate_<port>` tools.
- Generalise the consolidation context validator into a provenance validator
  driven by the plan (`cite`, `accountForAll`).

Tests: `workflow-result-conformance.test.ts` and `workflow-result-tools.test.ts`
stay green without modification. New tests cover `graph-output` slots, per-port
tool names, and provenance validation on a non-review type.

### P1.4 Predicates

A JSON predicate language with the operators `eq`, `neq`, `lt`, `lte`, `gt`,
`gte`, `in`, `exists`, `empty`, `nonEmpty`, `count`, `all`, `any` and `not`. Its
paths reach into input artifacts, `params.*` and `run.iteration`. There is a
type checker that runs against the producer schemas, and a total evaluator: it
never throws, and an unknown or missing value is false. Evaluation is bounded
in depth and node count.

### P1.5 Prompt templates

- A logic-less template language: variables, list sections, partials for
  inputs, and nothing executable.
- The renderer handles the five render modes. Evidence frames reuse
  `review-evidence-frames.ts`.
- There is a size estimator based on type budgets.
- Lints:
  - a variable that is not bound;
  - a per-branch variable placed before large shared inputs, which breaks
    prompt caching;
  - prose output requested when the node has output ports;
  - an instruction that contradicts the node's profile (advisory).
- The locked system contract is assembled from the existing pieces: the
  unattended policy (`withUnattendedPolicy`), the result instruction
  (`workflowResultInstruction`) and a generated capability statement.

### P1.6 Capability profiles and enforcement tiers

- **Profiles.** `observer`, `reviewer`, `verifier`, `researcher`, `builder`
  and `custom`. Each compiles to a `NativeAgentExecutionPolicy` layered over the
  environment's policy, and can only narrow it. Each also declares a set of
  granted actions. There is no `shipper` profile (D12). Conflict resolution
  uses `builder`.
- **New capabilities.** Add `git.commit`, `git.push`, `github.write`,
  `subagents`, `mcp:<server>` (deny only until Phase 4) and the
  `orkestrator:<group>` family.
- **No push or GitHub writes for agents** (D12). Every agent profile, `custom`
  included, denies `git.push` and `github.write`. The compiler rejects a node
  that asks for them, and the remote-ref guard (P2.9) applies to every agent
  node. The session environment also withholds the GitHub credential where the
  provider allows it, so `gh` cannot write even if a shell command slips
  through.
- **Older bridges.** A bridge that does not know a new capability gets the
  nearest enforceable stand-in:
  - `git.push` and `git.commit` become a `shell.mutate` denial when the profile
    allows no other mutation;
  - otherwise they rely on the post-hoc guard.
- **Tiers.** An enforcement matrix gives `enforced`, `provider-configured` or
  `advisory` per profile, provider and platform, generalised from
  `coordinator-providers.ts`. The coordinator qualification keeps calling the
  same function, so the two cannot drift apart.

### P1.7 Compiler

- **Output.** `compile(template, {types, providers}) → {plan, diagnostics,
  cost}`. The plan is normalised and carries a digest. Diagnostics carry a node
  or edge ID, a code and a severity.
- **Checks.** Every rule in §7.4: cycles outside loops, loops without a bound,
  type and cardinality, required inputs, producers on mutually exclusive gate
  branches, condition paths, workspace concurrency (D3), replicated writers,
  taint reaching side effects, unmet `minEnforcement`, prompt size, and limits.
- **Cost.** Best-case and worst-case agent sessions, and peak parallelism.
- **Shortcut.** "First iteration from A, later from B" is supported as a port
  option (`firstIterationFrom`) so loops like the pipeline's do not need a
  hand-built gate (§9.2).

### P1.8 Built-in templates

- Describe Multi Review, the Build Pipeline and Looped Review in
  `graphs/builtins/`. Each carries `engine: "multi-review" | "build-pipeline" |
  "looped-review"`, meaning it is described but runs on its own engine.
- They must compile with no errors.
- Tests pin each built-in template to its engine's behaviour: node set, routing
  conditions, iteration bounds, profiles and result kinds. A change to one side
  then fails until the other matches.

### P1.9 Template storage and trust

- **Storage.** The `graph-templates` store holds user templates, versioned by
  revision. Built-ins are loaded from code. Project templates are read from the
  project's checkout and re-read when files change.
- **Trust.** Trust records are kept per project as `{path, digest, approvedAt}`.
  A project template whose digest changed is untrusted again.
- **Ceiling** (D18). A per-project capability ceiling caps what any template
  may grant there, user and project templates alike.
  - The default allows every agent capability (file writes, shell, network, web
    search) up to the environment's own policy.
  - The user can tighten it per project, for example to no network.
  - `git.push` and `github.write` are outside the ceiling altogether, because
    no agent node can hold them (D12).
- **Commands.** Register in `commands-registry-graphs.ts`: `graph_templates_list`,
  `graph_template_get`, `graph_template_save` (compare-and-swap on revision),
  `graph_template_delete`, `graph_template_duplicate`, `graph_template_compile`,
  `graph_template_import`, `graph_template_export` and
  `graph_template_trust`.

### P1.10 Canvas spike and read-only designer

- **Spike** (time-boxed, written up in `docs/architecture/graphs.md`). Compare
  React Flow (`@xyflow/react`) with extending the in-house renderer. Criteria:
  - keyboard and screen-reader support, against the existing flow-graph
    keyboard navigation;
  - theming with Tailwind v4 and shadcn;
  - grouping for loop regions;
  - performance at 100 nodes;
  - bundle size and licence.
- **Read-only designer.** A `graph-designer` tab with:
  - a library list (built-in, user, project, with trust state);
  - a canvas with typed ports coloured by type family;
  - a read-only inspector;
  - a compile panel and a cost estimate;
  - JSON import and export;
  - "Duplicate", which creates a user template the user can then edit as JSON.
- Agent-testing coverage follows `docs/development/agent-testing.md`.

### Phase 1 exit criteria

Ticked only in [`graphs/000-index.md`](graphs/000-index.md); this list is the
definition.

- All three built-in templates compile cleanly. The pinning tests fail when
  either the engine or the template changes alone.
- The result-kind registry change is behaviour-neutral, as shown by the
  unchanged conformance suites.
- Compiler, predicate, prompt and schema-subset modules have unit tests for
  every diagnostic code.
- The designer shows the built-in templates and imported user templates,
  with diagnostics pinned to nodes and edges.
- The canvas library is chosen and the decision is recorded.

---

## Phase 2: graph runtime and editable designer

This phase is the feature. Its rule is to reuse the primitives of the existing
engines rather than copy them.

### P2.1 Run record and storage

`GraphRun` and `NodeActivation` as sketched in the report (§8.1):
- the run is saved with revision compare-and-swap;
- activation history is bounded;
- there are at most 50 rewinds;
- each activation records the policy and enforcement tier it actually got.

Artifacts:
- `graph-artifacts` holds value artifacts by digest, with lineage;
- reference artifacts live on disk and are hash-verified before each consumer,
  inside containers too (reuse the review package's in-container `sha256sum`
  path);
- per-run budgets: 32 MiB inline, 256 MiB on disk.

### P2.2 Supervisor domain

- Add `graph-run` to `KEYED_SCHEDULING_DOMAINS` (`workflow-supervisor.ts`). It
  is covered by the existing rollback variable `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK`.
- A run is one key.
- Wake reasons are the existing set. `result-accepted` wakes only the owning
  run.

### P2.3 Scheduling

- Each pass, under the run lock, computes the ready set: activations whose
  required inputs are live and whose `when` holds. Workspace locks are applied
  next (D3), then admission through the existing work-admission pool and the
  per-provider caps (4/8/4/16).
- The `limits.maxConcurrentAgents` and `limits.maxAgentSessions` limits are
  enforced at admission.
- Running activations are observed every 3 s plus jitter, as reviewers are.

### P2.4 Agent node executor and the shared branch runner

- Extract `AgentBranchRunner` from `review-fanout.ts`. It covers:
  - admission;
  - session creation with an explicit policy;
  - the dispatch journal (`prepared → dispatching → sent`) and proof-based
    recovery;
  - observation;
  - result reading, repair, the reminder and continuation;
  - token metering;
  - transcript capture.
- Review-specific parsing and provenance stay behind `ReviewFanoutHost`. Multi
  Review and the pipeline fan-out keep their behaviour.
  `review-fanout-interleaving.test.ts`, the efficiency benchmark and the
  dispatch tests must pass unchanged.
- **Per-activation MCP credential.** It is minted the way
  `workflowResultConnection` is today, and exposes:
  - `submit_<port>` and `validate_<port>` for each output, plus the status tool;
  - `report_progress` when an output type has `items`;
  - `read_artifact` when any input renders `on-demand`;
  - the opt-in actions from the profile: tickets, mail and artifacts;
  - `ask_human` only on nodes that opt in (D15). A call pauses the activation
    and the run shows "waiting for you". The answer goes back as the tool
    result. Nodes that do not opt in keep the unattended policy.
- A node completes when every required output port has an accepted artifact.
  Providers on structured output receive one combined schema, which the runtime
  splits by port.
- **Sessions.** `session: "fresh"` is the default. `session: "continue"` is
  allowed only under the compile-time constraints in §5.2 (same agent and model,
  a direct predecessor, no replication).

### P2.5 Replication and collection

- `replicate` over `panel`, `lenses` and `samples`, plus their combinations,
  with at most 32 branches per node.
- Branch keys are stable across retries and appear in activation keys, artifacts
  and item IDs.
- Collect policies: `all-settled`, `quorum` and `first` (which cancels the
  rest), with `minSuccessful` and `includeFailures`.
- Zip edges join two replicated nodes over the same branch keys.

### P2.6 Gate, merge, loop and failure handling

- **Gates** evaluate predicates. Branches that are not taken mark their subtree
  `skipped`.
- **Merges**: `concat`, `dedupe` (by key path, keeping every source ID), `vote`
  (with a tie policy), `best` and `collect`.
- **Loops**: an `until` condition, `maxIterations`, carried ports and
  `firstIterationFrom`. The iteration index is part of the activation key.
- **Failure**: `retry` (attempts, and which failures count), then `onFailure`.
  The options are `fail-run` (the default for writers), `skip`, or `route`,
  which emits `error@1` on an `error` port.

### P2.7 System nodes, version 1

| Action | Reuses | Notes |
| --- | --- | --- |
| `prepare-environment` | Build Pipeline provisioning (create, start, setup) | used when the run creates its own environment |
| `run-validation-and-seal` | review validation service and `generate_looped_review_package` | input `validation-plan@1` + `workspace@1`; output `review-package@2` |
| `push-branch` | Ship's push rules | pushes a `workspace@1` commit to the run's branch, for example after conflict resolution. Idempotent per commit. Force-with-lease only after a code rewind |
| `open-pull-request` | the coordinator's PR job and Ship's update-or-reopen rule | input `workspace@1` + `pr-description@1`; pushes first, then opens, updates or reopens the PR. Idempotent per run and branch. Force-with-lease only after a code rewind |
| `wait-for-checks` (D20) | the PR monitor's `checkSummary` | input: the PR. Waits within a bound (default 60 minutes, at most 6 hours) without polling of its own. Output `check-summary@1` (`state`: passed, failed, pending at timeout or no checks, plus the failing checks), so a gate can route red builds to a fix node |
| `update-ticket` | Kanban lifecycle and `record_kanban_criteria_checks` | column moves, comments, criteria results |
| `notify` | agent mail | mails the coordinator or a tab |

### P2.8 Human nodes

- Three forms: `approve`, `edit` (the user edits an artifact through its type's
  form, or as JSON) and `choose` (pick a gate branch).
- A waiting human node shows in the sidebar activity, in the run view and as a
  coordinator notice, through the existing attention and status-wake paths.
- An optional timeout routes to the `error` port. Without one, the run waits
  indefinitely, paused rather than failed.

### P2.9 Guards and enforcement

- The read-only guard from P0.1 applies to every node with
  `workspaceAccess: read` or `none`.
- A remote-ref guard compares upstream refs before and after every agent node,
  since none may push (D12).
- `minEnforcement` filters pickers at launch, and is re-checked at dispatch.
  If the provider's tier dropped since launch (for example the sandbox stopped
  working), the activation fails before dispatch with a clear message.
- The tier actually applied is recorded on the activation and shown in the
  inspector.

### P2.10 Restart and rewind

- **Restart a node.** Supersede its activation, every activation that
  transitively consumed its artifacts, and those artifacts. Then rerun it with
  the same inputs. Independent branches are kept.
- **Loops.** A restart inside a loop rewinds the iteration counter.
- **Code rewind.** It uses the node's input `workspace@1` commit, reusing the
  preview, refusals, backup ref and reset in `build-pipeline-code-rewind.ts`.
- A repeated request is a no-op. Restarting a superseded node is refused.

### P2.11 Run view

- **Projection.** A `graph-run` tab uses one generic projection,
  `graphRunFlowModel(plan, run)`, over `flow-graph/`:
  - replicated activations share a column;
  - loops unroll to the right;
  - superseded activations collapse into "Previous attempt" nodes;
  - nodes not yet reached are drawn faded.
- **Inspector.** It shows the transcript (`PipelineSessionTranscript`), the
  input and output artifacts rendered by their types, the profile and enforced
  tier, and guard results.
- **Actions.** Retry, restart from here, rewind code to here, skip, open
  session, approve, edit or choose (human nodes), pause, resume and cancel.
- **Rehydration.** The view reads only snapshots. Test the inactive-environment
  path: start, switch away, finish, return.

### P2.12 Editable designer

- **Canvas.** Add, connect, delete and group (loop regions), with undo. Ports
  are typed, and dragging shows only compatible targets.
- **Inspector forms.** For each node: prompt, inputs and outputs, capabilities
  (profile, toggles, the per-provider tier matrix, `minEnforcement`), and
  execution (role, replicate, retry, timeout, failure, session).
- **Prompt editor.** Variable autocomplete from input schemas, and a live
  preview that includes the locked system contract, using each type's `example`
  or a pasted fixture. It shows the size against the ceiling, and lints.
- **Type editor.** A form editor limited to the schema subset, plus "schema
  from example".
- **Compile panel and saving.** The compile panel and cost estimate are live.
  Saving uses compare-and-swap on revision, and a conflicting save offers
  "save as copy".
- **Taint.** A taint warning needs an acknowledgement, which is stored in the
  template against the warning's digest.

### P2.13 Mock runs

- `graph-mock-provider.ts` answers agent nodes with each type's `example`, a
  value generated from the schema, or a per-node pinned sequence. For example:
  "Verify: fail, fail, pass".
- A mock run creates no provider sessions and uses no tokens. It runs in the
  same runtime, so it exercises gates, loops, merges, guards (a no-op on mock
  nodes) and the run view.
- Mock runs are labelled as mocks everywhere and can never open a PR or move a
  ticket: system nodes with side effects record "would have run".

### P2.14 Launch surfaces

- **Launch dialog.** It is generated from the template: inputs, role pickers
  (filtered by `minEnforcement` and by structured-result support), panel
  editors with lenses, parameters, and the environment choice (new container,
  new worktree, or existing environment). Defaults are saved per template per
  project.
- **Naming** (D17). The feature is called "Graphs" in menus, tabs and Settings,
  and "Run graph…" in action menus.
- **Entry points:**
  - the environment action bar ("Run graph…");
  - the Kanban card ("Run graph…", with the ticket as input);
  - the designer ("Run" and "Mock run").
- **CLI.** `orkestrator graph list | show | validate | launch | status | cancel`,
  with the JSON and exit-code contract from `docs/architecture/public-cli.md`.
- **Control MCP.** `list_graph_templates`, `launch_graph`, `get_graph_run` and
  `cancel_graph_run`. Add a `graph-run` association kind beside
  `build-pipeline` and `multi-review` (`packages/protocol/src/coordinator.ts`),
  so the coordinator gets one status wake when the run ends or waits on a human.
- **Schedules.** A scheduled job can launch a saved template. Coordinator
  authoring stays out (D6).

### P2.15 "Describe a graph"

- A built-in agent flow takes the user's description and returns a
  `graph-template` artifact. Its schema is the template schema, and compiler
  diagnostics are fed back as repair prompts through the existing repair loop.
- The result opens in the designer as an unsaved draft. It never runs without
  the user saving it.

### P2.16 Documentation

`docs/architecture/graphs.md` (living architecture, kept in step with the code)
and a user guide. Add both to `docs/README.md`.

### Phase 2 exit criteria

Ticked only in [`graphs/000-index.md`](graphs/000-index.md); this list is the
definition.

- The design bake-off graph (§9.3, without the subgraph) runs end to end on
  at least two providers, from launch to PR. It uses lenses, a judge, a
  human approval and a system PR node.
- The failure-diagnosis loop (§9.4, with a static panel instead of `items`)
  converges or stops at its bound.
- Restart from a mid-graph node keeps independent branches and supersedes
  exactly the descendants.
- Code rewind works as it does in the pipeline.
- A backend restart in the middle of a fan-out recovers without
  re-dispatching. Interleaving seeds cover activations.
- Read-only guards refuse a committing reviewer on every provider.
  Enforcement tiers shown in the UI match the live conformance runs.
- A mock run of every example template passes with zero provider sessions.
- The inactive-environment test passes for the run view and human nodes.
- Multi Review and Build Pipeline suites, benchmarks and interleaving tests
  are unchanged after the `AgentBranchRunner` extraction.

---

## Phase 3: Multi Review on the graph runtime

- Run the built-in Multi Review template on the graph runtime behind a setting,
  with an environment override for testing.
- **Parity checklist:**
  - the evaluation corpus scores (`multi-review-evaluation.test.ts`);
  - the efficiency benchmark budgets (two verifications per generation, at most
    one save per running pass, no whole-store reads);
  - the interleaving and dispatch-recovery suites;
  - auto-fix and auto-PR ordering (§"Auto-fix and auto-PR" in
    `review-preparation.md`);
  - coordinator launch, status wakes and `get_multi_review`;
  - the review-pass tab, CLI `review` commands, provisional findings and
    overlap metrics;
  - stored Multi Review records stay readable.
- **Flip and retire.** Make the graph runtime the default once every item holds
  over a soak period. Delete the bespoke service once no supported version
  needs it (`docs/architecture/version-compatibility.md`).

## Phase 4: extensions

Each item gets its own design note before work starts.

- **`items` fan-out** over a list artifact, with `maxBranches`, and per-item
  provenance through to fixes.
- **Sub-graphs**: inlining with namespaced IDs and parameter pass-through. The
  built-in Multi Review becomes usable as a block.
- **Isolated branch worktrees**: one worktree per replicated writer branch,
  created from the input snapshot, then `select` or agent `merge`. This means
  worktree lifecycle, disk accounting (`docs/development/disk-usage.md`) and a
  container story.
- **Per-node user MCP servers**: per-session injection of user servers in every
  bridge, after which `mcp:<server>` can grant as well as deny.
- **Sharing**: export and import with signatures or digests, and a project
  template review flow.
- **Coordinator authoring** of templates, under the same trust rule as project
  templates.

## Phase 5 (optional): the Build Pipeline

Port only if Phase 3 shows clear benefit. Parity is needed for:
- Kanban lifecycle and retries;
- the PR monitor;
- per-round semantics;
- skip rules;
- the "Prepare package again" variants;
- feature builds.

Otherwise the pipeline stays on its engine, described by its built-in template.

---

## Testing strategy

| Layer | What | Where |
| --- | --- | --- |
| Protocol | Compiler diagnostics, predicates, prompt rendering, schema subset, guards, built-in pinning | `packages/protocol/src/graphs/*.test.ts` |
| Backend | Service tests with fake providers; interleaving and chaos seeds for activations (crash between commit and send, late delivery, `absent`/`lost` dispatch answers); restart recovery; artifact bounds; guard refusals | `apps/backend/src/core/graph-*.test.ts` |
| Benchmarks | Control-plane work per pass against fan-out width and retained runs, as for Multi Review | `graph-run-efficiency.bench.test.ts` |
| Live providers | Enforcement per profile and provider on the real stack; results the matrix calls `enforced` must hold | extends coordinator live conformance; batched in todo 0031 |
| Web | Designer and run-view components; Playwright agent-testing for editing, compiling, launching, switching away and back | `apps/web/src/components/graph-*`, `docs/development/agent-testing.md` |
| CLI | `graph` commands' JSON and exit contract | `packages/cli` tests |

Follow `docs/development/testing-guide.md` for commands and
`docs/development/linting.md` for lint rules.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| The runtime is less robust than the engines it generalises | Extract and share their primitives (P2.4) instead of rewriting them. Gate Phase 3 on the existing parity suites. |
| Cost blow-up from fan-out × loops | Compile-time worst case against `limits`, admission caps at run time, and a cost estimate in the designer and launcher. |
| Users over-trust capability profiles | Show the per-provider tier on every node and default `minEnforcement` (D4). Post-hoc guards. System nodes for side effects. |
| Prompt injection travelling along edges | Evidence frames, taint analysis with acknowledgement, and human nodes as a suggested mitigation. |
| Malicious project templates | Digest trust, a per-project ceiling, and capabilities that only narrow. |
| Custom schemas that some providers reject | Schema-subset rules enforced at compile time, and a conformance test per provider for representative custom types. |
| Prompt-cache regressions in panels | The lint for early per-branch variables. Lenses placed after the shared prefix. Cache-read metrics carried over from Multi Review. |
| Designer scope creep | A read-only designer first (Phase 1). A time-boxed canvas spike. JSON import and export as the escape hatch. |

## Tracking

Every work item has a numbered file in [`plans/graphs/`](graphs/000-index.md).
The ID is the phase times 100 plus the item number, so P1.7 is `107`. Phase 4's
six items are `401`–`406`; Phases 3 and 5 are one item each. Each file holds the
item's status, checklist, notes and progress log, and
[`000-index.md`](graphs/000-index.md) is the status board, including the
phase exit criteria. [`plans/graphs/AGENTS.md`](graphs/AGENTS.md) says how
agents keep both current, and `tests/unit/graphs-plan.test.ts` checks that
they agree.

This plan holds the design and the decisions; change those here. Keep its
Status line current when a phase completes. The graphs work is tracked only in
`plans/graphs/`, not in `docs/todo/`.
