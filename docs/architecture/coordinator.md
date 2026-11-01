# Project Coordinator

Status: Living — current product and architecture.

Select a project to open **Coordinator**, the default project page. Coordinator
reads and discusses the configured local checkout, searches the code, and uses
Orkestrator controls to delegate implementation to isolated worker environments.
It cannot edit the project checkout itself.

What is still missing — mainly provider parity and live qualification — lives in
[0026-coordinator-read-only-adapters.md](../todo/coordinator-and-multi-review/0026-coordinator-read-only-adapters.md) and
[0024-coordinator-live-conformance.md](../todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md);
OpenCode and Grok steer in
[0005-mid-turn-steer-and-interrupt.md](../todo/agent-engines/0005-mid-turn-steer-and-interrupt.md);
worker-surface follow-ups (other nodes, status wakes for feature
planning) in
[0395-coordinator-worker-surfaces-follow-ups.md](../todo/coordinator-and-multi-review/0395-coordinator-worker-surfaces-follow-ups.md);
live qualification of the gap tools (`resolve_conflicts`, PR wakes,
`stop_worker_turn`, `get_worker_changes`, `fork_worker`, schedule edits,
worker slash commands, `answer_worker_question`) in
[1021-coordinator-gap-tools-follow-ups.md](../todo/coordinator-and-multi-review/1021-coordinator-gap-tools-follow-ups.md).
Engine internals live in [`agent-engines.md`](agent-engines.md). Control MCP
operator detail lives in [`control-mcp.md`](control-mcp.md). Qualification
invariants for agents live in `AGENTS.md` under **Coordinator qualification**.

## Ownership

A coordinator is not a local environment whose `worktreePath` happens to point
at the project root. Existing environment delete, merge, setup, and cleanup
paths assume they own a disposable workspace. Routing the checkout through them
would risk modifying or deleting the user's repository.

The durable owner is `{ kind: "coordinator", projectId, coordinatorId }`.
Provider processes, projections, queues, transcripts, attachments, and mail
use a distinct `coordinator:` runtime namespace
(`coordinator:<id>:<conversation>`). Each conversation gets its own bridge so
its scoped MCP and mail credential cannot be shared with a sibling tab.
A conversation's native session key is the ordinary tab key,
`env-coordinator:<id>:<conversation>:<tabId>`
(`coordinatorConversationSessionKey`), on every path — the renderer, mail
injects, close and the projection checks. Any other key opens a second
provider session on the same bridge, so a mail-woken turn runs where the tab
never shows it. Records with the older `coordinator-<id>:<conversation>` key
migrate when read.

One workspace is persisted per project: conversations, selected tab, immutable
`coordinator-read-only` execution policy, repository-context revision, lifecycle
state, and sanitized last startup error. Workflow associations are stored
separately so their lifetime is independent of an open chat tab.

The working directory is the canonical `Project.localPath`. A project without a
valid local path shows a checkout setup state; it does not silently use an
environment worktree, a container, or a temporary clone. Bridge state,
transcripts, attachments, and generated configuration live under application
data. Opening Coordinator does not run project setup scripts, install
dependencies, copy environment files, or load repository hooks.

A control-MCP operator or the CLI addresses a conversation as a public session
through this runtime ID; `apps/backend/src/core/public-api/sessions.ts` resolves
it from the coordinator store, never by creating an environment or pane layout.
See [control-mcp.md](control-mcp.md#coordinator-conversations).

Unmounting the page or changing projects detaches the view only. Backend-owned
sessions, pending mail, and workflows continue. Closing a conversation settles
live approvals, revokes its credential, and tombstones its mailbox without
deleting provider history or the checkout. Removing the project stops
Coordinator and deletes the isolated runtime, never the user's local repository.

## Multiple machines

On a command node ([command-nodes.md](command-nodes.md)) a coordinator also
works across the nodes that node controls:

- `list_nodes` shows the connected nodes, whether each has a copy of this
  project (matched by repository identity) and, for this machine and each
  node, its OS and load (see [Choosing a machine](#choosing-a-machine));
  `list_environments` lists the project's environments on them as well.
- Every environment and workflow tool takes an optional `nodeId` and works
  on that node's copy with the same contract as here: launches, jobs,
  prompts and messages open delegations that wake this conversation once,
  and build pipelines and Multi Reviews there send status wakes. See
  [command-nodes.md](command-nodes.md#one-tool-family-every-node).
- A node without a copy needs one first: `request_project_on_node` asks the
  user, who settles the location and files in the copy dialog.
- `request_environment_deletion` only asks: the user confirms in a dialog
  that names the node and the environment. A coordinator never deletes on
  its own initiative, here or on its own node.
- `propose_agents_md_update` with `nodeId` saves decisions to that node's
  copy: the user reviews it here, and the pull request is opened there (see
  [Saving decisions to AGENTS.md](#saving-decisions-to-agentsmd)).

The coordinator's context says whether its node is a command node. A command
node attached to another runs in leaf mode: its coordinator's context names
the controlling node, its node tools refuse, and it handles any message as
an agent on that node would. Its conversations are kept but hidden behind a
warning in the project's Coordinator tab.

### Choosing a machine

A node the user names always wins. Otherwise a coordinator stays on its own
node unless load or OS gives a clear reason to move; the context line
(`coordinatorNodeContext`) says so, and placement stays its decision: nothing
places work automatically. `list_nodes` gives it what it needs, under `machine`
on `self` and on each node:

```json
{
  "status": "ok",
  "osFamily": "macos",
  "os": "macOS 27.0",
  "arch": "arm64",
  "cpuCores": 18,
  "totalRamGb": 64,
  "latestSampleAgeSeconds": 12,
  "load": [
    { "window": "5m", "windowSeconds": 300, "coveredSeconds": 300, "cpuPercent": 21.4, "ramPercent": 58.2 },
    { "window": "1h", "windowSeconds": 3600, "coveredSeconds": 3600, "cpuPercent": 18.9, "ramPercent": 57.6 },
    { "window": "24h", "windowSeconds": 86400, "coveredSeconds": 7260, "cpuPercent": 17.3, "ramPercent": 55.1 }
  ]
}
```

- **Windows.** 5 minutes, 1 hour and 24 hours, named constants in
  `packages/protocol/src/machine-load.ts`. A worker runs for hours, so a
  one-minute figure is mostly noise. `os.loadavg()` is not the source: it is
  zero on Windows, not a percentage, and stops at 15 minutes.
- **Percentages.** Of the whole machine, so a 32-core box and a laptop compare.
  CPU is the `os.cpus()` change between readings, a true average of the time
  between them. RAM is a point reading from the title bar's cached reader:
  `vm_stat` on a Mac (`os.freemem()` there counts cached files as used),
  `os.freemem()` elsewhere (under Bun on Linux that is `MemAvailable`).
- **Coverage.** `coveredSeconds` below `windowSeconds` means the average rests
  on less history than its window, so a 24-hour figure from ten minutes reads
  as ten minutes. Before the first reading the figures are `null`. A gap of more
  than three intervals (a sleeping host) is no history, not a reading. Windows
  end at the newest reading while sampling is on schedule, so a steady machine
  reads as fully covered; `latestSampleAgeSeconds` says how old that reading is.
- **Restarts.** History is in memory (`MachineLoadSampler`,
  `apps/backend/src/core/machine-load.ts`) and starts empty on each start;
  persisting it would add a database write on every machine all day for a
  figure the coverage field already keeps honest. A bucket a minute for the
  shorter windows and one every 15 minutes for the longest bound it to about
  160 buckets, so the 24-hour edge is accurate to 15 minutes. Cost and cadence:
  [recurring-work.md](recurring-work.md) B29.
- **Machines that cannot answer.** One node never fails or holds up the call:
  each is asked in parallel through `invoke_on_node` with a 2 s limit, and its
  `machine` is otherwise `{ "status": "unavailable", "reason", "detail" }` with
  no figures. Reasons: `offline` (not connected, so not asked), `timeout`,
  `older-version` (it answered that it has no `get_machine_load`) and `error`.
  Last-known figures are never shown. `detail` is fixed wording, so a node's
  error text does not reach the coordinator.
- **Who sees it.** Read-only, for main coordinators and side agents
  (`list_nodes` is under `discovery`). The answer is parsed down to the fields
  above; no hostname, account, path or process detail crosses. The operator
  `list_nodes` over `node.list` and the public action schema are unchanged. A
  coordinator on a leaf gets its usual refusal from `list_nodes`.

### Reaching a leaf's coordinator

A command node's window reaching a leaf's project shows the leaf's
coordinator directly when the sidebar is grouped by machine or project.
Grouped by repository it leads to the command node's coordinator for that
repository instead, when the command node has one
([command-nodes.md](command-nodes.md#leaf-mode)).

## One main coordinator, and side agents

A project has exactly one **main** coordinator conversation
(`CoordinatorConversation.role`). Every worker reports to it and it owns all
delegation. Any agent reaches it at the mail address `"coordinator"`
(`COORDINATOR_MAIL_ADDRESS`), which resolves to whichever conversation is the
main right now; an address of a conversation that has since closed is
redirected there too.

Closing the main tab is how its provider is changed. Nothing reopens it on its
own until it is needed: the next agent mail to the coordinator, or a worker's
delegation wake, starts a new main with the repository's default agent
(`CoordinatorService.ensureMainConversation`) and moves onto it the work the
closed one still owed a report for (open delegations, unreported workflows).
A build-pipeline or review notice does not start one by itself — it waits for
the next main — so finished work from long-closed conversations cannot wake a
fresh coordinator. With no main open, the toolbar action reads **Start
coordinator**.

Every other conversation is a **side agent**, named Side 1, Side 2… (the lowest
free number). A side agent reads the project and Orkestrator state (its
credential carries only the `discovery`, `mail` and `schedules` capabilities
(`coordinatorRoleCapabilities` in `control-mcp-tools.ts`), so it launches
nothing, graphs included), and exchanges mail with the main coordinator only:
the mail store refuses side ↔ worker and side ↔ peer mail in both
directions. The user may still write to it.

Records from before roles migrate when read (`normalizeCoordinatorRoles`): the
selected conversation, else the oldest with an agent, becomes main and the
others become side agents. Nothing is closed. Workers a former conversation
launched belong to the main.

At most 16 conversations may be open, the main included. A new conversation
starts unassigned, so empty composers could fill that limit: **New side agent**
therefore names the unassigned side agents whose composer is empty in this
window (`unusedCoordinatorConversationIds`, which reads the live draft and so
covers text typed in the last few hundred milliseconds), and
`createConversation({ closeUnused })` closes, in the same write, each one the
backend agrees was never used: unassigned, no provider session, no saved draft
with text, mentions, attachments or annotations, no mail and no owned work. The
main coordinator is never closed this way, and a caller that names nothing
(the CLI, an older client) closes nothing.

## Tab groups

Conversation tabs split into tab groups the same way environment panes do:
drag a tab onto another group's strip to move it, or onto a pane edge to open
a new group beside or below it, so a side agent can sit next to the main
coordinator. Dividers resize, and a group closes when its last tab leaves.
Each group has its own **New side agent** action, and a new conversation
joins whichever group is focused.

The arrangement is renderer presentation only
(`apps/web/src/lib/coordinator-pane-layout.ts`, persisted per project in
`coordinatorPaneLayoutStore`). It never opens or closes a conversation; on
every snapshot it is reconciled against the backend's open set, dropping
closed conversations and placing new ones. Focusing a group selects its front
conversation (`selectCoordinatorConversation`), and a selection made elsewhere
brings that conversation to the front of its group. Only each group's front
conversation is mounted.

## Project home

The files pane works on the project board too. With a project selected and no
environment, the toggle (⌘E) opens the pane on **All files** for the project's
own checkout (`Project.localPath`); reads go straight to that path. A file
dropped, moved, created, reverted or deleted there is applied to the checkout
itself, never to a worktree, and appears under **Changes** like any edit.

Every file mutation and every session needs an environment record, so the
checkout is represented by one **project home** environment per project
(`projectHome: true`, `apps/backend/src/core/project-home-environment.ts`). It
is a local environment whose `worktreePath` is the canonical repository root.
`ensure_project_home_environment` creates it on first use and re-reads the
checkout's current branch on every call. It has no sidebar row: selecting a
project with a checkout activates its home (`useProjectHomeActivation`). The
toolbar then shows the ordinary environment controls, acting on the home, so
Review, Multi Review, its Fix session and Create PR run directly on the main
checkout. The project tabs sit on a row beneath: **Home** shows the home's own
tabs, and Coordinator, Kanban, GitHub, Linear and Features cover them with a
board panel. The home's tabs stay mounted under the board, so a tab launched
from the toolbar while a board panel is showing switches the page to **Home**.
The PR prompt branches off the base branch before committing when the checkout
is on it, and the stored branch follows the checkout after each agent turn.

The project home is a writable environment, not a coordinator, and is never a
disposable workspace. These invariants are enforced by the backend:

- `projectHome` is set only at creation; `updateEnvironment` cannot set it.
- Start never creates a worktree for it and setup scripts never run against it.
- A rename changes the display name only, never the checked-out branch.
- Deleting it removes the record and runtime state; the cleanup entry schedules
  neither the worktree nor the branch step.
- A coordinator credential cannot target it (scoped invoker, Multi Review
  launch, and address), because that would let a read-only coordinator delegate
  writes into the checkout it may only read.

## Choosing an agent

A conversation has no agent until its first prompt. The composer offers every
platform this machine qualifies, with the repository default preselected, and
the first send binds the conversation to whichever was chosen. That binding is
one-way: the transcript and rollout belong to that platform, so a different one
means a new conversation. Re-assignment is allowed only while the first send has
not yet reached a provider, so a failed start does not strand the conversation.

There is no silent fallback and no silent provider substitution. Control MCP may
be disabled globally; chat remains read-only and usable, while the page shows
that delegation controls are unavailable.

## Provider qualification

Coordinator runs against the project's real checkout, so how strongly a
platform holds the read-only boundary is named rather than flattened to
available/unavailable. The single table is
`apps/backend/src/core/coordinator-providers.ts`. Every gate — workspace
service, runtime resolver, bridge launcher, trusted session input — consults
it. Its tier and reason come from the shared enforcement matrix
(`agentPolicyEnforcement` in `packages/protocol/src/graphs/capability-enforcement.ts`)
asked about the coordinator's own policy, so a graph node with a read-only
capability profile is rated by exactly the same rules as a coordinator.

| Tier | Meaning | Platforms |
| --- | --- | --- |
| `enforced` | The provider or the OS blocks the mutation whatever the agent attempts | Codex; Claude where its command sandbox can run commands (macOS; Linux whose bubblewrap can nest a user namespace, with `socat` on `PATH`); Pi |
| `provider-configured` | The SDK is told to deny, and exposes no way to verify it | OpenCode, Cursor; Claude where the command sandbox cannot run commands (Windows; Linux without `bwrap` or `socat`, or whose policy refuses the nested namespace, such as Ubuntu's AppArmor `bwrap-userns-restrict`) |
| `advisory` | The agent is asked to request permission first; a tool that does not ask is not stopped | Grok |

**Settings → Agent platforms → Coordinator safety level** chooses the weakest
tier this installation will offer. It defaults to `provider-configured`:
`enforced` and `provider-configured` platforms are offered, and `advisory`
stays opt-in.

What each enforced platform actually does:

- **Codex** runs under a permission profile that denies the filesystem and the
  network inside the child process, with `sandbox: read-only`,
  `approvalPolicy: never`, and a private `CODEX_HOME` holding only `auth.json`.
  The bridge refuses to run a turn unless app-server echoes the profile back.
  Hosted web search is outside the profile, so its mode is set separately
  (`disabled`, or `cached` when research is on, never `live`), and the bridge
  refuses a thread unless `config/read` reports that mode.
- **Claude** runs with the SDK command sandbox on and `allowUnsandboxedCommands`
  off, a permission mode capped by the deny policy (`plan` while the composer
  is in plan mode, which a fresh coordinator composer selects, otherwise
  `default`; never `bypassPermissions`, see `claudePermissionMode`), with
  `canUseTool` refusing whatever reaches it. Not `dontAsk`: the pinned CLI
  refuses AskUserQuestion outright in `dontAsk`, so a coordinator could not ask
  the user anything. Then an allowlist that excludes every writing tool
  and WebFetch (and WebSearch unless research is on), `settingSources: []`, a private
  `CLAUDE_CONFIG_DIR` holding only the credential, managed settings that run
  no plugin or skill hook and no skill inline shell (see [Skills](#skills)),
  and a bridge-owned `PreToolUse` hook. The hook is the real boundary for
  shell: it allows a fixed
  list of reading commands and refuses pipes, redirection, substitution and
  chaining, writing arguments (`uniq in out`, `sort -o`, `git diff --output`,
  gawk's in-place and program options), path-qualified programs and the
  network-only `gh`, `curl` and `git ls-remote`. The SDK sandbox's default lets
  a command write its working directory, so the coordinator sandbox denies
  writes to the checkout (`filesystem.denyWrite`); before that, `uniq in.txt
  out.txt` wrote the checkout of an `enforced` Claude coordinator.
  `defaultCoordinatorHostCapabilities` decides whether the sandbox can run
  commands: always on macOS, never on Windows, where the pinned CLI's sandbox
  sits behind a vendor flag that is off, and on Linux by running the probe in
  [Claude's sandbox on Linux](#claudes-sandbox-on-linux). Elsewhere Claude is
  `provider-configured`, and the reason the picker shows names the cause. The
  launcher passes the same answer to the bridge as process authority
  (`ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX`, `required` or `unavailable`;
  absent reads as `required`). `required` keeps `failIfUnavailable` on, so a
  sandbox that fails to start fails the turn, and the bridge refuses the turn
  up front if its own probe fails. `unavailable` leaves the sandbox off and
  the hook is the boundary: the CLI decides availability from the programs
  alone, so asking for a sandbox the probe found broken would start it and
  fail every command.
- **Pi** blocks every tool outside its read-only set in its own `tool_call`
  gate, which runs in the bridge process and cannot be switched off by the
  workspace.

OpenCode denies through its own permission rules and runs its `plan` agent, but
always loads the checkout's project configuration, including any MCP servers it
declares. Cursor applies the sandbox and a tool ban but exposes no approval
callback, and is refused outright if its sandbox cannot be enabled.

Grok deny-policy children load a private agent profile that removes `write`,
`search_replace`, `run_terminal_cmd`, built-in subagents and 1.0.67's `monitor`
waiting tool, with `--no-leader`
so a shared process cannot bypass it. This also covers read-only review turns.
Remaining ACP permission requests, including MCP calls, are refused by choosing
`reject_once`. Other tools that never ask remain advisory, among them xAI's
hosted X search tools (`x_keyword_search`, `x_semantic_search`,
`x_user_search`, `x_thread_fetch`), which neither the profile nor
`--disallowed-tools` removes on 1.0.67. Grok
1.0.52 ends its turn on any answer except allow, so the bridge then sends the
same session a fixed continuation saying the call was refused and must not be
retried (`POLICY_DENIAL_CONTINUATION`, `acp-prompt.ts`). The continuation
counts as part of the same turn, and a turn gets at most eight. Without it, a
Grok coordinator stopped at its first refused tool and never answered.

The coordinator policy names operations, not one provider's tool strings:
`capabilityPolicy.deny` is `file.write`, `file.patch`, `shell.mutate`, and
`network`. Each bridge translates that list. `capabilityPolicy.allow` carves
exceptions out of it; the only one is `web.search` (see below). `toolPolicy`
stays Codex-shaped and is also the user-override surface, so it cannot carry
the translation.

### Network and web research

A sandbox or firewall on this machine only sees what the agent's own commands
send. Hosted web tools run on the vendor's servers, so they reach the internet
whatever the sandbox says. A live run once showed a Codex coordinator opening
`https://example.com` through hosted search while its permission profile had
the network off. So a `network` denial (`nativeAgentPolicyDeniesNetwork`)
covers hosted tools as well as commands, and each bridge removes them in its
provider's own terms.

**Settings → Agent platforms → Coordinator web research** reopens one part of
that on purpose. Commands stay off the network and hosted page fetches stay
off in every mode, because a URL the agent opens can carry data out to
whoever owns the page:

| Mode | Coordinator gets |
| --- | --- |
| Web search and research servers (default) | Hosted web search, plus the remote research MCP servers the user lists (Context7 by default) |
| Web search only | Hosted web search |
| Off | Neither |

The backend passes the setting to each coordinator bridge at launch as process
authority (`ORKESTRATOR_COORDINATOR_WEB_RESEARCH`,
`ORKESTRATOR_COORDINATOR_RESEARCH_MCP`), like the execution policy, so a
change applies when a conversation's agent next starts. Worker bridges never
receive either variable, even one inherited by the backend. The policy carries
the result as `capabilityPolicy.allow: ["web.search"]`; a bridge or a stored
record that predates `allow` ignores it and keeps search off.

Research servers are HTTPS only, named with lowercase letters, digits and
hyphens (`orkestrator*` is reserved), at most eight. A local (stdio) server is
refused: it would be a program running on this machine outside every sandbox.
Orkestrator injects each one itself, never from a file the checkout can edit.

| Platform | Search | Page fetch | Research servers |
| --- | --- | --- | --- |
| Codex | `web_search = "cached"` when allowed, else `"disabled"`; `features.standalone_web_search = false`. The engine reads the mode back through `config/read` once per app-server generation and refuses the thread on any other value. `cached` serves pages only from OpenAI's index: a live run had it refuse a fresh URL with "Cache miss" while `live` opened it. | No separate tool; `live` mode is never used | Process `-c mcp_servers.<name>` overrides, tools approved |
| Claude | WebSearch on the allowlist when allowed, else in `disallowedTools` and refused by the hook | WebFetch denied by name and by the hook | Added to the inline MCP set, `mcp__<name>__*` on the allowlist and the hook |
| OpenCode | `websearch` and `codesearch` allowed by name when allowed, else denied | `webfetch` denied after every allow; `task` subagents inherit it | Registered on the coordinator's own `opencode serve` at launch (`POST /mcp`, replacing any project entry of the same name), before the conversation is ready. OpenCode 1.19.4 lists no MCP tools over HTTP, so the backend lists each server's tools itself and allows exactly `<name>_<tool>`, leaving out an id a project server named `<name>_…` could also produce (`opencode-coordinator-research.ts`) |
| Cursor | `webSearch` joins the read-only allowlist when allowed | `webFetch` never on the allowlist | Hosted in-process as `<name>__<tool>` custom tools beside Orkestrator's, because a sandboxed read-only attach cannot call an HTTP MCP server; published under their own server name (`hostResearchCustomTools`) |
| Grok | Off. On 1.0.67 the hosted `web_search` carries `open_page` and `open_page_with_find`, which open any URL, and neither the agent profile nor `--disallowed-tools` removes them (`scripts/coordinator-probes/grok-web-tools-probe.mjs`), so search there is fetch. `--disable-web-search` removes all three; `GROK_WEB_FETCH=0` removes only the client `web_fetch`. Also `--no-leader`, so a shared leader that ignores the flag is never used | Off | None |
| Pi | No hosted search | None; the read-only gate is a name allowlist, so an extension's web tool is refused | Connected by the bridge-owned MCP client in a coordinator process only (`research` scope, reserved like `orkestrator` so a `mcp.json` entry cannot stand in), and admitted by the gate by exact registered name |

The coordinator context tells the agent which of these it has, that commands
and live page fetches are off, and to report a tool as refused only after a
call was refused. It also says to keep its own work to quick reads and
lookups and to delegate anything more serious to a worker.

The agent information panel reads "no network, web search and web fetch off",
or "no network except hosted web search, web fetch off" when search is
allowed. A `restricted` network without a `network` denial still reads
"restricted network", because hosted tools stay available there.

Every coordinator bridge is launched with
`ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`. That is process
authority: the bridge replaces whatever policy a request body or a persisted
record carries, so a permissive record cannot survive a restart and widen a live
conversation.

### Skills

A coordinator can load and invoke the user's own skills and the project's,
the ones a worker sees, so that a procedure such as this repository's
`.claude/skills/release` is followed rather than improvised. A skill is
instructions, but it can also carry parts that run or grant, so each platform
loads skills only where those parts stay inside the boundary.

**Claude.** With `settingSources: []` the pinned CLI (2.1.309) reads no
skills directory at all: not `$CLAUDE_CONFIG_DIR/skills`, not `.claude/skills`,
whatever the `skills` or `additionalDirectories` options say. Turning on the
`user` or `project` source would also load that layer's hooks, permissions,
`env`, MCP servers and CLAUDE.md, so the bridge hands each directory over
through the one channel the CLI still honours, the inline plugin set
(`coordinator-skills.ts`):

- **Two generated plugins.** `user-skills` mirrors the directory a worker on
  the active account reads (`<account home>/skills`, else
  `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`), which the launcher names
  in `ORKESTRATOR_COORDINATOR_CLAUDE_USER_SKILLS_DIR` because the bridge's own
  `CLAUDE_CONFIG_DIR` is the private one. `project-skills` mirrors the
  coordinator's own checkout's `.claude/skills`, the project's main checkout,
  whether or not git tracks it. This repository ignores `.claude/`, so a skill
  there that is not force-tracked reaches the coordinator but not a worker in
  a worktree, which has only tracked files. Their skills are listed as
  `user-skills:<name>` and `project-skills:<name>`. Worker launches never
  inherit the variable, and a read-only review turn in a worker bridge loads
  neither plugin.
- **Mirrored, not linked.** Each `SKILL.md` is rewritten with only `name`,
  `description`, `when_to_use`, `argument-hint`, `arguments`,
  `disable-model-invocation`, `user-invocable` and `version`, parsed with
  Bun's YAML parser and re-serialised as JSON scalars, so nothing of the
  original syntax reaches the CLI's parser. Dropped are `hooks` (registered as
  session hooks when the skill runs; a command hook runs outside the sandbox),
  `allowed-tools` (granted without `canUseTool`), `context`/`agent`, `model`
  and the rest. Frontmatter that does not parse skips the skill. Every other
  file is a symbolic link to the original, so references and scripts stay
  readable.
- **Allowed by name.** The allowlist names each mirrored skill
  (`Skill(project-skills:release)`). A skill from another inline plugin that
  declares hooks or tool grants reached `canUseTool` in the probe, which
  refuses it under the deny policy; the user can still type its slash
  command.
- **Nothing in a skill runs.** Every read-only turn passes `managedSettings:
  { allowManagedHooksOnly: true, disableSkillShellExecution: true }`
  (`claudeManagedSettings`), including the command-discovery probe. That
  closes, for every inline plugin and not only the mirrors, three paths probed
  on 2.1.309 that the `PreToolUse` hook never sees: a plugin's
  `hooks/hooks.json` (its `SessionStart` and `UserPromptSubmit` command hooks
  ran in a coordinator-shaped session), a skill's frontmatter hooks, and a
  skill's `` !`cmd` ``, which runs before the model sees the skill and is
  checked only against that skill's own `allowed-tools`: `allowed-tools:
  Bash(touch:*)` plus `` !`touch x` `` wrote the checkout. The bridge's own
  hooks are SDK callbacks, which `allowManagedHooksOnly` keeps.
- **A grant cannot widen the tool set.** `allowed-tools` (on a typed slash
  command of an unmirrored plugin skill, which skips the Skill tool's
  permission check) grants without `canUseTool`, so a built-in the hook does
  not name would run. The capability translation therefore also denies, by
  name and in the hook, `EnterWorktree` and `ExitWorktree` (`file.write`),
  `PowerShell` (`shell.mutate`: the hook vets Bash commands only) and
  `RemoteTrigger` (`network`). Write and Edit were already denied by name,
  and a granted Bash still goes through the hook, which refuses running a
  skill's script (`bash scripts/x.sh`, `./x.sh` and path-qualified programs).
  A subagent a skill starts runs under the same hooks, deny rules and
  sandbox.
- **Launch identity.** Each mirror is content-addressed
  (`<plugin>-<digest>`), so adding, removing or editing a skill changes the
  plugin path. The launch fingerprint and the discovery cache compare plugin
  paths, so an idle warm CLI is replaced and one that still owes work refuses
  the prompt with a `plugins` conflict until it finishes. The four previous
  mirrors of each source stay for a CLI still running on one.

The proof against the real CLI is
`bun src/services/coordinator-skills.live-probe.ts` (claude-bridge; opt-in,
billed, uses the caller's login), which runs a hostile skill both mirrored and raw, through
the Skill tool and as a typed slash command, and reports that no hook, inline
shell, Write, Bash `touch` or worktree ran while the mirrored skill loaded.

**Other platforms.** Every coordinator loads the user's skills from its own
platform's directories and the project's from the checkout, including the
checkout's `.claude/skills`, so a project that keeps its procedures there (as
this one does) is not invisible to a coordinator on another platform. What
runs in a skill stays inside that platform's read-only boundary.

| Platform | User skills | Project skills | How it holds |
| --- | --- | --- | --- |
| Codex | The account's `CODEX_HOME/skills`, which the launcher names in `ORKESTRATOR_COORDINATOR_CODEX_USER_SKILLS_DIR` because the coordinator's own `CODEX_HOME` is private, added with `skills/extraRoots/set` once per app-server generation; `~/.agents/skills`, which Codex lists from HOME | `.agents/skills` and `.codex/skills`, no longer disabled for a coordinator process (`codexLoadsProjectSkills`); `.claude/skills` as an extra root. The checkout stays pinned untrusted, so its config, hooks and MCP servers stay out | A Codex skill grants nothing; what it asks for runs as a command under the permission profile (no write, no network). The profile reads each user skill root and each skill it links to (`codexCoordinatorSkillReadRoots`): a link target is granted only when it holds a `SKILL.md` and is not HOME, `/` or an ancestor, and the checkout's own links are never followed. `features.skill_mcp_dependency_install` and `skill_env_var_dependency_prompt` are off. Proved by `live-coordinator-skills.test.ts` (no credits): the skills are listed and offered, a user skill is readable from a command, and a neighbouring file, the skill and the checkout stay unreadable or unwritable |
| Cursor | `~/.cursor`, `~/.agents`, `~/.claude`, `~/.codex` and `~/.grok` skills, Cursor's own list | The same five directories under the checkout | The SDK has no skills-only switch (the `user` layer also brings `~/.cursor/mcp.json`), so the bridge hosts one read-only tool, `orkestrator-skills__load` (`coordinator-skills.ts`), beside the Orkestrator and research tools: its description lists the skills, and a call returns a `SKILL.md` or a file inside that skill. A directory counts as a skill only with a `SKILL.md` and not as HOME, `/` or an ancestor; a file outside the skill's own directory is refused. The allowlist and sandbox are unchanged. The list is read at attach |
| OpenCode | OpenCode's own, `~/.claude` and `~/.agents` skills | `.opencode`, `.claude` and `.agents` skills | OpenCode discovers them itself; the `skill` permission is now allowed. On 1.19.4 it only returns the `SKILL.md` and a file list, and a shipped script still needs the denied `bash` |
| Pi | `~/.pi/agent/skills` and `~/.agents/skills` (`noSkills: false` in a coordinator process) | `.pi/skills`, `.agents/skills` and `.claude/skills` as `additionalSkillPaths`, with the project still untrusted, so `.pi/` settings and extensions stay out | A Pi skill is markdown the model reads with `read`; extensions stay off and the read-only gate admits no tool that could run what a skill ships. `coordinator-skills.test.ts` (pi-bridge) runs it against the real SDK |
| Grok | Loaded from `~/.grok`, `~/.claude` and installed plugins; the coordinator has no private home | Gap: only through Grok's own folder trust, which also loads the checkout's hooks and MCP servers. The per-process overlay (`GROK_CONFIG`) applies `models` but drops a `skills` section, so `skills.paths` can be set only in the user's own `~/.grok/config.toml` (probed on 1.0.67) | Advisory tier. A checkout the user trusted in Grok already loads its hooks and MCP servers in the coordinator, a gap that predates skills |

### Claude's sandbox on Linux

The Claude CLI checks only that `bwrap` and `socat` are on `PATH`. It runs each
command under bubblewrap (`--unshare-user --unshare-pid … --proc /proc`) and,
inside that, its embedded `apply-seccomp` helper, which creates a second user
namespace with its own PID and mount namespaces. Ubuntu's AppArmor package
ships `/etc/apparmor.d/bwrap-userns-restrict` (profile `unpriv_bwrap`), which
lets bubblewrap create its namespace but strips capabilities from anything
nested in it. On such a host the sandbox starts and every command then fails
with `apply-seccomp: write /proc/self/setgroups (nested userns is
capability-restricted …): Permission denied`. This was seen on GitHub's Ubuntu
26.04 runner; neither `kernel.apparmor_restrict_unprivileged_userns=0` nor
`kernel.apparmor_restrict_unprivileged_unconfined=0` is enough.

So the probe runs what the CLI needs:
`claudeLinuxSandboxStatus` (`packages/protocol/src/node/claude-linux-sandbox.ts`)
runs `bwrap --new-session --die-with-parent --unshare-user --unshare-pid
--ro-bind / / --dev /dev --proc /proc -- unshare --user --map-root-user --pid
--mount --fork --mount-proc true`, and on failure `bwrap … -- true` to tell the
two stages apart. Each run is bounded at 5 seconds and the answer is reused for
5 minutes, so a host whose policy the user changes is re-read without a
restart. It fails closed: a host without `bwrap`, `socat` or `unshare`, whose
bubblewrap cannot create a user namespace, or whose nested namespace is
refused, is not sandboxed. The reason names the cause, and names
`bwrap-userns-restrict` when AppArmor is enabled and that profile is installed.

Three consumers use it:

- the backend's coordinator table, which reports Claude as
  `provider-configured` with that reason;
- the Claude bridge, which runs the probe where the CLI runs (the host, or
  inside a container) and refuses a turn that requires the sandbox: a session
  whose execution policy sets `sandbox: "provider"`, or a coordinator launched
  as `required`. The prompt route answers 422
  `{ kind: "sandbox-unavailable" }` before anything is journaled, and the
  backend shows the reason as the prompt's error
  (`claudeSandboxRefusal`, `bridges/claude-bridge/src/services/claude-execution-sandbox.ts`); and
- a read-only review turn in an ordinary bridge (a prompt with `readOnly`:
  Multi Review's consolidation and packaged reviewers, plan-mode fan-out
  reviewers), described next.

#### Read-only review turns without a working sandbox

Such a turn runs under `READ_ONLY_TURN_POLICY`, the coordinator's boundary,
but no launcher has qualified the host for it. It used to ask the CLI for a
required sandbox whatever the host, so the pinned CLI refused the whole turn
before any model call where `bwrap` or `socat` is missing (every container:
the image ships neither), and under AppArmor's `bwrap-userns-restrict` the
turn ran and every Bash call failed in `apply-seccomp`.

Now the bridge decides per turn (`claudeReadOnlyCommandSandbox`): a
coordinator process keeps its launcher's answer (absent reads as `required`);
otherwise macOS asks for Seatbelt, Linux follows the probe, and any other
platform has none. Where there is none, the turn runs with
`enabled: false, failIfUnavailable: false`, the way an `unavailable`
coordinator does. Everything else that holds the turn is unchanged: the
PreToolUse command hook, the reading-tool allowlist, the denied tools, the
`deny` approvals, `allowUnsandboxedCommands: false` and the `denyWrite` list
(inert without the sandbox, kept as intent). The turn is never refused for
it. The decision is part of the launch boundary, so a warm CLI launched under
the other answer is not joined.

The boundary is shown, not silent:

- **Agent Info.** While the turn runs, the reported policy says `sandbox:
  "none"` and its note adds `readOnlyCommandSandboxOffNote` with the probe's
  reason (`claudeReportedPolicy`, `readOnlyTurnReportedPolicy`).
- **Multi Review.** `GET /session/:id` carries `readOnlyCommandSandbox:
  { state: "off", reason }` until the next non-read-only turn; the backend
  reads it as `commandSandboxOff` on the session observation and keeps it on
  the reviewer (`ReviewerRecord.commandSandboxOff`) and on the consolidation
  step (`stepRuntimes.consolidate.commandSandboxOff`). The reviewer's and the
  consolidation step's inspector show it as a warning note. A restarted
  reviewer or step starts without it.

Proved by the bridge's session-manager and route tests with an injected probe
answer, and by the `read-only-*` cases of
`conformance-coordinator-sandbox-live.test.ts`, which hide `bwrap` and
`socat` from `PATH` and run the pinned CLI against a scripted endpoint; the
case that pins the CLI's own refusal of a required sandbox runs only on Linux.
Not yet run: a real Multi Review in a container environment and on stock
Ubuntu
([0190](../todo/agent-engines/0190-claude-read-only-turns-without-working-sandbox.md)).

Orkestrator never changes AppArmor policy and does not ship a profile. To get
`enforced` on such a host, an administrator chooses one of:

- **A local profile for bubblewrap that allows nested namespaces.** For
  example a profile in `/etc/apparmor.d/` attached to `/usr/bin/bwrap` that
  keeps `userns` and capabilities for its children instead of
  `bwrap-userns-restrict`'s capability-free `unpriv_bwrap`. This keeps the
  restriction for every other program. It also widens what any bubblewrap
  user (Flatpak, other sandboxes) may do inside its namespace, and the
  profile has to be kept in step with Ubuntu's own across upgrades.
- **Removing `bwrap-userns-restrict` (and `unprivileged_userns`) on a
  dedicated host**, with `apparmor_parser --remove`. CI does this, and sets
  both sysctls above to 0, on its disposable runner
  (`.github/workflows/ci.yml`); that is the tested combination. It removes Ubuntu's mitigation against unprivileged user
  namespace exploits for every program on the host, and the profiles return on
  the next boot unless they are disabled in `/etc/apparmor.d/disable/`.

Otherwise Claude still works as a `provider-configured` coordinator, with the
hook as its boundary, and an interactive session can run without the provider
sandbox.

Not yet run: stock Ubuntu 24.04 and 26.04 desktops, Debian with AppArmor,
Fedora (SELinux) and Docker containers
([0145](../todo/agent-engines/0145-claude-linux-sandbox-apparmor-nested-userns.md)).

### Changing qualification

Do not reintroduce a platform literal at any of the gates listed above — that
is what previously let a platform be half-qualified, allowed to hold a
conversation but refused a bridge.

Change a tier in the read-only boundary of `capability-enforcement.ts`, never
in `coordinator-providers.ts`: the coordinator and graph nodes share it, and
`coordinator-providers.test.ts` fails if the two disagree.

Moving a platform to `enforced` is a claim that the provider or the OS blocks
the mutation whatever the agent attempts. It requires both:

- a translation of `capabilityPolicy` into that provider's own vocabulary, in
  the bridge, applied on create, resume, config and every turn; and
- `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only` honoured as
  process authority, so a request body or a persisted record cannot widen a
  live conversation across a restart.

`toolPolicy` cannot carry that translation: its strings are Codex's tool names,
so the same list means "Write, Edit" on one bridge and nothing at all on
another. Use `capabilityPolicy`, which names the operation rather than the tool.

Before moving a platform to `enforced`, run the live read-only suite for it
(`mise run test:agent:coordinator --credential-source <platform>`) and keep the
summary it writes. The unit tests show that the bridge translates the policy.
Only a live run shows that the provider holds it. `coordinator-conformance.test.ts`
fails if a platform the coordinator offers, enforced ones included, is missing
from the live suite's platform list (`COORDINATOR_LIVE_PLATFORMS`).

Where a platform cannot honour an axis, report it in the policy's `note` and
leave the tier at `provider-configured`. Do not silently drop the axis, and do
not claim a boundary the bridge is not holding — the tier is shown to the user
next to the platform they are choosing.

`delegation` is derived, not declared per platform. It is an MCP client *and* an
injectable native mailbox, because `launch_environment` goes out over MCP while
the worker's reply comes back as agent mail. Native Claude, Codex, OpenCode,
Pi, Cursor, and Grok all have both. Cursor and Grok consume per-tab
`agentMcp` the same way Claude and Pi do; the process-env token is only the
fallback. Deriving delegation from the outbound half alone is what would
let the coordinator prompt promise workers whose mailbox cannot receive the
answer.

## Attachments

Pasted images and other prompt attachments are staged under application data, in
a per-conversation directory, never in the checkout a coordinator may not write
to. A bridge otherwise confines an attachment path to its session's workspace,
so each coordinator bridge is launched with
`ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT` naming that one directory as a second
readable root; Codex additionally grants it `read` in the conversation's
permission profile. Like the execution policy, this is process configuration —
a request body cannot name a root of its own — and it is scoped to the one
conversation. Deleting the project removes them with the rest of the coordinator
runtime.

## Repository toolbar

The toolbar shows the canonical path, branch, upstream freshness, ahead/behind
state, local changes, and any retained Git error. **Refresh** fetches remote
state. **Sync** performs only a fast-forward pull. Branch switching and sync are
disabled for conflicted repositories, an ongoing merge or rebase, an occupied
worktree branch, or an active coordinator turn. A dirty checkout blocks sync,
but the branch picker remains available and asks the user to confirm discarding
tracked and untracked changes before switching. A branch without an upstream is
a valid local-only state and does not block branch switching; refresh fetches
all configured remotes in that state so their branches remain discoverable.

These buttons are explicit user actions. The coordinator agent cannot invoke
them. Mutations are serialized by canonical repository root, across windows and
tabs, and hold a lease that also prevents new coordinator turns and mail
injections from starting. After a successful or externally detected branch or
HEAD change, the repository-context revision increments and is supplied before
the next turn so the agent does not assume its old analysis still describes the
checkout.

### Merging upstream commits before a message

Before each message to the main coordinator, its first prompt included, the
panel runs the cooldown-bound fetch (`fetchProjectGit` without `force`, waited
on for at most five seconds) and asks *"There are N upstream commits … Do you
wish to merge them?"* when the checkout can merge them: an upstream is
configured, `behind > 0`, and nothing blocks a fast-forward (no local commits,
no uncommitted changes, no unfinished repository operation). **Enter** (the
focused default) fast-forwards with `syncProjectGit`, then sends; a failed
fast-forward keeps the draft and shows the error. **Escape** or **Don't merge**
sends without merging.

A decline is remembered per project against the upstream tip it was given for
(`ProjectGitStatus.upstreamCommit`), in a persisted renderer store whose key is
per machine (`coordinatorUpstreamDeclineStore`). The question returns as soon as
the tip changes, and survives a reload. It is not asked for side agents, for `!`
commands, while any of the coordinator's conversations is running a turn (the
backend refuses to change the checkout then), or when the checkout is behind but
blocked; the toolbar already says why that checkout cannot sync. A status from a
backend that predates `upstreamCommit` cannot match a decline, so it always asks.

A chip in the same toolbar shows **Waiting on N workers** when the selected
conversation has open delegations. It is a projection from the snapshot, not
from anything this page observed, so it is correct after a reload. A worker
whose delegation has a waiting episode (`delegation.waiting`, written by status
wakes from the worker tab's own turn activity, never the environment aggregate)
is marked as needing a person ("1 needs you", and named in the tooltip). The
episode starting or ending announces a `coordinator` change, so the chip
refreshes without a reload; the notice's own bookkeeping is not announced.

## User `!` commands

A message that starts with `!` in a coordinator conversation's composer runs
the command as the user in the project's checkout on this node, with the
user's own environment, and shows its output, the prompt it waits on (link,
code, ENTER), an input line and Cancel in the conversation. The coordinator's
agent is told what ran, and what it printed, at the start of its next turn.
The mechanism is the same as in any agent tab; see
[user-commands.md](user-commands.md).

**Why this does not break the read-only boundary.** The read-only policy is a
limit on the *agent*: the bridge's tool hooks, the shell allowlist and the
sandbox decide what the coordinator model may do, and none of them changes.
A `!` command is the person at the keyboard acting, exactly as if they typed
it in a terminal in that checkout, and the backend runs it outside the agent
entirely:

- only the composer can start one (`run_user_command` is not a Control MCP or
  agent tool, and the backend never treats a leading `!` in prompt text as a
  command), so the coordinator model cannot use it to escape its policy, and
  neither can mail, a workflow or a scheduled prompt;
- the agent receives the command and its output as text in its next prompt,
  not as a tool it can call again;
- it may write to the checkout, as the user's own terminal may. It does not
  take the coordinator-turn lease, so a long-running command (`npm login`
  waiting on a browser) does not block Sync or branch switching; the
  repository toolbar notices a branch or HEAD change it makes as it would any
  other external change.

## Control MCP

Coordinator uses the same Control MCP HTTP endpoint as an ordinary external
client, with a separate backend-issued credential bound to project, workspace,
conversation, mailbox incarnation, and allowed capabilities. The credential is
written only into the trusted bridge runtime; it is not returned to the
renderer or stored in a transcript. Closing the conversation revokes it.
Restart reaps the old bridge and issues a new credential on reattachment.

Role is authenticated server-side. Supplying `role: coordinator`, a sender tab
id, or text in a message cannot gain coordinator privileges. Discovery is
limited to the bound project. Environment and workflow mutations must target a
disposable worker in that project. The credential cannot dispatch arbitrary
backend commands, change application settings, merge or delete the root
checkout, or mint credentials.

Delegation tools return as soon as the resource is reserved and started. Their
JSON result includes `delivery: "async"`, a wake sentence, and
`nextStep: "Finish your turn now. Do not poll."` The same contract is the
exported `COORDINATOR_ASYNC_CONTRACT` used in the coordinator context prompt
and the mailbox poll guard.

Repeated unchanged reads of `read_messages`, `get_message_status` or
`list_environments` return the authorized page with `repeatedRead: true` and
the contract attached, after three identical answers inside 120 seconds. The
guard never withholds data. For `list_environments` "identical" means the same
filters and the same lifecycle, setup, activity and PR state for every listed
environment (and every other node's rows); `lastActivityAt` is left out, so
re-listing while a worker is still `working` counts as the same answer. PR
state there is the whole reading below: a PR that starts conflicting, has a
check finish or fail, or becomes ready to merge is a different answer.

A coordinator's `get_environment` and `list_environments` rows for a worker
with a pull request carry, besides `prUrl` and `prState`,
`prHasMergeConflicts`, `prMergeability` (`clean`, `blocked`, `dirty`,
`behind`, `unstable`, `unknown`, `unavailable`), `prChecks` (`passed`,
`failed`, `pending` and `total` counts, plus `requiredFailed`, or null) and `prReadyToMerge` with
`prNotReadyReason` when false (`coordinator-pr-status.ts`). Readiness is
`evaluatePrMergeReadiness` (`packages/protocol/src/pr-merge-readiness.ts`),
the rule behind the sidebar's shimmer, with the PR monitor's confirmation as
its freshness: this node's announced monitor state
(`get_environment_pr_health`, which never asks GitHub), or for another
node's rows the health its summaries relay while that node is connected and
current. Other nodes' rows carry `prState` and these fields but never a URL,
since summaries do not. They are states and counts only, never check names
or logs. Operator reads are unchanged.

`requiredFailed` is GitHub's `isRequired`, which the PR monitor asks only
when its rollup shows a failing check, cached per PR head and failing set
(`pr-required-checks.ts`). A PR whose only failing checks are not required
stays quiet: no `pr-checks-failed` wake, and still not ready to merge. When
GitHub does not answer, or an older node does not relay the count, it is
null and every failing check counts; that notice says the check may not be
required.

## Worker delegation

Delegation is a round trip. `launch_environment` goes out over MCP, and the
worker's result comes back as agent mail — so a platform needs both an MCP
client and a native mailbox that can pull, ack, and be injected into.
`delegation` on the qualification is derived from those two halves, not
declared per platform.

**Delegation is available on every native platform** that has an MCP client
and `{canPull,canSend,canInject}=true`: Claude, Codex, OpenCode, Pi, Cursor,
and Grok. Cursor and Grok receive a per-tab `agentMcp` on create/prompt;
the process-env token is only the fallback. Grok still needs the host
safety setting to admit `advisory`.

Worker creation records an explicit base branch and commit. Uncommitted root
changes are not copied, stashed, or committed into a worker, unless the user
approves a `request_root_changes` request (see
[Worker surfaces](#worker-surfaces)). A container worker
can start only from a commit published to a remote branch; unpublished commits
remain available to local workers.

A worker never raises a pull request; a **PR tab** does, after review. In a
prompt environment the flow is build → review or Multi Review → fix → PR →
resolve conflicts:

- A Multi Review with auto-fix and auto-PR opens the PR tab itself (see
  [Status wakes](#status-wakes)).
- Otherwise the coordinator calls `create_pr` (see
  [Worker surfaces](#worker-surfaces)) once it has been told the review and
  its fix finished. Pass `nodeId` for a worker on a connected node; that node
  validates its project and worker and uses its own PR base branch and agent
  defaults. Retries reuse the same PR job on that node.
- A build pipeline, feature builds included, has its own PR step;
  `create_pr` refuses its own worker while the pipeline can still raise the PR.
  Forks and workers left by a removed, failed, cancelled or completed pipeline
  can use `create_pr`.
- Once raised, the coordinator follows the PR: it is woken when it opens,
  conflicts with its base, fails a check, becomes ready to merge, merges or
  closes (see [Status wakes](#status-wakes)). On a conflict it calls
  `resolve_conflicts`, which opens the worker's Resolve tab (the Resolve
  Conflicts button) and wakes it once that tab finishes, with the refreshed
  state. It never merges; the user does.

The main coordinator's context carries this, the PR wakes and
`resolve_conflicts` included, as `COORDINATOR_PR_RULE`
(`packages/protocol/src/coordinator.ts`), also in the Control MCP
instructions, and `launch_environment`, `launch_job` and `send_prompt_to_tab`
repeat it in their descriptions. Every delegation frame tells the worker the
same (`COORDINATOR_WORKER_NO_PR_INSTRUCTION` in
`packages/protocol/src/review-evidence-frames.ts`): commit and report, and do
not open a pull request even if the prompt asks for one.

A coordinator turn ends when it has delegated. It does not wait for the worker,
so the composer stays open. A prompt typed during a turn is queued and runs
before any worker mail. While the turn is running the send button reads **Send
after this turn**.

Each launch, job, or message to a worker opens one **delegation** on the
workflow association (`requestedAt`, `workerTabId`, `state`, `wakeKind`,
`wokenAt`). Each delegation wakes the conversation exactly once, when that
worker's turn ends (`working → idle`). Environment error, stop, or deletion
closes it as `failed` or `stopped` on the periodic sweep. A worker blocked on
an approval or a question has not finished — that needs a person — so
`working → waiting` does not close the delegation. Once the wait has lasted
20 seconds the coordinator does get one status notice saying so (see
[Status wakes](#status-wakes)), so it can tell the user; it still cannot
answer on the worker's behalf. For a question it may propose an answer with
`answer_worker_question`, which the user confirms, edits or declines in
Orkestrator (see [Worker surfaces](#worker-surfaces)); approvals stay with the
person in the worker's tab.

Nothing the worker does mid-turn wakes the coordinator. Progress mail is stored
and readable, held with reason `delegation-running`, and released together with
the final report. The mail drain claims every ready message for one mailbox,
renders them into a single carrier in send order (bounded at 10 messages and
128 KiB), and settles them together. A worker that finishes without reporting
still wakes its coordinator, with a system notice saying so.

In the coordinator's transcript every delivered message — a worker's report,
a peer's mail or a workflow notice — is a collapsed mail tile rather than the
full text, so a long report no longer takes over the view. The tile's icon and
tone come from the carrier's structured `kind` and `notice`, never from the
prose, and a batched wake shows one tile per message (see
[`agent-messaging.md`](agent-messaging.md#how-a-message-moves), "Carrier").

A follow-up message to a worker that is still on an earlier request joins that
delegation instead of opening a second one: the open delegation does not close
while the follow-up is undelivered, so the worker reads it in its next turn and
the coordinator is woken once, after both. (`send_prompt_to_tab` and
`launch_job` still refuse a second live request to the same tab.)

"Finished" is read from the turn, not the process: a worker whose turn ended
while background tasks still run counts as idle on the sweep, so a missed
turn-end edge cannot hold its report until those tasks finish. A worker that
ended its turn **without** a report while that background work (a shell,
sub-agents) still runs is paused, not finished: its delegation stays open until
the work reports and a later turn ends, for at most two minutes per pause,
after which the notice says background work may still resume the worker. The
short bound limits notice latency for servers and watchers, which share the
same raw activity signal as awaited tasks. Observing the worker working again
resets the pause budget. The timeout reason and duration are stored with the
delegation's close, so failed wake writes and backend restarts preserve that
qualification. Remote workers use the same bounded hold when their node
reports `backgroundWorkPending` through `get_worker_request_state`; older
nodes retain their previous turn-only settlement behavior. A report is always
released immediately, even if background work continues. So is a turn end
while a command in the worker's environment is waiting on the user (a sign-in
link, a code, a password; see [user-commands.md](user-commands.md)): that turn
ended to hand something to a person, and the coordinator is woken at once. A
command an agent runs in a worker that starts waiting on the user also sends
the main conversation one workflow notice with the link and code, whether or
not the worker's turn has ended, and the panel shows it until it clears.

A worker started by `launch_environment`, or forked with a prompt by
`fork_worker`, receives its request as the startup tab's initial prompt. That prompt counts as an undelivered request until the
provider accepts it (`pendingAgentLaunch` is cleared), exactly like
uninjected mail, so the startup session reading idle during setup, before the
delegated turn starts, cannot settle the delegation. A report held
for a delegation that closed and was woken without it (a race with the
"finished without a report" notice) is released on the next sweep.

Mail for a stopped worker waits in its inbox. A stopped **local** worker is
started (at most once every five minutes) and the mail is delivered once it
runs; a stopped **container** is never started behind the user's back — the
coordinator gets one notice per worker per hour asking it to call
`start_environment` or ask the user. The coordinator's `send_message` result
carries a `deliveryNote` saying which. Peer mail never starts an environment.

When a new main starts after the old one was closed, unhandled mail from the
old main's inbox moves to it — a report still owed to a delegation stays held
for that delegation, anything else is delivered.

Coordinator sessions participate in the same activity reconciler as environment
sessions, so `idle` is an observed edge. That edge drains mail and the prompt
queue immediately. User prompts queued during a turn still run first.

A launched worker wakes only the main coordinator: mail it sends to a sibling
worker or an ordinary environment is stored without a wake (route `isolated`,
see [`agent-messaging.md`](agent-messaging.md#routes)), and mail to a side
agent is refused. Mail between the main and its workers wakes whatever the
default inject policy is. Workers are told to report with `send_message` to
`"coordinator"`; the coordinator may message a worker by environment id alone,
which resolves to the tab it is waiting on or the environment's agent tab.

### Course corrections with deliverNow

Mail to a busy worker normally waits for its turn to end. A coordinator that
must correct a worker mid-turn ("add this to your task", "stop, the
requirement changed") sets `deliverNow: true` on `send_message` (also when it
replies with `replyToMessageId`; the coordinator has no separate
`reply_message`). The tool description says to keep it for course
corrections, not routine follow-ups.

`send_coordinator_agent_mail` passes `steer` to `sendAgentMail`, which marks
the message's pending entry `steerRequested`: the same flag as the mail UI's
**Deliver now**, so the steer itself, its single attempt and the journal
verification of an unanswered steer are that path
([`agent-messaging.md`](agent-messaging.md), "Deliver now into a running
turn"). The flag is set only when the message is placed `pending-inject`, so
mutes, inject policy, the unattended budget, the hourly limit and
`mayInjectMessage` decide delivery exactly as before; `deliverNow` only lets
an admitted message skip the wait for idle. The command then waits for one
drain pass (outside the worker admission lock, as `retry_agent_mail_inject`
does) and returns `deliverNow` with a `deliverNowNote`
(`coordinator-deliver-now.ts`):

| `deliverNow` | Meaning |
| --- | --- |
| `steered` | Landed in the worker's running turn (`injectedVia: "steer"` on the message). |
| `delivered` | The worker was idle, so it went out as a new turn. |
| `queued until idle` | The steer did not happen (refused, too large, busy gate); it is delivered when the turn ends. |
| `unsupported, queued` | The agent cannot take mail mid-turn (a tmux agent, which also gets the `steer-unsupported` hold note, or a provider without `steer`); delivered when the turn ends. |
| `verifying` | The steer was handed off without an answer. It is checked against the steer journal and never offered twice. |
| `not queued` | The message was bounced, stored, held by a budget, or blocked by paused messaging or an unavailable environment; the note names the reason. |

The result includes the post-drain placement, reason and injection provenance.
Replaying a completed request ID returns its persisted success without another
drain or delivery. An unused steer request expires after this one pass, including
when messaging is paused or the environment is stopped or unready; later turns
can receive the mail at idle but are never steered by that expired request.

A steered message counts as delivered, so the delegation it opened or joined
settles when the running turn ends and the coordinator is woken once, as for
any delegation.

Decisions:

- **Coordinator-only.** Worker `send_message` and `reply_message` have no
  `deliverNow`, and `sendAgentMail` ignores `steer` for any sender that is not
  a coordinator (on this node, or a command node's coordinator whose mail the
  node link delivered): a worker steering its coordinator would bypass the
  delegation hold.
- **Never into a coordinator conversation.** Main ↔ side mail ignores the
  flag. Scheduled mail reports `queued until idle`; bounced, stored or
  budget-held mail reports `not queued`, so a side agent cannot cut into the
  main's turn with the user.
- **Across a node link, through a leaf that advertises it.** For mail to a
  worker on another node (`send_message` with `nodeId`, or a reply to mail
  from one), `send_coordinator_node_mail` adds `steer: true` to
  `deliver_node_mail` only when that leaf's hello advertises
  `node-mail-steer`. The leaf marks the pending entry as a local coordinator's
  would be, runs the same single delivery pass (`settleCoordinatorDeliverNow`),
  and answers with its own `deliverNow`, `deliverNowNote`, post-drain
  placement and `injectedVia`; its mutes, budgets and steer eligibility
  decide. Mail already injected by that pass still opens or joins the
  delegation. An older leaf would refuse the unknown field and the whole
  message, so it is sent nothing new and the result is worked out here:
  `unsupported, queued` for scheduled pending mail, `not queued` with the
  leaf's placement and reason otherwise. A lost answer is the ordinary
  outcome-unknown error with no `deliverNow` claim; retrying the same
  `requestId` replays on the leaf. `send_node_message` has no `deliverNow`.
  Live qualification is in
  [0740](../todo/coordinator-and-multi-review/0740-coordinator-deliver-now-live-qualification.md).

`list_agents` (discovery) returns every agent tab in the project and what each
is doing — see [`agent-registry.md`](agent-registry.md).

Pause or mute messaging, or set a mailbox's injection policy to **Off**, to
hold automatic delivery. Stored, injected, acknowledged, and completed remain
distinct states. An injection receipt is not proof that the task finished.

### Stopping a worker's turn

`stop_worker_turn` ends a runaway or wrong-direction turn in one worker tab
(see [Worker surfaces](#worker-surfaces)); `deliverNow` is for correcting a
turn that should go on. When the coordinator is waiting on that tab, the stop
records `stopRequestedAt` on each open delegation for it before the provider
is asked, then the turn end settles the delegation as any other: the
coordinator is woken once, with the worker's held report if it sent one, or
with a notice that says it stopped the turn itself ("… stopped because you
stopped its turn with stop_worker_turn, before it sent a report") and the
worker's last message. On this node a stop the agent confirms settles the
delegation at once rather than on the next edge or sweep, so the tab takes a
`send_prompt_to_tab` straight away, in that turn or the next; an unconfirmed
one settles on the turn end. For a worker on another node, after any stop
that reached a running turn (confirmed or not), the command node asks that
node for the worker's state at once, and the usual remote rules (seen
working, or the idle grace period) decide when it settles. The notice keeps
the stop note however the delegation closes: a turn end, or an environment
that failed or stopped meanwhile ("… failed after you stopped its turn with
stop_worker_turn"). The background-work hold above is skipped for a
stopped turn. A stop that finds the tab idle marks nothing. A follow-up the
worker has not read yet still keeps the delegation open, as it does for any
turn end, so the worker's next turn answers it.

Decisions:

- **Settle on the turn end, and say who stopped it (chosen).** Options:
  (a) settle as usual with a stop-aware notice; (b) close the delegation as
  `stopped` at once with no wake, since the coordinator knows what it did;
  (c) leave the delegation untouched, so the notice says the worker finished
  without a report. (a) keeps the one-wake-per-request contract and releases
  whatever the worker had sent, which (b) would leave held or drop; (c) tells
  the coordinator something false. Con of (a): a report the worker sent
  before the stop is released as the wake without the stop note; the
  coordinator called the tool, so it knows.
- **Mark before the stop, unmark if nothing stopped.** Marking after the stop
  could lose the race with the turn-end edge and its wake. A stop that fails,
  or that a node answers with "idle", removes the mark; a lost node answer
  keeps it, because the stop may have landed.

## Scheduled wakes and actions

A coordinator turn cannot wait, so a coordinator that needs to act later
(after a usage window resets, before a deadline) schedules it:
`create_schedule` with `at: "03:12"` and `action: {type: "send_message",
toEnvironmentId: "coordinator", body}` arrives at 03:12 as a reminder that
starts a turn, even if the conversation's provider was swapped meanwhile.
Schedules can also send a worker mail, prompt a worker tab, launch a worker
(resolving the base branch's newest commit when it fires) or call another of
the coordinator's own tools, with `nodeId` where the tool takes one. Each
fire runs the coordinator's own tool under its current scope, so read-only
rules and project boundaries apply unchanged. Main schedules follow the next
main conversation; a side agent's schedules end with it.
`list_schedules`, `cancel_schedule`, `pause_schedule`, `resume_schedule` and
`update_schedule` manage them: each conversation sees only its own (the main
also its side agents'), and `update_schedule` checks a new action exactly as
`create_schedule` does, so a side agent cannot reschedule into a tool it
cannot call. See [scheduled-jobs.md](scheduled-jobs.md).

### Self-timers and provider accounts

`create_schedule` with action type `remind_me` is a **self-timer**: its body
comes back to the conversation that set it (the main coordinator's address,
or the side agent's own runtime id) as a reminder that starts a new turn, and
one that fires mid-turn waits, like mail, until the turn ends. `at: "+2h"`
and `at: "14:30"` are both accepted; absolute times are read in this
machine's local zone (the user's) unless `timeZone` is given, and the result
names the zone (`timeZoneUsed`) and the local time (`nextFireLocal`).

For "check in 2 hours and switch accounts if the workers hit a usage limit"
the main coordinator has three tools (capability `accounts`, plus
`get_usage_limits` under `environments`; side agents get none):

- `get_usage_limits` lists the agent tabs whose newest recorded turn failed
  with a provider usage limit, and the active accounts' cached quota windows.
  It reads storage and caches only.
- `list_provider_accounts` lists the Claude and Codex logins on this machine
  or another (`nodeId`), the active one per provider, and each one's plan
  usage with `hasAllocationLeft`.
- `switch_provider_account` changes the active login through
  `set_active_agent_account`, the Settings switch, machine-wide. Without
  permission it creates a `switch-agent-account` request the user approves
  in the same dialog as `request_environment_deletion`. With the `scheduleId`
  of a self-timer that carries the user's permission it switches at once.

A self-timer carries that permission only when the main coordinator sets it
with `authorizeAccountSwitch` in a turn the user started with their own
message: the backend records each conversation's `lastTurnOrigin` (`user` or
`mail`) at dispatch, and mail, status wakes and fired timers count as `mail`.
The permission names the providers and any other machines, holds the user's
words, and lasts two hours after the timer fires.
[agent-accounts.md](agent-accounts.md#coordinator-switching) and
[scheduled-jobs.md](scheduled-jobs.md#self-timers) have the details.

## Status wakes

Besides the delegation wake, a coordinator is woken when other work it started
or prompted **settles**, so it can keep track and respond without polling
(`apps/backend/src/core/coordinator-status-wakes.ts`).

**Ownership.** Only resources with a coordinator workflow association: the
durable record written at launch or prompt time with the coordinator and
conversation ids (`launch_multi_review`, `start_multi_review`,
`start_build_pipeline`, `launch_graph` (a `graph-run` association),
`create_pr` and `resolve_conflicts` (a `pull-request` association), and the
delegations `launch_environment`,
`launch_job`, `send_prompt_to_tab` and `send_message` open). A Multi Review or
build the user started in the UI, or a pull request the user raised, has no
association and never wakes a coordinator. Notices go to the main coordinator, like every other report, and
do not start one: with no main open they wait, and the sweep sends the state
current when one opens.

**What wakes it.** Each resource is reduced to one settled status with a
stable key; a key is sent once, recorded on the association
(`statusNotice`).

| Resource | Status | Setting that sends it |
| --- | --- | --- |
| Multi Review | consolidation `ready` (finding counts by severity, coverage gaps, verdict) | `settled` |
| Multi Review | interactive fix turn finished (`fix-done`, with the reason when auto-PR started no PR) or failed (`fix-failed`) | `settled` |
| Multi Review | auto-PR: PR session started (`pr-started`), its pull request open (`pr-opened`, with the URL) or already `pr-closed`, `pr-merged` or `pr-unknown`, or the launch failed (`pr-failed`) | `settled` |
| Multi Review | a reviewer, consolidation or fix session `stalled` | `settled` |
| Multi Review | `completed` (fix summary, files changed), `failed` (error), `cancelled` | always |
| Multi Review | all reviewers finished and consolidation started (`reviews-finished`) | `stages` |
| Build pipeline | `paused` by the supervisor on an error (a requested pause is not news) | `settled` |
| Build pipeline | a stage `stalled` (`stallWarning`) | `settled` |
| Build pipeline | `completed` (task, last verification), `failed` (error) | always |
| Build pipeline | a stage completed (`stage-completed`: build, review, address, verification) | `stages` |
| Graph run | waiting for a person (`waiting`): an open human-node wait or an agent's `ask_human` question (`graphRunPendingInteractions`), keyed by the newest open wait, describing up to six waits by node and form, never the question's text | `settled` |
| Graph run | ended: `completed` (agent sessions and tokens), `failed` (the run's error), `cancelled`, keyed `complete`, `failed` or `cancelled` | always |
| Pull request | opened (`pr-opened`, with the URL), conflicts with its base (`pr-conflicts`), a required check failed (`pr-checks-failed`; any failing check when GitHub does not say which are required), ready to merge (`pr-ready`), merged (`pr-merged`) or closed (`pr-closed`); keyed per state and PR URL | `settled` |
| Pull request | its Resolve tab finished (`resolve-finished`), with the PR's state after the PR monitor's recheck | `settled` |
| Delegated tab | `waiting` for 20 s: on an approval, a question, or both when its pending interactions say which (otherwise "input or an approval"), with its last message; for a question, a line that the coordinator may propose an answer with `answer_worker_question` for the user to confirm | `settled` |
| Delegated tab | turn ended: the worker's report, or `completed`/`failed`/`stopped` with its last message | always (the delegation wake) |

A graph run is reduced to two statuses only (`graphRunCoordinatorStatus` in
`graph-run-coordinator-status.ts`): it ended, or it waits for a person.
Anything else, nodes finishing included, is progress. A wait's key is
`waiting:<openedAt>:<id>` of the newest open wait, and a wait is sent only when
it opened after the one last reported (`graphRunWaitNoticeIsNew`). So one wait
staying open while another is answered, a backend restart or a second observer
sends nothing again, and every new wait (a later node, a restarted one) sends
one. Graph waits have no 20-second debounce: the 2-second save debounce is the
only delay. `launch_graph` takes no `nodeId`, and the observer skips a
`graph-run` association that has one.

Individual reviewers finishing never wakes anyone: that is progress, and a
seven-reviewer panel would otherwise be seven turns. A relaunched fix, a second
consolidation, or a new stall or waiting episode has a new key and is sent
again. Nothing is sent for elapsed time alone (no "still running after N
hours"): every wake is an observed state change, the toolbar chip already
shows the wait, and the 20-second waiting debounce only suppresses waits too
short to matter.

A review with auto-fix and auto-PR advances on its own, so a state it is about
to leave is not reported. Consolidation with findings goes straight to the Fix
handoff and never reaches `ready`. A finished Fix that queued its PR is held
until the PR launch settles, and the coordinator hears `pr-started` instead of
a `fix-done` it would be expected to act on. `pr-opened` follows once the
environment records `prUrl` with `prState: open`; the PR monitor sets them, and
the next workflow save or the 60-second sweep reports it. A retained URL whose
state is closed, merged or unknown is reported as that state, never as open.
Each PR launch records the identity of the Fix attempt that authorized it
(`autoPrLaunch.fixIdentity`, a hash of the Fix session key and start time). A
later Fix, for example after a reviewer restart, is reported as `fix-done`,
noting that the earlier PR does not confirm it includes the new changes. A
launched record without an identity, from before this change, is treated the
same way. A failed or stopped Fix reports `fix-failed`
or `fix-done` with "No PR session started"; the review stops there. A
consolidation with nothing to fix and auto-PR on queues the PR straight away
(`autoPrLaunch.basis: clean-review`), is held the same way, and reports
`pr-started`, `pr-opened` or `pr-failed` headed "found nothing to fix"; a
skipped launch, such as one for an environment that already has a pull
request, reports `ready` with the reason. Without auto-PR it reports `ready`
with a line saying no Fix or PR started. A Fix started later is not covered by
the clean report's PR. A legacy structured Fix holds `completed` until its PR launch settles,
then lists the PR outcome in its details.

**Pull requests.** A `pull-request` association (`resourceId` the worker,
`pullRequest` the follow) is the coordinator's claim on one worker's PR,
reduced by `pullRequestStatus` in `coordinator-pr-status.ts`. It is written by
`create_pr` when the PR tab launched (a skipped one raised nothing), by
`resolve_conflicts` (pinned to the PR it resolves), and by the review
observer once a coordinator-launched review with auto-PR has reported
`pr-opened` (seeded as already told, so it is not repeated) or `pr-unknown`,
or completed with its PR session started. From then on the review records
its own PR states silently and the follow reports them. One live follow per
coordinator, worker and node: `create_pr`, a later `resolve_conflicts` and a
review's handoff share it. A request that joins a live follow is kept as a
request alias (`requestAliases`), so the review still finds its handoff and
stays silent, and its `pr-opened` seeds the shared follow unless that follow
already reported the PR. The follow pins the first PR URL it sees; another URL on the
worker, the worker disappearing, a merge or a close ends it
(`terminalNotifiedAt`), so a reopened PR is not reported. Merge and Cleanup
writes `merged` and deletes the worker straight away, before any
observation can run, so deleting a worker first keeps its last PR reading
on its follows (`pullRequest.final`, `captureFinalPullRequest` in
`deleteEnvironment`): a follow whose worker is gone still reports a merge
or close it had not reported, once, then ends. The owning node also retains the
last 1,000 terminal PR readings in `environment-final-pr.json` before deleting
a worker. Remote follows read those tombstones through `get_environment` with
`includeFinalPrState`, recovering a merge even after missed events or restart.
A `create_pr` follow stores the publication tab identity and reports
`pr-not-created` once if its turn ends without a URL, with a transcript link
and instructions to retry. Pending dispatches and unavailable node reads
keep publication and Resolve attempts pending beyond their start grace.
Owning-node action receipts replay completed launches and slash commands
before mutable PR or busy-session checks. `list_workflows` shows a
follow with what started it, its PR URL, whether it is still followed, the
last state reported and a Resolve tab's progress, and the worker with its PR
fields.

Every key ends with a hash of the PR URL. `pr-opened` is sent once per PR;
a first reading that already conflicts, fails or is ready sends that instead,
with the URL. An open PR with nothing to act on (checks running, review
required, behind) is recorded without a wake, so the next conflict or
failure after a fix is news again, while a reading that cannot tell (GitHub
recomputing mergeability, the monitor not confirming it) changes nothing.
Because the same state recurs with the same key, each recorded state counts
an episode (`pullRequest.notices`), and a notice's mail request id includes
the episode it opens: conflicts, then a fix, then conflicts again is two
messages, while a retry of one episode (a restart, a second observer, a
crash before the bookkeeping landed) reuses its request id and replays.
Conflicts are the monitor's `hasMergeConflicts` or `dirty` mergeability.
"Failed" is the check rollup reporting a failed check: it counts every
check, so required ones are not told apart. "Ready to merge" is the
sidebar's rule (`pr-merge-readiness.ts`) with the monitor's confirmation, so
it needs this node's monitor (or a connected node's current summaries) to
vouch for the reading.

A Resolve tab is followed through its turn: seen working, then idle or gone
(or so a minute after launch, for a turn too short to see), then held until
the PR monitor's recheck lands (the Resolve completion action is disarmed,
or this node's monitor answered after the turn ended) or one more minute
passes, then reported once as `resolve-finished` with the state it left the
PR in. While it runs, the PR's own changes are not sent, and the report's
state is recorded so it is not sent again. Workers on a connected node are
followed the same way, through that node's `get_environment`, its relayed
summaries and its relayed `environment` and `environment-pr-health` changes;
an unreachable node is no news.

**Setting.** **Settings → Messaging → Coordinator status updates**
(`coordinatorStatusWakes`): *Finished work only* (`off`, what woke a
coordinator before status wakes), *Decisions and problems* (`settled`, the
default) and *Every build stage too* (`stages`). It applies to coordinator-
created resources only; there is no per-resource opt-in.

**Message.** An ordinary workflow notice (`from.kind: "system"`) with a
structured `notice` (resource kind and ids, state, tone), a subject such as
"Multi Review api-fix is ready to address", a bounded Markdown body (at most
eight 400-character detail lines) and the calls that read more or act —
`get_multi_review`, `address_multi_review`, `open_multi_review_fix`,
`get_build_pipeline`, `resume_build_pipeline`, `get_graph_run`,
`get_tab_state`, `get_tab_transcript`, `get_environment`,
`resolve_conflicts` — written out with their arguments. In the transcript it
is a mail tile toned by the notice.

**No wake storms.**

- Dedupe: one notice per status key, recorded durably; the mail request id is
  fixed by association, conversation and key (for a followed pull request,
  key and episode), so a crash between placing a notice and recording it
  cannot send it twice.
- Coalescing: a status notice is held 10 seconds (`coalesceMs`); notices
  arriving while the window is open join it, so reviews settling together are
  one wake, and the drain batches them into one carrier (at most 10 messages,
  128 KiB). A coordinator mid-turn gets everything that settled meanwhile in
  its next wake. A held notice never starts a turn itself, but when the drain
  dispatches other mail to the same coordinator (a worker's report, say) the
  held notices ride along in that batch (`includeCoalescing`,
  `joinCoalescing`) rather than wake it again when their hold ends.
- Debounce: workflow saves are observed at most every 2 seconds per resource;
  a waiting episode must last 20 seconds before it is reported, so an approval
  answered at once wakes nobody.
- Budget: each resource's notices are budgeted as one routed pair with the
  coordinator (`statusBudgetKey`), so the unattended budget and the hourly
  limit hold them exactly as they hold a chatty worker. The user prompting the
  coordinator, or **Resume**, starts a new budget.
- Upgrade: a workflow first seen in a non-terminal settled state it reached
  more than a day ago is recorded without a wake.

**Delivery.** The durable mailbox and the existing drain: presence-gated
injection, ack/read semantics, retry and restart recovery are the mail
store's. Workflow saves, and environment and PR-health changes of a followed
worker, wake an observation within seconds; the
`coordinator-repair` maintenance job (every 60 s, and at startup) re-reads
every owned workflow, followed pull request and open delegation, which
recovers a missed save, a timer lost to a restart, or bookkeeping that never
landed.
`launch_multi_review`, `address_multi_review`, `start_multi_review`,
`start_build_pipeline` and `launch_graph` return `delivery: "async"` with
`COORDINATOR_WORKFLOW_STATUS_WAKE`, so the model is told it will be woken
rather than left to poll `get_multi_review`; `create_pr` (when it launched)
and `resolve_conflicts` return `COORDINATOR_PR_STATUS_WAKE`.

## Launch defaults

Coordinator-launched work runs the user's saved defaults unless the user asks
for something else. Coordinators used to copy a model and effort from
`get_launch_options` into every call, so each worker silently ran a more
expensive selection than the configured default. The rule is now stated in
three places that agree:

- `COORDINATOR_LAUNCH_DEFAULTS_RULE` (`packages/protocol/src/coordinator.ts`)
  is a single line in the coordinator context prompt and the Control MCP server
  instructions.
- The descriptions of `launch_environment`, `launch_job`, `launch_multi_review`,
  `start_multi_review` and `start_build_pipeline`, and of each model, effort and
  agent field, say that omitting the field uses the saved default.
- `get_launch_options` returns `defaults` (`agent`, per-agent
  `byAgent[agent] = { modelId, reasoningId }`, `guidance`) and marks each
  agent's default catalogue row with `isDefault: true`.

What an omitted choice resolves to:

| Tool | Omitted | Resolves to |
| --- | --- | --- |
| `launch_environment`, `launch_job` | `modelId`, `reasoningId`, `fastMode` | The platform column across environment → repository → app settings, else the agent's own default (`defaultReasoningId` for effort) |
| `launch_multi_review`, `start_multi_review` | `reviewers`, `reviewModel`, `fixModel` | The Multi Review button's rows: Review, Review 2, saved extra reviewers and reviewer count, each reviewer with its position's saved focus (`multiReview.reviewerLenses`); Review preparation and Fix review issues, each falling back to Review |
| `launch_multi_review`, `start_multi_review` | `autoFix`, `autoPr` | The saved app-level Auto-fix and Auto-PR, which the button reads; a requested `autoPr: true` turns an omitted `autoFix` on |
| `start_build_pipeline` | `agentType`, `steps`, `reviewers`, `reviewPreparation` | `buildPipelineConfiguredDefaults` (`packages/protocol/src/build-pipeline-defaults.ts`), the resolver the Build button uses |

Every one of these can be overridden. A coordinator is told to override only
when the user has asked for a specific model, agent, effort or reviewer set.
Overrides layer the way the launchers do. For `start_build_pipeline`:

- A named step replaces only that step, and a step that names only an agent runs
  that agent's saved model.
- A step, or `reviewPreparation`, may carry `instructions` (at most 16 KiB of
  UTF-8; [per-stage instructions](build-pipeline-view.md#per-stage-instructions)).
  One that names only `instructions`, without an agent, keeps its saved
  selection: the pipeline agent for `build`, the saved row for the others, and
  the saved preparation model (Address's when the saved review has one
  reviewer) for `reviewPreparation`. Reviewer rows always name their agent and
  may carry their own `instructions` and a `lens`.
- `steps.build.agent` decides the pipeline agent.
- Explicit `reviewers` replace the saved rows; otherwise an explicit
  `steps.review` becomes Reviewer 1.
- `maxIterations` is optional, from 1 to `MAX_BUILD_PIPELINE_ITERATIONS` (10),
  the limit the protocol accepts; the tool schema refuses a larger value
  before anything starts. Omitted, the pipeline's default applies.

Each Multi Review row field is replaced independently.

A reviewer row, in `launch_multi_review`, `start_multi_review` or
`start_build_pipeline`'s `reviewers`, may carry `lens: { label, instruction }`:
the reviewer's focus, a label of at most 64 characters and an instruction of at
most 4 KiB ([reviewer lenses](review-preparation.md#reviewer-lenses)). The
tools refuse a longer or blank one, and `reviewModel`, `fixModel` and
`reviewPreparation` take none. Explicit rows replace the saved rows and their
saved focus. The coordinator is told to set a lens only when the user asks for
a focus.

Multi Review rows resolve in `apps/backend/src/core/coordinator-launch-defaults.ts`
over the worker's model catalogue, mirroring the launch dialog: an unset or
stale saved model falls back to the connected model a tab with no model would
start on (the catalogue row marked `sessionDefault`, which the Pi bridge sets
on Pi's saved default), else to the first connected catalogue model, and an
effort or speed is kept only when the chosen model offers it. A Pi catalogue
that marks no connected row (a cache written before the mark existed, or a
login with no saved default) leaves the row `default`, so the session picks. When a platform has no catalogue,
the saved model id is kept. The request hash covers the caller's payload, not
the resolved rows, so retrying with the same `requestId` after the user edits
their defaults replays the original work.

Every launch reports what will run. `launch_environment` and `launch_job` return
`selection: { agent, model, reasoning, source }`, where `source` is `requested`
if the call set `modelId` or `reasoningId` and `default` otherwise. `model` is
null when no tier pins one and the agent picks its own. The Multi Review result
reports its rows the same way, plus `autoFix` and `autoPr` with a source of
`default`, `requested` or `implied` (auto-fix turned on by a requested auto-PR).
`start_multi_review` reports the same `selection`. `start_build_pipeline` reports the pipeline's
`agentType`, `steps`, `reviewers` and `reviewPreparation`, with a per-step and
per-field `source`; a step's stored instructions are reported as
`instructionsBytes`, not echoed. A reviewer's lens is reported in every
`selection` as `{ label, instructionBytes }`. The environment and tab UI do not show a marker
for overrides yet; that is a tracked follow-up.

## Complete application actions

Use `launch_multi_review` for an environment's **Multi Review** button. Pass a
stable `requestId` and the environment ID. Omitted `reviewers`, `reviewModel`
and `fixModel` use the saved Multi Review defaults exactly as the button does
(see [Launch defaults](#launch-defaults)); explicit rows (`agent`, `model`,
optional `reasoningEffort`) replace them one field at a time. Omitted
`targetBranch` and `reviewInstruction` use the repository's PR base branch
(falling back to `main`) and the global review instruction. An empty
instruction explicitly clears the instruction for this launch. The result's
`selection` lists the rows and auto-actions the saved review runs and, per
field, whether they were `requested`, `default` or `implied`. A reused active
review keeps its own rows and auto-actions.

Optional `autoFix` and `autoPr` match the launch dialog's **Auto-fix after
consolidation** and **Auto-PR after fix or clean review** checkboxes, which open on the saved
app-level settings. Omitted, they use those settings. With both on, the review
runs end to end through the button's own code path in `MultiReviewService`:

1. Consolidation with findings saves the report and the default Fix handoff in
   one save (`queueDefaultFix`). The supervisor delivers it like
   `address_multi_review`.
2. When the interactive Fix turn finishes on its own as the conversation's last
   turn, the same save that settles it records `autoPrLaunch: pending`
   (`queueAutoPr`).
3. The supervisor launches the ordinary `PR` tab: the Create PR prompt and the
   `pr` action default, under the stable request id `multi-review-pr:<id>`.

Consolidation with nothing to fix skips the Fix: with `autoPr` on, the save
that settles it at `ready` records `autoPrLaunch: { basis: "clean-review",
state: "pending" }` (`queueCleanReviewAutoPr`) and step 3 follows, whatever
`autoFix` says.

The PR intent is only ever recorded with proof that a Fix completed or that
there was nothing to fix, so the PR cannot come before a Fix. A failed, stopped, superseded or unconfirmed Fix records
`skipped` with a reason or nothing at all, and no PR starts. A custom Fix never
starts a PR. A Fix handoff that cannot be delivered fails the review after its
bounded retries. The PR launch retries three times before `failed`. Each step
is durable, so a restart resumes at the step it reached. Nothing in this flow
merges.

`autoPr: true` with `autoFix` omitted also turns auto-fix on, because a
coordinator asking for an automatic PR wants the whole flow. An explicit
`autoFix: false` with `autoPr: true` keeps the button's meaning: the PR follows a
Fix started with `address_multi_review`. `get_multi_review` reports
`automation: { autoFix, autoPr, prLaunch?, next }`, where `next` says in one
sentence what runs next and whether the coordinator has to act.

This action has no build-pipeline prerequisite. It reopens an active review
regardless of the new selections, or reserves an immutable workflow ID and
starts one review. It then creates or focuses the root Multi Review tab in the
environment's selected pane. It does not change the global project/environment
navigation: an inactive environment receives the durable tab and selection,
which its renderer adopts when the user returns.

`open_multi_review` reopens/focuses that root without starting work.
`open_multi_review_fix` opens/focuses the authoritative Fix provider session
without sending a turn. `address_multi_review` now opens the root first and
records the backend's idempotent fix handoff; the supervisor publishes and
selects Fix after confirmed dispatch when the foreground action initiated that
attempt. A background retry or backend-restart resume publishes Fix without
changing the current tab or pane. A repeated address call returns the existing
interactive handoff. An unassociated workflow started from the renderer remains
available within its project. When an association exists, these controls require
it to belong to the current coordinator conversation; use `adopt_workflow` for
an orphaned or closed conversation's association before opening it.

Read the result before reporting success:

- `outcome: "opened"` and `ui.status: "opened"` confirm durable presentation;
  `ui` names the tab, pane, and layout revision. `reused` distinguishes reattach
  from a new launch. MCP returns a bounded workflow summary; backend commands
  return the workflow snapshot with controller fences removed.
- `outcome: "pending"` on address confirms a durable intent, not prompt delivery.
  Inspect `get_multi_review` for `addressPromptPending`, `presentationError`, and
  `fixTabId`. Do not send another fix prompt manually.
- `outcome: "partial"` is an MCP error result with the saved workflow and an
  actionable `recovery` message. A new launch whose tab cannot be published
  requests cancellation. Cancellation may still be in progress or unconfirmed;
  the result says which. An already active review is never cancelled because
  reattachment failed. Completed cancellation records are retained as retry and
  recovery evidence.

Retry launches with the same request ID and payload. The durable coordinator
receipt and reserved workflow identity survive backend restarts, including the
gap between workflow persistence and receipt completion. Reusing a key with a
different payload is rejected. If the associated workflow was explicitly
deleted, retry fails instead of silently starting fresh work. Change the key
only when deliberately asking for a new action.

Tab writes recompute their semantic intent against the latest layout after a
CAS conflict. They preserve concurrent pane structure, moves, and tabs, enforce
the tab limit on each attempt, and announce the existing `pane-layout` resource.
Workflow writes announce `multi-review`. Both initial restoration and live
authoritative reconciliation load referenced workflows before installing tabs.

### Exposed-action audit

| Existing control / button family | Durable consequences and disposition |
| --- | --- |
| `start_multi_review` / Multi Review | Backend-only and build-gated; retained for diagnostics/recovery. Its metadata explicitly prefers `launch_multi_review`, which adds root-tab publication, focus, readiness checks, reattachment, and truthful recovery. |
| Multi Review open / Open fix session | Added `open_multi_review` and `open_multi_review_fix`; operate entirely through backend snapshots and pane persistence. No additional provider turn. |
| `address_multi_review` / Address findings | Upgraded to the complete action above. Existing backend handoff already owns session adoption, turn idempotency, and eventual Fix publication; it now selects that tab when published and reports queued/partial outcomes. |
| `start_build_pipeline` / Build | Already complete: `BuildPipelineService` owns environment provisioning, workflow persistence, Kanban/feature ownership, root-tab creation and selection, with supervisor repair. Reuse it; no duplicate wrapper added. |
| `pause_build_pipeline`, `resume_build_pipeline`, `cancel_build_pipeline`, `cancel_multi_review` | Backend transitions already durable; these buttons have no required new pane or tab consequence. |
| `launch_environment` / New environment | Existing backend operation owns creation, startup tab/initial-prompt state, and background start. Its accepted/created/error distinction already reports partial startup. |
| `launch_job` / Agent action | Already creates a durable native tab, binds a provider session, and dispatches an idempotent initial turn. Now requests tab activation, matching the button. Later binding/retry writes preserve focus so slow launch completion cannot steal a user's newer selection. |
| `send_prompt_to_tab` | Existing durable intent dispatcher; targets an existing native tab and creates no additional tab. |
| `/goal` (composer) | Added `set_worker_goal`, `get_worker_goal`, `pause_worker_goal`, `clear_worker_goal`; see [Worker goals](#worker-goals). The goal service owns the loop and its limits, and the tools add ownership, a required limit, and one wake. |
| Start/stop environment, ticket edits, adoption, mail | Existing backend mutations; no renderer-only workflow launch step. Mail preserves separate stored/injected/acknowledged outcomes. |

Repository checkout mutation controls remain unavailable to coordinators.
The worker surfaces below were added with their own authority and
idempotency design.

### Worker surfaces

The main coordinator can also drive a worker's own surfaces, as the user
would in that worker's window. Every one targets a disposable worker
environment of the bound project: the backend command
(`coordinator-surface-actions.ts`) revalidates the credential's scope and
refuses the project home, the checkout the coordinator may only read. Side
agents have none of them (their capabilities are `discovery`, `mail` and
`schedules`), except `get_worker_changes`, which only reads and is
`discovery`: a side agent asked to review or discuss a worker's work can read
that work. It does not widen the checkout boundary; the checkout itself is
read directly, and `get_worker_changes` refuses the project home.

`launch_terminal`, `open_worker_browser`, `edit_worker_tab`, `create_pr`,
`resolve_conflicts`, `get_worker_changes`, `fork_worker`, `stop_worker_turn`,
`list_worker_commands`, `run_worker_command`, `custom_fix_multi_review` and
`open_multi_review` (with or without `reviewerId`) also take `nodeId` for a
worker on a connected node. The
receipt, any adoption of the review, and a PR follow stay on the command node; the node
that owns the worker checks its project and refuses its checkout, then runs
the work through a controller command (`launch_controller_terminal`,
`open_controller_browser`, `edit_controller_worker_tab`, `create_controller_pr`,
`resolve_controller_conflicts`, `get_controller_worker_changes`,
`fork_controller_environment`, or the `reviewer` and `custom-fix` surfaces of `controller_multi_review_surface`
in `commands-registry-controller-workflows.ts`; `stop_controller_worker_turn`,
`list_controller_worker_commands` and `run_controller_worker_command` in
`coordinator-worker-turn-actions.ts`). Those are node-link only,
never reachable with a workspace grant. Job, tab and navigation IDs on that
node derive from the command node's receipt key. So when the node link loses
an answer, the tool returns outcome-unknown and asks for a retry with the same
`requestId`, and the retry reattaches to what the first attempt made; nothing
is resent automatically. A remote custom fix that is already past its handoff
when the retry arrives is reported, with its Fix tab, rather than refused as
not ready. A node from before these commands answers "update that node".
`request_root_changes` stays on this node; see
[0395-coordinator-worker-surfaces-follow-ups.md](../todo/coordinator-and-multi-review/0395-coordinator-worker-surfaces-follow-ups.md).
`answer_worker_question` also takes `nodeId`; its request stays on the command
node and only the approved answer crosses the link
(`answer_controller_worker_question`).

| Tool | What it does | Retry with the same `requestId` | What the user sees and can undo |
| --- | --- | --- | --- |
| `launch_terminal` | A terminal tab in the worker running one command (`plain`), an agent CLI with an optional prompt (`claude`, `codex`, `grok`, `opencode`, `pi`), or Claude under tmux (`claude-tmux`), through `launch_terminal_job`. | Replays the receipt; the job and tab IDs derive from the request, so a retry after a crash reattaches to the same PTY. | The tab opens selected, like one the user opened; closing it ends the PTY. |
| `open_worker_browser` | A browser tab at a loopback `http(s)` address of a service the worker runs, or navigates an existing browser tab. The address is stored as an `agent-link` preview intent, so it resolves to the worker's own service, local or container. | Replays; the new tab's ID and the write's `navigationRequestId` derive from the request. | A browser tab; the address bar and back button work as usual. The open web is refused: the coordinator's research tools are the policy-gated way out. |
| `edit_worker_tab` | Focus, move (to a pane from `list_tabs`) or close one tab. | No receipt: each edit states the end state, so a retry is a no-op. Closing a tab that is gone succeeds. | Closing never deletes a conversation (`teardown_tab`'s retain-history close). It is refused while a native agent tab's turn is running or waiting on a person, and while a coordinator waits on that tab's report. A terminal tab closes with whatever its process is doing. |
| `stop_worker_turn` | The tab's **Stop** button: stops the running turn of one native agent tab, never the environment (that is `stop_environment`). Runs `session.stop`'s own stop (`stopSessionTurn` in `public-api/session-turn-stop.ts`), so the tab's active public run settles as cancelled. An idle tab answers `stopped: false`, not an error; terminal and tmux tabs are refused. | Replays the receipt, so a retry never stops a later turn. A lost answer from a node is outcome-unknown and says to check `get_tab_state` first: a retry with the same `requestId` stops whatever turn is running then. | The turn ends as if the user pressed Stop; the tab and its conversation stay. A delegation on that tab still wakes the coordinator once (below). |
| `list_worker_commands` | The tab's `/` menu: `session.commands` for one native tab, without commands that act on a running turn (`/steer`). `refresh` re-reads the agent's list. | A read. | Nothing. |
| `run_worker_command` | Picks one row of that menu: `session.command`'s resolution and every refusal it has (missing, ambiguous, unavailable, changed since listed, wrong arguments, busy tab, parked dispatch), dispatched as a selection, never as prompt text. `/steer` is refused. A command that starts a provider turn opens a delegation, as `send_prompt_to_tab` does, and is refused while one is open on that tab; one that answers without a turn (`bridge-local`, an Orkestrator session action such as `/compact`) opens none and says to read its output with `get_tab_transcript`. | Replays the receipt; the dispatch request ID derives from it, so a retry after a lost answer replays on the node that owns the worker. | The command runs in the tab as if the user picked it. |
| `open_multi_review` with `reviewerId` | Opens one reviewer's read-only transcript subtab (`multi-review:<id>:reviewer:<reviewer>`). | Focuses the same tab. | Same tab the reviewer node opens in the review. A reviewer without a session yet returns `partial` with the reason. |
| `custom_fix_multi_review` | The review tab's **Custom fix prompt**: a fix with the caller's instruction and, optionally, another model (`MultiReviewService.customFix`). | Replays the outcome and re-reads the workflow; while the handoff is pending the service itself also replays. | The Fix tab, as for `address_multi_review`; a custom fix never starts an automatic PR. Status wakes follow as for a default fix. |
| `create_pr` | The **Create PR** button: the worker's `PR` tab, with the Create PR prompt and the `pr` action default, against `targetBranch` or the repository's PR base branch (`launchPrAgent` in `multi-review-auto-pr.ts`, shared with auto-PR). Pass `nodeId` for a remote worker, using that node's repository and agent defaults. Refused while the worker's pipeline still owns publication; skipped when the worker already has a PR. | Replays; the native-agent job's request ID derives from the request, so a retry joins the same PR agent. | The `PR` tab, opened without taking focus. A launched PR is followed: status wakes when it opens, conflicts, fails a check, is ready to merge, merges or closes ([Status wakes](#status-wakes)). |
| `resolve_conflicts` | The **Resolve Conflicts** button: the worker's `Resolve` tab, with the Resolve Conflicts prompt, the `resolve` action default and the button's completion action (the PR monitor rechecks the PR when the agent finishes), against `targetBranch`, else the PR's own base branch, else the repository's PR base branch, else `main`, as `pr.resolve` does (`launchWorkerResolve` in `coordinator-pr.ts`, `launchResolveConflictsAgent` in `multi-review-auto-pr.ts`). The button's precondition applies: refused when the worker has no PR, when it is merged or closed, or when GitHub reports no conflicts (an unknown mergeability is allowed), and while the worker's pipeline owns it. Pass `nodeId` for a remote worker. | Replays; the native-agent job's request ID derives from the request, so a retry joins the same Resolve agent. | The `Resolve` tab, opened without taking focus. One status wake when it finishes, with the refreshed PR state; the PR stays followed. |
| `launch_feature_plan`, `get_feature_plan` | **New feature** and **Send** on the Features board: a planning agent in its own environment turns the message into a summary and stories. Building from a plan stays the user's Build button. | Replays; a retry after a crash finds the plan that attempt created. | The plan on the Features board. No status wake. |
| `request_root_changes` | Asks the user to apply some of the checkout's uncommitted changes to a worker (below). | Replays the same approval request. | An approval dialog listing the checkout's changed files. |
| `get_worker_changes` | Reads what a worker changed, local or container, without fetching its branch (below). Read-only, capability `discovery`. | No receipt: a read. | Nothing; it changes nothing. |
| `fork_worker` | The sidebar's **Fork** for a worker: a new worker on its own branch from the worker's last commit, with an optional prompt for its agent (below). Main coordinator only (`environments`). | Replays the receipt; the fork's record carries a control request ID derived from the request, so a retry after a crash finds the same fork, and its association and delegation are idempotent. | A new environment in the sidebar, started in the background. Deleting it is the user's. |
| `answer_worker_question` | Proposes an answer to a question a worker is waiting on, for the user to confirm (below). Takes `nodeId` for a worker on a connected node. | Replays the same approval request. | An approval dialog with the worker, its tab, the question, its options and the proposed answer, which the user may change. Declining leaves the question waiting in the worker's tab. |

**Worker slash commands.** `list_worker_commands` and `run_worker_command`
share `session.commands` and `session.command`'s code (`listSessionCommands`
and `resolveSessionCommand` in `public-api/actions-session-commands.ts`), so a
command a coordinator runs is checked, journaled and refused exactly as one
the CLI runs ([native-agent-commands.md](native-agent-commands.md)). Two
choices are the coordinator's own:

- **No live-turn commands.** `/steer` (and any row whose `busy` is
  `running`) is neither listed nor run. Options: expose it as a command; refuse
  it and point at `send_message` with `deliverNow`. Chosen: refuse. The mail
  path already steers a running turn and carries what a raw steer would skip:
  mutes, inject policy, budgets, joining the open delegation and the steer
  journal's single-attempt verification.
- **Which commands are delegations.** Options: every command; none; by
  execution kind. Chosen: by execution kind. `bridge-local` commands (Codex
  `/help`, `/models`) and Orkestrator session actions (`/compact`) answer
  without a provider turn, so a delegation would only wake the coordinator
  with a "finished without a report" notice for nothing; every other kind
  starts a turn and opens one, refused like `send_prompt_to_tab` while one is
  already open on that tab. Con: a provider command that happens to answer
  locally (some Claude built-ins) still opens one and wakes once.

Receipts live in the coordinator store (`actionReceipts`, bounded at 2,000,
oldest completed dropped first). A receipt is admitted before the action has
any effect and bound to a hash of the caller's payload; reusing a
`requestId` with a different payload is refused. Concurrent identical calls
in one backend share one run. A failed run drops its pending receipt so the
same request can be retried; a pending receipt whose backend process died is
reclaimed by the next retry, which reattaches as the table says.

**Reading a worker's changes.** `get_worker_changes` answers from backend
change tracking, through the same `changes_*` commands the Changes panel and
the public `changes.view` read (`coordinator-worker-changes.ts`), so it works
for container workers the coordinator cannot fetch from. It returns the
worker's branch and base (`createdFromCommit`, or the user's chosen diff base),
the commits since the base (a bounded log of `<base>..HEAD` through the
checkout's Git runner the base picker uses, local or `docker exec`),
`sinceBase` (the `environment-net` measurement: base to working tree,
committed and uncommitted together, each file with status and line counts and
`uncommitted: true` when it also has uncommitted changes), `uncommitted` (the
`uncommitted-net` measurement, `HEAD` to working tree with untracked files),
and `diffs`: backend-rendered hunks of the listed `sinceBase` files as unified
text (`changes_resolve_live_detail` and `changes_get_diff`, the Diff tab's
path). Every part is bounded: 100 files by default (at most 500), 5,000 rows
scanned per measurement, 50 commits (at most 200), diffs of 20 files (at most
50), 16 KiB per file and 64 KiB in total (at most 256 KiB). A cut part says
`truncated`, and the result names the arguments that page or narrow it:
`offset` (`sinceBase.nextOffset`), `paths` (files or directories) and `file`,
which renders one file's whole diff up to the total budget. A stopped
container worker answers what change tracking last measured, with its commits
unavailable and each diff `null` with the reason; a measurement still being taken says `pending`. The diff is base to
working tree, so a file marked `uncommitted` shows both kinds of change
together: change tracking keeps no bodies for a commits-only or
uncommitted-only comparison. With `nodeId` the node owning the worker reads it
(`get_controller_worker_changes`) and applies its own bounds.

**Forking a worker.** `fork_worker` runs what the sidebar's Fork runs
(`forkEnvironmentRecord` in `commands-environment-fork.ts`): the worker's
committed `HEAD` becomes the fork's base on a new branch, with its agent
settings, network mode, allowed domains and ports. Its uncommitted changes and
its conversation are not copied, so the description tells the coordinator to
have the worker commit first. A container fork needs the commit on a remote,
as for the sidebar. The fork becomes a coordinator worker exactly as a
`launch_environment` worker does: a durable `environment` association with
its base branch and commit (`requestId` `fork:<requestId>`) and, with a
prompt, the delegated startup prompt (`pendingAgentLaunch`, see
[Worker delegation](#worker-delegation)) and one delegation on the
`startup-agent` tab, opened only once the start succeeded. Without a prompt
the fork starts with no agent turn and no delegation. Omitted, the agent is
the fork's own startup agent (the worker's, from its copied settings) and the
model and effort resolve as for `launch_environment`; the result reports
`selection` the same way. The fork does not keep the worker's
`buildPipelineId`: deleting an environment deletes its linked pipeline and the
supervisor finds a pipeline's environment by that ID, so a fork that kept it
would appear to own the pipeline. `create_pr` therefore treats a fork as an
ordinary worker. (The sidebar's Fork still keeps the link.) With `nodeId` the
receipt, association and delegation stay on the command node, and the node
owning the worker forks it (`fork_controller_environment`) under a control
request ID derived from the receipt.

**Uncommitted changes in a worker.** Workers start from a commit, so work the
user has not committed never reaches one on its own. When the user wants it
to, `request_root_changes` creates an `apply-root-changes` node action
request (the same approval flow as `request_project_on_node`). The user sees
the checkout's changed files (`list_project_root_changes`: `git status`
without optional locks), with the files the coordinator suggested ticked,
and picks the files. Only the approval runs `apply_project_root_changes`,
which the coordinator's command invoker refuses by name. It builds a binary
patch from `HEAD` to the working tree for exactly those files, against a
scratch copy of the index and a scratch object store in front of the real
one, so the checkout's index, objects, refs and files are untouched. It then
runs `git apply --check` and `git apply` in the worker (a local worktree, or
`docker exec` in a running container): the patch applies whole or not at
all. Paths the checkout no longer reports as changed are refused. The
outcome is mailed to the conversation as a system notice, which wakes it.
The coordinator never sees the patch.

**Answering a worker's question.** A delegated worker waiting on a question
needs a person, and the coordinator cannot answer for them, but it can save
the user a trip to the worker's window. It reads the question in
`get_tab_state` (`state.interactions`: id, kind, questions and options) and
calls `answer_worker_question` with the interaction id, the answer in the
question's own shape (each `questionId` with its `optionIds` and/or
`freeText`) and a short reason. The backend command
(`request_coordinator_worker_answer` in `worker-question-relay.ts`) reads the
pending interaction from the tab, on this node or through the node link,
and refuses anything that is not a `question`: command, file, plan and tool
approvals, MCP forms and links, terminal selections and any question asking
for a secret stay in the worker's tab. It checks the proposal against the
question and creates an `answer-worker-question` node action request holding
a bounded copy of the question, its revision and the proposed answer; it
answers nothing. The user sees the worker, its tab, the question, its
options with the proposal preselected and the reason, may change the answer,
and approves or declines. Only the approval runs
`answer_project_worker_question` (or, for a worker on another node,
`answer_controller_worker_question` over the node link), which the
coordinator's command invoker refuses by name, as it does
`resolve_native_agent_interaction`. It re-reads the worker's pending
interactions where the worker lives and answers only the revision the
request named, through `resolve_native_agent_interaction`, the command the
worker's tab uses, with the answer as the user approved it. A question
answered in the tab meanwhile, replaced, expired, or gone because the turn
ended or the tab closed settles the request `stale` and nothing is sent.
Malformed answers fail without reaching the worker; an approval that times
out (24 hours) expires; a node that disconnects fails the request, and an
answer lost on the node link settles it outcome-unknown, never resent. A
schedule's tool action for `answer_worker_question` runs the same tool, so it
too only creates a request. Answered, stale, declined and failed requests
each mail the conversation a system notice, which wakes it; the notice,
receipt and logs name the worker and tab only, never the question or the
answer.

### Worker goals

A coordinator can give a worker tab a goal, and is woken once when it stops
(`plans/goals/403`). The tools sit on the same service as `/goal` and
`session goal`, so its rules apply: one goal per session, an iteration cap, and no change to the permission mode.
Coordinator tools cannot configure shell checks; a person configures checks
through the composer or public API. A coordinator goal ends as an unverified claim.

| Tool | What it does | Retry | Capability |
| --- | --- | --- | --- |
| `set_worker_goal` | Sets the goal from structured fields. `maxIterations` is **required**, bounded by `NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit`, with no default; `tokenBudget` is optional. Shell checks are refused; a done report ends as `claimed`. | Same `requestId` replays the receipt. The goal's ID derives from the request, so a retry after a lost receipt finds the goal instead of starting another. | `jobs` |
| `get_worker_goal` | Status, reason, what the status means, iterations and limit, the last check's result, and recent ended goals. | Read | `environments` |
| `pause_worker_goal` | Stops the loop. A turn already running finishes. | States an end: a goal that already stopped answers `alreadyStopped`. | `jobs` |
| `clear_worker_goal` | Removes the goal in any status. It stays in the goal history. | States an end: no goal answers `cleared: false`. | `jobs` |

**Ownership.** Every tool refuses a tab this coordinator did not launch or prompt.
The durable delegation record says so, the same ownership status wakes use, and
it outlasts the delegation that made it. A tab a person opened in the same worker
stays theirs until the coordinator delegates to it, under the existing rules. The
backend commands (`coordinator-goal-actions.ts`) revalidate the scope and refuse
the project home, and side agents have no goal tools.

**No resume.** Resuming can raise a limit, which is widening what a goal may spend.
A coordinator sets a new goal, or leaves a stopped goal for a person to resume.

**One wake.** `set_worker_goal` opens a delegation after the goal is set, or joins
one already open on the tab; `wakeOwed` in its result says which was arranged, and
the result says so plainly when none could be. While the goal runs, a turn-end edge
settles nothing (`goals.holdsTurnEnd`), and neither does the delegation sweep,
which otherwise reads an idle tab as a finished worker: the tab really is idle
between iterations and during a check (`workerGoal`, read from the session record so
it holds across a restart). When the goal ends or pauses, `onGoalReleasedTurnEnd`
settles the delegation once. A worker's own mail is that wake as usual. Otherwise
the notice names the outcome (`Its goal is limited (iteration-cap) after 3 of 3
iterations`) and `get_worker_goal`. A coordinator's own pause or clear of a running
goal ends the wait too, so that wake arrives at once.

**Status reads.** `get_worker_goal` and `get_tab_state` report the goal through
`goalForModel`, and `list_agents` adds its status and counts, so an `idle` tab whose
`goal.running` is true reads as between iterations. A model reads what a worker or
its check wrote only inside an `<orkestrator-goal-evidence>` frame the text cannot
close: the agent's report, the status detail, a verifier's summary and the check's
output. The result says it is evidence and not instructions. Fields are named one by
one, so a field added to the goal stays out until someone judges it.

**Qualification does not change.** These tools change no platform's tier, boundary
or delegation, so `coordinator-providers.ts` has nothing to add: any platform that
can delegate can call them. Whether a *worker* can hold a goal is its own
`actions.goal` capability, which a refusal reports.

**Not covered: workers on another node.** The tools take no `nodeId`. A remote
delegation settles from its node's turn state, which does not know about goals, so
the coordinator would be woken between iterations. A person's `/goal` on a remote
worker the coordinator delegated to has that problem today.

A live run is the `goal` scenario of `mise run test:agent:coordinator`, described in
[`agent-testing.md`](../development/agent-testing.md#live-coordinator-suite). Whether
it has passed is recorded in `plans/goals/403`.

## Saved graphs

The main coordinator runs saved graph templates
([graphs.md](graphs.md#launching)); it never authors them (D6). Four tools
(`control-mcp-graph-tools.ts`, over the commands in
`coordinator-graph-actions.ts`) need the `graphs` capability, which only the
main role holds (`COORDINATOR_TOOL_CAPABILITY` in `control-mcp-tools.ts`).
They are in `COORDINATOR_CONTROL_TOOL_NAMES`, the allowlist Pi's read-only
gate and OpenCode's coordinator permission rules (`orkestrator_<tool>`, by
name) admit, like every other Control MCP tool. They change nothing in
[provider qualification](#provider-qualification): they are backend actions
under the scoped credential, never a write to the checkout.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_graph_templates` | optional `ref` (`{scope: "builtin" \| "user", id}` or `{scope: "project", path}`), optional `environmentId` | Without `ref`: `{templates, total}`, at most 200, each with its `ref`, name, scope, revision, `trust`, `engine`, `launchable` and compile counts and cost. With `ref`: `{template}`, its launch options: roles (panel, `maxPanel`, `floor`, steps, each provider's `tier`, `available` and `unavailableReason`, the default binding), parameters, inputs, environment default, cost, `launchable` and `blockedReason`. `environmentId` judges the launch on that existing environment |
| `launch_graph` | `requestId`, `template` (a `ref`), `environment` (`{kind: "new", create: "worktree" \| "container"}` or `{kind: "existing", environmentId}`), optional `roles` (role key → one `{platform, model?, reasoningEffort?, fastMode?, lens?}` or a panel list of up to 32), `params`, `inputs` (value inputs only), `ticket: {taskId, input?}` | `{runId, launch, delivery: "async", wake, nextStep}` |
| `get_graph_run` | `runId` | `{run, waitingFor, failed, terminal}`: the run summary, plus up to 16 steps waiting for a person and 16 failed steps (`activationKey`, `nodeId`, a failed step's error cut to 400 characters) |
| `cancel_graph_run` | `runId` | The same view with `cancelled`; a run that already ended or is cancelling answers `cancelled: false`. Steps stop; the record and artifacts are kept |

Every result is content-free: ids, states, counts and template metadata,
never prompts, input values or artifact payloads. Runs and environments of
another project, and the project home, are refused. A refusal's error text
starts with its stable code (`GRAPH_LAUNCH_ERROR_CODES` in
`packages/protocol/src/graphs/launch.ts`, such as `untrusted:` or
`engine-template:`), else `graph-error:`.

**No authoring.** No tool creates, saves, edits, duplicates, imports,
deletes, trusts or describes a template. "Describe a graph"
(`graph_describe_*`) are app commands only: neither a coordinator
credential, the operator profile nor a public action reaches them
(`graph-describe-coordinator.test.ts`, `control-mcp-graph-tools.test.ts`).

**Launching.** `launch_graph` goes through the same `GraphRunLaunchService`
as the app and the CLI, recorded as `requestedBy: "coordinator"`. Omitted
roles and parameters use the defaults saved for the template in the project,
then the Settings defaults. It admits before it acts: the launch's own
idempotency key is `coordinator:<coordinatorId>:<requestId>`, the run id is
derived from that key (`graphLaunchRunId`), and a `graph-run` workflow
association holding that run id, the `requestId` and the payload hash is
reserved before the launch service is called. A retry with the same
`requestId` returns the same run (`repeated: true`), answers `conflict` while
the first attempt is still in flight, and is refused when the payload
differs. A launch the service refused outright (a launch code and no run)
releases the reservation, so the same `requestId` can carry a corrected
request. The association is what gives the conversation its
[status wakes](#status-wakes): one per wait for a person and one when the
run ends. To launch later, schedule the tool itself (`create_schedule` with
`action: {type: "tool", tool: "launch_graph", arguments}`); the operator-only
`graph` schedule action is refused for a coordinator.

## Saving decisions to AGENTS.md

Users settle durable decisions in coordinator conversations: how workers
behave, safety rules, conventions ("never touch ports 34121/34122", "commit
flaky-test records in the same change"). The main coordinator can save them to
a dedicated `## Orkestrator` section of the project's root `AGENTS.md`, which
every agent reads, through a pull request, without a worker environment.

**When it offers.** The main coordinator's per-turn context
(`COORDINATOR_AGENTS_MD_RULE` in
`packages/protocol/src/agents-md-orkestrator.ts`) tells it to ask once,
briefly, at a natural pause after such a decision is agreed, whether to save
it; to batch several decisions into one question and one call; to skip
one-off task details; and not to ask again about a decision the user declined
in the same conversation. The decline mail repeats that last rule. Side agents
are not told and cannot call the tool.

**The tool.** `propose_agents_md_update` (main only: capability
`environments`) takes a `requestId`, a `reason`, an optional `nodeId` for the
project's copy on another node, and 1 to 20 `changes`, each
`{action: "add" | "replace" | "remove", text, replaces?}` (`replaces` names the
existing entry for a `replace`). Each entry is one plain line of at most 500
characters. It cannot start another Markdown block (a heading, quote, list,
fence, table, HTML or thematic break) or contain a line break, an HTML comment,
a control character or a bidirectional override, so it cannot escape the
section; there is no path parameter and unknown fields are refused. Two
changes may not touch the same entry. The tool creates an `update-agents-md`
node action request and returns at once (`delivery: "async"`); it writes
nothing. A retry with the same `requestId` returns the same request with its
current `state` and, once opened, `prUrl`.

**The review.** The request opens `AgentsMdApprovalDialog` in every window of
the command node. It reads the section from the freshly fetched base branch on
the node owning the project copy (`preview_agents_md_update` →
`read_project_agents_md_section`) and shows the change as a line diff,
computed by the same merge the backend runs. The user can edit each entry's
text or drop it, and approves or declines. Approval stays disabled until the
preview has loaded and the merge succeeded; a failed read offers a retry and
still permits declining. A replacement whose original is no longer in the section shows as a conflict and blocks approval until it is
dropped; a proposal the section already satisfies says no pull request is
needed. Nothing happens without approval; the outcome is mailed to the
coordinator, which wakes it.

**The pull request** (`apps/backend/src/core/agents-md-pr.ts`, run by
`open_project_agents_md_pr` on the owning node, which coordinator credentials
are refused by name):

1. `gh auth status` first; a missing or signed-out `gh` fails with what to run
   (`gh auth login` on that machine, or a token under Settings).
2. A pull request for the request's branch (`orkestrator/agents-md-<key>`, the
   key derived from the request) is returned if it is open. A closed or merged
   pull request produces a clear status and URL instead of an open-PR success.
3. `git fetch origin +refs/heads/<base>:refs/remotes/origin/<base>`, the
   base being the repository's PR base branch, else its default branch.
4. The entries are re-applied to `AGENTS.md` at the fetched `origin/<base>`.
   Additions already present and removals already gone are no-ops; a
   replacement whose original is gone is a conflict and nothing is pushed.
5. If an earlier attempt already pushed the branch, it must change only
   `AGENTS.md` and its file must match that fresh merge byte for byte. A
   mismatch is a conflict; recovery never force-pushes. Otherwise, with
   nothing left to change, there is no pull request.
6. A temporary worktree inside a fresh private mode-0700 system temp directory,
   detached and without a checkout, gets the new file's exact bytes through
   `hash-object --no-filters` and `update-index`, so line-ending conversion,
   clean filters and LFS cannot alter the rest of the file. It commits with
   `core.hooksPath=/dev/null`, checks the commit changes only `AGENTS.md`, and
   pushes the branch, never forced. A lost push reply is accepted only if
   origin holds that exact commit. The PR body also lives in the private directory.
7. `gh pr create` with a body listing the changes and the reason, ending with
   the generated-by line. The worktree is removed in every case.

The user's checkout (its branch, index, working tree and stash) is never
touched; only `origin/<base>` is fetched and the shared object store gains
the new objects. Nothing merges.

**The section.** `mergeOrkestratorSection` copies everything outside the
section byte for byte (CRLF kept, a byte-order mark kept, invalid UTF-8
refused). A missing section is created at the end of the file, opening with a
note that it holds coordinator-approved operating decisions every agent must
follow; a missing file is created with just the section. Entries are compared
ignoring case, spacing and a final full stop, stay de-duplicated (existing
duplicates collapse to the first when the section changes), keep their order,
and new ones go after the last entry. ATX and Setext level-one and level-two
headings end the section; a first-line BOM does not hide its heading. Headings
inside fenced code are not headings, and two `## Orkestrator` sections are
refused as ambiguous. Invisible Unicode format characters are refused in new
entries and ignored in comparison keys; compatibility normalization also
prevents visually equivalent block markers from bypassing validation.

**Durability.** The request (with the user's edited entries once approved)
is in the node action request store. An approval a backend restart
interrupted is run again after node links and portal storage start
(`resumeInterrupted`); with steps 2–5 above that finds the pull request or pushed branch the earlier run left
rather than opening a second. An unavailable target keeps the request approved
with the user's edits intact; reconnects and a 30-second reconciliation sweep
retry it. On another node the routed call is retried if its answer is lost (the node link times out after 60 seconds); each retry
joins the run still going there using the same routed request key. A successful
answer clears earlier unknown-outcome notices for that run. After five lost
answers the request ends `outcome-unknown`, naming the branch to check, with one
routed outcome record. Remote failures retain their error code and message.

## Tests that exist today

The async and read-only contracts are asserted at the layer that owns each
guarantee, not by one end-to-end scenario replayed per platform:

- coordinator presence and the turn-end edge:
  `native-agent-service-reconciliation.test.ts`
- one-wake invariant and crash recovery: `coordinator-service.test.ts`
- status wakes (ownership, one wake per settled transition per resource kind,
  coalescing, budgets, restart, bounds): `coordinator-status-wakes.test.ts`;
  graph runs: `graph-run-coordinator-status.test.ts`,
  `coordinator-status-wakes-graph.test.ts`; pull requests (the reducer and
  environment PR fields: `coordinator-pr-status.test.ts`; follows, Resolve
  tabs, review handoff: `coordinator-status-wakes-pr.test.ts`; a remote
  worker's Resolve tab and follow: `coordinator-pr-remote.test.ts`)
- `create_pr` and `resolve_conflicts` admission, preconditions and follows:
  `coordinator-surface-actions.test.ts`
- saved graphs: the four tools and no authoring tool, admission before
  launch, refusal codes, project scoping and scheduling
  (`control-mcp-graph-tools.test.ts`); no describe or authoring tool for a
  coordinator, the operator profile or a public action
  (`graph-describe-coordinator.test.ts`)
- single-turn mail batching: `agent-mail-service.test.ts`
- tool contract and poll guard: `control-mcp-server.test.ts`
- the answer relay: questions only, the proposal checked and stored, stale and
  malformed answers never sent, end to end on this node
  (`worker-question-relay.test.ts`) and on a connected node
  (`worker-question-relay-remote.test.ts`), the approval executor
  (`node-worker-answer.test.ts`), and the approval dialog
  (`WorkerQuestionApprovalDialog.test.tsx`)
- no-waiting-tools boundary, tier table, hosted network tools removed on
  every platform, and search without fetch when research is on:
  `coordinator-conformance.test.ts`
- hosted web search against the real pinned Codex, read from the model request
  on a loopback endpoint (gated on `RUN_LIVE_CODEX_APP_SERVER=1`), plus a
  canary that proves `cached` refuses a fresh page `live` opens and that a
  research server is callable (`RUN_LIVE_CODEX_WEB_SEARCH_CANARY=1`):
  `live-network-lock.test.ts`
- per-bridge activity and policy tests already cover whether a bridge reports
  `idle` at turn end and how it translates `capabilityPolicy`
- the Claude coordinator sandbox against the pinned CLI with a scripted local
  model: the default sandbox writes the working directory, the coordinator
  sandbox refuses it and still reads, and the hook refuses `uniq in out`:
  `conformance-coordinator-sandbox-live.test.ts` (claude-bridge)
- research servers on the pinned OpenCode, with a real `opencode serve` and a
  local MCP server: `opencode-coordinator-research-live.test.ts`
- coordinator skills on Codex against the real pinned app-server with a
  loopback model (`RUN_LIVE_CODEX_APP_SERVER=1`): `live-coordinator-skills.test.ts`
  (codex-bridge); the extra roots, read grants and project-skill rule in
  `codex-config.test.ts`, `app-server-engine.test.ts` and
  `app-server-runtime-prompt.test.ts`; Pi's loader against the real SDK
  (`coordinator-skills.test.ts`, pi-bridge); Cursor's hosted skill tool
  (`coordinator-skills.test.ts`, `agent-session.test.ts`, cursor-bridge)
- coordinator skills: the mirror and its frontmatter allowlist
  (`coordinator-skills.test.ts`), the options a coordinator, a worker and a
  worker's read-only review pass and the launch conflict a changed skill set
  causes (`session-manager-coordinator-skills.test.ts`), the hook refusing
  granted tools and skill scripts (`read-only-policy.test.ts`), all in
  claude-bridge; the launcher naming the account's skills directory
  (`agent-accounts-active.test.ts`, `commands-servers-coordinator.test.ts`)

- the same contracts against real providers: `mise run
  test:agent:coordinator` runs its scenarios per platform in a disposable
  profile. `read-only` attempts every class of mutation and checks that the
  checkout digest is unchanged and that read and discovery tools still answer.
  `async` launches real workers and checks the async launch result, that a
  queued prompt runs before pending worker mail, one carrier per delegation, one
  notice for a silent worker and the poll guard. `family` runs a two-worker
  exchange of sixteen messages, including a follow-up to a busy worker, with
  nobody answering anything. `status` checks that a coordinator-launched
  Multi Review wakes it once when ready and once when its Fix turn finishes
  (with `address_multi_review` in between), and that a delegated worker held
  on an approval wakes it once after the 20-second debounce. `peer` has two
  ordinary environments exchange ten messages with Wake peers on and no
  coordinator involved. `goal` has a coordinator set a worker a two-turn goal with a
  claim, then checks one wake and its read of the result. Every scenario with mail also runs the renderer's
  carrier parser over each echoed carrier row and requires one toned tile per
  delivered message and no raw carrier text. It is opt-in
  and never runs in `mise run test` or CI. See "Live coordinator suite" in
  [`agent-testing.md`](../development/agent-testing.md).
- AGENTS.md decisions: parsing, merging, injection and the diff
  (`agents-md-orkestrator.test.ts`, protocol); the pull request against a real
  local `origin` with a fake `gh`, including a fresh base, a missing section
  or file, retries, a restart after the push, upstream conflicts, missing
  `gh` sign-in, hooks and line-ending filters (`agents-md-pr.test.ts`); main
  versus side, validation and replay (`agents-md-commands.test.ts`); approval,
  decline, remote routing and restart (`node-coordination-agents-md.test.ts`);
  the dialog (`AgentsMdApprovalDialog.test.tsx`, web, and
  `e2e/AgentsMdApproval.spec.ts` in a real browser)
- worker surfaces (terminal, browser, tab edits, feature plans, custom fix, reviewer tabs, the root-changes request and receipts):
  `coordinator-surface-actions.test.ts`; the patch and the untouched
  checkout against real Git repositories: `root-changes.test.ts`; the
  approval dialog: `node-action-requests.test.tsx` (web); scope forwarding
  and side agents: `control-mcp-server.test.ts`
- `get_worker_changes` bounds, paging, path filters, uncommitted marks and
  diff rendering over fake `changes_*` answers:
  `coordinator-worker-changes.test.ts`; `fork_worker`'s base, association,
  delegation, receipt replay, pipeline unlinking and project-home refusal
  against a real Git checkout: `coordinator-fork-worker.test.ts` (slow tier)
- worker turns (`stop_worker_turn`, `list_worker_commands`,
  `run_worker_command`) over the real registry, native-agent service and
  delegations: the stopped run settling as cancelled, the one stop-aware wake,
  a later prompt not refused, idle and terminal tabs, the project home,
  `session.command`'s refusals and side agents (`coordinator-worker-turns.test.ts`);
  on a connected node, with lost answers (`coordinator-worker-turns-remote.test.ts`)

- worker goals: the tools, the schema limit pinned to the constant, refusals for
  tabs the coordinator does not own, replay and framing:
  `control-mcp-coordinator-goals.test.ts`; many iterations, one wake, for each way a
  goal stops, and the sweep's hold: `coordinator-goal-wake.test.ts`
- an OpenCode coordinator keeps its scoped Control MCP credential on its server
  through every later reconcile, and does not start until it is connected:
  `commands-servers-coordinator-opencode.test.ts`

The runs that qualify each platform, and the scenarios still to add, are in
[0024-coordinator-live-conformance.md](../todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md).
