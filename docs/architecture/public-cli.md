# Public CLI (`orkestrator` client commands)

Status: Living — operator and architecture guide for the client command
surface of the published `orkestrator` package.

Testing workflow and coverage by layer: [cli-testing.md](../development/cli-testing.md).
Outstanding work: [0017-cli-command-surface.md](../todo/cli-and-slash-commands/0017-cli-command-surface.md) and
[0014-cli-qualification.md](../todo/cli-and-slash-commands/0014-cli-qualification.md) (with the evidence log).
Contract source: [`packages/protocol/src/public-api.ts`](../../packages/protocol/src/public-api.ts)
and [`public-api-resources.ts`](../../packages/protocol/src/public-api-resources.ts).
Public agent summary: [orkestrator.dev/skill.md](https://orkestrator.dev/skill.md)
(`apps/web-public/public/skill.md`); keep its connection steps in step with
this guide.

## Invocation modes

One executable has three modes. The launcher
([`bin/orkestrator.js`](../../packages/cli/bin/orkestrator.js)) decides which
**before** the backend is imported, using
[`packages/cli/src/client.ts`](../../packages/cli/src/client.ts):

| Invocation | Mode |
| --- | --- |
| `orkestrator` (no arguments) | Foreground service, as before |
| `orkestrator serve [service options]` | Foreground service (explicit form) |
| `orkestrator --host … --port … …` (only service flags) | Foreground service (historical form) |
| `orkestrator <group> <command> …`, `help`, `version`, `--help`, `--version` | Client |
| `orkestrator --fix AGENT [--data-dir DIR]` (anywhere in argv) | Problem report: opens `claude`, `codex` or `opencode` |
| Anything else (typos, stray words, service flags mixed with client options) | Refused, exit 2 |

Service flags are inventoried in
[`apps/backend/src/server-flags.ts`](../../apps/backend/src/server-flags.ts); a
test fails if `options.ts` parses a flag the inventory lacks. Client commands,
help and version never initialize a backend, create its data directory, or
start a listener, bridge or child process. Client commands **never start a
backend**: they attach to one that is already running.

`--fix` ([`fix.ts`](../../packages/cli/src/client/fix.ts)) takes the place of
starting Orkestrator: it resolves the agent (PATH first, then
the managed toolchain: `bin/current`, the sole activation set, or `bin`), reads
a few non-secret facts about this machine (versions, data and log directories,
whether debug logging is on, the running backend's version from
`backend-instance.json`), and runs the agent
interactively in a new temporary directory with a prompt that has it interview
the user, collect diagnostics read-only, draft a redacted issue in `issue.md`
and, once the user approves, file it on `orkestrator-ai/orkestrator-v2` with
`gh issue create`. The launcher ignores SIGINT while the agent runs (Ctrl+C
belongs to the agent's TUI) and exits with the agent's status. Its interview, diagnostics and redaction sections are shared with the
desktop's Report a bug sheet ([bug-report.md](bug-report.md)) through
`packages/protocol/src/bug-report.ts`, and the machine facts through
`packages/protocol/src/node/bug-report-facts.ts`. Edit them there when the
data-directory layout, log names or settings labels they cite change.

## Selecting a backend

Resolution is explicit and never falls back:

1. `--profile NAME` — a running isolated development profile
   (`mise run dev:test --profile NAME`). The client reads the same status
   manifest `dev:status` reads, requires `status: "ready"` and a live backend
   PID, then uses that backend's instance descriptor.
2. `--connection NAME` — a saved connection.
3. Otherwise the saved default (`orkestrator connection default NAME`).

With none of these the command fails with `connection-not-configured` (exit 4).
There is no port scan and no implicit production default. `--profile` and
`--connection` together are refused.

### Instance descriptor

Once serving, the backend writes `<data dir>/backend-instance.json` (mode
0600, atomic rename): installation ID, per-start generation, PID, endpoint,
the **path** of the credential file (never the credential), data directory,
app version and public schema version. `controlMcp` (`running`, and `url`
when known) names the Control MCP listener, which is ephemeral for every data
directory but the default one; the backend rewrites the descriptor when that
listener starts, stops or fails to bind. It is removed on graceful shutdown if
it still describes that generation. A descriptor whose PID is gone is stale and
is refused.

The installation ID is stable per data directory (a copied directory gets a
new one). Every public response carries `backend.installationId`/`generation`;
the client rejects an answer from a different installation than the one it
resolved (`identity-mismatch`), so a recycled port cannot silently bind a
receipt to another backend. A generation change within the same installation
(a restart) is allowed.

### Connections and credentials

```bash
# A backend on this machine: read its descriptor and private auth file per call.
orkestrator connection add local --data-dir "$HOME/.config/orkestrator-v2" --default

# A remote backend: the token comes from a private file or stdin, never argv.
orkestrator connection add laptop --url https://laptop.tailnet.ts.net --credential-file ~/.secrets/ork-token
printf '%s' "$TOKEN" | orkestrator connection add ci --url https://host.ts.net --token-stdin

orkestrator connection list | show NAME | check [NAME] | default NAME | default --clear | remove NAME
```

The client configuration lives in `ORKESTRATOR_CLI_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/orkestrator-cli` (Linux) or
`~/Library/Application Support/orkestrator-cli` (macOS): `connections.json`
(0600), `credentials/` (0600 files in a 0700 directory), `receipts/`. A config
file writable by others or a credential file readable by others is refused.
`mise run smoke:cli` checks the platform default from the packed install: with
a disposable `HOME` and no override, `connection add` creates the directory
0700 and `connections.json` 0600 there, and a group-writable file is refused
(exit 4, `connection-not-configured`). There is no project-local configuration, so cloning a repository cannot select
a backend or hand a worker an operator credential. `add` contacts the backend
and pins its installation ID unless `--no-check`. URLs with embedded
credentials are refused; plain `http` is accepted only for loopback and
Tailscale addresses.

Tokens travel only in the `Authorization` header. The transport never follows
redirects, bounds decoded responses (8 MiB), and re-reads the credential file
once after a 401 for reads only (token rotation) — never for a mutation.

## Output and exit codes

| Mode | stdout | stderr |
| --- | --- | --- |
| human (default) | Free-form text; may change between releases | Diagnostics, receipt hints |
| `--json` | Exactly one envelope, success or failure | Nothing on success |
| `--output id` | Only the documented ID(s); nothing on failure | The error |
| `--jsonl` | One record per line while following, then the final envelope | — |

The envelope (`PublicSuccessEnvelope` / `PublicErrorEnvelope`):
`{schemaVersion: 1, action, ok, connection, backend, result | error, receipt?, warnings?}`.
`error` is `{code, message, exitCode, retryable?, details?}` with a stable
`code`; the exit status groups codes into classes:

| Exit | Class | Examples |
| --- | --- | --- |
| 0 | Requested condition satisfied | |
| 1 | Operation failed | `operation-failed`, `setup-failed`, `run-failed`, `run-cancelled`, `run-interrupted`, `exec-failed`, `store-capacity` |
| 2 | Invalid input | `invalid-input`, `input-too-large`, `empty-input`, `unknown-command` |
| 3 | Target absent, ambiguous or expired | `not-found`, `ambiguous-target`, `history-expired`, `node-not-found` |
| 4 | Connection or authentication | `connection-failed`, `auth-failed`, `identity-mismatch`, `profile-unavailable`, `transport-uncertain`, `node-unavailable` |
| 5 | Observer deadline | `deadline-exceeded` |
| 6 | Interaction required | `interaction-required` |
| 7 | Unknown dispatch or outcome | `dispatch-unknown`, `run-unknown`, `node-outcome-unknown` |
| 8 | Conflict or unsupported | `request-conflict`, `revision-conflict`, `namespace-expired`, `busy`, `not-ready`, `not-empty`, `capability-unavailable`, `backend-incompatible`, `node-unsupported` |
| 10 | `session goal --wait`: the agent says it is done and nothing verified it | `goal-claimed` |
| 11 | `session goal --wait`: the agent says it needs a person | `goal-blocked` |
| 12 | `session goal --wait`: an iteration cap or token budget stopped it | `goal-limited` |
| 13 | `session goal --wait`: paused, by a person, a failed turn, a stopped environment or no progress | `goal-paused` |
| 14 | `session goal --wait`: cleared or replaced before it ended, or there is no goal | `goal-gone` |
| 130 / 143 | Observation stopped by SIGINT / SIGTERM (`observation-interrupted`) | |

An HTTP 200 carrying a rejected or unknown outcome is never a success. Errors
are never classified by matching English text; the one gateway message the
client recognizes is the gateway's own `Unknown backend command:` for a
backend that predates the contract (`backend-incompatible`).

## Command surface

Every command maps to one versioned public action entering the backend through
the single registry command `public_action`
([`apps/backend/src/core/public-api/`](../../apps/backend/src/core/public-api/)).
The raw registry is not exposed. `orkestrator connection check` lists which
actions a backend advertises; the client refuses a mutation the backend does
not advertise at its version before sending it.

| Command | Action | Backend owner reused | Effects |
| --- | --- | --- | --- |
| `project list/get` | `project.list/get` | storage snapshot | read |
| `project add --remote/--path` | `project.add` | `addExistingProject` (locks, duplicate/symlink guards, clone rollback) | metadata, filesystem |
| `project create --path P --github-private` | `project.create` | `createProjectFromScratch`: `git init`, **private GitHub repository**, push | metadata, filesystem, external |
| `project init --path P` | `project.init` | `initLocalProject`: `git init -b main`, one empty commit, **no remote** | metadata, filesystem |
| `project update ID` | `project.update` | revision-checked storage patch | metadata only — no directory move, no `.git/config` rewrite |
| `project remove ID [--cascade [--wait]]` | `project.remove` | `delete_environment` per environment (cascade), then removal fence + `cleanupProjectForRemoval` | registration only, plus the environments with `--cascade`; refused with environments otherwise |
| `project config get/set/unset` | `project.config.get/set` | config lock, content revision | metadata |
| `environment list/get` | `environment.list/get` | environment snapshot (no Docker sync) | read |
| `environment create` | `environment.create` | `create_environment` (control request ID + fingerprint) | metadata |
| `environment start/stop/recreate/delete` | `environment.*` | the registered lifecycle commands and queue | filesystem, process |
| `environment fork/rename` | `environment.fork/rename` | `fork_environment`, `rename_environment` (branch renamed too) | metadata, filesystem |
| `environment config get/set/unset` | `environment.config.get/set` | environment lock, content revision | metadata |
| `environment launch` | `environment.launch` | create + start + startup reconciliation's single first prompt | all |
| `environment exec ID -- ARGV…` | `environment.exec` | environment-side exec worker | filesystem, process |
| `agent options` | `agent.options` | model catalogues (`--refresh` asks providers) | read |
| `session list/get` | `session.list/get` | pane layout + native-session records (metadata only); a Coordinator conversation's runtime ID (from `mail mailboxes`) resolves from the coordinator store, see [control-mcp.md](control-mcp.md#coordinator-conversations) | read |
| `session start [--literal] [--attach F]` | `session.start` | `launch_native_agent_job` (durable job tab, exactly-once first prompt) | provider |
| `session prompt SESSION [--literal] [--enqueue] [--attach F]` | `session.prompt` | `dispatch_native_agent_intent`; with `--enqueue`, the native prompt queue (`enqueuePromptQueueMessageIfAbsent`, drained by `drainPromptQueue`) | provider |
| `session commands SESSION [--refresh]` | `session.commands` | the session's cached command catalogue (`refresh_native_agent_commands` with `--refresh`) | read |
| `session command SESSION --command ID\|NAME [-- ARGS]` | `session.command` | `dispatch_native_agent_intent` with `{ kind: "selected" }` intent (or the queue with `--enqueue`) | provider |
| `session stop` | `session.stop` | `stop_native_agent_session`; pauses its goal and cancels its check or verifier | metadata, provider, filesystem, process |
| `session steer` | `session.steer` | steer session action | provider |
| `session config get/set` | `session.config.get/set` | live composer controls | provider |
| `session history/resume/fork` | `session.history/resume/fork` | resumable sessions; fork adopts into a new tab | provider |
| `session interactions list/resolve` | `session.interactions`, `session.interaction.resolve` | pending interactions, `resolve_native_agent_interaction` | provider |
| `session interactions hold [--resume]` | `session.interaction.hold` | `hold_native_agent_interaction` (the card timer's pause) | provider |
| `session goal set SESSION --objective\|--objective-file\|--objective-stdin [--check CMD] [--verifier AGENT[:MODEL]] [--max-iterations N] [--budget TOKENS] [--wait]` | `session.goal.set` | `NativeAgentService.performGoalCommand` from structured fields, never a `/goal` string | provider, filesystem, process |
| `session goal get SESSION [--check-output] [--wait]` | `session.goal.get` | the session record; starts nothing | read (content) |
| `session goal pause\|clear SESSION` | `session.goal.pause/clear` | the goal service on the session record; cancels its check or verifier | metadata, provider, filesystem, process |
| `session goal resume SESSION [--max-iterations N] [--budget TOKENS] [--wait]` | `session.goal.resume` | the goal service, through the live session | provider, filesystem, process |
| `session transcript` | `session.transcript` | transcript window + message pages | read (content) |
| `changes view ENV` | `changes.view` | `ChangeTrackingService.getView` / `projections.files` after `diffStats.sync` (the `changes_get_view` path) | read |
| `changes history SESSION` | `changes.history` | `ChangeTrackingService.getHistory` + each turn's projection (no scan) | read |
| `review launch ENV [--reviewer A=M[@E]]… [--focus N=TEXT]… [--focus-file N=PATH]… [--review-model] [--fix-model] [--[no-]auto-fix] [--[no-]auto-pr]` | `review.launch` | `launch_controller_multi_review`: the Multi Review button (saved defaults for what is omitted; an active review is reused) under an ID reserved from the operation. `--focus`/`--focus-file` set `--reviewer` row N's `lens` ([reviewer lenses](review-preparation.md#reviewer-lenses)): the first line is the label (at most 64 characters), the rest the instruction (at most 4 KiB), one line is both; the receipt carries no lens text | provider |
| `review list ENV` / `review get REVIEW` | `review.list/get` | Multi Review storage, bounded summary | read |
| `review open REVIEW [--fix]` / `review address REVIEW` | `review.open/address` | `controller_multi_review_surface` (root or Fix tab; Address findings) | metadata / provider |
| `review cancel REVIEW` | `review.cancel` | Multi Review supervisor `cancel` | process |
| `review start ENV [--target-branch B]` | `review.start` | the single-agent Review button: `session.start`'s job path with the shared review prompt (`@orkestrator/protocol/git-workflow-prompts`), the target branch (else the project's PR base branch, else `main`) and the saved review instruction resolved by the backend, the `Review` title, the `review` action default, and a review tab (it offers Address all) | provider |
| `build launch TICKET --project P (--type local\|container [--base-branch B --base-commit SHA] \| --environment ENV) [--agent A] [--step STAGE=A[/M[@E]]]… [--instructions STAGE=TEXT]… [--instructions-file STAGE=PATH]… [--reviewer A=M[@E]]… [--focus N=TEXT]… [--focus-file N=PATH]… [--max-iterations N]` | `build.launch` | the Build button on a Kanban ticket, through the coordinator's path: `buildPipelineInputWithDefaults` over the saved Build defaults, `isStartBuildPipelineInput`, `BuildPipelineService.start` (whose admission key returns the ticket's active build: `reused`). See [Build Pipelines](#build-pipelines) | metadata, filesystem, provider, external |
| `build list --project P` / `build get BUILD` | `build.list/get` | Build Pipeline storage; each step's selection with the byte size of its instructions and focus, never the text | read |
| `build cancel BUILD` | `build.cancel` | Build Pipeline supervisor `cancel` (refused once the build ended) | process |
| `graph list [--project P] [--limit N] [--cursor C]` / `graph show TEMPLATE [--project P [--environment ENV]]` | `graph.list/show` | the graph template library (`GraphTemplateService`), paged by reference; with a project, the launch options (`GraphRunLaunchService.options`): each role's providers with their tier and why one is unavailable, and the launch defaults. Never prompt text. See [Graphs](#graphs) | read |
| `graph validate (TEMPLATE \| --file PATH) [--project P]` | `graph.validate` | `GraphTemplateService.compile` of a saved template, or of a template file's JSON without saving it | read |
| `graph launch TEMPLATE --project P (--environment ENV \| --new-worktree \| --new-container) [--role KEY=A[/M[@E]][,…]]… [--focus ROLE[.N]=TEXT]… [--focus-file ROLE[.N]=PATH]… [--param KEY=VALUE]… [--input NAME=JSON]… [--input-file NAME=PATH]… [--ticket T [--ticket-input NAME]]` | `graph.launch` | the one launch service every surface uses (`GraphRunLaunchService.launch`, `requestedBy: "cli"`) | metadata, filesystem, provider, external |
| `graph status RUN` / `graph cancel RUN` | `graph.status` / `graph.cancel` | the graph run record (states and counts) / `GraphRunService.cancel` (refused once the run ended) | read / process |
| `pr create ENV [--target-branch B]` | `pr.create` | the Create PR button: `session.start`'s job path with the shared PR prompt, the `PR` tab title and the `pr` action default, then PR monitoring; refused when the environment has a PR | provider, external |
| `pr resolve ENV [--target-branch B]` | `pr.resolve` | the Resolve Conflicts button: the same path with the shared resolve prompt, the `Resolve` title, the `resolve` action default and the PR refresh on completion. Always a new tab with its own receipt; the button can reuse this tab, but this action never resends to one | provider, external |
| `pr push ENV` | `pr.push` | the Push Changes button: the same path with the shared push prompt, the `Git Push` title and the `push` action default; refused unless the environment has an open PR | provider, external |
| `pr get ENV` / `pr timeline ENV` / `pr files ENV [--path P]` / `pr options ENV` | `pr.get` / `pr.timeline` / `pr.files` / `pr.options` | the environment's pull request, read live through the viewer's commands; `pr get` reports `attachment` (`stored`, `detected`, `none`, `unknown`) | read |
| `pr list PROJECT [--filter F] [--query Q]` | `pr.list` | the viewer's pull request list | read |
| `pr merge ENV --yes [--method M] [--keep-branch] [--cleanup] [--expected-head-sha S]` | `pr.merge` | the Merge and Merge and Cleanup buttons: `merge_environment_pr`, settled from GitHub | external, filesystem, process |
| `pr close ENV --yes` / `pr reopen ENV` / `pr ready ENV` / `pr draft ENV` | `pr.close` / `pr.reopen` / `pr.ready` / `pr.draft` | the viewer's state command | external |
| `pr comment ENV` / `pr comment-edit ENV --comment-id N` (`--body` or `--body-file`) | `pr.comment` / `pr.comment.edit` | the viewer's conversation comment | external |
| `pr review ENV --event E --yes [--comments-file PATH]` / `pr review-comment ENV --path P --line N --side S` | `pr.review` / `pr.review.comment` | the viewer's review and inline comment; `--comments-file` reads a JSON array of `{path,line,side,body,startLine?}` | external |
| `pr thread-reply ENV --thread-id T` / `pr thread-resolve ENV --thread-id T [--unresolve]` / `pr file-viewed ENV --path P [--unviewed]` | `pr.thread.reply` / `pr.thread.resolve` / `pr.file.viewed` | the viewer's thread and file controls | external |
| `pr reviewers ENV [--add L] [--remove L]` / `pr label ENV --name N [--remove]` | `pr.reviewers` / `pr.label` | the viewer's reviewers and labels | external |
| `node list` | `node.list` | the command node's registry and links (never routes or credentials) | read |
| `attention [--follow --jsonl]` | `attention.list` | pending interactions of sessions observed waiting, the caller's settled runs, finished setups | read |
| `ticket list/get` | `ticket.list/get` | Kanban storage | read |
| `ticket create/update/comment` | `ticket.create/update/comment` | Kanban storage; the operation ID is the store's request key | metadata |
| `mail mailboxes` | `mail.mailboxes` | agent-mail directory (refused while messaging is disabled) | read |
| `mail send ENV TAB` | `mail.send` | external agent mail, inbox-only, never injected | metadata |
| `schedule list/get` | `schedule.list/get` | `ScheduledJobService` ([scheduled-jobs.md](scheduled-jobs.md)) | read |
| `schedule create/update/pause/resume/run/delete` | `schedule.*` | `ScheduledJobService`; the schedule fires later as its owner. `create`/`update` build a mail, prompt, launch, graph (`--graph TEMPLATE` with the flags of `graph launch`; see [Graphs](#graphs)) or other action | metadata |
| `permissions rules list` | `permission.rule.list` | `PermissionRuleStore` ([permission-rules.md](permission-rules.md)) | read |
| `permissions rules remove` | `permission.rule.remove` | `PermissionRuleStore`; removal only, a rule is created only from an approval card | metadata |
| `run get/wait` | `run.get` | operation store + reconciler | read |
| `run retry/discard` | `run.retry/discard` | `retry/discard_native_agent_dispatch` | provider |
| `run cancel/output` | `run.cancel/output` | exec worker control | process / read |
| `run receipts` | local | private local receipts | none |
| `host status` | `host.status` | `HostMaintenanceService` detailed snapshot (impact, tools, image) | read |
| `host update channel stable/beta/unstable` | `host.update.channel` | persisted channel and a fresh check; refused while updating | metadata |
| `host update check [--wait]` | `host.update.check` | check request answered by the host's updater | metadata |
| `host update apply --yes [--release V] [--when-idle [--max-wait D]] [--wait]` | `host.update.apply` | update job applied by the desktop app or the standalone self-updater; see [host-updates.md](host-updates.md) | process (restarts the host's app or service) |
| `host update cancel` | `host.update.cancel` | cancels the job before its restart | metadata |
| `host toolchain repair [--wait]` | `host.toolchain.repair` | pinned toolchain manager under its install lock | filesystem |
| `host image update [--wait]` | `host.image.update` | `docker pull` of the matching release image, then retag | filesystem |
| `host gh latest/pinned [--wait]` | `host.gh.update` | checksum-verified newest `gh`, or back to the pin (unqualified) | filesystem |
| `service install/uninstall/status` | local | launchd or systemd user service running versioned releases through the launcher | filesystem, process |
| `toolchain install [--tool T] [--dry-run]` | local | pinned toolchain installer into `<data-dir>/toolchains` (see [`packages/cli/README.md`](../../packages/cli/README.md) and [upgrade-agents.md](../development/upgrade-agents.md)) | filesystem |
| `completion bash\|zsh\|fish` | local | completion script generated from this build's command table (nouns, verbs, flags; never IDs, never a backend) | none |

Merge confirmations bind the resolved PR URL and effective cleanup and branch deletion effects. A changed attachment or newly requested cleanup needs fresh confirmation. Project homes keep their branch. An earlier cleanup request still applies to a later plain merge and conflicts with `--keep-branch`. Merge-and-cleanup receipts remain `running` until deletion finishes; a deletion error produces `partial` with the cleanup error. Human `pr timeline` output includes each entry, and `pr files --path` includes diff hunks and matching review threads. Both report truncation.

The shared discovery, tab resolution, catalogue and launch-validation helpers
live in [`control-shared-actions.ts`](../../apps/backend/src/core/control-shared-actions.ts)
and are used by both Control MCP and the public actions. Control MCP keeps its
own result formatting, annotations and coordinator scope; an operator request
cannot assert coordinator fields.

Control MCP reaches the same actions in-process for its operator credentials
([control-mcp.md](control-mcp.md#tool-tiers)), and the two surfaces are kept
in step by tests: each `CommandSpec` names the action it runs (`action`), and
[`command-actions.test.ts`](../../packages/cli/tests/command-actions.test.ts)
requires every public action except `capabilities` to have a command, every
backend command to name its action, and every flag and positional to name one
of that action's input properties (directly, through `SHARED_INPUT_FIELDS`, or
through the command's own `inputFields`). The same test pins
`PUBLIC_ACTION_CLI_COMMANDS` (`packages/protocol/src/public-api-cli.ts`), which
Control MCP's `describe_action` reports as each action's CLI equivalent.
`--wait` classifies receipts with the shared `classifyReceiptForWait`
(`packages/protocol/src/public-api-wait.ts`), as Control MCP's `run_status`
does.

## Leaf nodes (`--node`)

Connected to a command node ([command-nodes.md](command-nodes.md)), every
command can run on one of the leaf nodes it controls: pass the global
`--node NODE_ID` (IDs from `orkestrator node list`). The CLI sends the same
`public_action` request with `node` set; the command node forwards it over its
node link and the leaf runs it, admits its request key and keeps its receipt,
exactly as if the CLI were connected to the leaf. `run get --node …` and
`--wait` follow the operation there. The envelope's `backend` stays the
command node (so the identity check holds) and `node` names the leaf that
answered.

- **Before anything is routed** the CLI checks that the connected backend
  advertises `features.nodeRouting`; an older backend would ignore `node` and
  run the action on itself, so the CLI refuses with `backend-incompatible`.
- **`--node all`** runs `project list`, `environment list` or `attention` on
  this node and every node it controls. Every item carries `nodeId` and
  `nodeName`, `nodes` reports each node (its total, its `nextCursor` or
  attention `cursor`, or its error), and a node that did not answer is a
  warning, not a failure. Cursors are per node: page or follow one node with
  its `--node`. `environment list --project` takes one node. Mutations name
  one node. Attention applies `--limit` per node; the combined page may contain
  more items than that limit. Human attention lines name their owning node,
  and partial-read warnings are retained in both human and JSON output.
- **`environment list --sort priority|newest|oldest`** orders the returned page
  on the client with the app's activity comparator. It orders one page only and
  never reaches the backend.
- **Codes.** `node-not-found` (3): no such node here. `node-unavailable` (4):
  registered but disabled or not connected; nothing was sent.
  `node-unsupported` (8): the leaf's Orkestrator is too old to take public
  actions from its command node, or this node is itself a leaf (its own
  registry is suspended). `node-outcome-unknown` (7): the link lost the leaf's
  answer to a mutation; it was not resent, and repeating the identical request
  with the same `--request-id` replays the leaf's outcome. A leaf's own errors
  come back unchanged.
- **Authority.** The CLI is the operator on the command node and on its
  leaves (the same user holds both gateway tokens). A Control MCP credential's
  calls are relayed with their own authority instead (see
  [control-mcp.md](control-mcp.md#leaf-nodes)).
- **Not copied for a leaf launch:** files a leaf project lacks are not seeded
  from the command node's project root for `environment launch --node`, as the
  portal's New Environment does; the leaf's own project files apply.

Paths passed to project commands are on the **backend** host. Prompt, patch,
stdin, attachment and credential files are read on the machine running the
client.

## Request keys and receipts

Every mutation carries a request key. `--request-id KEY` sets it; otherwise the
client generates one. Before the request leaves the process the client writes a
private local receipt (action, key, namespace, installation, target node, intent digest — no
payload). A local receipt records intent, not acceptance, and is never
resubmitted automatically. The cache and request-key lookup are scoped to the
selected node. Recovery commands and receipt hints retain `--node`.
`orkestrator run receipts` lists them.

In the backend the key is scoped by authority, action, target scope and
request ID, and bound to a SHA-256 fingerprint of the canonical intent. The
admission check, key reservation and record publication happen in one critical
section (cross-process lock) **before** any side effect; if publication fails,
nothing runs.

- Same key, same intent → the original operation (`replayed: true`), whatever
  its state. A deleted resource is never recreated by a replay.
- Same key, different intent → `request-conflict` (exit 8).
- Control MCP's operator tools and gateway submit the same public actions
  under the credential's own authority (`control-mcp:<credentialId>`), so one
  conflict rule covers both transports, and a key reused across the CLI and an
  MCP credential is two independent requests. Records created before
  fingerprints existed keep converging (legacy recovery).
- Authority also scopes reads: `run get`, request-key lookups and every action
  that names an operation see only the caller's own operations.

Operations persist their resource IDs as soon as they are known, their stage,
dispatch and execution state, and a small content-free result. `run get OP`
or `run get --request-id KEY --action ACTION` reads them. Receipts include the
bounded current/final `result`, including partial cascade outcomes; `run get`,
`run wait`, and `project remove --wait` expose the latest counts and per-environment
results. Cascade details use a byte budget and report `truncated` and `omitted`
when rows cannot fit; aggregate totals remain available.

`not-found` and `history-expired` are distinct and neither is evidence that
nothing ran.

`session start --wait` and `session prompt --wait` do this themselves when the
submission's response is lost (`transport-uncertain`, for example an admission
slower than the client's 60 s request timeout). They look the run up by its
saved key and server-validated canonical intent and scope until it appears,
then keep waiting. Recovery shares one `--timeout` deadline measured from
before submission; a warning names the recovery. Ordinary successful
submissions get the full observation duration after admission. If the key
never appears, exit 4 stands. Definitive lookup errors and signal interruptions
remain visible with the saved key details. A locally known changed intent is
refused before sending. Nothing is resubmitted.

### Retention and expiry

Keys belong to a **namespace** (`ns-<created ms>-<random>`), published in
`capabilities.requestKeys`. A namespace admits new keys for 7 days; its records
are retained until its fence (created + 7 + 30 days) and longer while any of
its operations is active (a permanently `unknown` record with nothing left to
recover no longer pins it past the fence). After the fence the namespace is
retired: its records are deleted and any request or lookup naming it is refused
with `namespace-expired` / `history-expired`, never re-executed. Limits: 5,000
records and 16 MiB per namespace, 8 KiB per record; a full namespace refuses
new work (`store-capacity`) rather than evicting history. A corrupted store
refuses admission instead of being treated as empty. Each namespace is the
logical SQLite store `public-operations/<namespace>` (with the index in
`public-operations/index`) in the backend database: WAL with
`synchronous = FULL`, so a committed admission survives a process crash; see
[storage.md](storage.md). "Never delete `public-operations/`" below means those
logical stores.

### After a restart

A reconciler (startup pass, environment change events, 15 s sweep, and every
`run get`) settles active operations from authoritative state:

| Operation in flight | After a backend restart |
| --- | --- |
| `admitted` (nothing ran) | Runs once when its key is replayed; closed as interrupted after a day otherwise |
| create | Settled from the environment carrying its control request ID, else interrupted |
| start / recreate in setup | Settled from setup state (ready → succeeded, failed → failed) |
| start not yet running, stop, other in-flight | `interrupted` — the effect is not confirmed and nothing re-runs |
| delete | Succeeds when the environment is gone; keeps observing a re-admitted deletion |
| prompt runs | Request-specific observation (below); unknown dispatch stays parked |
| queued prompt runs (`--enqueue`) | Still settled from the durable queue and dispatch journal; one restarted before its item was written is `interrupted` |
| project removal | Succeeds when the project is gone; otherwise its fence is lifted and it is `interrupted` (environments a cascade already deleted stay deleted) |
| exec | The worker survives; its recorded exit status settles the run |
| build launch | `partial` with the pipeline's ID when a pipeline holds the launch's admission key (recorded at admission), else `interrupted`; never launched again |
| build cancel | Succeeds when the pipeline ended (`failed`), else `interrupted` |
| graph launch | Succeeds with the run's ID when a run holds the ID derived from the operation's request key, else `interrupted`; never launched again |
| graph cancel | Succeeds when the run is cancelling or ended, else `interrupted` |

## Environments

`running` means processes run; **ready** means running with setup complete (or
explicitly overridden, reported as such — the CLI never overrides setup).

```bash
ENV=$(orkestrator environment create --project "$PROJECT" --type local \
  --base-branch main --base-commit "$SHA" --request-id "$ID:create" --output id)
orkestrator environment start "$ENV" --wait ready --timeout 10m --json
```

`--wait` conditions (`running`, `ready`, `stopped`, `deleted`) first require
the operation itself to finish successfully, so an earlier unrelated
transition never satisfies a wait; setup failure fails the wait with the
recorded reason (exit 1). A start operation stays `running` through setup and
completes when setup is ready or failed. `--timeout` and Ctrl+C stop observing
only; the printed receipt resumes with `run wait`.

An explicit base must be a branch plus a full 40-character commit contained in
it; container bases must be published to a remote. The commit actually used is
reported as `base.commit`. `recreate` (containers only) and `delete` are
destructive and say so in help. Without `--discard`, `recreate` is a
preserving rebuild: the workspace and preserved agent state are copied into a
new container and verified before it replaces the old one, which is kept
stopped as a recovery copy; where the image or engine cannot preserve them the
rebuild fails with nothing changed. `--discard` deletes the container's files
instead. Both forms are bound to the container seen at admission. Deletion is tracked through cleanup; a failed
cleanup stays inspectable. Stop, recreate and delete first cancel the
environment's running exec commands.

## Settings

`project config` and `environment config` edit typed keys only (schema:
`PUBLIC_PROJECT_SETTINGS`, `PUBLIC_ENVIRONMENT_SETTINGS`): repository branch
defaults, port mappings, files to copy, entry port, allowed domains, and the
agent defaults (`agent.defaultAgent`, `agent.<platform>.mode|model|reasoningEffort|fastMode`).
Credentials are never settable here. App-level settings, such as the review
focus presets (`reviewLensPresets`), have no CLI key; Settings in the app edits
them.

`get` reports the stored value, the effective value, its source tier
(environment → repository → global → default) and when it applies
(`next-environment`, `next-start`, `next-session`, `applied`). `set` accepts
`--set key=value` (JSON-parsed when possible), `--unset key`, or a JSON patch
file `{"set": {...}, "unset": [...]}`; `null` is refused (use unset). The
backend applies the patch atomically under the owning lock and a content
revision (`--expected-revision`); UI writes change the same revision, so stale
edits conflict. Launch intent (initial prompt, attachments, pending selection)
is never touched. Editing environment agent defaults never reconfigures a live
conversation — `session config set` does that.

## Sessions and runs

A public session ID (`ses_…`) is derived from the environment and tab, so it
survives provider resumes. Sessions are resolved from the backend's pane
layout, never from whichever tab a desktop shows; a closed tab is `not-found`,
never replaced.

- `session start` creates an independent conversation in its own tab (not
  focused) and sends one first prompt. `session prompt` continues an **idle**
  session; a busy one is refused (`busy`, exit 8) unless `--enqueue` is given —
  use `session steer` to redirect a running turn. Prompt text comes from
  `--prompt-file`, `--prompt-stdin` or `--prompt` (mutually exclusive; UTF-8;
  100,000 characters / 400,000 bytes).
- **Prompt text is typed intent by default.** Sessions the CLI starts are
  ordinary native tabs, so a prompt whose first word names a provider command
  (`/review …`) runs that command, exactly as typing it in the composer would.
  `--literal` (on `session start` and `session prompt`) sends the text with
  provider commands disabled (`{ kind: "literal" }`, which the planner maps to
  `allowProviderCommands: false`). A provider that interprets a leading
  command itself and cannot be told otherwise (Claude, for a known command)
  refuses the literal prompt (`operation-failed`, nothing sent) rather than
  running the command.
- **Selected slash commands.** `session commands SESSION` lists the session's
  catalogue as the backend holds it — ID, name, aliases, availability, argument
  and busy policy, and an opaque `bindingRevision`; never the private binding
  (skill paths, template files). `--refresh` asks the provider again.
  `session command SESSION --command ID|NAME [-- ARGS]` submits
  `{ kind: "selected", commandId, bindingRevision }` through the same dispatch
  path the composer uses. An ID matches exactly; a name (with or without its
  `/` or `$`) must match exactly one available command. Refused before
  admission, with nothing sent: no such command (`not-found`, exit 3), a
  shared name (`ambiguous-target`, exit 3, candidate IDs in `details`), a
  changed command (`--expected-binding-revision` mismatch, `revision-conflict`,
  exit 8), an unavailable one (`capability-unavailable`, exit 8), wrong
  arguments for its policy (`invalid-input`, exit 2), or an idle-only command
  on a busy session (`busy`). A command that changes between admission and
  dispatch fails the run (`operation-failed`); a selection is never downgraded
  to prompt text. `/steer` is not listed: `session steer` is its public form.
- **Durable enqueue.** `--enqueue` (on `session prompt` and `session command`)
  appends the prompt to the tab's backend-owned prompt queue — the same queue
  the composer uses — under the run's own operation ID, so the queued item, the
  dispatch request and the run share one identity and a replay finds the same
  item. The backend drainer sends it, FIFO, when the session is free; no client
  needs to stay connected. The run is `running` with `dispatch: pending`
  (stage `queued`) until then, and is observed like any other run afterwards. A
  provider that refuses the queued prompt (Pi answers 409 to a literal
  follow-up it would read as a command) fails the run with the provider's
  reason, and the item stays in the tab's queue with its error for the user to
  retry or remove; a retry from the app sends it outside this run. An item
  removed before it was sent cancels the run (`dispatch: not-sent`).
  Providers without a queue (`capabilities.providers.<agent>.queue`) refuse
  `--enqueue` (`capability-unavailable`). A busy prompt is never turned into a
  steer, and a prompt without `--enqueue` is never queued.
- **Attachments.** `--attach FILE` (repeatable, on `session start` and
  `session prompt`) reads files on the client machine and sends each file's
  name and bytes inside the request: at most 8 files and 256 KiB in total, so
  that they fit the 1 MiB request with the prompt. Images (PNG, JPEG, GIF,
  WebP by signature) are sent as images, anything else as files; a provider
  that cannot take one kind refuses (`capability-unavailable`). OpenCode gets
  a file as a `text/plain` file part, which it reads with its Read tool
  (binary content arrives as a read failure the agent sees). The backend
  writes them, after admission and before dispatch, to
  `.orkestrator/prompt-attachments/<operation ID>/` in the environment
  workspace (the directory the composer stages into) and attaches those
  workspace paths. They live with the workspace and go when the environment is
  deleted. A durable staging checkpoint records the session and request identity
  before any writes. A restart at that checkpoint settles the run as interrupted
  with `dispatch: not-sent`; it never queues or dispatches it automatically.
  Names carrying directories are refused, and no input field accepts
  a backend host path. Each attachment's name, type, size and SHA-256 are part
  of the request fingerprint (the bytes never are, and never reach a receipt),
  so a replay with different files conflicts.
- `environment launch` is one backend-owned flow: create, start, setup, then
  exactly one initial prompt under the stable request ID
  `initial-prompt:<environment>:startup-agent`. Setup failure leaves the prompt
  unsent (`partial`, `dispatch: not-sent`). Never follow it with `session start`.
- `session start` without `--model` uses the configured
  default as a default: it is reported as the resolved model, but the
  runtime may replace it when this login cannot serve it (the shipped Codex
  `gpt-5.4` on a ChatGPT login), exactly as a launch from the app does. Only a
  model named with `--model` is pinned.
- Responses mean **submitted**. The receipt's `dispatch` is
  `accepted | rejected | unknown`; `execution` is
  `pending | running | waiting-for-input | completed | failed | cancelled | interrupted | unknown | unsupported`.

### Request-specific completion

A run is identified by its dispatch request ID (the operation ID). It settles
only on evidence about that request: the dispatch journal, the backend's own
observation of that session's turn activity, and the per-request turn outcome
record (with one provider status read when the turn has visibly ended,
coalesced across concurrent waiters). An idle environment, another tab's
completion, a dropped client or the agent's wording are never evidence. A
later steering input does not end a turn while the session is busy. Missing
evidence stays `unknown`. A provider whose status reads idle after a failed
turn (OpenCode keeps the error on the request's last assistant message) is
asked for that request's terminal error before an idle turn counts as
completed; an unreadable answer is retried, never settled as success. A turn
the environment's stop cut off (it was last seen working or waiting when the
runtime stopped, and no outcome was recorded) settles `interrupted` with
evidence `none`: its bridge is gone, so no outcome can be read, and changes
made before the stop may remain. The stopped session itself reads `idle`.

OpenCode can also accept a prompt (`promptAsync` returns 204) and then drop it
while building its parts, reporting only a `session.error` and storing no
message. A request whose history holds nothing, two seconds or more after such
an error that the provider's event stream saw following its dispatch, settles
`failed` with "OpenCode did not accept the prompt: <reason>". Without that
event (a stream gap, or a backend restart in between) it stays `unknown`.

| Provider | Completion | Evidence (packaged CLI, file assertion + follow-up) |
| --- | --- | --- |
| Claude | qualified | live runs in local and container environments |
| Codex | qualified | live runs in local and container environments (explicit model from a refreshed catalogue) |
| OpenCode | qualified | live runs in local and container environments with a connected model; a failed turn settles as failed |
| Pi, Cursor, Grok | unqualified | not yet live-qualified through the CLI; runs end `unknown`/`unsupported` instead of claiming completion |

`run wait OP` exits 0 only on success; 6 when an interaction needs an answer
(add `--continue-on-interaction` to keep waiting for another client to answer);
7 for unknown dispatch/outcome; 5 at its own deadline; 1 on failure. Only
`pending` interactions count, and an answer from any client clears the cached
read, so a question that was just answered does not report 6.

- **Unknown dispatch** parks the session: other prompts are refused
  (`dispatch-parked`) until `run retry OP` (replays the stored prompt verbatim
  under the same key) or `run discard OP` (clears recovery; does **not** undo a
  turn that may have run — the run ends `interrupted`).
- **Stop** targets the session's current turn (`--expect-run OP` refuses if a
  newer turn started). It succeeds only when the provider confirms the turn
  ended; otherwise `run-unknown`. A stopped run settles as `cancelled`.
  Stopping a turn differs from stopping the environment.
- **Interactions**: `session interactions list` shows pending questions and
  approvals with their options, revision and allowed actions; `resolve`
  requires `--revision` to match and validates the answer against the
  interaction before anything reaches the provider. Stale, replaced, expired or
  malformed answers are refused and never approve; the same answer key does
  not answer twice. A CLI exiting never answers an interaction.
- **Pausing a countdown**: each listed interaction carries `expiresAt` and,
  where its deadline's authority publishes one, `hold` (`available`, `heldAt`
  while paused, `reason`). `session interactions hold SESSION INTERACTION`
  pauses the countdown and `--resume` restarts a fresh window, through the
  same `hold_native_agent_interaction` path as the card's timer. The bridge
  enforces the pause, so a paused request still ends at the 24-hour hold
  ceiling or the provider's own sooner limit (the moved `expiresAt` in the
  result). Pausing answers nothing, so it needs no `--revision` and no voice
  confirmation. An interaction with no countdown (OpenCode), one whose pause
  is unavailable (`no-extension`) or one whose bridge predates pausing
  (`bridge-outdated`, or no `hold` at all) is refused with `unsupported`
  before anything reaches the provider; one that is gone or expired is
  `interaction-stale`.

### Goals

`session goal` gives one agent tab a durable objective; the backend sends turns
until a check proves it, the agent needs a person, or a limit stops it. The
rules are the composer's `/goal` (`plans/goals.md`), and `docs/architecture/goals.md`
describes the loop. An agent in a session has only `report_goal`, so it can report
on a goal and never set one. A Control MCP credential granted `sessions.control`
reaches these actions like any other session control, and the voice profile
confirms `set` and `resume`.

- **Structured input.** `session.goal.set` takes `objective`, `check`,
  `maxIterations` and `tokenBudget` as fields, so an objective that mentions
  `--budget 5` is just an objective. `maxIterations` defaults to 20, is resolved
  at admission and recorded, and may be at most 100. `check` is one line, as it
  is in `/goal`. `--verifier AGENT[:MODEL]` (`verifier: {agent, model?}`) has a
  fresh read-only session judge the work on a done report; with a check, the check
  runs first and both must pass. With neither, a done report ends the goal as
  `claimed`. A verifier the backend cannot run, or an agent it refuses, fails the
  admitted operation (`conflict`, exit 8) with the reason, and a malformed `--verifier`
  is refused by the client (exit 2).
- **Refused before admission,** with nothing recorded: no capability
  (`capability-unavailable`, exit 8, as for a provider that has not qualified or
  a budget on one that reports no usage), bad bounds (`invalid-input`, exit 2), a
  tab with no conversation (`not-ready`), a parked dispatch (`dispatch-parked`),
  a running goal, or nothing to pause or resume (`conflict`, exit 8). A goal still
  at its limit after a resume is an admitted operation that fails `conflict`,
  with the reason.
- **One request, one goal.** The goal's ID derives from the operation, so a
  replay returns the original result whatever has happened to the goal since,
  and a set the backend died during reports whether it took effect: `succeeded`
  when the session record or its goal history holds that ID, otherwise
  `interrupted` with nothing set. The same reasoning covers a coordinator's
  `set_worker_goal`.
- **Content-free receipts.** A receipt carries the goal's ID, status and counts.
  The objective, check and reports are read with `session goal get`, and
  `session get` adds the same counts as its `goal` field. `--check-output`
  (`includeCheckOutput`) adds the last check's output tail, which is untrusted
  command output. Provider session IDs, workspace fingerprints and unread reports
  are never returned.
- **`--wait`** (on `set`, `resume` and `get`) follows `session prompt --wait`, but
  observes the goal rather than one turn, by polling `session.goal.get`:

  | Goal | Exit | Code |
  | --- | --- | --- |
  | `complete`: a check or verifier passed | 0 | |
  | `claimed` | 10 | `goal-claimed` |
  | `blocked` | 11 | `goal-blocked` |
  | `limited` | 12 | `goal-limited` |
  | `paused` | 13 | `goal-paused` |
  | cleared or replaced before it ended, or no goal | 14 | `goal-gone` |
  | still running at `--timeout` (default 10 m, at most 24 h) | 5 | `deadline-exceeded` |
  | a turn waiting on an answer, without `--continue-on-interaction` | 6 | `interaction-required` |

  Only a passing check or verifier exits 0, so a script cannot mistake an
  unverified claim for a finished job. A goal replaced after it ended still
  reports how it ended, from the history. The failure envelope's `details` carry
  the goal's ID, status, reason and counts, never its text. A deadline, a signal
  or a lost connection stops only the observing: the goal keeps running, and
  `session goal get --wait` picks it up again. A lost response to a set is found
  by its request key, as for `session prompt --wait`.

### Transcripts

`session transcript SESSION [--limit N] [--before CURSOR]` returns an
oldest-first page (≤ 100 messages, ≤ 1 MiB, message text ≤ 20,000 characters
with `textTruncated`). Tool inputs and outputs are never inlined
(`detailOmitted`). `olderCursor` pages back through the live window and then
the provider history; a cursor that no longer lines up is `cursor-expired`.
Missing, unavailable and empty are distinct. `--follow --jsonl` polls pages and
emits each new message once, with a `gap` record when more arrived than one
page holds; it stops at `--timeout` or Ctrl+C and never affects the session.
Transcript reads are explicit content access; status reads and waits never
read transcripts.

### Changes

`changes view ENV` reads the backend's change projection for the environment
(`environment-net`: its baseline to its current workspace) — the same
`ChangeProjection` `changes_get_view` gives the desktop and web clients — plus
one page of changed files. It never computes a count of its own. `--json`
prints the action result verbatim:
`{environmentId, scope, projection, files: {rows, nextCursor, totalRows}}`
(on the first page `files` repeats `projection.filePage`). `--scope` accepts
only `environment` (the default). `--page-size` takes 1–200 rows (default 200);
`--cursor` pages through the same revision, and once the changes move on the
cursor is refused with `cursor-expired` (exit 8) rather than mixing two
measurements. Human output prints the scope label, state (with observation and
coverage), file count and line counts with their quality — `~` partial or
estimated, `?` unknown, `≥`/`≤` a bound; binary files and submodules show
their kind instead of line counts — and the rows. An environment that has not
been measured yet says so; nothing is shown as zero unless the backend
measured zero.

`changes history SESSION [--limit N] [--cursor C]` lists a session's persisted
turns oldest first, each with the projection of every resource its
presentation names (`projections`, keyed by resource key, without file rows);
it never scans a worktree or reads a transcript or provider. A backend without
change tracking answers both actions with `capability-unavailable` (exit 8)
and advertises them as unavailable in `capabilities`. Both are reads: they
take no request key and leave no receipt.

## Build Pipelines

`build launch TICKET --project P` starts the Kanban ticket's Build Pipeline as
the Build button does (handler:
[`actions-builds.ts`](../../apps/backend/src/core/public-api/actions-builds.ts)):
the ticket's title, description, criteria, comments and images are the task
snapshot, its source is the ticket, and the pipeline runs build, review,
address, verify and PR ([build-pipeline-view.md](build-pipeline-view.md)).
Give exactly one target: `--type local|container` for a new environment
(optionally pinned with `--base-branch` and `--base-commit`, validated as for
`environment create`; a container base must be pushed) or `--environment ENV`
for an existing worker environment of the project (never the project
checkout). Everything left out runs the saved Build defaults, layered exactly
as for the coordinator's `start_build_pipeline`
(`buildPipelineInputWithDefaults`), so a launch from the CLI, the coordinator
and the app agree.

- `--step STAGE=AGENT[/MODEL[@EFFORT]]` picks one step's agent and model;
  STAGE is `build`, `review`, `address`, `verify`, `pr`, `resolve-conflicts`
  or `preparation` (the review panel's preparation and consolidation). A model
  ID may contain `/`; the effort follows the last `@`.
- `--instructions STAGE=TEXT` and `--instructions-file STAGE=PATH` (`-` reads
  stdin) add the user's own instructions to a step
  ([per-stage instructions](build-pipeline-view.md#per-stage-instructions)),
  at most 16 KiB each. A step named only this way keeps its saved model. Fix
  uses Build's.
- `--reviewer AGENT=MODEL[@EFFORT]` rows replace the saved reviewers; reviewer
  1 is the review step, so `--step review=` and `--instructions review=` are
  refused with rows (use `--instructions 1=TEXT`). `N=TEXT` targets reviewer
  row N, and `--focus`/`--focus-file N=…` set its lens as for `review launch`.
- `--max-iterations N` is bounded by `MAX_BUILD_PIPELINE_ITERATIONS` (10).

The client refuses malformed flags, over-bound text and a missing target
before sending anything (exit 2). The backend checks the same bounds (006's
instructions guard, 005's lens guard, the iteration limit), the project,
ticket and environment before admission, so a refused launch leaves no
operation record. The launch runs under the operation: a provisioning that
outlasts the request leaves it `running` and a backend continuation settles
it. The receipt and result carry IDs and states only (`pipelineId`,
`environmentId`, `taskId`, `phase`, `reused`); `build get` reports each step's
agent, model and effort with `instructionsBytes` and
`lens: {labelBytes, instructionBytes}`, never the text. A second request key
for a ticket whose build is still active returns that build with
`reused: true`; its steps are the ones it started with.

## Graphs

`graph …` launches saved graph templates (item 214; handler:
[`actions-graphs.ts`](../../apps/backend/src/core/public-api/actions-graphs.ts)).
Templates are created and edited only in the app's designer; there is no
authoring action, here or for the coordinator (D6). A template is named
`builtin:<id>`, `user:<id>` or `project:<file>` (a `.orkestrator/graphs`
file of `--project`; `graph list` prints the references).

- `graph show TEMPLATE --project P` reports each role's providers with the
  enforcement tier they hold on this host and, for one that is unavailable,
  why (a step's `minEnforcement` floor, or no way to return the role's typed
  results), plus what a launch that leaves a role out binds. Lenses are
  reported by size. An untrusted or engine template still shows, with
  `launch.launchable: false` and the reason.
- `graph validate` compiles a saved template, or with `--file PATH` (`-`:
  stdin, at most 512 KiB) a template document that is never saved, and prints
  the compiler's diagnostics (at most 50, the rest counted) and cost;
  `--project` compiles under that project's capability ceiling. It exits 0
  whenever it answers, even for a document that does not parse (its field
  errors come back as `template-<code>` diagnostics); read `ok` and
  `launchable`.
- `graph launch` runs in an existing environment of the project
  (`--environment`) or a new worktree or restricted container the run creates
  (D7). `--role KEY=AGENT[/MODEL[@EFFORT]]` binds a role (a panel role's
  models separated by commas); `--focus ROLE[.N]=TEXT` and `--focus-file` set
  panel model N's lens as for `review launch`. `--param KEY=VALUE` sends
  `true`, `false`, `null` and numbers as JSON scalars and anything else as
  text; the backend checks each against its declaration. `--input NAME=JSON`
  and `--input-file NAME=PATH` give value run inputs (at most 256 KiB
  together); `--ticket T` binds a Kanban ticket as the template's `ticket@1`
  input and links it to the run's environment. Whatever is left out uses the
  defaults saved for the template in the project, then Settings, exactly as
  the app's launch dialog and the coordinator's `launch_graph` do: they all
  call `GraphRunLaunchService`.
- `schedule create|update … --graph TEMPLATE --project P` schedules the same
  launch: it takes every flag of `graph launch` above, checked the same way,
  and stores `{kind: "graph", request}` (`graphScheduleLaunchRequest` in
  `commands/graphs.ts`): the reference, the environment choice, a role given
  one model as a single binding and several as a panel, parameters, inputs
  and the ticket, without a request key (each fire supplies `sched:<fireId>`)
  and without saving defaults. Roles and parameters left out take the saved
  defaults when the schedule fires. `schedule.create` refuses a template
  that is not launchable at creation. A graph flag without `--graph`, or
  `--graph` beside another action, is refused before anything is sent.

The client refuses malformed flags and references before sending anything
(exit 2). Before admission the backend reads the template's launch options,
so an unknown project, environment, ticket or template (exit 3), an
environment of another project (`invalid-input`, exit 2), an untrusted
project template (`conflict`, exit 8), an engine built-in (`unsupported`,
exit 8), a template that does not compile or waits on an acknowledgement
(`not-ready`, exit 8), and an unknown role or input, a list for a one-model
role, a provider below a step's floor or a parameter outside its declaration
(`invalid-input`, exit 2) leave no operation record. Every refusal carries
the launch's own code in `error.details.reason` (`GRAPH_LAUNCH_ERROR_CODES`:
`untrusted`, `engine-template`, `not-launchable`, `invalid-binding`,
`invalid-launch`, …). A launch's intent is the validated input with the
template reference as written (scope `project:<id>`), so reusing a
`--request-id` with other flags is `request-conflict`. The launch service's
idempotency key is `public:<requestKey>` (`graphPublicLaunchRequestId` in
`public-api/graph-recovery.ts`) and the run's ID is derived from it
(`graphLaunchRunId`: `launch-` and a SHA-256 prefix over the project and that
key), so a replay returns the same run and restart recovery finds it.
Receipts, results and `graph status` carry IDs, states and counts only
(`runId`, `environmentId`, `status`, activations by state, sessions and
tokens; `graph status` adds `requestedBy`, `ticketId`, `mock`, timestamps and
the run's error, cut to 500 characters, with its cause), never input
values, ticket text, prompts or lens text. `graph cancel` (scope
`graph-run:<id>`) asks the run to stop; its record, artifacts and
environment are kept. A run that already ended is refused before admission
(`conflict`, exit 8, its status in `error.details`); a run already
cancelling is admitted and succeeds. The coordinator's `launch_graph` is
separate: see [coordinator.md](coordinator.md#saved-graphs).

## Exec

```bash
orkestrator environment exec "$ENV" --wait -- bun test ./src/thing.test.ts
orkestrator environment exec "$ENV" --wait --exit-code -- sh -c 'make check'
```

Arguments after `--` are passed as argv without a shell (use `sh -c` to opt
in). A worker in the environment — on the host for local environments, inside
the container otherwise — owns the command in its own process group, writes
stdout and stderr to separate private files (16 MiB each; beyond that the
command is stopped and `outputLimited`), enforces `--exec-timeout` (default
30 m, max 6 h), and records the exit code or signal before completion is
reported. `cwd` is relative to the workspace and symlink-confined. Environment
names starting `ORKESTRATOR_` are reserved and removed from the command's
environment. At most four commands run per environment.

The worker outlives the client and the backend; a backend restart reconciles
it by its heartbeat (a recycled PID cannot impersonate it). A worker that stops
reporting is `interrupted` and never re-run. If the launcher fails, the
backend can prove a local controller exited before claiming the run
(`state.json`) and fail it at once (`exec-failed`, "worker never started").
A timeout or container transport failure cannot prove the controller stopped:
an unconfirmed launch stays pending with an unknown outcome, even if a later
status read finds no state yet. A late worker claim can still reconcile; a
second worker is never started. `run cancel OP` targets that exact
worker and drains its descendants. `run output OP [--stream stderr] [--tail N]`
reads a bounded window. By default a non-zero exit is exit 1 with the child's
code in JSON; `--exit-code` passes the child's code through (the envelope stays
`ok: true`, which is how a script tells it apart from a client failure).

## Targeted scenarios

`mise run test:cli:scenarios` builds the package and runs scenarios against
isolated backends started through the packaged launcher (disposable data and
worktree roots, argv-only driver, owned cleanup, private manifest under
`output/cli-scenarios/<run>/`). Credential-free by default:
`read-only`, `local-lifecycle`, `retry-and-retention`, `setup-failure`,
`client-exit`, `exec`, `wrong-profile`, `project-cascade` (a started and a
stopped environment deleted by `project remove --cascade`; checkout and origin
kept) and `project-init` (local only: no remote, a local environment starts
from the repository's own `main`). The container matrix adds
`foreign-owner`: a container and two volumes (one mounted, one unmounted)
carrying every label of the scenario's environment except its owner
(`orkestrator-owner`) sit beside it while `environment start`, `exec`, `list`,
`stop` and `delete` run, and must
stay exactly as created (state, start time, labels), with the command run in
the environment's own container. Cleanup verifies that all decoy resources
are absent and reports Docker failures in `cleanupErrors`. `live-session`
records the model each session reports in force (`session config get`) on
its `session start`
manifest entry, beside the pinned model or `null` for the provider default.
`live-session` also lists the session's
commands, checks that an unknown and a changed command are refused, runs a
selected command (Claude's built-in `/context`), and sends `--literal`,
`--attach` and an `--enqueue` prompt behind a running turn. Options: `--scenario NAME` (repeat),
`--list`, `--keep-on-failure`, `--environment-type container
--docker-image TAG` (a worktree-owned image from `mise run docker:build:dev`;
the shared `latest` tag is refused), and `--provider NAME` for the
credentialed `live-session` scenario (`ORKESTRATOR_SCENARIO_MODEL` pins a
model). Fixture origins sit at `<scenario root>/fixtures/origin.git`, the one
remote the agent-test runtime mounts into containers. Container live runs for
providers other than Claude use `--network full`, because the default
restricted allowlist reaches only Anthropic's API. Every isolated backend
gets disposable provider homes under its scenario root (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME` and the three `XDG_*` homes; `isolateProviderHomes` in
`packages/cli/scenarios/provider-homes.ts`), so agents never write sessions, history
or settings into the operator's own `~/.claude`, `~/.codex` or OpenCode
directories. `PI_CODING_AGENT_DIR` and `GROK_HOME` are disposable too. A
live run stages only API-key credentials for Codex, OpenCode, Pi (`api_key`
entries; OAuth entries are dropped) or Cursor (`CURSOR_API_KEY`), and Grok's
login with its refresh token blanked (or `XAI_API_KEY`, staged as a private
`.grok/xai-api-key` file and read only by Grok container bridge startup)
(mode 0600); OAuth `auth.json` files are refused, even when fresh, because a
refresh (including one triggered by a 401) could rotate the host's login and
leave its replacement in a disposable home. For Codex, supply a test API key
through `CODEX_API_KEY` or `OPENAI_API_KEY`, or an API-key-only `auth.json` in
`CODEX_HOME`. OpenCode requires API-key-only entries in its `auth.json`.
Claude's original custom config directory or host Keychain is read before
isolation, and only its access token is staged in the disposable Claude home;
its refresh token is never copied. Inherited credential-source and agent-test
host-directory controls are cleared; only the runner's explicit live provider
selection authorizes credentials. Git (including both global config files),
gh and mise retain their host settings through explicit tool-specific overrides
while provider XDG homes remain disposable. The same disposable provider homes
are staged into containers.

A backend never passes on an agent tool connection it inherited
(`ORKESTRATOR_AGENT_MCP_URL` and `_TOKEN`, dropped by
`dropInheritedAgentToolConnection` before login-shell PATH discovery): one
started from inside an agent session would otherwise let its own agents act
as the parent tab. The harness starts every backend with a decoy connection.
`inherited-agent-connection.test.ts` executes startup with a stub login shell
and a real catalogue probe to check this boundary; the `exec` scenario checks
exec's separate environment filter. Live runs cost real tokens; keep them
opt-in. The published package ships only the Claude and Codex bridges (OpenCode runs its own server).
For a live Pi, Cursor or Grok run the harness gives that backend its own
`--resource-root`: the packaged Claude and Codex bridges plus the provider's
worktree-built bridge (`prepareProviderRuntime` in
`packages/cli/scenarios/provider-runtime.ts`), with the provider enabled.
Every live run with a pinned binary (Claude, Codex, OpenCode, Pi, Grok) first
installs it into the scenario data directory with `toolchain install --tool`,
because an agent-test backend never falls back to `PATH`. Pi, Cursor and Grok
are not yet live-qualified (see
[0014-cli-qualification.md](../todo/cli-and-slash-commands/0014-cli-qualification.md)).
Which test proves each scenario class is listed in
[cli-testing.md](../development/cli-testing.md#coverage-by-layer).

## Limitations and rollout

- `capabilities.features` reports `projectCascadeRemove`, `localProjectInit`,
  `promptAttachments`, `selectedSlashCommands` and `enqueue` as `true`; a
  client must treat a missing or `false` entry (an older backend) as
  unavailable. `transcriptFollow` stays `poll`.
- Cascade removal is operator-only: a Control MCP credential, even one holding
  `projects`, is refused (`capability-unavailable`), because deleting
  environments is a separate destructive grant.
- A `project init` project has no remote and records its checkout path as
  `gitUrl`. Its local environments start from its own branch
  (`resolveRemoteWorktreeStartPoint` uses `refs/heads/<branch>` only for such a
  project while it has no `origin`; any other checkout without an origin still
  fails). Container environments cannot clone it and pull requests are
  unavailable until a remote is added (`git remote add` in the checkout, then
  `project update --remote`).
- Not provided: event-stream following (`--follow` polls snapshots),
  worker-scoped CLI credentials, declarative `apply`, and backend auto-start;
  see [0017-cli-command-surface.md](../todo/cli-and-slash-commands/0017-cli-command-surface.md).
- Container lifecycle and exec are qualified on Linux Docker and macOS Docker
  Desktop with worktree-owned images. The 2026-10-18 macOS evidence also records
  live Claude, Codex and OpenCode container passes. The 2026-10-25 evidence
  completes macOS packed install/config permissions/profile discovery and the
  foreign-owner Docker decoy through the CLI. Pi, Cursor and Grok live runs
  and live token-cost measurement remain open; see the
  [qualification evidence and remaining work](../todo/cli-and-slash-commands/0014-cli-qualification.md).
- Browser-checked in `e2e/agent-testing/cli-ui.spec.ts`: CLI-made project,
  environment and settings changes reach an open and a reloaded renderer;
  with live Claude and OpenCode profiles, CLI-started questions and approvals
  rehydrate in an inactive, reloaded renderer and the UI's answer or approval
  completes the CLI's run. Codex raised neither card in host build mode;
  Pi, Cursor and Grok card checks await credentials (see the qualification record).
- To withdraw one action, remove its handler from
  [`registry.ts`](../../apps/backend/src/core/public-api/registry.ts):
  capabilities stop advertising it and clients refuse it before submitting,
  while `run.*`, the reconciler and the operation store keep serving already
  accepted work. Never delete `public-operations/` when withdrawing a feature.
