# Coordinator read-only adapters

Checked against `main` at `2459b05c` (2026-10-15).

Coordinator runs against the user's real checkout, so every platform it offers
must hold the same read-only outcome: creating a file, editing a file, running
a writing shell command and fetching a URL all fail, and Control MCP discovery
still works. The deny list is already one shared policy. What differs is how
strongly each adapter holds it, and the remaining work is a set of
per-platform decisions about that strength and the tier each platform
advertises.

## Current state

- The contract every qualified platform is held to (from the coordinator
  design). A finished coordinator conversation must:
  - **Inspect** the checkout under `coordinator-read-only`, with mutations
    denied by the adapter rather than by asking the model to behave. The
    per-platform strength differs; see the table below.
  - **Choose** platform and model on the first send, then stay on that
    binding. Done on every platform.
  - **Delegate** through Control MCP (`launch_environment`, `launch_job`,
    `send_message`, build and review) and finish the turn. Done on every
    platform; `delegation` is true for all six in
    `coordinator-conformance.test.ts`.
  - **Wake** exactly once per delegation when the worker's turn ends, with
    held progress mail delivered as one carrier, and a system notice for a
    silent worker. Done on every platform at the layer-test level; live
    evidence is in [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md).
  - **Queue** a prompt typed during a turn and run it before worker mail. Done
    on every platform.
  - **Steer** a running inspection turn where the platform has a steer
    adapter. Claude, Codex, Pi and Cursor do; OpenCode and Grok do not (see
    [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md)).
- The policy names operations, not vendor tools.
  `resolveNativeAgentExecutionPolicy(..., "coordinator")`
  (`apps/backend/src/core/native-agent-execution-policy.ts`) returns
  `capabilityPolicy.deny: ["file.write", "file.patch", "shell.mutate",
  "network"]`, `approvals: "deny"`, `projectResources: false` and
  `networkAccess: "restricted"`. `toolPolicy` stays Codex-shaped and is the
  user-override surface, so it cannot carry the translation.
- Process authority. `commands-servers.ts` sets
  `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only` on every
  coordinator bridge launch. Each bridge replaces whatever policy a request
  body or persisted record carries:
  - Claude: `bridges/claude-bridge/src/services/read-only-policy.ts`;
  - Codex: `isCoordinatorReadOnlyEnvironment` in
    `bridges/codex-bridge/src/codex-config.ts` (also honours the older
    `CODEX_BRIDGE_EXECUTION_POLICY`);
  - Cursor: `bridges/cursor-bridge/src/agent-session.ts`;
  - Pi: `BRIDGE_EXECUTION_POLICY_ENV` in `bridges/pi-bridge/src/agent-session.ts`;
  - Grok: `effectiveExecutionPolicy` in `bridges/acp-bridge/src/acp-policy.ts`,
    with `restorePersistedPolicy` (`acp-persistence.ts`) refusing a permissive
    persisted policy;
  - OpenCode has no bridge. The backend applies `effectiveOpenCodePolicy`,
    `openCodePermissionRules` and `openCodeCoordinatorAgent` (the `plan`
    agent) from `apps/backend/src/core/opencode-provider-helpers.ts`.
- Qualification is one table: `judge` and `coordinatorProviderQualification`
  in `apps/backend/src/core/coordinator-providers.ts`. Claude's tier depends on
  the host probe `defaultCoordinatorHostCapabilities` (command sandbox on
  macOS and Linux only). **Settings → Agent platforms → Coordinator safety
  level** defaults to `provider-configured`. A platform whose tier is weaker
  than the setting is unavailable, and the tier's `reason` is shown in the
  picker.
- Per-platform strength today:

  | Platform | Tier | How read-only is held | Gap |
  | --- | --- | --- | --- |
  | Claude (macOS, Linux) | `enforced` | SDK command sandbox, `allowUnsandboxedCommands` off, `dontAsk`, an allowlist without writing tools, and a bridge `PreToolUse` hook that allows a fixed list of reading commands; WebFetch and WebSearch are off the allowlist, in `disallowedTools` and refused by the hook | None known |
  | Claude (Windows) | `provider-configured` | Same, without the OS sandbox; the hook allowlist is the boundary | No OS containment |
  | Codex | `enforced` | Permission profile that denies filesystem writes and network in the child; the bridge refuses a turn unless app-server echoes the profile back. Hosted web search (`web__run`) is switched off with `web_search = "disabled"`, and the bridge refuses a thread unless `config/read` reads it back | `sleep` is not denied (it is a read-only command) |
  | Pi | `enforced` | In-process `tool_call` gate in the bridge; a name allowlist, so an extension's web tool is refused too | None known |
  | OpenCode | `provider-configured` | SDK `plan` agent plus permission rules (`*: deny`, a read-only list, the coordinator's own Orkestrator tools by name, then named denies for `webfetch`, `websearch` and `codesearch`) | Always loads the checkout's project configuration, including command-backed MCP servers in `opencode.json` |
  | Cursor | `provider-configured` | SDK sandbox plus a built-in tool allowlist (`CURSOR_READ_ONLY_TOOLS`, with denied capabilities mapped by `CURSOR_CAPABILITY_TOOLS`), which leaves out `webFetch` and `webSearch`; a read-only session without a sandbox boundary is refused before attach | No approval callback, so a denial cannot be verified |
  | Grok | `advisory` | Write, edit, shell and built-in subagents removed with a private `--agent-profile`; web tools removed with `--disable-web-search`; `--no-leader` keeps those restrictions local; remaining permission requests refused | A tool that does not ask is not stopped; not offered at the default safety level |

- Waiting tools. Claude refuses `Monitor`, `ScheduleWakeup`, the `Cron*`
  tools and `sleep`/`watch`/`timeout` (asserted in
  `coordinator-conformance.test.ts`). OpenCode and Pi have no sleep primitive.
  Codex can run `sleep`; Cursor and Grok depend on the provider. The Control
  MCP poll guard (`coordinatorPollGuard` in `control-mcp-server.ts`) is the
  backstop.
- `coordinator-conformance.test.ts` pins the `enforced` set to exactly
  `claude`, `codex` and `pi`, so a platform cannot be promoted without a
  matching test change.

## Outstanding work

### Code

1. **Claude on Windows.** Decide whether the hook allowlist is enough to keep
   offering Claude at the default `provider-configured` setting on Windows.
   An `enforced`-only installation already refuses it, because the tier is
   compared with the setting. Whatever is decided, never report `enforced`
   where the sandbox cannot start.
2. **Codex `sleep`.** Optionally add an argv0 deny for `sleep` (and similar
   waiting commands) on the coordinator permission profile in
   `codex-config.ts`. Only do this if a live run in
   [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md) shows
   Codex reaching for it; the poll guard covers mailbox polling either way.
   Live evidence on 2026-10-18: no Codex coordinator ran `sleep` in the
   async and worker-mail family scenarios (nor did Claude, OpenCode or
   Cursor), so the deny is still not justified.
3. **OpenCode at `enforced`.** Only if unification requires it: the adapter
   would have to ignore or disable project MCP servers that can execute
   commands. Until then OpenCode stays `provider-configured`, and the note
   from `effectiveOpenCodePolicy` stays on its qualification `reason`.
4. **Cursor.** Stays `provider-configured` until a probe can prove that a
   denied tool did not run. Without an approval callback there is nothing to
   check today.
5. **Grok.** Stays `advisory`. The ACP bridge now removes built-in mutation
   tools through an agent profile, including the shell that ran `touch`
   without asking. Qualify live before changing the tier; unasked tools
   outside that removed set still need a stronger boundary.
6. **Pi.** No change.
7. **Hosted network tools and web research.** Done. A live run of the
   read-only suite found a Codex coordinator reaching `https://example.com`
   through Codex's hosted web search while its permission profile had the
   network off: the profile stops commands, and hosted search runs on OpenAI's
   servers. Every policy whose `capabilityPolicy` denies `network` now loses
   the provider's hosted and network tools, except that
   `capabilityPolicy.allow: ["web.search"]` keeps hosted search. The
   coordinator gets that exception from **Settings → Agent platforms →
   Coordinator web research** (default: search plus research servers), passed
   to each bridge at launch as process authority. Hosted page fetch has no
   exception in any mode. See
   [`coordinator.md`](../../architecture/coordinator.md#network-and-web-research).
   - Codex: `web_search = "disabled"`, or `"cached"` when search is allowed,
     never `live`; `features.standalone_web_search = false`. The engine reads
     the expected mode back through `config/read` once per app-server
     generation and refuses the thread on any other value
     (`assertHostedNetworkLock`). Research servers are `-c mcp_servers.*`
     overrides with approved tools. Verified against 0.162.1:
     - The loopback `live-network-lock.test.ts` reads the tools from the real
       model request.
     - Its canary showed `live` open a fresh Wikipedia search page while
       `cached` refused it ("Cache miss"), and a coordinator call Context7 from
       inside its permission profile.
     - A `dev:test` profile with real credentials, before the research setting
       existed: the old bridge searched and returned example.com's title; the
       fixed bridge said "Web search is not available to me", and its `curl`
       could not resolve a host.
     - The same on 2026-10-16 with the default setting, for a Codex main and a
       Claude side coordinator. Both found Bun's latest version through web
       search and React's Context7 library ID through Context7. Neither could
       open a fresh Wikipedia search page: Codex got "Cache miss", and Claude
       found no tool that opens a URL. Claude's attempt to write a plan file
       was refused.
   - Claude: WebSearch on the allowlist when allowed; WebFetch denied by name
     and by the hook; research servers added to the inline MCP set and
     allowed by name. Any other network-denied policy gets the same tools in
     `disallowedTools` (`claudeDisallowedTools`).
   - OpenCode: `webfetch` denied after every allow (a `task` subagent inherits
     it); `websearch` and `codesearch` allowed by name when search is allowed,
     else denied.
   - Cursor: `webSearch` joins the read-only allowlist when allowed; `webFetch`
     never does.
   - Grok: `--disable-web-search` and `--no-leader`, keyed by provider id and
     applied to policy-less children in a coordinator process. It removes
     search with fetch, so Grok coordinators get no search (item 8).
   - Pi: no hosted tools; its name allowlist refuses an extension's web tool.
   - The coordinator context now says what research is available, to keep its
     own work to quick looks and delegate anything serious, and to report a
     tool as refused only after a call was refused.
8. **Grok search without fetch.** `--disable-web-search` removes both tools,
   and its effect is read from the 1.0.52 binary rather than a live turn. The
   binary also mentions `GROK_DISABLE_WEB_FETCH`. Verify on the pinned build
   what that switch does; if it removes fetch alone, honour the research
   setting on Grok.
9. **Readiness for a failed Codex lock.** A Codex coordinator whose
   `config/read` does not confirm its search mode is refused at thread start,
   which the user sees as a failed turn. `NativeAgentReadiness` has no state for
   "this provider cannot hold the boundary", so the conversation still looks
   ready until the first send. Add one if a Codex bump ever trips the check.
10. **Research servers on OpenCode, Cursor and Pi.** Only Claude and Codex load
    the coordinator's research servers. OpenCode would need them injected
    under names its project configuration cannot claim, Cursor through its
    in-process hosted tools, and Pi through its bridge-owned MCP client.

11. **Show Codex sandbox refusals in the live transcript.** Done. Under a
    `read-only` or `workspace-write` sandbox, Codex 0.162.1 emits no item for
    a rejected `apply_patch`, nor for a failing command whose output looks
    like a sandbox denial ("Operation not permitted", "Permission denied",
    "Read-only file system", "sandbox", "landlock", "seccomp", "failed to
    write file"). This was mapped on the pinned binary; full access itemizes
    everything. The model is told and usually says the call was denied, so a
    Codex coordinator, reviewer or sandboxed session looked as if it claimed a
    denial it never tried. `RefusedCellTail` (`bridges/codex-bridge/src/sessions/refused-cell-tail.ts`)
    now reads the active turn's records from the rollout app-server names in
    `thread.path`, and shows a code-mode cell as a failed `exec` row in two
    cases: no item of the turn started while it ran, or its output carries a
    refusal. It reads from the rollout size captured before `turn/start`,
    every 200 ms, and before each new model response and the turn's
    completion are applied. See "Constraints and rationale" for the choices.

### Qualification

- The live read-only scenario (tree hash unchanged, every mutation denied,
  discovery still returns) runs per platform in
  [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md). The
  decisions above for Codex, Cursor and OpenCode depend on its results.

## Constraints and rationale

- Refused Codex calls are read from the rollout, not from app-server's raw
  events. `experimentalRawEvents` streams the cell as
  `rawResponseItem/completed` (checked on 0.162.1), but only `thread/start`
  accepts it. A thread resumed in a new app-server process never gets raw
  events, with or without the flag, and neither does a fork. Every session and
  coordinator conversation that outlives an app restart would lose the rows
  again. Raw events would also have needed `experimentalApi` for the whole
  connection. The rollout covers started, resumed and reloaded threads alike.
- The tail polls every 200 ms while a turn runs. `fs.watch` fired nothing on
  macOS for Codex's appends (same inode, growing size). The poll alone can
  still lose a race with a fast next response, so while a tail is active the
  turn's events are applied in order: an event that opens a new model
  response, and `turn.completed`, wait for a rollout read, and cells that
  finished before it are placed first. Only this thread waits; app-server's
  notification stream keeps being consumed. The queue is bounded; on overflow
  the bridge stops reading the rollout, applies every queued event and tells
  readers to reconcile. A poll with nothing new costs one `stat`.
- The tail starts at the rollout size captured before `turn/start` is sent,
  not at the end of the file when `turn/started` is applied: a fast turn can
  write its cells before that. A turn that did not go through the prompt path
  (an inline review) reads a bounded window and keeps only records carrying
  its own turn id.
- A cell becomes a row in two cases: no client tool item of the turn started
  while it ran, or its output carries "patch rejected", "Operation not
  permitted", "Permission denied" or "Read-only file system". Codex's own
  heuristic also suppresses on "sandbox", "landlock", "seccomp" and "failed to
  write file", but ordinary output says those words (this repository's files
  do), and a cell whose calls already have rows would gain a duplicate. The
  no-item rule still shows such a cell when nothing else does. Showing every
  cell, as a reload does, was rejected for the same reason: each nested
  command would appear twice in the live view.
- The row is a completed `dynamic_tool_call` named `exec`, failed when the
  output reports a refusal or a failed script. That is the row a reload
  builds from the same rollout record, with the same id (the `call_id`).
- Only code-mode cells are read. Every model Codex 0.162.1 serves runs in
  code mode. A direct `apply_patch` or `exec_command` call from a model that
  does not would still be missing, as before.

- Do not cover a missing adapter half with prompt text. A platform joins the
  unified set only when its adapter holds the same contract as the others.
- Moving a platform to `enforced` claims that the provider or the OS blocks
  the mutation whatever the agent attempts. It needs all of:
  - a translation of `capabilityPolicy` into the provider's own vocabulary, in
    the bridge, applied on create, resume, config and every turn;
  - `ORKESTRATOR_BRIDGE_EXECUTION_POLICY` honoured as process authority;
  - an entry in the `enforced` list in `coordinator-conformance.test.ts`;
  - a place in the live suite's platform list (see
    [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)).
- New adapter work must honour the policy on create, resume, config and every
  turn, and fail closed if a persisted session carries another policy id.
- Where a platform cannot honour an axis, report it in the policy's `note` and
  leave the tier at `provider-configured`. Do not silently drop the axis.
- Do not reintroduce a platform literal at any qualification gate (workspace
  service, runtime resolver, bridge launcher, trusted session input). That is
  what once let a platform hold a conversation but be refused a bridge.
- `delegation` is derived (`mcpClient && canInject`), not declared. The tier is
  about sandbox strength, not mail.

## Open questions

- Should Windows Claude be offered at the default safety level at all, given
  that its boundary is a command allowlist inside the bridge?
- Is `provider-configured` an acceptable final tier for OpenCode and Cursor, or
  does "same product" require `enforced` on every default-offered platform?

## Related

- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md): the live
  suite that produces the evidence these decisions need.
- [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md): steer and
  the smaller parity gaps.
- [`coordinator.md`](../../architecture/coordinator.md): "Provider qualification"
  and "Changing qualification"; `AGENTS.md` "Coordinator qualification".
- [`control-mcp.md`](../../architecture/control-mcp.md) ("Project coordinator
  credentials").
- Living-doc drift to fix: `coordinator.md` links
  `docs/todo/coordinator-to-implement.md` twice, in its introduction ("What is
  still missing") and at the end of "Tests that exist today". That file is
  split into this file,
  [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md) and
  [0028-coordinator-consistency-gaps.md](0028-coordinator-consistency-gaps.md). The
  introduction should point at all three; the "Tests that exist today" link
  should point at the live conformance file.

## Replaces

- `docs/todo/coordinator-to-implement.md` (introduction, "The unified
  interface", the read-only and waiting-tool rows of "Current matrix", and §1
  "Read-only adapters")
