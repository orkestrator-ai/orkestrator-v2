---
id: 214
title: "Launch surfaces"
phase: 2
plan: "P2.14"
status: done
depends_on: [109, 204, 211]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1436"
updated: 2026-10-29
---

# 214 · Launch surfaces

- **Plan:** [P2.14 Launch surfaces](../composable-graphs.md#p214-launch-surfaces)
- **Decisions:** D6, D7, D17
- **Depends on:** [109](109-template-storage-and-trust.md), [204](204-agent-node-executor.md), [211](211-run-view.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Graphs can be launched from everywhere the built-in flows can, and the coordinator can use saved graphs.

## Work

- [x] Launch dialog generated from the template: inputs, role pickers (filtered by `minEnforcement` and structured-result support), panel editors with lenses, parameters, environment choice. Defaults saved per template per project.
- [x] "Graphs" naming; "Run graph…" in the environment action bar and on Kanban cards (ticket as input); "Run" and "Mock run" in the designer.
- [x] CLI `orkestrator graph list | show | validate | launch | status | cancel` (`packages/cli/src/client/commands/graphs.ts`), following `docs/architecture/public-cli.md`.
- [x] Control MCP `list_graph_templates`, `launch_graph`, `get_graph_run`, `cancel_graph_run`. No authoring (D6).
- [x] A `graph-run` association kind beside `build-pipeline` and `multi-review` (`packages/protocol/src/coordinator.ts`), with one status wake when a run ends or waits for a person.
- [x] Scheduled jobs can launch a saved template.
- [x] A `graph` schedule is created and edited from the CLI (`orkestrator schedule create|update --graph TEMPLATE …`) and from Settings → Schedules, not only through the public `schedule.create` input.

## Tests

- [x] CLI JSON and exit-code contract tests.
- [x] Control MCP tool tests, including refusal of authoring.
- [x] One status wake per run end or wait.
- [x] A scheduled launch.
- [x] CLI and Settings build the stored `graph` action (flags, pinned roles or saved defaults, edits, refusals before submission).

## Done when

- [x] Every entry point launches the same run, and the coordinator is woken once.

## Notes

**2026-10-29 · Launch service.** `apps/backend/src/core/graph-run-launch.ts`
(`GraphRunLaunchService.launch(request, origin)` / `options` / `sweep`), protocol
`@orkestrator/protocol/graphs/launch` (`GraphLaunchRequest`, `parseGraphLaunchRequest`,
`GraphLaunchOptions`, `GraphLaunchResult`, `graphRoleDefaultBindings`, `graphLaunchParams`,
`graphLaunchCostEstimate`, `graphTicketInputName`, `GRAPH_LAUNCH_ERROR_CODES`: `invalid-request`,
`not-found`, `untrusted`, `engine-template`, `not-launchable`, `invalid-binding`, `invalid-launch`,
`conflict`, `disabled`). App commands `graph_launch_options {ref, projectId, environmentId?,
create?}` and `graph_run_launch {…request}` (`commands-registry-graph-launch.ts`). The origin
(`requestedBy: user | cli | coordinator | schedule`, `scheduleId`) comes from the surface, never the
body; it is stored as `GraphRun.launch = {requestedBy, create?, ticket?, scheduleId?}` (ids only).
`compileForLaunch(ref, projectId, environment)` now compiles with the real launch environment's
policy (`resolveEnvironmentExecutionPolicy(env, "build-pipeline")`, or the policy of a new worktree /
restricted container), cached per environment policy. Role defaults follow 108's reading;
`GraphModelBinding.lens` carries a panel member's lens (a template lens axis wins).
`requestId` derives the run id (`launch-<sha256>`): a repeat returns the run (`repeated`), a
different template or environment is `conflict`.

**2026-10-29 · Decisions.**
- Defaults per template per project live in the `graph-templates` store's `projects` row
  (`launchDefaults`, keyed by `graphTemplateRefKey`, at most 64, least recently saved dropped):
  no new collection, one `updateStoreRow` writer.
- New environment (D7): the launch omits `environmentId`; `launch.create` (the dialog's choice)
  wins over the template's `workspace.create`, so any template can run on a new worktree or
  container. Empty `workspace@1` run inputs are filled from the environment's branch and HEAD: at
  launch for an existing environment, and for a new one by the provisioner's ready report
  (`workspace`), which the pass stores before the run starts (`graphDeferredWorkspaceInputs`);
  without a commit the run fails. Without this, the §9.2 loop and every template with a `target`
  input could not launch on a new environment.
- The Kanban ticket is linked to the run's environment at launch (existing) or by the provisioner
  once it creates one; never for mock runs.
- "Structured-result support" = result tools when the rollout admits `graph-output`, else
  structured output (`STRUCTURED_OUTPUT_PROVIDER_VALUES`); a role whose nodes only produce
  `workspace@1` needs neither. Today every enabled provider qualifies; the filter is for providers
  added later or rolled back.
- Runs that end without an environment: `sweep()` (startup and after each launch) keeps at most
  20 terminal ones per project and none older than 7 days, through item 213's
  `deleteEnvironmentlessGraphRun` (now also removing transcripts). Mock runs are skipped (213's
  own retention).

**2026-10-29 · Surfaces.** Web: `components/graph-launch/` (`GraphLaunchDialog`,
`GraphLaunchFields`, `GraphLaunchRoleField`, `graph-launch-model.ts`, `RunGraphButton`), "Run
graph…" in the action bar and on Kanban cards, "Run" in the designer header (saves a dirty or new
draft first). `openLaunchedGraphRun` routes through 213's `requestGraphRunView`; the navigation
module's listeners now return whether they opened the run, and the active environment's
`TerminalContainer` answers requests for it (and takes a pending one when it becomes active) — 213's
Mock run had no listener before this. CLI: `graph list|show|validate|launch|status|cancel` over
public actions `graph.*` (`public-api/actions-graphs.ts`, `graph-recovery.ts`,
`packages/cli/src/client/commands/graphs.ts`, `public-api-inputs-graph.ts`); refusals map to public
codes (untrusted → conflict/8, engine-template → unsupported/8, not-launchable → not-ready/8,
invalid-binding/-launch → invalid-input/2, missing → not-found/3) with the launch code in
`error.details.reason`. Control MCP: `list_graph_templates`, `launch_graph`, `get_graph_run`,
`cancel_graph_run` (`control-mcp-graph-tools.ts`, `coordinator-graph-actions.ts`); a test asserts
no authoring tool. Public actions also appear as public MCP tools (`graph_launch`, …), recorded as
`requestedBy: "cli"`. Schedules: `ScheduleAction {kind: "graph", request}`, validated at create
time, fired as `schedule` with `requestId` `sched:<fireId>`.

**2026-10-29 · Association and wakes (merged with 208).** One `graph-run` association kind
(`CoordinatorWorkflowAssociation.kind`), reserved by `launch_graph` before it acts and released on
a definite refusal. One status-wake path: 208's `graph-run-coordinator-status.ts` (wait key
`waiting:<openedAt>:<id>`, a wait is news only when it opened after the last reported; terminal
keys `complete`/`failed`/`cancelled`). Kept over 214's own reducer, which keyed the whole waiting
set and so would re-notify when one of two waits was answered. Terminal notices changed to
`mode: "off"` (sent whatever the wake setting), as every other terminal workflow notice.

**2026-10-29 · Not done.** ~~No `orkestrator schedule` CLI flag creates a `graph` schedule action
(the app's Schedules settings and the public `schedule.create` input take it).~~ (done: see
"Graph schedules in the CLI and Settings" below; the Settings list showed a `graph` schedule but
could not create one either.) `graph launch` has no `--wait`. The coordinator wake was tested on the mail world, not with a live coordinator.

**2026-10-29 · Graph schedules in the CLI and Settings** (branch `graphs-limits-schedules`). The
stored action is unchanged: `{kind: "graph", request: ScheduleGraphLaunch}`, the launch request
without `requestId` or `saveDefaults`, parsed by `parseGraphLaunchRequest` and refused at creation
when the template is not launchable.

- CLI: `orkestrator schedule create|update … --graph TEMPLATE --project P (--environment ENV |
  --new-worktree | --new-container)` plus every other flag of `graph launch` (`--role`, `--focus`,
  `--focus-file`, `--param`, `--input`, `--input-file`, `--ticket`, `--ticket-input`). The flag
  list is shared (`GRAPH_LAUNCH_OPTIONS`, `GRAPH_LAUNCH_INPUT_FIELDS` in
  `packages/cli/src/client/commands/graphs.ts`), the flags are checked by the same
  `graphLaunchInput`, and `graphScheduleLaunchRequest` turns that `graph.launch` input into the
  stored request: the template text becomes its `GraphTemplateRef`, a role given one model is a
  single binding and several a panel (the launch service reads a single binding for a panel role
  as a panel of one, so no `graph show` read is needed), `{agent}` becomes `{platform}`, and the
  ticket `{taskId, input?}`. Roles and parameters left out take the saved launch defaults at fire
  time. A graph-only flag without `--graph` is refused (`--role needs --graph`), as are two
  actions. `schedule get` prints `graph <scope:id>` as the action.
- Settings → Schedules: "Run a graph" is an ordinary action choice (`ScheduleGraphFields.tsx`,
  pure rules in `graph-schedule-model.ts`). Project, template picker (non-launchable templates
  listed disabled with the reason, as in the launch dialog), inputs (a Kanban ticket fills a
  `ticket@1` input), environment (new worktree, new container or an existing environment), and a
  "Use the saved launch defaults" toggle, on by default. On, the request leaves roles and
  parameters out; off, the launch dialog's own role pickers (floors, typed-result support, panel
  editors with lenses) and parameter fields pin them. Everything comes from `graph_launch_options`
  compiled for the chosen environment, and the launch dialog's checks apply; a default the saved
  values cannot fill is reported with "turn off saved defaults to set it here". Editing starts
  from the stored request; a save that touched nothing in the action sends no action.
- Tests: `packages/cli/tests/schedule-command.test.ts` (3 new: every flag into the stored request,
  which the backend's parser accepts unchanged; an existing environment on `update`; seven
  refusals before submission); `apps/web/src/components/settings/SchedulesSettings.test.tsx`
  ("graph schedules": create with saved defaults, pin roles and parameters, edit untouched and
  changed); `graph-schedule-model.test.ts` (5).

**2026-10-29 · Agent testing.** Profile `graphs-214-launch` (`--fixture --no-agent-credentials
--agent-platforms claude`), worktree `graphs-214-launch` at the 214 merge: `mise run test:logged --
--name agent-graph-run-view -- bunx playwright test --config
e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/graph-run-view.spec.ts` passed
(2/2). The new scenario saves a credential-free template (prepare-environment without setup, then a
gate), launches it from "Run graph…" in the action bar, switches to another environment at once,
waits for `complete` through `graph_run_get`, returns (the tab shows Complete), reloads (same). The
CLI on the same profile: `graph list` (built-ins `no (engine)`, the QA template `yes`), `graph
launch user:qa-launch-rehydrate --new-worktree --request-id qa214-cli-1` → provisioning, a repeat
with the same key → the same run, an unknown template → exit 3; the CLI-launched run created its own
worktree and completed. Screenshots under `output/agent-testing/graphs-214-launch/browser/artifacts/`
(not committed). Profile stopped and reset.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Launch service, dialog and entry points, CLI, Control MCP tools, association and wakes (merged with 208), schedules, deferred workspace inputs, environment-less sweep, real-stack launch/switch/finish/return. · complete; awaiting PR
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Graph schedules from the CLI (`schedule create|update --graph`) and Settings → Schedules (template, environment, inputs, saved defaults or pinned roles and parameters); tests; scheduled-jobs.md and public-cli.md. · complete; awaiting PR
- 2026-10-29 · coordinator · Delivered in https://github.com/orkestrator-ai/orkestrator-v2/pull/1436; status done. · None.
