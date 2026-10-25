# Orkestrator control MCP

Status: Living — Control MCP operator guide.

Orkestrator exposes its controls to Codex, Claude Code, realtime voice agents
and other MCP clients through a local Streamable HTTP server. Every public
action the `orkestrator` CLI can run is reachable through it, under the same
request keys, receipts and error codes ([public-cli.md](public-cli.md)).

Outside agents get a short public summary of this guide and the CLI at
[orkestrator.dev/skill.md](https://orkestrator.dev/skill.md), linked from
`/llms.txt` (`apps/web-public/public/`). Update it when the port, the
Settings labels or the credential rules change.

## Connect a client

1. Keep Orkestrator running.
2. Open **Settings → MCP**.
3. Pick a credential (or create one for this client) and copy the setup for
   your client.

That is the whole setup. The server URL and each credential's token stay the
same when Orkestrator restarts.

### Codex

In **Settings → MCP**, choose **Copy setup** under Codex and paste the block into
`~/.codex/config.toml`:

```toml
[mcp_servers.orkestrator]
url = "http://127.0.0.1:34122/mcp"
http_headers = { Authorization = "Bearer YOUR_TOKEN" }
```

Restart Codex, then ask it to use the `orkestrator` MCP server. Codex documents
these fields in its
[MCP guide](https://learn.chatgpt.com/docs/extend/mcp#streamable-http-servers).

### Claude Code

In **Settings → MCP**, choose **Copy setup** under Claude Code and paste the
copied command into a terminal. It has this form:

```bash
claude mcp add --scope user --transport http orkestrator http://127.0.0.1:34122/mcp --header "Authorization: Bearer YOUR_TOKEN"
```

Start a new Claude Code session. Run `/mcp` if you want to check the connection.
Claude Code documents this command in its
[MCP guide](https://code.claude.com/docs/en/mcp).

### Other and voice clients

**Other or voice client** copies the URL and the `Authorization` header as
JSON, for any Streamable HTTP client. A realtime voice agent should use a
credential with the `voice` profile; see
[control-mcp-voice.md](control-mcp-voice.md) for its tools, confirmation flow,
attention relay and the local relay a hosted voice platform needs.

## Credentials and profiles

Each client gets its own named credential: `{id, label, profile, capabilities,
deniedActions, token, createdAt, lastUsedAt}`. Credentials are stored in
plaintext with mode 0600 in `<dataDir>/control-mcp.json` (descriptor version
2), so Copy setup works at any time. **Rotate** replaces one credential's
token and **Revoke** removes it; neither touches any other client. Revoking
the last credential is kept across restarts; only a missing or unreadable
descriptor starts fresh with a new `default` credential.

The single token from before named credentials became credential `default`
with the `full` profile when the descriptor was first read as version 2, so
existing Codex and Claude Code setups kept working unchanged.
`rotate_control_mcp_token` still rotates `default`.

| Profile | Tools listed | Default capabilities | Text in results |
| --- | --- | --- | --- |
| `voice` | the 8 voice core tools and the 4 gateway tools | all but `projects`, `settings`, `environments.destructive`, `exec` | a short speakable `say` sentence, the IDs the next call needs, a `next` hint; at most 2 KB |
| `full` | the operator tools (the 18 original tools, `list_nodes`, the Multi Review tools, `create_pr` and `resolve_conflicts`), the voice core, the gateway, and one direct tool per allowed public action | every capability except `host` | compact JSON |
| `read-only` | the same shape as `full`, reads only | every capability except `host`; every mutation is refused | compact JSON |
| `custom` | the same shape as `full` | an explicit list | compact JSON |

Capabilities group public actions (`discovery`, `sessions.read`,
`sessions.control`, `interactions`, `environments.lifecycle`,
`environments.destructive`, `exec`, `projects`, `settings`, `tickets`, `mail`);
each action's group is in `PUBLIC_ACTION_INPUTS`
(`packages/protocol/src/public-api-inputs.ts`). `host` (updating Orkestrator
itself) is never granted to an MCP credential. A voice credential may be
granted `exec` explicitly; every voice call of `environment.exec` then needs a
confirm token. `controlMcpActionAllowed` (`packages/protocol/src/control-mcp.ts`)
is the one rule: `run_action`, every direct tool and the `tools/list` filter
all call it, so a tool a credential cannot use is never listed and never runs.

The endpoint listens only on `127.0.0.1`; this design adds no public
listener. Treat every token like a password: a `full` credential can create
environments, launch jobs, read transcripts, and update tickets. Managed
development profiles request an ephemeral loopback port so they can run
alongside an installed Orkestrator instance; the selected URL is published in
the profile's readiness and descriptor data.

With the full profile the default credential lists 105 tools, about 117 KB of
`tools/list` (measured 2026-10-25; 82 tools and 76 KB before leaf-node
targeting and the review and PR actions); clients that defer or search tool
definitions handle that well. The voice list stays within its 8,000-byte
budget (12 tools, about 7.6 KB). A client that loads every tool up front is
better served by a `voice` or `custom` credential.

## Tool tiers

- **Tier 0, voice core:** `overview`, `resolve_target`, `read_session`,
  `prompt_session`, `steer_session`, `stop_session`, `answer_question`,
  `start_work` (`control-mcp-voice.ts`). A core tool may compose several reads;
  every mutation is exactly one public action under the caller's `requestId`.
- **Tier 1, gateway:** `find_actions(query?, group?)` (at most 15 rows, each
  with its confirmation rule and whether this credential may call it),
  `describe_action(action)` (input JSON Schema, up to two examples, wait
  conditions, CLI equivalent), `run_action(action, input, requestId?,
  confirmToken?)` and `run_status(operationId | requestId, action?,
  waitSeconds?)` (`control-mcp-gateway.ts`). `run_action` accepts only
  `PUBLIC_ACTIONS` names and enters through `public_action`; it never reaches a
  raw registry command. `requestId` is required for mutations and refused for
  reads.
- **Tier 2, direct tools** (`full`, `read-only`, `custom`): one tool per
  allowed public action, named with the dots replaced (`session.prompt` →
  `session_prompt`), with the action's input schema plus `requestId` and, where
  the action can need it, `confirmToken`. They are generated from the protocol
  schemas with the SDK's `fromJsonSchema` and compiled once per process
  (`control-mcp-direct-tools.ts`).

The server is stateless: it is rebuilt for every request, so it never sends
`tools/list_changed`. The gateway is how a client with a fixed tool list
reaches everything else.

`run_status` waits up to `waitSeconds` (0 to 20, default 0) with the CLI's
backoff and returns early on a terminal state, a pending interaction, an
unknown dispatch or outcome, or a provider whose completion cannot be
observed. The CLI's `--wait` uses the same classification
(`classifyReceiptForWait` in `packages/protocol/src/public-api-wait.ts`).

## Results

`structuredContent` is the public envelope unchanged (`ok`, `error.code`,
`exitCode`, `receipt`, `warnings`, `backend`), so an MCP client sees the same
codes and exit classes as `orkestrator … --json`; `isError` is set exactly
when `ok` is false. `run_status` adds a `wait` field with its verdict, and
`read_session` replaces the transcript page with its bounded excerpt. The 18
original tools keep their documented output shapes and add a `receipt` for
mutations. Adapter errors that never reached a public action
(`confirmation-required`, a credential that may not call the action, a
missing `requestId`) have no `backend` field.

## Confirmation

Risky actions are confirmed with a stateless token. Each action's class lives
beside its schema in `PUBLIC_ACTION_INPUTS`:

- `always`: `project.create`, `project.remove`, `environment.delete`,
  `environment.recreate` with `discard`, `run.discard`. `project.remove` with
  `cascade` is refused for every Control MCP credential
  (`capability-unavailable`): deleting environments is a separate destructive
  grant that `projects` must not imply, so only the operator's own CLI
  cascades.
- `voice` (voice profile only): `environment.stop`, `environment.exec`,
  `pr.create` and `pr.resolve` (both push to the remote), and
  `session.interaction.resolve` when it approves a command or file change
  (`answer` or `approve-for-session` on any interaction but a question).
  Denials, cancels and question answers run directly.

The first call without a token is refused with `confirmation-required` (exit
class 6) and returns a spoken `description` ("This deletes environment
auth-fix and its worktree", "This approves Run rm -rf dist: rm -rf dist") and
a `confirmToken`. The token is HMAC(per-process secret, credential, action,
input fingerprint, expiry) and lives 120 s. The second call with identical
input plus the token runs; a changed input, an expired token or another
credential's token is refused with a fresh `confirmation-required`. A backend
restart invalidates outstanding tokens. An approval whose interaction cannot
be read is confirmed rather than run. `confirmation-required` is an adapter
code, not a public error: the CLI expresses the same intent with explicit
flags (`--github-private`, `--discard`, `--yes`).

## Authority

Every operator credential dispatches under its own authority,
`control-mcp:<credentialId>`, set in-process (a symbol key on the
`public_action` call that cannot cross the gateway's JSON boundary) and never
read from request input. The CLI and the app dispatch as `operator`.
Authority is part of every request key and scopes `run.get`, every lookup by
operation ID (`run.retry`, `run.discard`, `run.cancel`, `run.output`,
`session.stop/steer` with `expectedOperationId`) and request-key lookups, so
one credential can neither read another's (or the CLI's) receipts nor collide
with its keys. `attention.list` lists only the caller's own runs. The
reconciler always runs as the operator.

## What an agent can do

Everything the public CLI can do except `host.*`, subject to its credential:
projects, environments, settings, agent sessions, interactions, transcripts,
changes, runs, exec, Kanban tickets (`ticket.*`), agent mail (`mail.*`), the
attention feed (`attention.list`), Multi Review (`review.*`), the Create PR and
Resolve Conflicts tabs (`pr.create`, `pr.resolve`), and all of it on the leaf
nodes of a command node ([Leaf nodes](#leaf-nodes)). The original tools remain:

- See projects, environments, tabs, tab state, and bounded transcripts.
- Create and update Kanban tickets and add comments.
- Create a validated environment with an initial agent prompt.
- Launch a new job in an existing running environment.
- Send a new prompt to an existing native-agent tab.
- Discover durable agent mailboxes with `list_mailboxes`.
- Send an inbox-only external message to one mailbox with `send_message`.

Operator credentials also get, under the names a coordinator already uses:

- `list_nodes` (`node.list`): this machine and the leaf nodes it controls.
- `launch_multi_review` (and `start_multi_review`, the same action for an
  operator), `list_multi_reviews`, `get_multi_review`, `open_multi_review`,
  `open_multi_review_fix`, `address_multi_review`, `cancel_multi_review`
  (`review.*`): the Multi Review button and its follow-up actions. A launch
  uses the saved reviewers, models, branch, instruction, Auto-fix and Auto-PR
  for whatever is omitted, reuses an active review, and creates its root tab.
  A review whose tab could not open is a `partial` operation with its
  recovery text.
- `create_pr` and `resolve_conflicts` (`pr.create`, `pr.resolve`): the action
  bar's Create PR and Resolve Conflicts buttons. Each opens the same agent tab
  (the shared prompt, the `PR` or `Resolve` title, the `pr` or `resolve` action
  default) through `session.start`'s job path, so it is a run with a receipt
  that `run_status` follows. `create_pr` is refused while the environment has a
  PR and starts PR monitoring; `resolve_conflicts` refreshes the PR when it
  finishes. Neither merges.

### Operator tools over public actions

For operator credentials the original mutation tools are adapters over one
public action each (`control-mcp-operator-tools.ts`): `launch_environment` →
`environment.launch`, `launch_job` → `session.start`, `send_prompt_to_tab` →
`session.prompt`, `create_ticket`/`update_ticket`/`add_ticket_comment` →
`ticket.*`, `send_message` → `mail.send`; `list_projects`, `list_tickets`,
`get_ticket` and `list_mailboxes` read the matching public action. Coordinator
credentials keep their own implementations. Recorded differences from the
pre-public tools:

- Request keys live in the public operation store under the credential's
  authority, bound to the action's intent fingerprint. A `launch_environment`
  or `create_ticket` retried with a key first used before this change is not
  matched to its earlier result.
- `send_prompt_to_tab` refuses a busy or waiting session with `busy`, as
  `session prompt` does; it never queues or steers.
- `launch_job` creates the tab without focusing it (`session.start` never
  activates a tab).
- `update_ticket` accepts an optional `requestId` for retries. Without one,
  each edit gets a fresh key, so repeating an earlier edit after an intervening
  change applies it again. Reusing an explicit key replays its original receipt.
- `send_message` returns `{id, toEnvironmentId, toTabId, placement}` and a
  receipt instead of the whole stored message record.
- Errors are structured envelopes (`isError` with a public `error.code`)
  rather than thrown messages.
- The other reads (`get_launch_options`, `list_environments`,
  `get_environment`, `list_tabs`, `list_agents`, `get_tab_state`,
  `get_tab_transcript`) keep their registry projections: they return pane,
  terminal-tab and launch-default details the public reads do not carry, and a
  read has no request key or intent to diverge on. They are listed only when
  the credential may call the matching public read.

Discovery summaries, native-tab resolution, launch options and selection
validation live in `apps/backend/src/core/control-shared-actions.ts`, shared
with the public CLI contract ([public-cli.md](public-cli.md)); this adapter
keeps its tool formatting, annotations and coordinator scope.
Model, effort and agent fields are optional. Leaving them out runs the user's
saved defaults, and the tool descriptions tell callers to set them only when the
user asks for a specific choice. `get_launch_options` returns those defaults in
`defaults` and marks each agent's default model with `isDefault: true`.
`launch_environment` and `launch_job` report the resolved
`selection: { agent, model, reasoning, source: "default" | "requested" }`.
`start_build_pipeline` accepts optional `steps`, `reviewers` and
`reviewPreparation` overrides and reports what it started the same way.
[coordinator.md](coordinator.md#launch-defaults) lists what each omitted field
resolves to.
`launch_environment` binds its `requestId` to a fingerprint of its creation
intent: retrying with the same content returns the same environment, and
reusing a `requestId` for a different launch is rejected rather than silently
returning the first environment.

Control-MCP messages are always classified as external and are never injected
into an agent turn. The destination's user can inspect and acknowledge them in
the global inbox. `send_message` requires a stable `requestId`; retrying the
same request with different content is rejected.

## Leaf nodes

Connected to a command node ([command-nodes.md](command-nodes.md)), an
operator credential acts on every leaf node it controls with the same tools,
results and codes as on the command node itself. The CLI's `--node` is the
same mechanism ([public-cli.md](public-cli.md#leaf-nodes---node)).

- **Discovery.** `list_nodes` (or `node_list`, `run_action node.list`) names
  this node and each leaf: availability, link state, version, and whether it
  can take public actions (`publicActions`, with a `reason` when not). It never
  returns routes, addresses or credentials. A node in leaf mode lists only
  itself and `controlledBy`. It needs `discovery`, like `project.list`.
- **Targeting.** Every direct tool except `node_list`, `run_action`,
  `run_status`, every voice core tool, and every original tool takes an
  optional `nodeId`; omitted means this node. Public actions carry it as
  `request.node`; the original tools' registry reads (`get_launch_options`,
  `list_environments`, `get_environment`, `list_tabs`, `list_agents`,
  `get_tab_state`, `get_tab_transcript`) go through `invoke_on_node` after the
  node is checked against `node.list`. Session handles, environment and
  project IDs are the leaf's own; results from a leaf carry `nodeId` and `node`
  (the public envelope's `node` field).
- **Aggregates.** `nodeId: "all"` on `project_list`, `environment_list`,
  `attention_list`, `list_projects`, `list_environments`, `overview` and
  `resolve_target` reads this node and every node it controls. Each item is
  tagged with `nodeId` and `nodeName`; `nodes` reports each node's total,
  cursor or error. List adapters retain healthy results and unavailable-node details;
  composed voice summaries and target resolution report an error when a machine
  could not be read. List helpers drain each node's pages independently. Attention
  applies `limit` per node and returns every fetched item, so its cursors cannot
  advance past an omitted event. Cursors
  are per node, and a `projectId` names one node's project, so both refuse
  `all`. `resolve_target` with `all` reports ambiguity across machines rather
  than picking one, and returns the match's `nodeId` in `ids`.
- **Security.** The listener stays loopback-only, and every check runs on the
  command node before anything crosses the link: the credential's profile and
  capabilities (`controlMcpActionAllowed`), the request-key rule and
  confirmation. A confirmation names the node ("… on Studio") and its token is
  bound to it: a token issued for one node is refused (`mismatch`) on another.
  The leaf still enforces its own rules.
- **Authority across the hop.** The command node sends the request with
  `relayedAuthority: {controllerId, authority}`. The leaf accepts it only for a
  command node attached to it, from a caller holding its gateway token (who
  could act as the operator anyway, so the claim can only narrow), and
  records the operation under
  `node:<commandNodeId>/control-mcp:<credentialId>`, so a credential's request
  keys, receipts (`run.get`, `run.*`) and attention items on the leaf are its
  own, and operator-only rules (`project.remove --cascade`) stay operator-only
  there. The CLI and the app remain the operator on both.
- **Idempotency.** The leaf admits the `requestId`; the command node keeps no
  copy. Retrying the identical call with the same `requestId` replays the
  leaf's receipt, and reusing it for a different intent is
  `request-conflict` there.
- **Codes.** `node-not-found` (exit 3), `node-unavailable` (4: disabled or not
  connected; nothing was sent), `node-unsupported` (8: the leaf predates
  `public-action-relay` in its hello, so nothing is sent to it rather than run
  as the operator; or this node is itself a leaf), and `node-outcome-unknown`
  (7: the link lost a mutation's answer; it is recorded in the node outcome
  ledger, never resent, and the same `requestId` learns its outcome). Tools
  over public actions return them in the envelope; the original tools' routed
  registry reads report them as errors whose text starts with the code.
- **Coordinators** keep their own project-scoped `nodeId` tools
  ([command-nodes.md](command-nodes.md#one-tool-family-every-node)).

## Agent mailbox credential boundary

An agent-tools credential is scoped either to one tab or to one environment.
A tab credential can act only as that tab. An environment credential authorizes
the agent mailboxes inside that environment: when there is one pull-capable tab
the backend resolves it automatically; when there are several, the caller must
claim a live pull-capable tab id on each messaging call. This does not widen the
trust boundary—sibling tabs already share the project, environment, worktree,
and user—and claims outside the environment or for non-agent tabs are denied.

## Project coordinator credentials

The project Coordinator uses the same HTTP endpoint with a separate,
backend-issued credential. That credential is ephemeral and bound to one
project, coordinator workspace, conversation, and mailbox incarnation. It is
written only into the trusted bridge runtime configuration; it is not returned
to the renderer or stored in a transcript. Closing the conversation revokes the
credential and stops that conversation's bridge. A backend restart reaps the
old bridge and issues a new credential on reattachment.

A coordinator's `tools/list` is filtered by its capabilities the same way
its `tools/call` is refused, so a side agent (`discovery` and `mail`) no
longer sees launch or workflow tools it could never call.

Coordinator calls are checked again at the command boundary. Discovery is
limited to the bound project, environment and workflow mutations must target a
disposable worker in that project, and the credential cannot dispatch arbitrary
backend commands, change application settings, merge/delete the root checkout,
or mint credentials. Repository branch switching and synchronization are UI-only
backend actions and are not MCP tools.

In addition to the ordinary discovery tools, a coordinator can start/stop
workers, launch a job, start and control a structured build pipeline, start/get/
cancel/address a multi-review, and use durable mailbox read/send/ack operations.
`launch_multi_review` and `start_multi_review` take optional `autoFix` and
`autoPr` booleans. Omitted, they use the user's saved Multi Review settings, as
the button does; a coordinator sets them only when the user asks. With both on
the review runs consolidation, then Fix, then a PR session, and the PR never
precedes a completed Fix. With `autoPr` on, a consolidation with nothing to fix
starts the PR session directly. No tool merges. The launch result's `selection` and
`get_multi_review`'s `automation` report the effective settings and the next
step; see [`coordinator.md`](coordinator.md#complete-application-actions).
Environment launch requires an explicit base branch and immutable 40-character
commit. The association between request, coordinator, worker/workflow, and base
revision is persisted independently of the open chat tab.

Authenticated same-project coordinator messages and worker replies are eligible
for idle delivery even when the ordinary external/peer default is inbox-only.
This exception is role-checked server-side, remains subject to pause/mute,
activity, approval, draft, incarnation, queue, and hop limits, and never treats
an injection receipt as proof that a task completed. Backend workflow
notifications use a distinct authenticated system origin and a stable outbox
message ID so restart reconciliation cannot lose or duplicate them. Besides
completion, a coordinator is sent a status notice when work it started settles
— a Multi Review ready to address or fixed, its automatic PR session started,
opened or failed, a build paused on an error, a stall, a delegated tab waiting
on input — and the tools that start a workflow
say so in their result (`delivery: "async"`); see
[`coordinator.md`](coordinator.md#status-wakes).

Agent launches, prompt dispatches, agent messages, ticket creation, comment
appends and every gateway or direct-tool mutation use a caller-provided
`requestId`. Reuse the same ID only when retrying the same action after an
ambiguous response. Ticket field updates are naturally idempotent because they
replace the specified values.

## First prompt

```text
Use the Orkestrator MCP to list my projects, environments, and tabs. Do not make
any changes yet.
```

The control MCP can be disabled before startup with
`ORKESTRATOR_CONTROL_MCP_DISABLED=1`.
