# Agent engine architecture

Status: Living — six-engine architecture; keep aligned with the tree.

Orkestrator provisions six coding-agent platforms. They are listed once, in
`packages/protocol/src/agent-platforms.ts`, and everything else keys off that
list:

| Platform | Label | Integration |
| --- | --- | --- |
| `claude` | Claude Code | Bridge process wrapping the Claude Agent SDK |
| `codex` | Codex | Bridge process speaking JSON-RPC to `codex app-server` |
| `opencode` | OpenCode | No bridge — the backend drives `opencode serve` through the SDK |
| `cursor` | Cursor Agent | Bridge process wrapping `@cursor/sdk` |
| `grok` | Grok Build | Bridge process speaking ACP to the CLI over stdio |
| `pi` | Pi | Bridge process wrapping the Pi coding-agent SDK |

They do **not** share one mechanism. Each vendor exposes a different surface —
a TypeScript SDK, a JSON-RPC app-server, an HTTP server, or a raw stdio
protocol — and Orkestrator adapts each one rather than pretending they are
interchangeable. What *is* shared is the shape around them.

## The shape every engine has in common

Read `AGENTS.md` first — the background-reliability and transport invariants it
lists are the reason these engines are built the way they are. In short:

1. **The backend owns the process, not the renderer.** `apps/backend/src/core/commands.ts`
   spawns every bridge and server, keyed by environment id, and keeps them alive
   across tab switches and component unmounts. A React tree unmounting means
   "not currently visible", never "cancel the work".
2. **One process set per environment.** Environments differ in filesystem,
   container, `PATH`, credentials, and installed toolchains, so they never share
   an agent process.
3. **Every child is authenticated.** The backend generates a 32-byte token per
   environment and passes it in as `CLAUDE_BRIDGE_TOKEN`, `CODEX_BRIDGE_TOKEN`,
   `CURSOR_BRIDGE_TOKEN`, `ACP_BRIDGE_TOKEN`, `PI_BRIDGE_TOKEN`, or
   `OPENCODE_SERVER_PASSWORD`. A missing or blank token
   makes a bridge fall back to a random value nobody holds, so it fails closed
   rather than open. The Claude and Codex bridges delete the variable from
   `process.env` after reading it, so a spawned agent child cannot inherit the
   bridge's own credential.
4. **Live events are incremental updates over authoritative snapshots.** Each
   engine exposes both a stream and a way to re-read current state, because a
   tab that was inactive must be able to catch up from the snapshot instead of
   depending on an event it never received.
5. **Approvals fail closed.** Timeout, disconnect, a malformed answer, or the
   death of the process that asked all deny. None of them approve.
6. **Managed executables are pinned and hash-verified.** `packages/toolchain/src/manifest.ts`
   pins each managed binary; the backend passes the resolved path down
   (`CLAUDE_CLI_PATH`, `CODEX_PATH`, `ACP_AGENT_PATH`) so a packaged app never
   depends on a `PATH` lookup. See [`docs/development/upgrade-agents.md`](../development/upgrade-agents.md)
   for the bump procedure.

The renderer reaches a bridge over HTTP and SSE — directly on loopback when it
runs inside Electron, and through the gateway's authenticated loopback proxy
when it runs in a remote browser.

## Closing a tab retains the conversation

Closing a native agent tab releases what Orkestrator holds for it and keeps
the conversation resumable on every platform. Four operations stay distinct:

| Operation | Execution | Bridge mapping / resources | Vendor history |
| --- | --- | --- | --- |
| Unmount / switch away | Continues | Kept | Kept |
| Idle detach | Already idle | Expensive handle released, identity kept | Kept |
| Tab close | Owned work stopped, parked approvals denied | Mapping retired, resources released | **Kept** |
| Explicit delete | Provider-specific | Removed | Deleted where supported |

Tab close is `POST /session/:id/close` on every bridge. It answers 200
`{closed:true,retained:true}`, or 200 `{closed:true,missing:true}` for an id it
does not hold (never 404), or 503 `{closed:false,pending:true,error}` when it
cannot prove the work stopped — in which case the session stays registered.
The backend (`commands-registry-teardown.ts`, `bridge-session-close.ts`) keeps
its durable teardown intent until a 2xx arrives. A 404/405 from the route
means the bridge predates it: the backend may then use a legacy
`DELETE /session/:id` only for platforms whose DELETE has never deleted history
(`LEGACY_DELETE_RETAINS_HISTORY`: Codex, Pi, Grok, Cursor). Claude's DELETE
calls the SDK's `deleteSession`, so an old Claude bridge leaves the close
pending with a "restart the environment" error instead.

Only a 2xx whose body affirms `closed: true` confirms a close; an empty or
malformed 2xx leaves the intent pending. Pending intents are retried at
startup and by the backend's coalesced 60-second sweep, with a per-intent
backoff (30 s, doubling, capped at 15 minutes) so a bridge that keeps refusing
is not polled every minute. The old-Claude-bridge failure carries a stable
`bridge-upgrade-required` marker (`@orkestrator/protocol/tab-teardown`), and
the renderer shows one non-destructive toast per environment asking the user
to restart it; the conversation is not deleted and the close is retried.

Per bridge, "stop proven" means:

- **Claude** — every owned `Query.close()` returned within a 10-second budget
  and any racing prompt-dispatch claim settled. Otherwise 503, and the session
  stays registered with its `deleting` claim so prompts and DELETE are refused
  until a retry completes the close.
- **Codex** — the last-reference turn is interrupted and terminal (an
  in-flight `turn/start` is waited for and then interrupted), approvals are
  denied, and the removal tombstone is written before the thread is
  unsubscribed. A failed tombstone write answers 503 with the session, its
  record and its subscription intact. From the start of close until it is
  confirmed, prompt, steer, compact and review answer 409 `Session is closing`.
- **Pi, Cursor** — see their bridge sections; both answer 503 until owned work
  has stopped and the removal is published.
- **Grok (ACP)** — see [Grok Build](#grok-build).

OpenCode has no bridge. Tab close goes through the native agent service to the
cached (or freshly peeked, never started) `OpenCodeProvider.closeSession`: it
aborts the owned turn through the same path as a user stop, which settles
workflow-turn ownership; restores temporary reviewer permissions; rejects every
permission and question still pending for that session (neither the pinned SDK
nor the server docs promise that abort withdraws them, so close fails closed);
treats a 404 on abort as a session already gone; and forgets the provider's
registration. OpenCode's `DELETE /session/:id` removes the session and all its
data and is not used, so the conversation stays in `session.list` for resume.

When two tabs map the same provider session, closing one retires only its
mapping; the last one performs the close. Teardowns are serialized per
(environment, agent, provider session), so two such tabs closed together (or a
close racing the reconcile sweep) cannot both skip the provider close.
A tab that Multi Review's "Open session" opened on one of its workflow's
current sessions (a step's or a reviewer's, `multiReviewOwnsProviderSession`)
is closed the same way: only the tab's mapping goes, and the session keeps
running in the background for the supervisor. Closing the Multi Review itself
closes those sessions and removes their `multi-review-review:<workflow>:` tabs;
a session a restart superseded is no longer the workflow's and closes with its
tab. `NativeAgentRuntimeProvider.closeSession` has the same non-destructive meaning
for every caller (Multi Review included).
New teardown intents carry a `retain-history-close:` session-id fence
(`fenceRetainingCloseSessionId`, `packages/protocol/src/tab-teardown.ts`). A
backend refuses an intent whose session id differs from the tab's mapping, and
clears one with no mapping without a provider call, so an older backend reading
a new intent after a downgrade never replays it as a DELETE. Intents written
before the close route existed (a bare id) are replayed with the close route,
never with the DELETE their writer would have sent. A downgrade does restore
the old per-provider semantics for *new* closes (an old Claude bridge's DELETE
deletes history), and history that pre-retention builds already deleted cannot
be recovered.

A tab opened from **Resume Session** (an unassigned tab, then a platform)
creates no provider session while its picker is open: the backend resumes into
a tab with no mapping, and the tab starts its own session only if the picker is
dismissed or the resume fails. The resume then sends no composer controls, so
the conversation keeps its own settings. Before, every such resume created an
empty conversation (one more row in OpenCode's and Grok's stores, and briefly a
Grok agent process) and closed it again.

Claude's bridge re-adopts a closed rollout as an idle session when
`/session/list` reconciles the SDK listing. That is history discovery, not a
resurrected tab: the backend mapping is gone, so nothing polls or reopens it
until the user resumes it.

### Who calls close

| Caller | Intent | Behaviour |
| --- | --- | --- |
| `teardown_tab` for a `*-native` tab | Close one tab | Bridges: `POST /session/:id/close`. OpenCode: `closeProviderSessionIfRunning` on the native agent service (never starts a server). Mapping retired on confirmation |
| `reconcile_tab_teardowns` (startup and the 60-second sweep) | Finish an earlier tab close | Same close |
| `reconcile_orphaned_tab_resources` (tabs no pane layout references, after a one-hour grace) | Release ownership nobody holds | Native tabs (including a startup agent session) go through `teardown_tab` |
| `teardown_tab` for `terminal` / `claude-tmux` | Stop a terminal process | Kills the process; the tmux Claude CLI keeps its own JSONL |
| `resume_native_agent_session` replacing a tab's session | Release the session the tab no longer shows | `provider.closeSession` after the resume is adopted, under tab teardown's lock and last-owner rules; skipped while another tab maps it or a Multi Review owns it. Journaled first as a teardown intent keyed `resume-replaced:<agent>:<digest>` (`replacedSessionCloseIntent`, `provider-session-ownership.ts`) and cleared on a confirmed close, so a pending or failed close is replayed by `reconcile_tab_teardowns` under the same rules. A tab opened only to resume creates no session of its own, so this replaces a session only when the tab had started one |
| `reconcile_tab_teardowns` on a `resume-replaced:` intent | Finish a replaced session's close | Same close, without the tab-mapping checks (the backend wrote the id) and without revoking a tab credential. `teardown_tab` refuses that key prefix |
| `MultiReviewService` cleanup | Remove a finished workflow and its tabs | `provider.closeSession`, so reviewer and fix conversations are kept |
| `close_coordinator_conversation` | Close a coordinator conversation | Stops the projection and that conversation's bridge, revokes its credentials, invalidates the mapping. No DELETE |
| `delete_environment` | Remove an environment | Stops processes, removes mappings, worktree or container. No provider DELETE; history inside a removed container goes with it |
| Native agent reconcile on an authoritative `missing` | Drop a mapping whose provider session is gone | Mapping only |

Claude's `DELETE /session/:id` (SDK `deleteSession`) is the only destructive
operation and nothing in the backend or renderer calls it.

## What survives a restart

"Bridge restart" means the bridge process dies and a successor starts on the
same state directory; "backend restart" means the backend restarts while
bridges keep running. Backend stores are rows in `orkestrator.sqlite`
([storage.md](storage.md)).

| Record | Owner | Bridge restart | Backend restart |
| --- | --- | --- | --- |
| Logical tab → provider session mapping | Backend `native-agent-sessions` store | Kept | Kept |
| Tab teardown intent | Backend `environments` store, `tabTeardownIntents` | Kept | Kept; replayed by `reconcile_tab_teardowns` |
| Parked prompt or steer with an unknown outcome | `pendingDispatch` on the native session record (`storage-native.ts`), with retry and discard controls | Kept; a prompt the restarted bridge reports `lost` is retired without a click | Kept |
| Last retired dispatch (content-free `requestId`, `retiredAt`) | `retiredDispatch` on the native session record, projected as `retiredDispatch` plus a warning notice | Kept | Kept; replaced by the next one, cleared by the next accepted dispatch, hidden after 24 hours |
| Compose draft (text, attachments, metadata) | Backend `compose-drafts` store; the renderer copy is a cache | Kept | Kept |
| Cursor session identity, prompt and steer journals, steer fence, rendered transcript | `CURSOR_BRIDGE_STATE_DIR/state.json` | Kept; unfinished prompts reload as `ambiguous`, transcripts may be shed with an explicit truncation base | Unaffected |
| Cursor closing state | `closing` tombstones in `state.json` until the removal is published | Tombstone kept; close finished on start | Unaffected |
| Cursor attach promise, dispatch claim, cancel handle, parked cancel | Bridge memory | Lost | Unaffected |
| Pi session pointer, journals, rendered transcript | `PI_BRIDGE_STATE_DIR/state.json`; the conversation is Pi's own JSONL file | Kept | Unaffected |
| Pi prompt claim and parked cancel | Bridge memory (`promptClaim`, `cancelRequestedClaim`) | Lost; an unfinished prompt reconciles through its ambiguous journal entry | Unaffected |
| Codex thread registry and dispatch journal | `sessions/persistence.ts`, `sessions/dispatch-journal.ts`; the rollout belongs to `codex app-server` | Kept; `prepared` reads as unknown | Unaffected |
| Claude session identity and dispatch journal | Bridge preferences file (`session-manager-persistence.ts`); the conversation is the SDK's `{sessionId}.jsonl` | Kept | Unaffected |
| Grok session state and journal | `ACP_STATE_DIR`; unfinished entries reload as `ambiguous` | Kept | Unaffected |
| OpenCode session and history | The OpenCode server; the backend holds registration and subscriptions in memory | No bridge | Registration lost; the session persists on the server |
| Transcript cursor | Request state; bridges answer from `droppedMessages` plus the retained window | A restart changes the window; an invalid cursor falls back to the retained window | Unaffected |

## Activity observation

The backend's activity sweep (every 2 s) is the one observer of whether a
session is busy; everything else reads its shared observation. What each
provider offers it is `NATIVE_AGENT_OBSERVATION_CAPABILITIES`
(`apps/backend/src/core/native-agent-observation.ts`). The columns that drive
policy:

| Provider | Activity read | Idle backend wakeup | Client idle backoff | Idle view changes without a transition |
| --- | --- | --- | --- | --- |
| Claude | Bridge `/activity` (batched) | Bridge observation stream (`/event/subscribe?observe=1`) | Only while `turn.quietObservation` | Background tasks; announced from `contentRevision` |
| Codex | Bridge `/activity` (batched) | Bridge observation stream (`/event/subscribe?observe=1`) | Only while `turn.quietObservation` | Async questions, late command changes; announced from `contentRevision` |
| Cursor | Bridge `/activity` (batched) | None: every sweep | Yes | No |
| Pi | Bridge `/activity` (batched) | None: every sweep | Yes | No |
| Grok | Bridge `/activity` (batched) | None: every sweep | Yes | No |
| OpenCode | Event-fed batch in the backend | SDK event stream | Yes | No |

A wakeup only makes a stably idle group due; the sweep's no-touch read stays
the source of truth, and a group without a live wakeup is read on every sweep.
Client backoff also needs a backend that advertises stamped announcements. The
announcements and the client side are in
[event-snapshot-recovery.md](event-snapshot-recovery.md#native-observation-invalidations);
cadences and budgets are in [recurring-work.md](recurring-work.md).

## Claude Code

**Bridge:** `bridges/claude-bridge/` · **Transport:** HTTP + SSE (Hono)

The bridge wraps `@anthropic-ai/claude-agent-sdk` and exposes it as a REST
surface: `POST /session/create`, `POST /session/:id/prompt`,
`GET /session/:id/messages`, `GET /session/:id/activity`, and an SSE stream at
`GET /event/subscribe`. `services/session-manager.ts` is the compatibility
surface — it is where the SDK's message union is normalized into Orkestrator's
own `NormalizedMessage`/`NormalizedPart` model, and it is the file to review on
every SDK bump.

Turns run through the SDK's `query()` with `includePartialMessages: true` so
partial assistant output streams as it arrives. Continuation uses the SDK's own
`resume` with the stored `sdkSessionId` rather than replaying the transcript.
The SDK is pointed at Orkestrator's managed executable through
`pathToClaudeCodeExecutable`.

Permission handling defaults to `bypassPermissions` for an interactive tab,
which is a deliberate choice: an Orkestrator agent tab is an interactive session
in an isolated environment. `plan` mode is the read-only alternative, and the
SDK's `canUseTool` callback is what routes a tool request back through the
bridge's approval flow when one is raised.

Background shell commands are bounded. Since Claude Code 2.1.285 an Agent SDK
session stops a `run_in_background` command at its `timeout` (30 minutes by
default, 2 hours at most) and reports a `stopped` task notification saying why;
interactive terminal sessions have no such limit. The CLI raises that ceiling to
`BASH_MAX_TIMEOUT_MS` when the variable is larger, so the Claude settings pane's
**Background task time limit** (`claudeBackgroundCommandLimitHours`, 2–168
hours) is delivered to every local and container Claude bridge as that variable
when the bridge starts. At the default it is left unset, because the same
variable also lifts the CLI's 10-minute foreground ceiling; a running bridge is
not replaced to apply a change, since that would stop the very commands the
setting protects. A dev server Claude starts in a native tab therefore does not
run indefinitely, and the bridge's appended system prompt states the effective
limits (`services/background-commands.ts`) and tells Claude to hand longer-lived
servers to an Orkestrator terminal tab instead.

Claude also has a second, unrelated execution mode: `apps/backend/src/core/tmux.ts`
drives the Claude Code CLI inside a tmux session and observes its terminal
output. That path does not use the bridge or the SDK at all.

## Codex

**Bridge:** `bridges/codex-bridge/` · **Transport:** JSON-RPC over private stdio

The bridge supervises exactly one persistent `codex app-server --stdio` child
per environment and speaks JSON-RPC to it — `thread/start`, `thread/resume`,
`thread/read`, `thread/fork`, `thread/list`, `thread/unsubscribe`, `turn/start`,
`turn/steer`, `turn/interrupt`. One child serves every Codex tab and build phase
in that environment, which makes it a shared failure domain, so most of the
bridge exists to make that survivable:

- **Generations.** `app-server/process-supervisor.ts` stamps a monotonic
  generation on each child. Anything arriving from a dead generation is
  discarded, so a late event can never overwrite state owned by a newer process.
- **Ambiguous failures are not retried.** In-flight requests fail *ambiguously*
  rather than being replayed. Only an explicit `-32001` overload proves a turn
  did not run; anything else reconciles against persisted turns via
  `sessions/dispatch-journal.ts`, which is what makes prompt dispatch
  at-most-once.
- **A circuit breaker,** rather than restarting forever: five start failures
  within 60 s open it. After a quiet 5-minute cooldown the next demand gets
  one probe start (half-open, no retries behind it); success closes the
  breaker, failure re-opens it with the cooldown doubled up to 30 minutes.
  The backoff sleep between start attempts wakes on `stop()`, so shutdown
  never waits it out. Plus an environment fingerprint that forces a
  controlled restart when the developer's `PATH` changes.
- **A pidfile and process-group termination,** so orphaned children cannot
  outlive the bridge and race over the same `CODEX_HOME`.

The transport is the other load-bearing constraint. app-server's outbound queue
is bounded, so the stdout read loop never awaits rendering, an SSE write, or any
other consumer — notifications go to a per-thread serial queue and fan out from
there. A slow consumer on one thread therefore cannot stall every other thread
in the environment.

SSE frames carry `id: <revision>`, and `event-ring.ts` keeps a bounded replay
buffer so a reconnecting client can ask for exactly what it missed. The
`connected` frame echoes the client's own cursor rather than the latest
revision, because a browser `EventSource` adopts every id it sees.

Idle threads are detached (`thread/unsubscribe`, state freed) and transparently
re-attached on the next request. `thread/delete` is never called: closing a
session unsubscribes, whereas deleting would destroy the user's rollout. Tab
close (`POST /session/:id/close`) additionally confirms that a last-reference
turn has actually stopped before releasing the thread.

Calls a sandbox refuses are the one thing the item stream leaves out. The
models Codex serves run in code mode, so the model sends a JavaScript `exec`
cell that calls `apply_patch` or `exec_command`. Under a `read-only` or
`workspace-write` sandbox, app-server emits no item for a rejected patch, nor
for a failing command whose output looks like a sandbox denial. The model is
still told, and usually says the call was denied. `sessions/refused-cell-tail.ts`
reads the active turn's records from the rollout app-server reported
(`thread.path`) and shows such a cell as a failed `exec` row, the same row a
reload builds from that record. A cell whose calls already have rows is
skipped unless its output reports a refusal.

A Codex turn runs the model in its session's config; the prompt carries no
model. Two rules in `apps/backend/src/core/session-held-model.ts` keep the
picker and the run on the same model:

- **New sessions.** A session created on an inherited default that the login's
  live `model/list` does not offer starts on the picker's first model, the same
  row the picker would show. The user gets a toast, Build stages record a
  `modelSubstitution`, and the setting is not changed. A pinned or explicit
  model is kept. Availability is the complete list, including models hidden
  from the picker (`includeHidden`), returned as `supportedModelIds` by
  `/global/models`. The bridge reads `model/list` on every request rather than
  keeping it for the process lifetime, so a login change cannot leave the old
  account's list counted as live. The bridge's cache or fallback catalogue, a
  response without `supportedModelIds`, or a list longer than the page bound is
  never grounds for a swap.
- **Existing sessions.** If a session holds a model the picker does not list,
  the picker shows that model, labelled "session model", instead of the first
  catalogue row. The label makes no claim about the login, because the
  durable catalogue does not record where it came from. Picking any listed
  model replaces it.
  The renderer keeps that row when a later discovery update replaces the
  composer's models with the bare catalogue
  (`withRetainedSelectedModelRow` in `useNativeAgentSession.ts`).
- **A dispatch that names another model.** A `dispatch_native_agent_prompt`
  or Control MCP `model` that differs from the session's stored model is
  applied the way a model pick is, a control update persisted under the session
  lease and sent to the bridge, before anything is journaled
  (`native-agent-dispatch-model.ts`, keyed on the platform policy's
  `runsSessionHeldModel`). A model the live `model/list` positively does not
  offer is refused with the draft kept, naming a model to pick instead. An
  inherited default (`modelSource: "default"`) never changes the session.

The bridge's `POST /session/:id/config` replaces the whole session config: a
field left out resets (mode to Build, fast tier off). The backend therefore
reads the current config and restates every field a control update leaves
alone (`updateCodexSessionConfig` in `http-bridge-codex-config.ts`). A model
change without an effort drops the old model's effort, so Codex applies the
new model's default.

Codex's reasoning summary (`summary`) and `personality` are not offered.
`model/list` reports no summary support, and upstream deprecated
`personality` (`supportsPersonality` is always false). Codex's own
`config.toml` still applies to both.

`session-titles.ts` is the one deliberate exception to all of the above — it
still spawns a hermetic `codex exec` with a custom model catalog, a read-only
sandbox, and user config ignored, so title generation cannot inherit the user's
tools or instructions.

### Project Coordinator

A Coordinator conversation is project-owned, not an environment disguised as a
local worktree. Its durable owner is `{ kind: "coordinator", projectId,
coordinatorId }`; provider processes, projections, queues, transcripts, and mail
use a distinct `coordinator:` runtime namespace. Each conversation gets its own
bridge so its scoped MCP/mail credential cannot be shared with a sibling tab.
Unmounting the project page does not stop that backend-owned runtime.

Coordinator qualification lives in one table,
`apps/backend/src/core/coordinator-providers.ts`. Every gate (workspace
service, runtime resolver, bridge launcher, trusted session input) consults it.
A conversation has no agent until the first prompt; that send binds the
conversation to one platform.

Default tiers:

| Tier | Meaning | Platforms |
| --- | --- | --- |
| `enforced` | The provider or the OS blocks mutation whatever the agent attempts | Codex; Claude where its command sandbox can start; Pi |
| `provider-configured` | The SDK is told to deny, with no independent verification | OpenCode; Cursor; Claude when the sandbox cannot start |
| `advisory` | The agent is asked to request permission first; a tool that does not ask is not stopped | Grok |

**Settings → Agent platforms → Coordinator safety level** chooses the weakest
tier this install will offer. It defaults to `provider-configured`, so Grok
stays opt-in. There is no silent fallback or provider substitution.

Delegation is derived, not declared: the platform must have an MCP client
*and* a mailbox that can inject replies. Native Claude, Codex, OpenCode, Pi,
Cursor, and Grok all have both, so delegation follows. Cursor and Grok
receive a per-tab `agentMcp` on create/prompt like Claude and Pi; the
process-env token is only the fallback.

The conversation always receives a trusted `coordinator-read-only` execution
policy. Codex additionally selects a per-conversation permission profile on
restored sessions and every turn: filesystem denied except the project and
managed Codex runtime, shell network off, hosted web search off or `cached`
per the research setting (read back through `config/read` before every
thread), isolated `CODEX_HOME` holding only the credential, project hooks and
plugin/browser paths disabled. Claude uses the SDK command sandbox, with
writes to the checkout denied, plus a read-only shell allowlist, with WebFetch
denied (and WebSearch unless research is on). Pi's gate runs inside the bridge
on every tool call. The injected MCP servers are the scoped Orkestrator
endpoint and, on every platform but Grok, the remote research servers the user
listed. The renderer stores pasted attachments outside
the checkout and hides mode/permission controls, resume/fork, and
file-rewinding actions; the backend independently rejects write-capable
history actions.

The working directory is the canonical `Project.localPath`. Bridge state and a
fresh coordinator `CODEX_HOME` live under application data, and initialization
does not run project setup scripts, dependency installation, environment-file
copying, or repository hooks. Git fetch/sync/switch is implemented by a separate
backend service, serialized by canonical repository root, and blocked while a
coordinator turn or another repository mutation is active. Sync is fast-forward
only with rebase/autostash disabled; switching never forces an occupied or dirty
worktree. Every successful or externally detected branch/HEAD change increments
the repository-context revision included before the next coordinator turn.

## OpenCode

**Bridge:** none · **Transport:** HTTP + SSE via `@opencode-ai/sdk/v2/client`

OpenCode is the exception: it ships its own HTTP server, so Orkestrator does not
interpose a bridge process. The backend starts `opencode serve --port <port>`
for the environment and talks to it directly.

Every local server, and the short-lived catalogue and sign-in servers, opens
the user's one `opencode.db` under XDG data. Two opening it in the same moment
can lose one to SQLite's "database is locked", which exits the server before it
is healthy. `opencode-host-start.ts` therefore lets one host server start at a
time, from spawn until healthy or exited, and a local start whose server exits
reporting a locked database is retried twice (0.5 s, then 2 s) before the
dispatch that asked for it is refused with that reason. Container servers have
their own database and are not serialised.

`apps/backend/src/core/native-agent-provider.ts` is where the split happens —
`createNativeAgentProvider()` returns an `OpenCodeProvider` for `opencode` and
an `HttpBridgeProvider` for every other platform. Both satisfy the same
`NativeAgentRuntimeProvider` contract in `agent-provider-contract.ts`, so
callers (interactive tabs and build pipelines alike) do not branch on platform.
`apps/backend/src/core/build-pipeline-provider.ts` re-exports a deliberately
smaller slice of that contract for pipeline code.

### Why OpenCode has no bridge

The other bridges exist because their vendor surface is an in-process SDK or a
stdio child; the bridge supplies the long-lived process, the authenticated HTTP
surface and the session state. `opencode serve` already is a long-lived,
password-protected HTTP + SSE server with its own persistent session store, and
its at-most-once evidence (a request marker in its own history) is durable. A
bridge in front of it would add a process and a hop per environment, a second
copy of session state, and the full bridge route contract, while the
translation code would only move, not shrink.

The trade-off is fault isolation: SDK and SSE-client failures surface in the
backend process rather than in a disposable bridge (see the patched SSE client
below). Revisit the decision if that recurs. Until then, treat
`OpenCodeProvider` as an in-process bridge and keep the boundary as strict as
an HTTP one:

- Shared native-agent code (`native-agent-service-*.ts`) does not branch on
  `agent === "opencode"` or import `opencode-*` modules
  (`agent-provider-boundaries.test.ts` enforces both). OpenCode-specific policy
  is reached through a provider-neutral seam selected per platform, and the
  service hands `createNativeAgentProvider` a neutral
  `NativeAgentProviderEnvironment` (environment id, data directory, config
  reader) from which `opencode-provider-environment.ts` derives OpenCode's
  shell-change journals and model-provider allowlist.
- The renderer does not talk to `opencode serve` and does not normalize
  OpenCode messages; it receives the same normalized projections and
  transcripts as every other platform.

Always use **v2** of the SDK (`@opencode-ai/sdk/v2/client`). v2 takes flat
parameters — `client.session.promptAsync({ sessionID, parts })` — where v1 took
nested `{ path, body }` objects, and the question APIs
(`client.question.list/reply/reject`) exist only in v2. Only the backend talks
to `opencode serve`; the renderer has no OpenCode client. Build-pipeline and
Multi Review transcripts are stored raw and normalized for display on the way
out (`apps/backend/src/core/opencode-display-transcript.ts`), so the renderer
carries no OpenCode normalizer. It accepts entries with display-row fields
(`role`, `content`, or a `parts` array) and groups entries with none of those
fields into a generic unrecognized-format notice suggesting an update of the
older peer. The named pre-2.19.17 raw-envelope guard is retired; an envelope
with a `parts` array follows the ordinary display-row path
([remote-gateway.md](remote-gateway.md#version-reminders)).

Because the server is the vendor's rather than ours, the SSE event vocabulary is
theirs too: `message.updated`, `message.part.updated`, `session.updated`,
`session.error`, `question.asked`, `question.replied`, `question.rejected`.
The SDK and CLI are pinned to the same exact version, and
`tests/unit/version-drift.test.ts` enforces that they agree.

Attachments travel as `file` parts (`openCodePromptParts` in
`opencode-provider-helpers.ts`), and OpenCode routes a `file://` part by its
declared MIME type alone: `text/plain` runs its Read tool (text inline, images
and PDFs as attachments, binary refused in a message the model still gets), an
image type is decoded as an image, and anything else is inlined as a data URL.
`openCodeAttachmentMime` therefore labels a non-image file `text/plain`; a text
file once labelled `image/png` failed decoding after `promptAsync` had
returned 204, and OpenCode stored no message. Such a background failure
reaches the backend only as a `session.error`; `OpenCodeStreamState` keeps the
first one after each dispatch (`dispatchFailure`), and
`readOpenCodeTurnTerminalError` settles the request `failed` with it when the
history holds no message for the request.

### Maintaining the OpenCode integration

The v2 SDK uses flat parameters instead of nested `path`/`body` objects:

```typescript
// v2 (CORRECT)
await client.session.create({ title });
await client.session.messages({ sessionID: id });
await client.session.promptAsync({ sessionID: id, parts });
await client.session.abort({ sessionID: id });
await client.session.delete({ sessionID: id });
await client.question.reply({ requestID: id, answers });
await client.question.reject({ requestID: id });

// v1 (WRONG - do not use)
await client.session.create({ body: { title } });
await client.session.messages({ path: { id } });
```

`client.session.delete` is shown only for its parameter shape. It deletes the
conversation and all of its data, so tab close must never call it: ordinary
close is `OpenCodeProvider.closeSession` (abort, settle workflow ownership,
restore reviewer permissions, reject pending requests, forget the session;
`apps/backend/src/core/opencode-session-close.ts`).

**The patched SSE client.** `@opencode-ai/sdk` is patched — see `patches/`,
wired in through `patchedDependencies` in the root `package.json`. The generated
SSE client calls `reader.cancel()` from its abort handler with no `.catch`; when
a `reader.read()` is pending the body stream is already errored by the aborted
fetch, so that call returns a rejected promise nobody owns. That is what
`OpenCodeProvider.dispose()` turned into a dead backend.

Re-check the patch on every SDK bump. It still applies as of 1.19.0, the file
is generated by `@hey-api/openapi-ts` rather than hand-written upstream, and
`bun patch` fails loudly when the target no longer matches. `apps/backend` is
the only workspace that depends on the SDK (`apps/web` has no OpenCode client),
so there is one pin for the patch to cover. An SDK upgrade is incomplete until
all of the following agree on the new version:

- The `apps/backend/package.json` dependency pin.
- The root `package.json` `patchedDependencies` key and patch path.
- The filename under `patches/` and the matching entry in `bun.lock`.

Regenerate or rebase the patch against the new SDK rather than only renaming
the old file, and confirm both `dist/gen/core/serverSentEvents.gen.js` and
`dist/v2/gen/core/serverSentEvents.gen.js` still handle a rejected
`reader.cancel()`. Keep the `patches` copy before the filtered `bun install` in
`docker/Dockerfile` (see [`docker/AGENTS.md`](../../docker/AGENTS.md)).

`apps/backend/src/core/opencode-provider-dispose.test.ts` is the regression, and
it deliberately drives the real client against a real `Bun.serve` SSE endpoint:
the `eventHarness` fake in `agent-provider-test-support.ts` closes cleanly on
abort and cannot reproduce this, which is why the bug shipped.

**History paging relies on OpenCode's message cursor.** Every OpenCode step is
its own message, so a long turn outgrows the native live window by itself.
`transcriptSnapshot` names a `before` cursor at its oldest kept message and
`transcriptPage` reads `session.messages({ limit, before })` from it
(`opencode-snapshots.ts`). The backend mints that cursor the way OpenCode's
`MessageV2.page` does — base64url JSON `{ id, time }` with `time` the message's
`info.time.created`, selecting rows strictly older by `(time_created, id)` —
verified against the 1.18.35 and pinned 1.19.0 servers, not a documented
contract. Re-check it on every SDK bump; a server that rejects the cursor fails
the page read with 400, and rows a server returns that are not strictly older
than the cursor explicitly expire the page instead of claiming completion
from a filtered window. Only a message OpenCode reported can name a
cursor: not the stream's synthetic compaction row, nor a placeholder a part
event created before its `message.updated`.

The window estimate (`openCodeDisplayBytes`) must follow the projection's
deferral rules (`inlineFileUrlDisposition`): an inline payload the projection
keeps, such as a PDF, counts in full. The history epoch moves on a
`message.removed` and when a re-read after a stream gap proves history was
rewritten (`OpenCodeStreamState.markGap`/`verifyGap`), not on every reconnect.
Messages changed in place are noted in the stream state, and those before the
window travel as `revisedMessages`.

| Component                         | Purpose                                      |
| --------------------------------- | -------------------------------------------- |
| `OpenCodeProvider`                | SDK session surface and backend SSE handling |
| `OpenCodeInteractionAdapter`      | Questions and permissions                    |
| `OpenCodeStreamState`             | Bounded incremental SSE projection state     |
| `AgentNativeTab`                  | Shared native-agent chat UI                  |
| `NativeAgentQuestionCard`         | Shared question/answer UI                    |
| `NativeAgentTurnRecovery`         | Incomplete-turn continuation; OpenCode strategy in `opencode-turn-recovery.ts`, selected by `native-agent-platform-policy.ts` |

The server's SSE event types:

- `message.updated` - Message content changed
- `message.part.updated` - Streaming part update
- `message.part.delta` - Streaming text delta
- `todo.updated` / `session.diff` - Runtime summary changed
- `session.status` / `session.idle` - Session activity changed
- `session.updated` / `session.deleted` - Session metadata or existence changed
- `session.error` - Error occurred
- `session.compacted` - Context compaction completed
- `mcp.tools.changed` - MCP inventory changed
- `permission.replied` - Permission interaction resolved
- `question.asked` - AI is asking a question
- `question.replied` - Question was answered
- `question.rejected` - Question was dismissed
- `server.connected` / `server.instance.disposed` / `global.disposed` - Reconcile or reconnect

## Execution policy

The backend resolves one `NativeAgentExecutionPolicy` when it creates a native
agent session. The decision is based on the environment boundary and session
origin, with an optional per-environment override, and is persisted with the
session. Bridges receive the resolved value on `/session/create`, retain it
across detach and restart, and expose it in their authoritative snapshot. The
agent info panel renders that effective value rather than making trust decisions
in the renderer.

Interactive host sessions default to no sandbox, auto-approval, project
resources off, and full network access: every vendor sandbox holds `.git`
read-only, which stalls ordinary Git work in a worktree (#613). Container
sessions use the container as their sandbox, automatically approve inside that
boundary, enable project resources, and follow the environment network
setting. An override cannot widen the container firewall; an override that
narrows a full-network container enables a provider sandbox inside it. The
resolved policy retains `containerNetworkAccess` alongside that optional inner
sandbox, so adapters without a provider sandbox still report the outer boundary.
Pipeline runs are unattended. The coordinator always
uses the immutable `coordinator-read-only` policy regardless of an environment
override.

On Linux the Claude bridge refuses a turn that requires the CLI's command
sandbox (a `provider` sandbox, or a coordinator qualified on it) when
bubblewrap on that host cannot nest the user namespace the CLI's seccomp helper needs, as under
Ubuntu's AppArmor `bwrap-userns-restrict` profile. The prompt fails with the
probe's reason instead of every Bash call failing; see
[Claude's sandbox on Linux](coordinator.md#claudes-sandbox-on-linux).

Agent Info renders the policy's effects (`nativeAgentPolicyEffects` in
`packages/protocol/src/native-agent-policy-effects.ts`): what confines the
agent, what becomes of an action nothing pre-approved, whether repository
configuration loads, and whether its commands reach the network. It renders
them from the policy the bridge reports, and each bridge reports what it
applies. Pi, Grok and OpenCode have no sandbox, so a `provider` sandbox and the
network restriction it would hold are reported as unsandboxed with a note;
Grok reports project resources as on, because its own folder trust decides;
Cursor reports `ask` as the auto-approval it runs. Codex honours project
resources off: every thread it starts, resumes or forks pins its cwd untrusted
(a nested `projects` table in the thread config; Codex ignores a dotted
`projects."<path>"` key there) and disables each repo-scope skill from
`skills/list` in a thread-scoped `skills.config`, because the untrusted pin does
not reach skills (`codexProjectTrustConfig`, `codexProjectSkillsConfig`). That
keeps out the checkout's `.codex` config layer (MCP servers, hooks, model
settings), its AGENTS.md and its skills, wins over a trusted main checkout, and
stops a writable thread marking the project trusted in the user's
`config.toml`. `live-project-trust.test.ts` proves it against the pinned
binary. When the policy turns
project resources on, the ACP bridge launches Grok with `GROK_FOLDER_TRUST=0` and
`agent --no-leader` (`providerEnv`), so a checkout Grok never trusted, such as a
container's `/workspace`, still loads its AGENTS.md, skills, commands, hooks and
project MCP servers. Otherwise Grok skips them silently.

The execution-policy conformance suite (`tests/conformance/execution-policy/`)
keeps the two honest. Each platform's runner sends ten policy shapes through
the adapter's real option builders, captures what the SDK or CLI receives,
decodes it into the same effects, and compares them with the summary. A
deliberate difference must be stricter than the summary and listed with its
reason in `narrowings.ts`. Change an adapter's options and its runner's
decoder together.

| Adapter | Policy mapping | `network` in `capabilityPolicy.deny` (search unless `allow` names `web.search`) |
| --- | --- | --- |
| Claude | `permissionMode` and the approval callback; `allowedTools`/`disallowedTools`; `settingSources`; SDK sandbox options | WebFetch, and WebSearch unless allowed, in `disallowedTools` (`claudeDisallowedTools`) |
| Codex | `approvalPolicy`, thread sandbox and sandbox network; an untrusted project pin and disabled repo skills when project resources are off; the coordinator's verified permission profile | `web_search = "disabled"`, or `"cached"` when search is allowed, on the thread; a coordinator also sets it as process configuration and has it read back through `config/read` |
| Cursor | local SDK sandbox/auto-review; `settingSources`; `tools`/`disallowedTools`, re-applied on resume | `webFetch`, `webSearch` and `task` in `disallowedTools`; the read-only allowlist never includes `webFetch`, and includes `webSearch` only when allowed |
| Grok | `--always-approve` only for auto-approval, and under auto-approval the bridge also answers the ACP permission requests Grok still sends (allow option), except for a kind the policy denies (`autoApprovedPermissionOption`); ACP permission requests otherwise; `GROK_FOLDER_TRUST=0` and `agent --no-leader` when project resources are on, Grok's own folder trust otherwise | `--disable-web-search` and `agent --no-leader`, which remove search with fetch; an allowed search is not honoured |
| Pi | approval extension; resource-loader exclusions and project trust; active SDK tool selection | No hosted tools; the read-only gate admits only its read tools by name |
| OpenCode | session permission rules; project resources remain enabled because OpenCode owns config discovery, which is stated in the effective policy note | A deny rule for `webfetch` after every allow; `websearch` and `codesearch` denied, or allowed by name when search is allowed |

A sandbox's network switch (`networkAccess`) only governs commands the agent
runs on this machine. Hosted web search and fetch run on the vendor's servers,
so only removing the tools stops them; that is what the last column does, and
why it keys on the capability denial rather than on `networkAccess:
"restricted"`, which a container uses for its own firewall. Hosted page fetch
has no exception: an opened URL can carry data out. See
[`coordinator.md`](coordinator.md#network-and-web-research).

A `readOnly` turn (a Multi Review reviewer, a consolidation report) denies
`network` on every adapter, whatever the session's own policy allows, so it
loses hosted search and fetch as well as writes. Claude, Cursor and Grok swap
in a fixed read-only policy that denies it; OpenCode masks `webfetch` and
`websearch` for the turn; Pi's read-only gate admits no web tool. Codex keeps
the session's policy and adds the denial (`codexReadOnlyTurnPolicy`), which
turns `web_search` to `"disabled"` on the thread. app-server applies thread
configuration only when a thread starts or resumes, so the runtime reloads an
attached thread whenever a turn's hosted search setting differs from the last
one applied (`promptThreadConfig`), and the next build turn reloads it back. A
coordinator, which already denies `network`, keeps its research mode on a
read-only turn, as Claude's does under process authority.

Claude, Cursor and Grok also report the fixed read-only policy, not the
session's, while it applies, so Agent Info does not understate the turn: Claude
while a turn started with `readOnly` is running (`claudeReportedPolicy`), Cursor
and Grok while the session's `readOnly` flag is set, which the next prompt
clears (`cursorAppliedPolicy` in `execution-policy.ts`,
`acpSessionReportedPolicy`). The reported policy carries
`READ_ONLY_TURN_POLICY_NOTE` so the summary says why it differs.

### Approval modes

Within that policy, Claude and Codex sessions also carry a per-session
approval mode chosen from the compose bar. The modes are each SDK's own
(`NATIVE_AGENT_APPROVAL_MODES` in `packages/protocol/src/native-agent.ts`), and
each is placed on a provider-neutral `kind` (`ask`, `auto-edits`,
`auto-review`, `auto-approve`) that the renderer uses for its icon.

| Adapter | Modes | Applied as |
| --- | --- | --- |
| Claude | `default`, `acceptEdits`, `auto`, `bypassPermissions` | the turn's `permissionMode`; plan turns carry it as `approvalMode` for after the plan is accepted |
| Codex | `untrusted`, `on-request`, `auto-review`, `never` | `turn/start` `approvalPolicy` and `approvalsReviewer`; `auto-review` is `on-request` with the `auto_review` reviewer |

The policy stays the ceiling. `deny` offers no modes, `ask` leaves only the
`ask` modes selectable, and both bridges cap a request the same way. A session
that never picks a mode runs in the one its policy implied before modes
existed (`bypassPermissions` / `never` under `auto-approve`). The selection
lives in the session's durable `controls.approvalMode`, the launcher can set it
for the session its first prompt creates, and every prompt resolves it against
the policy at send time.

Two consequences are deliberate. A Claude mode that asks narrows the CLI's
allow list to reading tools, which is part of the launch boundary, so crossing
between asking and non-asking modes needs a new CLI and is refused while
background work holds the current one. Codex `on-request` and `auto-review` only
ask when the agent leaves its sandbox, so on an unsandboxed host they narrow
`danger-full-access` to `workspace-write`; a container keeps its own boundary.
There, under `auto-approve`, `on-request` therefore never asks and
`auto-review` never consults its reviewer, and the composer says so
(`nativeAgentApprovalModes` with the policy's `sandbox`) rather than mapping
the pick to `untrusted`; under `ask` the bridge already runs `on-request` as
`untrusted`.

No bridge reads the old per-bridge policy environment variables
(`CURSOR_BRIDGE_SANDBOX`, `PI_BRIDGE_REQUIRE_APPROVAL` and the rest); the
backend policy is the only source.

### Interaction deadlines and pausing

Every question, approval and elicitation a bridge parks has a deadline after
which it is denied, cancelled or declined, never approved. The countdown on its
card can be paused: clicking the timer holds the deadline where it is enforced
and clicking again restarts a fresh window.

- Bridge timers are `InteractionDeadline`s
  (`packages/protocol/src/agent-interaction-deadline.ts`). A pause re-arms one
  at `AGENT_INTERACTION_HOLD_CEILING_MS` (24 h) or the provider's sooner limit,
  so an unanswered request still ends. Bridges publish `hold`
  (`AgentInteractionHold`) beside `expiresAt` and serve
  `POST /session/:id/{family}/:requestId/hold`; the backend reaches it through
  `holdInteraction` and the `hold_native_agent_interaction` command. A bridge
  that publishes no `hold` is shown as `bridge-outdated`.
- Provider limits: Grok stops its turn clock while a request is held (see
  `bridges/acp-bridge/AGENTS.md`, "Parked request deadlines") but honours an
  `ask_user_question` timeout the user configured; Pi pauses until its turn
  budget; a Codex question with `autoResolutionMs` until then; MCP prompts
  pause but warn that their server may stop waiting first. OpenCode publishes
  no deadline, so there is nothing to pause.
- Claude in tmux mode pauses through its hook script: the blocking hooks run
  as `hook.sh <Kind> hold-v1` with a 48 h hook `timeout`, and the script's wait
  loop consumes a hold request file and rewrites its timing file
  (`tmux-hooks.ts`, command `claude_tmux_hold_hook`). A hook without
  `hold-v1` (an older install, or a CLI started before the upgrade) keeps an
  unpausable countdown (`hook-outdated`).
- The public CLI lists `hold` and pauses or resumes a countdown
  (`session interactions hold`, action `session.interaction.hold`; see
  [public-cli.md](public-cli.md)).

Claude AskUserQuestion option previews are requested as Markdown
(`toolConfig.askUserQuestion.previewFormat`) and shown verbatim in a monospace
block on the question card (`AgentInteractionOption.preview`, bounded per
option and per request). Codex questions reach the card because interactive
threads turn on `default_mode_request_user_input`; pipeline threads keep
Codex's Default-mode refusal.

## Cursor Agent

**Bridge:** `bridges/cursor-bridge/` · **Transport:** Cursor TypeScript SDK in process

Cursor sessions are SDK-only. The bridge owns one `SDKAgent` per attached
session and translates `InteractionUpdate` events into the shared transcript
shape. Cursor has no managed CLI, terminal mode, or ACP fallback. Local and
container sessions use the same bridge and HTTP routes.

Cursor receives project-resource, sandbox and tool restrictions from the
backend-owned execution policy. Its SDK and native runtime closure are vendored
into the packaged bridge; see `docs/development/upgrade-agents.md` for the build and upgrade
checks.

On the host the backend exports `ORKESTRATOR_AGENT_MCP_URL` and
`ORKESTRATOR_AGENT_MCP_TOKEN` on the bridge process; container Cursor bridges
get no process-level connection and rely on the per-tab `agentMcp` sent on
create/prompt/attach, which wins over the process env either way. `src/mcp.ts`
turns it into `AgentOptions.mcpServers.orkestrator` (HTTP, bearer header); the
token is never persisted. When the container cannot reach that URL, the
Cursor SDK only reports "Tool call ended without a result"; see
[agent tools reachability](container-lifecycle.md#agent-tools-reachability-container-host-reachabilityts)
for the checks that surface the cause. Project `.cursor/mcp.json` is read only when the execution
policy opts into project settings (containers). Native Cursor mail is on:
`agentMailCapabilities("agent-native", "cursor")` is
`{canPull,canSend,canInject}=true`.

Durability and bounds:

- **Mandatory publication.** `persistBarrier()` (`src/persistence.ts`) must
  write the state file before a prompt or steer reaches the SDK. It also runs
  before create, resume and an identity-changing attach are acknowledged. It
  rejects when nothing was written; it never resolves on a swallowed failure.
- **Oversized state.** When the whole state file would exceed its cap, the
  oldest-touched persisted transcript copies are shed. Session identities,
  journals and (bounded) structured results are never shed, and a snapshot
  that still does not fit is refused with a typed error.
- **Unknown dispatch outcome.** A `send` that rejects after it was called is
  kept as ambiguous evidence and answered 502 `dispatch-outcome-unknown`. The
  backend parks it with retry-under-the-same-id and discard controls.
- **Steer history.** It is bounded at 256 records and 512 KiB. A steer that
  does not fit, or whose prepared record could not be written, is refused with
  429 `{ outcome: "rejected", reason }` before anything is sent. A retry whose
  record was evicted against a fenced run answers `unknown`, never
  non-delivery. Saturation appears as `steer` in `/runtime-health` and as a
  card in the runtime panel.

## Grok Build

**Bridge:** `bridges/acp-bridge/` · **Transport:** ACP JSON-RPC over stdio

The bridge spawns the `grok` CLI and speaks the Agent Client Protocol over its
stdio. One bridge process serves the environment and spawns one CLI child per
session, lazily re-attaching through `ensureSessionProcess` when needed. It
launches Grok as `agent [--model M] [--reasoning-effort E] stdio`, adding
`--always-approve` only when the execution policy selects automatic approval.
Grok 1.0.52 still sends `session/request_permission` over ACP before every
edit, command, fetch and MCP call under that flag, so the bridge answers those
with the allow option while the policy is `auto-approve`. It never does so for
a kind the policy denies (`edit`/`delete`/`move` against a file-write denial,
`execute` against a shell denial, `fetch` against a network denial); those
still wait for a person.

Because these are command-line flags rather than a typed SDK, **the argv is a
versioned contract that nothing in CI can check** — the bridge's own tests run
against a fake agent that accepts anything, so a renamed upstream flag leaves the
suite green and breaks every session at runtime. `docs/development/upgrade-agents.md` has the
manual verification steps to run after a version bump.

Protocol handling lives in `index.ts`. The bridge sends `initialize`,
`session/new`, `session/load`, `session/list`, and `session/prompt`, and
notifies `session/cancel`. `session/new` and `session/load` pass
`configuredAcpMcpServers(state.agentMcp)`, which injects the Orkestrator
HTTP MCP server from a per-tab `agentMcp` body or, as fallback, the same
process env the other bridges receive. The initialize handshake's
`_meta.mcpServers` is ignored because it is empty before the agent loads
that list. Native Grok mail is on:
`agentMailCapabilities("agent-native", "grok")` is
`{canPull,canSend,canInject}=true`. A rotated tab token closes that
session's CLI child and reloads it; it is never written into process env.

Inbound, it handles `session/update` notifications
(`agent_message_chunk`, `tool_call`, `tool_call_update`,
`available_commands_update`, `model_changed`, and friends) and answers
`session/request_permission` requests through the approval flow. Any *other*
inbound request is refused with JSON-RPC `-32601` rather than silently
acknowledged — acknowledging a capability the bridge does not have would be a
lie the agent then acts on. Vendor notifications it does not model are ignored,
which costs nothing because notifications expect no reply.

Agent stderr is drained but never logged: it may contain prompts or file
contents. Vendor wire formats stay inside the adapter — `session-config.ts`
converts them to the shared `NativeAgentComposerState` that HTTP clients see.

Tab close (`POST /session/:id/close`, `acp-session-close.ts`) runs one
operation per session id; a second close or DELETE joins it. It fences the
session first (`closing`: prompt, attach, config, resume, create-by-key and
approval/interaction answers get 409 `Session is closing`; reads, cancel and
close still work), denies every parked permission, question and plan approval
with its cancel outcome, and sends `session/cancel` to a running turn. It then
waits for an in-flight attach (`ACP_CLOSE_ATTACH_WAIT_MS`, 5 s) and for the
cancelled `session/prompt` to answer (`ACP_CLOSE_CANCEL_WAIT_MS`, 2 s; after
that it carries on), terminates every child, writes the state file without
the session, and only then drops the registry entry. The session stays
registered throughout, so a retry never sees an early `missing`: an attach
that outlasts its wait, a child that does not exit, or a failed state write
answers 503 pending and leaves the session fenced until a retry completes.
`closing` is not persisted, so a bridge restart restores the session unfenced
and the backend's retry closes it. Before terminating the child, a session
whose agent advertised `sessionCapabilities.close` is sent ACP `session/close`
(best effort, bounded by `ACP_CLOSE_SESSION_WAIT_MS`). The spec makes that
cancel-and-release, not delete; the bridge never sends `session/delete`, and
Grok CLI 1.0.52 keeps the conversation listed and loadable after it. Close
drops the bridge's own journal and usage for the session and leaves Grok's
store untouched, so `/session/list` + `session/load` reopen the conversation.

## Pi

**Bridge:** `bridges/pi-bridge/` · **Transport:** HTTP (Node `http`)

Pi is the second SDK-in-process bridge, after Claude. It wraps
`@earendil-works/pi-coding-agent` and serves the same REST surface as every
other bridge: `POST /session/create`, `POST /session/:id/prompt`,
`GET /session/:id/messages`, `GET /session/:id/activity`, and the rest.
`src/translate.ts` is the compatibility surface — it turns Pi's
`AgentSessionEvent` stream into Orkestrator's `BridgeMessage`/`BridgeMessagePart`
model, and it is the file to review on every SDK bump.

What makes Pi structurally different from the other five is that it is a
*harness*, not a vendor. It fronts around fifteen model providers using the
user's own credentials, so:

- **A model is a pair.** `provider` plus `modelId`, encoded flat as
  `provider/modelId` and split on the first slash only, because an OpenRouter
  id carries its own slashes. Identical to OpenCode's encoding, deliberately.
- **A fresh session starts on Pi's saved default model** (`defaultProvider`/
  `defaultModel` in `settings.json`, what `/model` writes) when a signed-in
  provider serves it, the way `pi` itself starts, and only then on the
  catalogue's first model. A login can refuse a model its provider lists, so
  the first model is a last resort. An agent-test profile also receives the
  host's saved default, which it uses when its own settings name no default
  that a signed-in provider serves. `/global/models` marks that starting model
  `sessionDefault` (`markSessionDefault` in `models.ts`; global settings only,
  as no session asks), and every launch default that has no saved model (Multi
  Review rows, the launch dialogs' `firstModelFor`) picks the marked row before
  the first, so a review row runs where a tab would.
- **"Signed in" is per provider.** `GET /global/auth` reports each provider's
  status; there is no single account. Sign-in itself is not served: Pi's login
  is an interactive multi-step prompt flow (`select`, `text`, `secret`) with no
  counterpart in Orkestrator's session surface, and the credential it writes is
  account-wide. Users sign in with `/login` in a Pi terminal tab, and containers
  receive `~/.pi` as a bind mount the entrypoint copies a bounded subset of.
- **Reasoning is Pi's thinking level** — the same off/minimal/low/medium/high/
  xhigh/max ladder `/thinking` sets, mapped onto the reasoning axis the Codex
  picker already uses, so an application-level effort default carries across
  without translation. Which levels a given model offers comes from Pi's own
  `getSupportedThinkingLevels`, because the rule has a corner: `xhigh` and `max`
  require an explicit `thinkingLevelMap` entry where every other level is
  included unless mapped to `null`. The default for a fresh session is resolved
  Pi's way too — per-model setting, then global default, then `medium` — off the
  same `settings.json` the CLI writes, so a level chosen in a terminal tab is
  the one the picker opens on. Pi clamps a level the model cannot honour, and
  `thinking_level_changed` carries the effective value back into the composer;
  without that the control would keep showing a selection the run is not using,
  and a clamped turn gives no other signal because it simply succeeds.

  There is no speed axis and no plan/build mode: "primitives, not features" is
  Pi's stated design, and both are things an extension adds rather than things
  the harness has.

The conversation is Pi's, not the bridge's. Pi persists each session to its own
JSONL file and resumes from it, so the bridge holds only the *rendered*
transcript, the composer selection and the prompt journal. An idle detach, a
bridge restart and a crashed process all recover by reopening that file, and
losing the bridge's own state costs a transcript rather than a conversation.
That also gives fork a real implementation: `createBranchedSession` writes a new
file holding the path to the chosen entry, so a fork is an independent
conversation rather than a copy of what was on screen.

Pi ships no permission system, so its adapter implements the execution policy's
approval mode on the SDK `tool_call` extension hook. Timeout, disconnect,
session close and a malformed answer all deny, and a turn that ends with a call
still parked denies it rather than leaving the turn awaiting a promise nobody
will settle. The same policy controls project-local `.pi/` extensions, skills
and prompt templates through Pi's resource loader and project-trust callback.

A prompt owns a claim from the moment its request is admitted. A cancel that
arrives before Pi has produced a cancel handle is parked against that claim and
answered 202 `{ cancelled: false, pending: true }`. It is honoured at the next
preparation boundary without calling Pi, or through `session.abort()` once Pi
is starting the turn. Startup is bounded by `PI_BRIDGE_STARTUP_TIMEOUT_MS`. The
session reports running on every read route while a claim exists.

Pi's SDK sessions load no MCP client; only Pi's CLI loads its built-in `mcp`
extension, which is what a Pi terminal tab uses. The bridge owns one (`bridges/pi-bridge/src/mcp.ts`)
and loads it through `extensionFactories` next to the approval gate: Orkestrator
from env / per-tab `agentMcp` (reserved name, HTTP only), user servers from
`~/.pi/agent/mcp.json`, and project `.pi/mcp.json` only when
`policy.projectResources` is on. Orkestrator tools keep their Agent MCP names;
user/project tools are prefixed `mcp_<server>_<tool>`. `GET /session/:id/mcp`
returns the live inventory. Native Pi mail flags are on; terminal `pi` stays
off. A failed MCP connect is a notice, not a failed attach.

The SDK and the `pi` binary a terminal tab runs are the same program published
two ways, so they are pinned to one version and `tests/unit/version-drift.test.ts`
enforces that the bridge's dependencies, `PINNED_TOOLCHAIN_VERSIONS.pi` and the
Dockerfile's `PI_CLI_VERSION` all agree.

## Workflow results through tool calls

Backend-owned workflows — feature planning, build pipeline stages, review
fan-out, multi-review, and looped review — need a structured result from the
model. Two transports exist, and each attempt records which one it was admitted
under so old records stay readable.

**Tool mode (`tool-v1`).** The backend prepares a durable result slot, mints an
attempt-scoped MCP capability, and attaches it to that one turn. The agent tool
server publishes three tools for that capability: one typed submission tool for
the attempt's result kind, `validate_workflow_result` and
`get_workflow_result_status`. A live Multi Review reviewer's attempt also gets
`report_finding` (see "Provisional findings" below). No Kanban or mail tool is
reachable through it, so a subagent cannot inherit anything broader. The one
addition is a separate, artifact-only `orkestrator-artifacts` server bound to
the turn's transcript-artifact grant (never to this capability), so workflow
agents can publish artifacts into their own transcript; see
[rich-transcripts.md](rich-transcripts.md#workflow-transcripts). The turn carries no provider final-output schema, and the prompt states
that the tool instruction supersedes any earlier "final JSON only" guidance.

**Legacy mode.** Review and pipeline attempts fall back to
`structured-output-v1`, the provider-enforced final-output schema. Feature
planning falls back to `planner-block-v1`, its tagged state block. Records
written before this transport existed carry no transport field and continue
through their original reader.

`WorkflowResultService` owns the slot lifecycle: `open`, `accepted`, `consumed`,
`cancelled`, `superseded`. It persists to a private file with atomic
replacement and a cross-process lock, so two backend processes sharing a data
directory serialize correctly. Submission returns a stable receipt. An identical
resubmission is deduplicated onto the original receipt, a different payload for
an accepted key is a conflict, and an invalid payload returns bounded
diagnostics the model can correct within a fixed budget. Acceptance is not
completion: the controller still owns turn settlement, worktree and package
checks, validation execution, pool application, stage changes, and PR
verification, and consumes an accepted result exactly once.

**Delivery failures that never reach the backend.** A model reaches these tools
through its client's own wrapper (Cursor's `CallDynamicTool`, for one), and that
wrapper rejects a call whose arguments do not parse before the backend sees it.
A rejection like `Failed to parse arguments string as JSON object` is therefore
invisible to the slot and to the bridge's run events, and its wording points the
model at quoting or size when the observed fault is a brace count that is off by
one (an extra trailing `}` from Grok on Cursor). Models that misread it shrink
the report until a call goes through. Four defenses, none of which depends on
seeing the rejection:

- `validate_workflow_result` returns a `validatedDigest` and the service holds
  that payload in memory (bounded by count, bytes and a 30-minute TTL). The
  submission tool accepts `validatedDigest` *instead of* `result`
  (`WorkflowResultService.submitValidated`), so the large object crosses the
  fragile wrapper once. It is an ordinary submission of the held payload, so
  every acceptance rule still applies, and giving both or neither is correctable
  feedback that spends no correction budget.
- `get_workflow_result_status` reports a `delivery` block for an open slot: the
  validation and submission calls that actually arrived, whether a validated
  result is held, and a hint. Zero calls received is the evidence that the
  model's own tool client is rejecting its calls, not the service.
- `ReviewFanoutRunner` steers a still-running reviewer once, after
  `REVIEW_RESULT_COMMIT_NUDGE_MS`, when a validated report is held but not
  committed, telling it to commit by digest. It uses the live-steer surface and
  is a no-op where that is unavailable.
- The placeholder check rejects filler such as `"x"`, which is what a payload
  shrunk to get past a failing call looks like.

The shared instruction and reminder text (`WORKFLOW_RESULT_MALFORMED_CALL_GUIDANCE`)
names both directions of the brace fault and forbids shortening the report.

**Follow-up turns.** A Multi Review reviewer, and the preparation,
consolidation and Fix steps, each get two bounded follow-up turns in the same
session, under a fresh request id and result slot
(`workflow-result-missing.ts`):

- **Result reminder.** A tool-mode turn that went idle with no accepted result
  gets one `workflowResultReminderPrompt` after the idle-poll bound, then fails
  (`resultReminderSent`). It says the work is done and only the submission is
  missing.
- **Restart continuation.** A turn the provider itself cut short is not failed.
  The bridge reports `interruption: "restart"` beside a failed status on its
  session snapshot, and `readProviderStatus` carries it. A result accepted
  before the restart still counts. Otherwise the turn gets one
  `workflowRestartContinuationPrompt` (`restartContinuationSent`), which asks
  the model to continue rather than resubmit, and a second interruption fails
  it. Two bridges report one:
  - **Codex**, on `/session/:id/status` beside `phase: "failed"`, when an
    app-server restart stopped the turn.
  - **Claude**, on `GET /session/:id`, in two cases
    (`session-manager-turn-interruption.ts`). The bridge keeps a
    content-free `turnInFlight` mark in the session's preferences file while
    a turn runs (or owes a background continuation), and clears it when the
    turn settles, is stopped or its tab closes. A later bridge process that
    restores the session with the mark still there, written by a process
    that is gone, reports the turn failed. The mark carries a per-process
    instance id and pid, so a turn another live bridge sharing the Claude home
    is running is left alone. The second case is a Claude Code process killed
    by a signal under the turn while the bridge stayed up: the SDK classifies
    that error (`errorClass: "process_killed_by_signal"`, pinned in
    `sdk-compatibility.test.ts`). A non-zero exit is not a restart, because it
    is as likely a launch or sign-in fault.

  Both bridges also name the request the restart cut short
  (`interruptedRequestId`): Codex from its dispatch journal record for the
  interrupted turn, Claude from the request id the `turnInFlight` mark (or the
  killed turn) carries. Status is per session, so until the continuation's
  turn starts the notice still describes the earlier request; given the
  watched request id, `readProviderStatus` reads a notice that names another
  request, while the provider's dispatch journal confirms it holds the
  watched one (`dispatched`), as "this request's turn has not settled"
  (`idle`, `turnSettled: false`) instead of a failure. The confirmation
  matters because a name can be stale: Claude rewrites the mark after the
  turn starts, so a bridge killed in between restores the previous request's
  name, and a restarted bridge no longer holds the request it lost. A bridge
  or mark that predates the field names nothing, and without both the notice
  is taken at face value.

  The other bridges report none yet, so their cut-short turns fail as before.
  A step or reviewer whose bridge is unreachable keeps its state and
  reconnects on the next pass, so a bridge that died and came back is read
  for its own outcome rather than failing the step first.

Both flags are persisted, so a backend restart cannot reset either budget.

### Provisional findings (`report_finding`)

A Multi Review reviewer's report arrives whole, when its result is accepted.
To let the "Issues so far" list fill in while reviewers work, a live reviewer's own
attempt capability also carries `report_finding`: one finding per call, in the
shape of one entry of the report's `issues`. The reviewer instruction
(`workflowResultInstruction(..., { provisionalFindings: true })`) encourages,
but does not require, reporting each finding as soon as the reviewer is
confident in it, and says the submitted report must still list every one.

- **Who may call it.** The tool is listed only on a `review-report` attempt the
  backend is following as a running tool-mode reviewer of a review in
  progress (`ProvisionalFindingInbox`, `review-provisional-findings.ts`, fed
  from every Multi Review save and load). Each call must name the capability's
  own result key, and the slot must still be `open`: a finished, superseded or
  cancelled attempt is refused (`attempt_closed`), and so is any attempt the
  inbox does not follow (`not_accepting`), such as a build-pipeline reviewer.
  The OpenCode broker lists it for every broker session but checks the signed
  one-attempt capability and the slot kind on every call, and only a reviewer's
  turn unmasks it.
- **Validation and bounds.** A finding must pass the structured-review issue
  contract and its budgets (`STRUCTURED_REVIEW_MAX_*`), and stay within 16 KiB
  encoded (`REVIEW_PROVISIONAL_FINDING_MAX_BYTES`). A reviewer keeps at most
  50 (`REVIEW_PROVISIONAL_FINDINGS_MAX`); later calls are refused with
  `limit_reached`, so the first ones are kept. Provider-authored provenance is
  dropped. The id is a digest of the normalised finding, so a retry returns
  the same receipt with `duplicate: true`.
- **Storage.** A call is staged in memory and the workflow is woken; the next
  review pass moves staged findings onto `reviewer.provisionalFindings` as an
  observation, so they cost no write of their own and never wait for the
  workflow's lock. A finding staged when the backend stops is lost, which is
  acceptable for progress: the report still carries it.
- **Lifetime.** The accepted report replaces them (`reviewer.report`). A
  reviewer that fails or is stopped keeps them; the flow graph labels them
  "unconfirmed (reviewer failed)" or "(reviewer stopped)". A restart or retry
  drops them, and they are removed once the workflow reaches `interactive` or
  `completed`. Consolidation reads accepted reports only
  (`consolidationReports`), never provisional findings.

How each provider lets a reviewer call it under its reviewer policy, including
the read-only turns of a packaged review:

| Provider | How |
| --- | --- |
| Claude | In `claudeWorkflowResultTools`: added to `allowedTools` and allowed by `canUseTool` before any policy decision; read-only turns already allow `mcp__orkestrator__*` |
| Codex | The attempt-scoped `orkestrator` server runs with `default_tools_approval_mode = "approve"` whenever a workflow result tool is set |
| Cursor | Read-only sessions host every tool the Orkestrator server lists in-process; other sessions never ask |
| OpenCode | `openCodeWorkflowResultTurnTools` / `openCodeWorkflowResultPermissionRules` unmask and allow it for a `submit_review_report` turn only |
| Grok (ACP) | Exempt as one of the turn's own attempt tools; see "Attempt tools in read-only turns" below |
| Pi | Exempt as one of the turn's own attempt tools; see "Attempt tools in read-only turns" below |

None of these has been run against a real reviewer on its provider yet; see
[0029-multi-review-flow-graph.md](../todo/coordinator-and-multi-review/0029-multi-review-flow-graph.md).

### Attempt tools in read-only turns (Grok, Pi)

The ACP (Grok) and Pi bridges gate tools themselves, and a packaged review's
reviewer turns are read-only: the ACP bridge denies every permission request
and Grok asks before every MCP call, and Pi's read-only gate blocks all but its
reading built-ins. So the backend tells those two bridges which attempt a
workflow-result turn runs for: the prompt body carries `workflowResultTool` and
`workflowResultKey` next to the attempt's `agentMcp`
(`bridgePromptBody`; the review fan-out sets the key to the reviewer's result
key). The bridge keeps them for that turn only (`state.workflowResultTurn`,
memory only, replaced by every prompt; a malformed pair is refused with 400
before the turn is claimed).

For that turn, and only for a call whose arguments name that result key
(`callsOwnWorkflowResult`), the attempt's own tools are let through under every
approval policy, including read-only: its submission tool,
`validate_workflow_result`, `get_workflow_result_status`, and
`report_finding` for a reviewer (`workflowResultTurnToolNames`).

- **Grok:** `workflowResultPermissionOption` (`acp-session.ts`), called from
  `onPermission` before the mail matcher, which is unchanged. Identity follows
  the mail matcher (a server-qualified name, Grok's namespaced metadata, or
  the tool `use_tool` wraps, whose arguments are read from `tool_input`); never
  a bare name, a display title, or an `execute`/`edit` kind.
- **Pi:** `isOwnWorkflowResultCall` (`mcp.ts`) in `requestToolApproval`: the
  tool must come from the Orkestrator server's own registrations.

An explicit `toolPolicy` deny still wins on both. A turn that declared no
attempt (an ordinary, coordinator or older backend's turn) gets no exemption,
so a call naming another key has no read-only approval exemption. If a
mismatched key reaches an attempt-scoped backend tool, it answers
`invalid_result` (or `invalid_finding` for `report_finding`) with
`nextAction: correct` and names only the connection's own key. The OpenCode
broker gives the same correction after authenticating the capability against
its own key and checking its environment, project, provider and result kind.
Invalid capabilities, foreign scopes, provider mismatches and wrong result
kinds still get `capability_denied` with `nextAction: stop`. Only the review
fan-out declares the key today; consolidation and Fix turns on Grok or Pi do
not yet.

### Provider qualification

| Provider | Tool mode | Notes |
| --- | --- | --- |
| Claude | Qualified | Per-turn `agentMcp`; the restricted review policy admits `mcp__orkestrator-workflow-result__*` and nothing else new |
| Codex | Qualified | Per-turn `agentMcp` on the pinned bridge |
| Cursor | Qualified | Per-turn `agentMcp`; a changed attempt capability re-attaches the SDK session before dispatch |
| Grok (ACP) | Qualified | Per-turn `agentMcp`; a changed attempt capability re-attaches the ACP session before dispatch |
| Pi | Qualified | Per-turn `agentMcp`; the bridge-owned MCP client rebuilds its session runtime when the capability changes |
| OpenCode | Qualified | One directory-scoped workflow-only broker is registered dynamically; every ordinary turn masks all broker tools, a workflow turn exposes only its submit/status pair, and each call still requires the signed one-attempt capability from the trusted prompt |

An unqualified provider is not a degraded path. It runs the legacy transport it
has always run, with the same validation and the same domain results.

### Rollout and rollback

Admission is a backend-owned setting, `global.workflowResultTools`, not a
user-facing transport choice. It carries a master switch plus per-provider and
per-result-kind lists, and is read through `get_workflow_result_tools_rollout`
and `set_workflow_result_tools_rollout`. The gate is evaluated once, when an
attempt is admitted, and the outcome is persisted on the attempt.

The setting can only narrow the qualified set, never widen it. Qualification is
a property of the code: naming an unqualified provider here has no effect,
because admitting one would dispatch a turn the model has no channel to submit
against.

To roll back, disable the combination. New attempts take the legacy transport
immediately. Attempts already admitted keep their tools and their receipts and
finish normally, so nothing in flight is stranded. Deploying a release that
cannot read `tool-v1` records is only safe once no such records are active:
drain them through the current version first.

### Operational metrics

`get_workflow_result_metrics` returns bounded, content-free counters: attempts,
submission outcomes by a fixed error-code set, distinct corrections, missing
submissions, acceptance and consumption latency, validation and storage
duration, and queue and retention gauges. Series names use only provider,
result kind, transport, schema version, outcome, and error code. Payloads,
prompts, diagnostics, evidence paths, digests, receipt ids, and result keys are
never recorded, and the series table is bounded with an explicit dropped-series
count.

## Where to look next

| Topic | Document |
| --- | --- |
| Agent-to-agent mail, inject, and provider flags | [`docs/architecture/agent-messaging.md`](./agent-messaging.md) |
| Editing the MCP servers each platform loads, and how saved edits reach a live session | [`docs/architecture/mcp-management.md`](./mcp-management.md) |
| Bumping any agent SDK, CLI, or pinned binary | [`docs/development/upgrade-agents.md`](../development/upgrade-agents.md) |
| Background-reliability and transport invariants | [`AGENTS.md`](../../AGENTS.md) |
| Agent-driven real-stack QA | [`docs/development/agent-testing.md`](../development/agent-testing.md) |
| Known flakes and their root causes | [`docs/tests/flaky-tests/0000-index.md`](../tests/flaky-tests/0000-index.md) |
