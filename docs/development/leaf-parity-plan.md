# Leaf parity and project copy: implementation plan

Status: **In progress.** Extends [command-nodes.md](../architecture/command-nodes.md)
and [command-nodes-plan.md](command-nodes-plan.md). Delete this file once the
behaviour is described in the living docs (`command-nodes.md`,
`coordinator.md`, `agent-messaging.md`).

## Goal

A coordinator on the command node works with environments on a leaf exactly
as it works with environments on its own node: the same tools, the same
delegation and wake semantics, the same workflows (jobs, build pipelines,
Multi Review). To make that useful, a project can be copied from one machine
to another (command → leaf, leaf → command, leaf → leaf) with the files Git
does not carry.

## User decisions

1. **Copy, never move.** The source project and its environments stay.
   Removing a copy is a separate, deliberate action.
2. **Transfer and full parity ship together** on one branch.
3. **Default location** for the copy on the target machine, editable.
4. **The user picks the untracked and ignored files** to copy. Dependency
   and build output (`node_modules`, `.venv`, `target`, …) is never
   pre-selected, because it is meant to be installed on the target.

## Design decisions

1. **The command node stays the authority.** Coordinator workflow
   associations, delegations and status wakes live on the command node, with
   a `nodeId` naming the leaf that holds the resource. Leaves run only their
   ordinary commands (`create_environment`, `start_build_pipeline`, …) plus a
   few new controller-facing ones. This keeps "coordinators run on the
   command node only" true and keeps older leaves working wherever possible.
2. **One tool family.** Every environment and workflow tool takes an
   optional `nodeId` (omitted: this node). This reverses deviation 3 of
   command-nodes-handoff ("node tools are a separate family"): with full
   parity, two families would give the model two ways to do one thing. The
   old `*_node_*` tools stay as thin aliases for one release so running
   conversations keep working; their descriptions point to the unified
   tools.
3. **Node mail is trusted mail.** Mail between a command node's coordinator
   and a leaf agent used to be stored as `external` mail, which never wakes
   anyone, so a leaf worker's report did not wake its coordinator and
   coordinator mail did not wake the worker. A new mail actor,
   `{ kind: "node" }`, carries the remote party's identity. It is
   `same-project` when the recipient's project matches the remote project by
   repository, takes the `coordinator` route (so it wakes), and is budgeted
   like any routed pair.
4. **Remote delegations behave like local ones.** A worker report from a
   leaf is held while its delegation runs and released as the wake when the
   worker's turn ends. The command node detects the turn end from the leaf's
   relayed environment events plus a reconcile sweep that reads the worker
   tab's activity on the leaf.
5. **Remote workflows wake like local ones.** Status wakes observe the
   leaf's relayed `resource-changed` events for `build-pipeline` and
   `multi-review` and read the workflow through the node link; the reducers
   (`buildPipelineStatus`, `multiReviewStatus`) are shared.
6. **Defaults resolve on the machine that runs the work.** A leaf already
   inherits the command node's preferences (`sync_controller_settings`), and
   only the leaf knows which agents and models are installed there, so model
   defaults and catalogue validation run on the leaf.

## Part A: copy a project to another machine

### Backend (every node)

| Command                                                 | What it does                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_default_project_location { name }`                 | `<default dir>/<name>` on this machine, where the default dir is the configured `defaultProjectsDirectory`, else the most common parent of existing projects, else `~/Projects`. Reports whether the path exists.                                                                                                                      |
| `list_project_transfer_candidates { projectId }`        | Untracked and ignored entries of the project root (`git ls-files --others [--ignored] --exclude-standard --directory`), directories collapsed, each with bounded size and file counts, `suggested` (`.env*` and the project's `filesToCopy`) and `heavy` (dependency or build output). Bounded: 2,000 entries, walks capped per entry. |
| `expand_project_transfer_paths { projectId, paths }`    | The regular files under the chosen paths, with sizes; refuses past the copy limits. Never follows symlinks or enters `.git`.                                                                                                                                                                                                           |
| `start_project_clone { requestKey, gitUrl, localPath }` | Starts `add_project` with `cloneOnly` in the background (a clone can outlast one node call) and returns a job; idempotent by `requestKey`.                                                                                                                                                                                             |
| `get_project_clone { requestKey }`                      | The job: `running`, `completed` (with the project) or `failed` (with a sanitized error).                                                                                                                                                                                                                                               |

### Backend (command node)

`copy_project_to_node { requestKey, source: { nodeId, projectId }, target: { nodeId, location? }, files, rememberFiles }`
starts a copy and returns its record; `list_project_copies` and the
`project-copy-changed` event report progress. Steps:

1. Resolve the source project (it must have a Git remote) and the target
   (connected; no copy of the repository yet unless this is a retry of the
   same copy).
2. Resolve the location (`get_default_project_location` when omitted).
3. Clone on the target (`start_project_clone`, then poll).
4. Expand the selection on the source and copy it in batches through the
   existing file-transfer framework (per batch: 1,000 files, 256 MiB; per
   copy: 10,000 files, 2 GiB). Existing files on the target are never
   overwritten.
5. Copy the safe repository settings: default and PR base branch, port
   mappings, files to copy (plus the selection when `rememberFiles`).
6. Record the outcome. A failure after the clone keeps the clone; retrying
   the same copy skips the clone and copies what is missing.

The coordinator's `request_project_on_node` takes an optional `location`
and suggested `files`; approving it opens the same copy dialog, prefilled,
and runs the same copy with the user's final choices.

### UI

- "Copy to machine…" in a project's menu wherever projects are listed (own
  sidebar, by machine, by project, by repository).
- The dialog: target machine (connected machines without this repository),
  location (prefilled, editable), the file list (suggested ones ticked,
  heavy ones flagged and unticked, sizes and totals, refused past the
  limits), "Use these files for new environments on that machine", then
  progress and the result.
- A default projects folder setting under the machine's general settings.

## Part B: parity for coordinator tools

### Mail

- `MailActor` and `AgentMailSender` gain
  `{ kind: "node", nodeId, nodeName, role: "coordinator" | "agent", projectId, environmentId, tabId, title? }`.
- Leaf: `deliver_node_mail` sends as `node`/`coordinator`; the worker is
  woken like local coordinator mail.
- Command node: collected leaf mail is delivered as `node`/`agent`; it wakes
  the coordinator unless an open remote delegation for that worker holds it.
- Pair budgets, hourly limits and coalescing apply unchanged.

### Associations and delegations

- `CoordinatorWorkflowAssociation.nodeId` names the resource's node; absent
  means this node. Every local reader of `resourceId` is checked so a remote
  resource is never looked up in local storage.
- Opening a remote delegation (launch, job, prompt, message) records it on
  the command node. `RemoteDelegationMonitor` closes it from the leaf's
  environment events and a sweep: environment gone or deletion requested →
  stopped, error → failed, stopped → stopped, worker tab idle after the
  grace period → completed. `deliverDelegationWakes` is unchanged apart from
  labels and excerpts read through the node.

### Tools

Optional `nodeId` on: `get_launch_options`, `list_environments` (default:
every node, rows carry `nodeId`), `get_environment`, `list_tabs`,
`list_agents`, `get_tab_state`, `get_tab_transcript`, `launch_environment`,
`start_environment`, `stop_environment`, `launch_job`, `send_prompt_to_tab`,
`send_message` (`toNodeId`), `get_repository_context`,
`start_build_pipeline`, `get_build_pipeline`, `pause_build_pipeline`,
`resume_build_pipeline`, `cancel_build_pipeline`, `start_multi_review`,
`launch_multi_review`, `get_multi_review`, `cancel_multi_review`,
`open_multi_review`, `open_multi_review_fix`, `address_multi_review`.
`list_workflows` reports remote workflows with their `nodeId`;
`adopt_workflow` works for them.

New controller-facing leaf commands, which run a workflow action without a
local coordinator conversation:

| Command                                                   | Wraps                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `start_controller_build_pipeline { input }`               | defaults + validation + `buildPipelines.start`                                 |
| `launch_controller_multi_review { input, reservedId }`    | the Multi Review button action: defaults, active-review reuse, start, root tab |
| `controller_multi_review_surface { workflowId, surface }` | open root / open fix / address                                                 |
| `launch_controller_job { … }`                             | `launch_control_job` with the delegated-prompt presentation                    |

### Status wakes

`CoordinatorStatusWakes` reads a remote association's workflow through the
node link, observes relayed `resource-changed` events from leaves, and
skips (without giving up) while the node is disconnected.

## Not in scope

- Moving a project (copy then delete the source).
- Copying into containerized environments (file transfer refuses them).
- Answering an agent's pending question on a leaf from the coordinator
  (unchanged: the user answers in that leaf's workspace).

## Verification

- Unit tests for each new command, the copy orchestrator, the node mail
  actor, remote delegations and remote status wakes, using
  `node-network-test-support.ts` for two- and three-node networks.
- `mise run format:check`, `mise run lint`, `mise run typecheck`,
  `mise run test`.
