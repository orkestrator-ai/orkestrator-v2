# Provider SDK adoption backlog

Checked against `main` at `cd7bbe3e5` (2026-10-30); pins and candidates rechecked at `6ce02251b` for the 2026-10-30 upgrade (1020 (retired), `git show 17d28238c:docs/todo/agent-engines/1020-provider-upgrade-2026-10-30.md`) and at `ee2cc8423` for the 2026-11-06 upgrade (1031 (retired 2026-11-14), `git show dc90609bf:docs/todo/agent-engines/1031-provider-upgrade-2026-11-06.md`).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`. Statuses rechecked
2026-10-30 against `main` at `cd7bbe3e5`: no pin has moved since the analysis
(`packages/toolchain/src/manifest.ts:6-12`, the bridges' `package.json`), and
none of the tasks below had already merged. Rechecked again the same day
against the upgraded pins (see "Recheck at the 2026-10-30 upgrade" under
Assumptions and decisions). Task 4 rechecked 2026-11-02 against `main` at
`38d55ee14` (Claude Agent SDK `0.3.314`) before its provenance half was built.
Task 8 rechecked 2026-11-03 against `main` at `7b48c23fb` (Pi `1.4.0`, Codex
`0.166.0`, OpenCode `1.19.5`) before its instructions half was built, and
again 2026-11-06 against `main` at `c1724ab74` (Pi still `1.4.0`) before its
abort and auto-compaction toggle were built.

Task 4 was rechecked on 2026-11-18 against `main` at `85c55358f` (Claude Agent
SDK `0.3.326`) before its re-arm half was built. The same review point was
used to evaluate Codex dynamic tools (task 6) at Codex `0.169.0`. Dynamic
tools remain deferred, with the conditions for adoption recorded below.

The "Decided out" list is product decisions, not tasks; only where the current
pins undercut one of them is it raised below (task 1).

### Tasks

1. **Re-check the backlog against current pins**: the "Needs verification" item; every pin in "Current state" has moved. Status: done (pins, verification note and Codex-goals wording refreshed; see Assumptions and decisions).
2. **Delete the dead Claude compaction guard**: remove `isSdkCompactBoundaryMessage` and its imports. Status: done (`refactor(claude-bridge): delete dead compact-boundary guard`).
3. **Claude in-process MCP server**: decide `createSdkMcpServer()` versus the HTTP loopback for Orkestrator tools. Status: done (decided out: keep HTTP; recorded under "Decided out").
4. **Claude permission lifecycle surfaces**: pending-permission re-arm on (re)initialize and MCP permission provenance. Status: done (re-arm 2026-11-18: a prompt that rejoins an idle surviving CLI re-reads its initialize inventory, and each request only the CLI still holds becomes one card; proved on the pinned CLI without credentials. Provenance 2026-11-02: an optional `source` on the shared interaction request, filled by Claude, shown on the card). Recovering MCP elicitations the same way waits on an Agent SDK that hands them over (see Candidates).
5. **MCP Apps widgets**: Claude `readMcpResource` / `_meta.ui` and the Codex equivalent. Status: deferred (decision recorded: until a user-visible MCP server needs it).
6. **Other unused Claude and Codex surfaces**: Claude `additionalDirectories` / `agents` / `skills`; Codex `config/*` writes, `command/exec`, `fs/*`, `feedback/upload`, `gitDiffToRemote`, dynamic tools, config requirements. Status: deferred (decision recorded: kept as candidates; Codex dynamic tools qualified against a concrete consumer on 2026-11-18 and deferred, with what would justify adoption under "Task 6: Codex dynamic tools deferred").
7. **Cursor `askQuestion`**: no typed tool-call variant or answer path. Status: blocked (upstream Cursor SDK; still at `1.2.0`).
8. **Pi compaction controls**: custom instructions, `abortCompaction`, auto-compaction toggle. Status: done (custom instructions 2026-11-03: `/compact <instructions>` behind `actions.compactInstructions`, on for Claude and Pi; 2026-11-06: Stop ends a Pi compaction through the cancel routes, and an Auto-compact composer toggle per session that never writes Pi's settings file). Live check on a signed-in Pi was to-do 7280 (retired 2026-11-10); how it works is in [native-agent-commands.md](../../architecture/native-agent-commands.md).
9. **Second ACP agent**: Gemini CLI or Claude-over-ACP through `AcpProviderConfig`. Status: deferred (decision recorded: until a user asks for a specific agent).
10. **Grok MCP elicitation**: `mcp-form` and `mcp-url` cards over `_x.ai/mcp/elicit`. Status: done (2026-10-31; proved signed in on 1.0.67 through the bridge).
11. **Grok `costUsdTicks` qualification**: establish the tick unit and scope, then show ticks-only costs. Status: open (depends on the billed two-turn qualification in manual checklist 7568). Accounting is implemented and tick-derived dollars remain disabled.
12. **OpenCode `find.*` and Session V2 features**: unused 1.x file search; V2 waits on 0008. Status: done for `find.*` (moved to "Decided out"); Session V2 stays with 0008.
13. **Living-doc drift**: fix `agent-engines.md` (Grok Build, Claude compatibility surface) and `upgrade-agents.md`. Status: done (`docs(agent-engines): fix Claude compatibility surface and Grok ACP drift`).

### 1. Re-check the backlog against current pins

**Problem.** The file's pins and its verification note are stale, so a reader cannot trust which candidates still exist upstream or which "decided out" reasons still hold.

**Context.** The maintenance rule says each SDK bump re-checks this list; several bumps have landed since 2026-10-15 (`28590e68`, #1198, and later) without updating it.

**Investigation.** Current pins: Claude Agent SDK `0.3.309` / CLI `2.1.309`, Codex `0.164.0`, OpenCode `1.19.4`, `@cursor/sdk` `1.0.40`, Pi `1.4.0`, Grok `1.0.67`, `@agentclientprotocol/sdk` `2.0.1` (a major bump) (`packages/toolchain/src/manifest.ts:6-12`, the bridges' `package.json`). At Claude SDK `0.3.309` every listed symbol is still present in `bridges/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`pending_permission_requests`, `reinitialize(`, `McpServerProvenance`, `readMcpResource`, `_meta`, `verbatimPrompts`, `additionalDirectories`, `createSdkMcpServer`). One "decided out" reason is imprecise: Codex 0.164.0's generated surface, produced without any experimental flag (`scripts/generate-codex-app-server-protocol.ts:358`), includes `thread/goal/get|set|clear` (`bridges/codex-bridge/src/app-server/generated/protocol-manifest.json`), and those methods have been there since the app-server migration (#151). Goals are gated by the `features.goals` config (`bridges/codex-bridge/src/app-server/process-supervisor.ts:95`), so "no stable goal RPC" should read "feature-flagged".

**Decisions.**

- **How to refresh the file?**
  - **Update the pins and the verification note in place, and narrow the Codex-goals wording, without reopening any decision (recommended).**
    - Pros: allowed by the README (correcting an item); cheap; keeps the list trustworthy.
    - Cons: will drift again unless the bump procedure enforces it.
  - **Drop the pin list from this file and point at `manifest.ts` and `version-drift.test.ts`.**
    - Pros: never stale again.
    - Cons: loses the record of which version each candidate was last checked against.
- **Reopen Codex goals?**
  - **No; record that the RPC exists behind `features.goals` and revisit when it leaves the flag (recommended).**
    - Pros: respects "do not reopen without a new reason"; a feature flag is not a stability promise.
    - Cons: if users want `/goal`, the gap stays.
  - **Yes, open a new todo to evaluate it.**
    - Pros: the original blocker (no RPC) is gone.
    - Cons: work on a surface the vendor still flags.

### 2. Delete the dead Claude compaction guard

**Problem.** `isSdkCompactBoundaryMessage` is dead code that suggests compaction is detected from SDK frames when it comes from the `PostCompact` hook.

**Context.** Small hygiene item listed under Candidates.

**Investigation.** Still dead. Defined at `bridges/claude-bridge/src/types/index.ts:242`; imported only by `services/session-manager-core.ts:41` and `services/session-manager-session.ts:35` (two modules, not four as the file says) and called only in `src/types/index.test.ts`. Rechecked 2026-10-30: by then only `session-manager-session.ts` imported it (with the equally unused `SdkCompactBoundaryMessage` type).

**Decisions.**

- **Delete or keep?**
  - **Delete the guard, its two imports and its test cases (recommended).**
    - Pros: removes misleading code; no behaviour change.
    - Cons: a future frame-based detector would rewrite it.
  - **Keep it as an exhaustiveness aid.**
    - Pros: none real: `SYSTEM_SUBTYPE_DISPOSITIONS` already records `compact_boundary`'s fate.
    - Cons: dead imports stay; lint `no-unused-vars` already flags this kind of residue.

### 3. Claude in-process MCP server

**Problem.** Orkestrator's control tools reach Claude through an HTTP MCP server with a bearer token, an extra loopback hop.

**Context.** The coordinator needs scoped credentials per tab, and other bridges (Pi, Cursor, Codex) reach the same HTTP server.

**Investigation.** Claude injects the HTTP server in `bridges/claude-bridge/src/services/mcp-config.ts:48-119` (`ORKESTRATOR_AGENT_MCP_URL`). `createSdkMcpServer` is in the pinned SDK. Nothing uses it.

**Decisions.**

- **Adopt `createSdkMcpServer()`?**
  - **Keep HTTP and record why: one server serves every platform, and the backend, not the bridge, enforces per-tab scope (recommended).**
    - Pros: one authorization path for all six platforms; the bridge never implements tool logic.
    - Cons: keeps the loopback hop and a bearer token in the Claude process.
  - **Adopt it for Claude, proxying calls to the backend.**
    - Pros: no token in the CLI's MCP config.
    - Cons: the bridge still needs a backend credential to proxy, so the hop moves rather than disappears; Claude-only divergence.

### 4. Claude permission lifecycle surfaces

**Problem.** After a Claude CLI restart or reinitialize, a permission request the CLI still holds is not re-armed in the UI, and permission cards do not show which MCP server asked.

**Context.** Touches the authorization lifecycle governed by 0001 and the deny-by-default invariant.

**Investigation.** `pending_permission_requests` and `Query.reinitialize()` are in SDK `0.3.309`; `McpServerProvenance` appears eight times in `sdk.d.ts`. The bridge references none of them.

Rechecked 2026-11-02 at SDK `0.3.314`: all three symbols are still there, and
`canUseTool`'s third argument carries `mcpServer: { name, source }` for
`mcp__*` tools. Since the analysis, the permission-rules work (todo 0723 (retired))
started reading `mcpServer.name` in
`bridges/claude-bridge/src/services/session-manager-parked-interactions.ts`
and forwarding it as `mcpServer` (it makes an MCP request rule-eligible), and
the backend mapper (`apps/backend/src/core/http-bridge/interactions.ts`) put it
into the card's body text as `MCP server: <name>`. So the name already reached
the card as one line of prose, but `source` (where the server's definition came
from, which the SDK says is what trust should key on) was dropped, and nothing
structured reached the shared contract for other consumers or providers.
Re-arm is still untouched.

Rechecked 2026-11-18 at SDK `0.3.326` before re-arm was built. The initialize
answer carries `pending_permission_requests`, `pending_user_dialog_requests`
and `pending_elicitation_requests` beside its `response`, not inside it.
`Query.reinitialize()` re-sends `initialize` and the SDK itself redelivers the
first two lists to `canUseTool` and `onUserDialog`, skipping an id it is still
answering; it drops the elicitation list, and `reinitialize()` resolves with
the inner `response`, so the caller sees none of the three. Over stdio the
re-sent request repeats the launch's hooks, prompts and agents; the bridge
sends MCP servers, plugins and managed settings on `argv`, so those are not
restated. The pinned CLI listed permissions on every answer and omitted the
elicitation list even while an MCP form request was pending
(`claude-rejoin-requests.live.test.ts`). The bridge's question and plan-approval cards did not watch the SDK's withdrawal signal, so a request
the CLI withdrew, or one from a CLI that had exited, stayed answerable.

**Decisions.**

- **Adopt re-arm?**
  - **Yes, after 0001's live runs (now 7568, 0001 tasks 3 to 6), re-arming as a fresh card that still denies on timeout (recommended).**
    - Pros: closes a "lost prompt" window after warm-CLI restarts (0005 made those more common).
    - Cons: risk of showing a card for a request the CLI has already answered; needs careful tests.
  - **No; treat a restart as denying everything pending.**
    - Pros: simplest, already safe.
    - Cons: the user loses the request and the turn may stall.
- **Show MCP provenance?**
  - **Add an optional `source` field to the shared interaction contract, populated by Claude first (recommended).**
    - Pros: normalise-then-generalise; helps users judge an MCP tool request.
    - Cons: protocol change for one provider initially.
  - **Leave it out.**
    - Pros: no work.
    - Cons: users approve MCP calls without knowing the server.

### 5. MCP Apps widgets

**Problem.** MCP tools that ship a UI (`_meta.ui`) render as plain cards.

**Context.** Needs a provider-neutral tool-card field before either bridge wires it; rendering arbitrary MCP HTML also raises sandboxing questions.

**Investigation.** Claude has `readMcpResource` and `_meta` members in `0.3.309`; nothing in the bridges or renderer reads them.

**Decisions.**

- **Keep deferred or schedule?**
  - **Keep deferred until a user-visible MCP server needs it (recommended).**
    - Pros: avoids building a sandboxed widget host speculatively.
    - Cons: parity with vendor UIs lags.
  - **Design the neutral tool-card field now.**
    - Pros: unblocks both bridges.
    - Cons: design without a consumer; the artefact-preview sandbox would need extending.

### 6. Other unused Claude and Codex surfaces

**Problem.** A set of vendor options and RPCs are unused with no stated consumer.

**Context.** Each needs a product reason before adoption; dynamic tools are answered as failure on purpose.

**Investigation.** Claude `additionalDirectories` / `skills` are referenced only in a comment (`bridges/claude-bridge/src/services/coordinator-skills.ts:6`). Codex uses only `config/mcpServer/reload` among config writes (`bridges/codex-bridge/src/engine/app-server-engine.ts:2161,2175`); `item/tool/call` still fails with a transcript explanation (the `item/tool/call` branch of `bridges/codex-bridge/src/app-server/server-request-router.ts`); `configRequirements/read` exists in the generated protocol and is not projected.

Codex dynamic tools, checked 2026-11-18 against the `0.169.0` pin:

- Registration is experimental and start-only. The committed (stable)
  protocol has no way to register one: `dynamicTools` is absent from the
  generated `ThreadStartParams`. Running `codex app-server generate-ts
  --experimental` on the pinned binary shows `dynamicTools?:
  Array<DynamicToolSpec>` on `ThreadStartParams` only, not on
  `ThreadResumeParams`, `ThreadForkParams` or `TurnStartParams`. The bridge
  initializes with `experimentalApi: false` (`process-supervisor.ts`), so it
  registers none and an `item/tool/call` is not expected at all.
- The concrete consumer is the workflow-result submit tool: the one
  host-provided tool a pipeline or graph result turn must call to finish
  (`workflowResultTool` and the graph slot tools, admitted in
  `app-server-runtime-prompt.ts`). The Orkestrator agent tools (mail,
  tickets, key information, artifacts) are the second candidate. Both are
  served today by the backend's `orkestrator` MCP server, the same server
  every other platform reaches.
- What that consumer needs: the call must reach the backend with the
  attempt's own credential, the tool set must change per attempt on a thread
  that keeps its conversation, and the call must bypass Codex's MCP approval
  gate. The turn should also be refused before dispatch when the tool is
  unavailable. The MCP path uses a per-attempt credential with
  `reloadThread` (which keeps the rollout) and a narrow workflow-result
  server that bypasses the approval gate. A confirmed missing tool returns
  424 before dispatch. An unverified inventory, such as after a timeout or
  RPC failure, permits dispatch.
- What a dynamic tool would change: the call would be answered inside the
  bridge, which would then need its own backend credential and a proxy route
  to deliver the result (the same hop that kept Claude off
  `createSdkMcpServer`, see "Decided out"). A per-attempt tool change would
  need a new thread, losing the conversation, because tools can be set only
  on `thread/start`. Whether registered tools survive the idle detach and
  `thread/resume` from the rollout is unverified. It would also be
  Codex-only, while the other five platforms keep MCP.

**Decisions.**

- **Keep these as candidates or move them to "Decided out"?**
  - **Keep as candidates, recheck on each bump (recommended).**
    - Pros: some (Codex config requirements, Claude `additionalDirectories` for multi-repo environments) have plausible future consumers.
    - Cons: the list stays long.
  - **Move to "Decided out".**
    - Pros: shorter backlog.
    - Cons: needs a real product decision for each, which nobody has made.

- **Codex dynamic tools: adopt one for the workflow-result submit tool, or defer?**
  - **Defer, answer every call with an explicit failure, and record what would justify adoption (recommended).**
    - Pros: no experimental opt-in; one tool path for every platform; the
      shared MCP path already serves the workflow-result submit tool; any
      unexpected call still gets one answer that tells the model and the
      user why it failed.
    - Cons: no in-bridge tool path exists if a future consumer needs one.
  - **Register the submit tool as a dynamic tool.**
    - Pros: no MCP server, and none of its configuration, on the thread.
    - Cons: needs `experimentalApi`, which exposes every experimental field
      and method to the bridge; registration only on `thread/start`, so a
      per-attempt change costs the conversation; the bridge would need its own
      backend credential to deliver the result; Codex would diverge from the
      other platforms.

### 7. Cursor `askQuestion`

**Problem.** Cursor's question tool cannot become a `question` interaction.

**Context.** Upstream gap.

**Investigation.** Still blocked at `@cursor/sdk` `1.0.40`: `askQuestion` is only a member of the `ToolName` string union (`bridges/cursor-bridge/node_modules/@cursor/sdk/dist/cjs/options.d.ts:378`, and `agent/options.d.ts`), with no typed call or answer API.

Rechecked at `1.2.0` (2026-10-30): `askQuestion` is still only in `ToolName`, there is still no `askQuestion` tool-call variant or answer API, and the bundled runtime still answers `askQuestionInteractionQuery` with `rejected`.

**Decisions.** None: blocked upstream; recheck on the next Cursor bump.

### 8. Pi compaction controls

**Problem.** Pi users cannot pass compaction instructions, abort a compaction or toggle auto-compaction. Instructions were built 2026-11-03; abort and the toggle were built 2026-11-06 (see "Task 8: abort and auto-compaction toggle built" under Assumptions and decisions).

**Context.** Shared layer has no compaction-parameter surface yet; optional instructions need a shared field and a capability bit so the UI accepts them only for providers that can honour them.

**Investigation.** The bridge calls `session.compact()` with no arguments (`bridges/pi-bridge/src/http.ts:911`). Pi `1.4.0` exposes `compact(customInstructions?)`, `abortCompaction()` and `setAutoCompactionEnabled()` / `autoCompactionEnabled` (`bridges/pi-bridge/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:726,730,771-773`). Rechecked 2026-10-30: the original recommendation's premise that Codex can also honour instructions is wrong at the current pins. Codex `0.164.0`'s `ThreadCompactStartParams` is `{ threadId }` only (`bridges/codex-bridge/src/app-server/generated/typescript/v2/ThreadCompactStartParams.ts`), and OpenCode `1.19.4`'s `session.summarize` body is `{ providerID, modelID, auto? }` (`apps/backend/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:8643`). Claude can honour them (its compact route sends the CLI's own `/compact`, `bridges/claude-bridge/src/routes/session.ts:1198`), and Grok may (the ACP bridge runs Grok's own `/compact` as a selected command, `bridges/acp-bridge/src/acp-http.ts:583-589`; whether that command takes input is unchecked). The shared `/compact` row also explicitly refuses arguments today (`rejectsArguments` in `packages/protocol/src/agent-slash-commands.ts:156-164`), so the change spans the protocol, the command dispatch, every provider's compact path and the web submission path. Rechecked at the 2026-10-30 pins: Codex `0.166.0`'s `ThreadCompactStartParams` is still `{ threadId }`, and OpenCode `1.19.5`'s `summarize` body is unchanged. Cursor `1.2.0` adds `agent.summarize()` (no instructions), now adopted by the bridge. Rechecked 2026-11-03 at `7b48c23fb`: Pi `1.4.0` still has `compact(customInstructions?)`, Codex `0.166.0`'s `ThreadCompactStartParams` is still `{ threadId }`, OpenCode is still `1.19.5`, and nothing had been built. On Claude a live catalogue normally lists the SDK's own `/compact`, which wins the collision and already takes instructions as a provider command; the action path (and its missing instructions) matters when that row is absent. Rechecked 2026-11-06 at `c1724ab74` (Pi `1.4.0`): a turn's own compaction (Pi's preflight check and the one after `agent_end`) runs inside the prompt's run, so the existing cancel, which calls `AgentSession.abort()`, already aborts it; the gap was the manual compaction from `/session/:id/compact`, which holds no prompt claim, so `/cancel` answered `cancelled: false` and the bridge reported the session `idle` (no Stop) while it ran. `compact()` calls `this.abort()` before it creates `_compactionAbortController`, so an `abortCompaction()` in that window reaches nothing. `setAutoCompactionEnabled()` calls `SettingsManager.setCompactionEnabled()`, which writes `compaction.enabled` into the global `settings.json` (`dist/core/settings-manager.js:635-641`); `getCompactionSettings()` and the `autoCompactionEnabled` getter both read `getCompactionEnabled()`, and the manager's `save()` recomputes its merged settings, dropping any `applyOverrides()` patch.

**Decisions.**

- **What to adopt first?**
  - **Custom instructions through an optional argument on the shared `compact` action, gated by a capability bit such as `actions.compactInstructions` (recommended).**
    - Pros: provider-neutral; enables instructions for Claude and Pi while refusing them for Codex and OpenCode at the current pins; Grok can opt in once its `/compact` input support is verified.
    - Cons: needs a composer affordance and capability-gated `/compact` argument policy, with changes across the protocol, command dispatch, provider compact paths and web submission path (see "Task 8: recommendation corrected, left open" under Assumptions and decisions).
  - **Abort and auto-toggle first.**
    - Pros: abort fixes a real "stuck compaction" case.
    - Cons: abort interacts with the claim and cancel logic in `http.ts:900-912`; the toggle is a Pi-only setting.

- **How does the backend learn that an older bridge dropped the instructions?** (decided 2026-11-03; see "Task 8: instructions built" under Assumptions and decisions)
  - **The new bridges echo `instructions: "applied"`; a missing echo is an applied outcome with `instructionsIgnored` (recommended).**
    - Pros: no extra round trip; a plain compaction sends exactly what it always did; never reports a compaction that ran as failed.
    - Cons: detected only after the older bridge compacted without the instructions, so the user is told rather than protected.
  - **Advertise the capability per bridge through the command catalogue, so the row refuses arguments on an older bridge.**
    - Pros: refuses before anything runs.
    - Cons: needs a new catalogue field threaded through every `withSessionActionSlashCommands` caller; the window it protects is a container that predates the backend upgrade.

- **How does a user stop a manual compaction?** (decided 2026-11-06)
  - **Through the existing Stop: the bridge reports `running` with `activity: "compacting"` while it compacts, and the cancel routes call `abortCompaction()` when no prompt claim owns the session (recommended).**
    - Pros: no new route, action or capability bit; the backend's stop ladder, an older backend and the renderer's Stop already work; matches how Claude reports its compaction.
    - Cons: a compaction now reads as a running turn with no `turnId`, so a steer status read answers `unknown` during it.
  - **A new `abort-compaction` session action with a capability bit.**
    - Pros: explicit, and leaves the status contract unchanged.
    - Cons: protocol, backend, renderer and capability changes for a case Stop already expresses; the tab would still show the session idle with no control.
- **Where does the auto-compaction toggle live?** (decided 2026-11-06)
  - **A session-scoped `autoCompaction` toggle parameter on every Pi model, applied by overriding the session's settings manager in memory and kept in the bridge's state file (recommended).**
    - Pros: the shared composer already renders toggle parameters and the backend already validates, stores and forwards them, so no renderer or protocol change; never touches the user's Pi settings or other sessions.
    - Cons: a model parameter for a session setting, so the backend has to keep it across a model switch (one line); the override assigns an SDK method on the instance, pinned by a test against the real SDK.
  - **Call Pi's `setAutoCompactionEnabled()`.**
    - Pros: Pi's own API, no override.
    - Cons: writes the account-wide `settings.json`, changing every Pi session and terminal tab on the host.
  - **`SettingsManager.applyOverrides()`.**
    - Pros: a public API meant for overrides.
    - Cons: the manager's own `save()` (a persisted model or thinking default, an extension's setting) silently drops it.

### 9. Second ACP agent

**Problem.** Only Grok runs over ACP.

**Context.** The `AcpProviderConfig` record (`bridges/acp-bridge/src/acp-provider-config.ts`) makes a new agent a config record plus a platform id.

**Investigation.** Still accurate. The ACP SDK is now `2.0.1`, so a second agent should be checked against the v2 SDK's protocol versions.

**Decisions.**

- **Keep deferred or schedule?**
  - **Keep deferred until a user asks for a specific agent (recommended).**
    - Pros: each platform adds toolchain, credentials and qualification cost.
    - Cons: the generalisation work sits unused.
  - **Add Gemini CLI now.**
    - Pros: proves the generalisation.
    - Cons: a seventh platform to maintain and qualify.

### 10. Grok MCP elicitation

**Problem.** Grok MCP servers that elicit input have no UI path.

**Context.** Grok uses a vendor reverse request rather than standard ACP elicitation; the bridge now handles it.

**Investigation.** Before this task, the ACP bridge had no elicitation handling (no hits under `bridges/acp-bridge/src`). The `2.0.1` ACP SDK does carry elicitation types (`dist/nes/acp.d.ts`, `dist/v1/acp.js`), so the client-side contract now exists; whether Grok `1.0.67` sends it is unchecked. Rechecked 2026-10-30: the bridge's `initialize` advertises only `fs`, `terminal` and `session` client capabilities (`bridges/acp-bridge/src/acp-context.ts:1156-1160`), not elicitation, and an elicitation request would be refused with `-32601` by the catch-all branch (`acp-context.ts:1414-1419`). Rechecked at Grok `1.0.70` (2026-10-30, signed out): both 1.0.67 and 1.0.70 document an "MCP elicitation card" driven by a vendor `x.ai/mcp/elicit` / `x.ai/mcp/elicit_complete` pair rather than standard `elicitation/create`, and the binary logs "MCP elicitation in non-interactive session; cancelling". At that point, whether a stdio ACP client was sent `_x.ai/mcp/elicit` remained unverified; the later live probe below answered that question for 1.0.67.

Rechecked 2026-10-30 against the 1.0.67 and 1.0.70 binaries, signed out (`strings`, bundled docs): both versions contain the vendor extension request `_x.ai/mcp/elicit` (form and url modes; Accept, Decline or Cancel) with a `_x.ai/mcp/elicit_complete` follow-up.

Probed live 2026-10-31 on 1.0.67: `agent stdio` does forward both modes, the answer is tagged by `outcome` (`accept` with `content`, `decline`, `cancel`), and an MCP-shaped `action` reads as malformed and cancels. Built on that; see `bridges/acp-bridge/AGENTS.md` ("Grok extensions").

**Decisions.**

- **Recheck now or wait?**
  - **Probe Grok for an elicitation request, then build against the observed contract (recommended; completed on 1.0.67).**
    - Pros: proves both modes before wiring the shared cards.
    - Cons: needs an MCP server that elicits; 1.0.70 still needs a live recheck.
  - **Wait for Grok release notes.**
    - Pros: no effort.
    - Cons: Grok's release notes rarely name ACP changes.

### 11. Grok `costUsdTicks` qualification

**Problem.** Grok turns showed no cost because the tick unit and scope were not confirmed for ACP.

**Context.** Grok documents 10¹⁰ ticks per USD for `grok usage` and headless output. The open question was whether ACP's `costUsdTicks` is the same quantity, and whether it is per turn or cumulative. The billed run planned for it in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md) (2026-11-10) needs a signed-in Grok CLI and the xAI billing dashboard; this host has no Grok login.

**Investigation.** Read 2026-11-18 from the pinned Grok `1.0.77` binary (`strings` over the managed toolchain's `grok`), with no login and no billed turn:

- Unit. The embedded docs say headless `total_cost_usd_ticks` "is the same value in exact integer ticks (1 USD = 10^10 ticks)", with the example `0.01268905` USD = `126890500` ticks, and that `grok usage`'s `costUsdTicks` "is 10^10 ticks per USD (divide by `1e10` for dollars)".
- Same field. ACP's `costUsdTicks` is a member of the `PromptUsage` struct (`inputTokens`, `outputTokens`, `totalTokens`, `cacheCreationTokens`, `reasoningTokens`, `modelCalls`, `apiDurationMs`, `costUsdTicks`, `costIsPartial`, plus `modelUsage` and `usageIsIncomplete`), the shape `turn_completed`'s `usage` and the prompt result's `_meta.usage` carry. The `grok usage` per-turn `UsageSummary` has the same fields under the same names.
- Scope. `PromptUsage` is the prompt's own usage: the headless docs call ACP `_meta.usage.inputTokens` "(PromptUsage) ... the full prompt sum", and the recorded fixture is one model call of 15,675 tokens at 226,620,000 ticks ($0.022662). The bridge already treats the token counts beside the ticks as per turn. That suggests per-prompt ticks, but the single-prompt fixture cannot distinguish per-prompt and cumulative values.
- Other carriers. `response_completed` carries `ResponseUsage` (five token fields, no ticks); ACP `usage_update`'s USD `cost` is the session's cumulative total.
- Ambiguity. Grok omits its own cost floats when `costIsPartial` or `usageIsIncomplete` is set, so ticks beside either flag are a lower bound.

**Decisions.**

- **What evidence qualifies the conversion?**
  - **The pinned binary's embedded docs and wire structs alone.**
    - Pros: available without a login or spend; ties the ACP field to the documented unit by name and struct; reproducible at every pin bump.
    - Cons: static evidence, not an observed bill; a server that stamped a different quantity under the same name would not show here.
  - **Wait for the billed checklist run (recommended; chosen).**
    - Pros: reconciles against the dashboard.
    - Cons: needs a signed-in Grok and access to the billing dashboard.
- **Where do per-turn ticks show?**
  - **On each turn's row, and summed into the panel's session cost only while every counted turn had qualified ticks (recommended; chosen).**
    - Pros: matches the session scope other providers give `costUsd`; usage history, which sums rows, stays exact.
    - Cons: missing cost hides the session total until the last turn is corrected or a cumulative USD snapshot establishes a new total.
  - **The last turn's ticks as the panel's cost.**
    - Pros: simplest.
    - Cons: a per-turn amount under a session label.

### 12. OpenCode `find.*` and Session V2 features

**Problem.** OpenCode file search is unused, and V2-only features wait.

**Context.** Session V2 is owned by 0008. `find.*` has no consumer: Orkestrator's own file search already covers workspaces.

**Investigation.** No `find.*` call under `apps/backend/src` (rechecked 2026-10-30).

**Decisions.**

- **Keep `find.*` as a candidate?**
  - **Drop it to "Decided out" with the reason that Orkestrator owns file search (recommended).**
    - Pros: removes a candidate with no plausible consumer.
    - Cons: closes a door that costs nothing to leave open.
  - **Keep it.**
    - Pros: no decision needed.
    - Cons: rediscovered on every review for nothing.

### 13. Living-doc drift

**Problem.** Two living docs describe code that has moved.

**Context.** Listed under Related; docs-only fixes.

**Investigation.** Still present. `docs/architecture/agent-engines.md:902-903` still says every other inbound ACP request is refused with `-32601`, although `bridges/acp-bridge/src/acp-client-methods.ts` serves `fs/*` and `terminal/*`; `agent-engines.md:874` also still names Grok `1.0.52` (pin is `1.0.67`). `agent-engines.md:228`, `docs/development/upgrade-agents.md:440` and `:521` still name `services/session-manager.ts`, which is a 12-line barrel.

**Decisions.**

- **When to fix?**
  - **Now, as a docs-only change (recommended).**
    - Pros: cheap; only `mise run format:check` needed; stops the next upgrade reading the wrong file.
    - Cons: none of substance.
  - **At the next agent bump.**
    - Pros: one combined edit.
    - Cons: the stale guidance is what that bump would follow.

## Assumptions and decisions

### Recheck at the 2026-10-30 upgrade

The pins moved to Claude `0.3.314` / `2.1.314`, Codex `0.166.0`, OpenCode
`1.19.5`, Cursor `1.2.0`, Grok `1.0.70` and ACP SDK `2.1.0` (Pi unchanged).
Rechecked every task and candidate here against them; the per-provider
classification is in 1020 (retired 2026-11-13; `git show 17d28238c:docs/todo/agent-engines/1020-provider-upgrade-2026-10-30.md`). Changes made
here: the Codex goals entry under "Decided out" is corrected, because the
flag it relied on defaults on, and the bridge now turns it off. New candidates
were added for Claude, Codex, Cursor and Grok. Tasks 7, 8, 10 and 11 record the
new evidence; their statuses are unchanged apart from the wording of 10 and 11.

Recorded 2026-10-30 by the worker that acted on this file, against `main` at
`cd7bbe3e5`. Each choice takes the (recommended) option unless it says why not.

### Task 1: refresh the pins in place

Chose the recommended option: "Current state" and "Needs verification" now
name the current pins, and the Codex-goals entry under "Decided out" says
"feature-flagged" rather than "no stable goal RPC". Kept the pin list rather
than pointing at `manifest.ts`, because the list records which version each
candidate was last checked against. The goals RPC is in Codex `0.164.0`'s
generated surface (`thread/goal/get|set|clear` and the `cleared` / `updated`
notifications in `bridges/codex-bridge/src/app-server/generated/protocol-manifest.json`);
the bridge never sets `features.goals` in production (the only uses are the
`configOverrides` doc comment in `process-supervisor.ts:95` and its test).

### Task 1: do not reopen Codex goals

Chose the recommended option. A Codex feature flag is not a stability promise,
and "Decided out" says not to reopen without a new reason. Revisit when goals
leave the flag.

Rechecked 2026-10-30: the revisit condition is already met at the pin.
`codex features list` (throwaway `CODEX_HOME`) reports `goals  stable  true`
for both `0.164.0` and `0.166.0`, so goals are on by default without
`features.goals`, and the bridge drops `thread/goal/updated` and
`thread/goal/cleared` as bookkeeping (`event-reducer.ts:162-163`) without
tracking them anywhere. A goal the model or a user sets in a Codex tab is
therefore invisible in Orkestrator. Goals are being handled centrally for every
provider (2026-10-31), so no Codex-only work follows from this.

### Task 2: delete the guard and its type

Chose the recommended option, and also deleted the `SdkCompactBoundaryMessage`
interface: it existed only to give the guard a narrowing target, and its one
import (`session-manager-session.ts`) was as unused as the guard's. The guard's
test cases went with it. `isSdkResultMessage` and its tests stay.
`SYSTEM_SUBTYPE_DISPOSITIONS` still records `compact_boundary`, so the drift
check is unchanged.

### Task 3: keep the HTTP MCP server

Chose the recommended option and moved the item to "Decided out". Pi, Cursor,
Codex and Grok reach the same HTTP server, and the backend, not the bridge,
enforces per-tab scope. An in-process server would still need a backend
credential to proxy calls, so the loopback hop would move rather than
disappear.

### Task 4: left open (2026-10-30)

Did not start it. Re-arm is recommended only after 0001's live runs, and those
are still open (`0001-agent-interactions-and-permissions.md` tasks 3–7).
Provenance is a protocol, bridge and renderer change that would have made this
batch too big; nothing blocks it.

### Task 4: provenance as an optional request-level `source` (2026-11-02)

Took the recommended option for provenance and left re-arm open: it still
waits on 0001's live runs (`0001-agent-interactions-and-permissions.md`
tasks 3–7), as the ticket asked.

- **Where the field lives.** Options: on `AgentInteractionRequest` beside
  `hold` and `blocking` (chosen), or inside `presentation`. Request level
  because provenance is a fact about who asked, not wording; a later provider
  can fill it without touching presentation text, and the content-free
  serializers (telemetry, transcript event, draft) already pick fields
  explicitly, so it cannot leak into them. Presentation would have been where
  the card reads everything else, but it would mix a fact with display copy.
- **Shape.** `{ kind: "mcp-server", name, scope? }`. `kind` is a one-value
  union so another kind of requester needs no new key; `name` is bounded at
  256 (`AGENT_INTERACTION_LIMITS.maxSourceNameLength`, the bridge's existing
  bound); `scope` is the SDK's `McpServerProvenance.source` kept only when it
  is a short lowercase token (`/^[a-z][a-z0-9_-]{0,31}$/`). Alternatives were
  forwarding the SDK's raw `source` string (rejected: it is an open set from
  the vendor and would reach the renderer unchecked) or name only (rejected:
  the scope is the part that helps judge a request).
- **Scope wording.** One table in the protocol
  (`agentInteractionSourceScopeLabel`): `project` reads "project settings",
  `plugin` "a plugin", `sdk` "the agent host", and so on. An unknown scope reads
  "other configuration", never as the host, following the SDK's own rule that
  an unknown value is a configured source and never `sdk`.
- **The old body line.** Options: keep `MCP server: <name>` in the body as
  well (duplicates the new line on the card), or drop it when a source is
  published (chosen). Dropping it would have cost the text-only consumers the
  name, so the public CLI (`session.interactions`) and the build pipeline's
  interaction summary now build their body through
  `agentInteractionTextBody`, which puts `MCP server: <name> (from <scope>)`
  first. The body line stays only when the bridge's name cannot become a
  source (over 256 characters), so no request loses the name.
- **Bridge.** `ClaudeToolApprovalRequest` gains `mcpServerSource`, filled
  through the protocol's `mcpServerInteractionSource` so the bridge and the
  contract share one pattern. A bridge that predates the field sends only
  `mcpServer`, which still becomes a source without a scope.
- **Card.** `NativeAgentInteractionCard` shows one muted line, "Requested by
  MCP server **name** · from project settings", above the rest of the card
  body. The name renders as text only (it is untrusted configuration), in a
  monospace span that breaks anywhere so a long name wraps at narrow widths.
  Requests without a source render exactly as before.
- **Not filled.** Claude's MCP elicitation cards (`mcp-form`, `mcp-url`)
  already name the server in their title, so they get no source; Codex,
  OpenCode, Cursor, Grok and Pi do not report MCP provenance on approvals at
  the current pins and send none. Nothing here changes how a request is
  answered or which requests a permission rule may answer.

### Task 4: re-arm on an actual rejoin (2026-11-18)

Built the re-arm half. Decisions:

- **When to read the inventory.** Read it on a prompt joining an idle warm CLI
  (chosen), with a 2 s bound. Reading it on every join covers busy runtimes too,
  but reinitializing settles outstanding callbacks and can deny a background
  tool in PreToolUse. A tab remount only sees cards already held by the bridge.
  A failed, slow or unsupported read leaves the join eligible to proceed.
- **How to read it.** Options: `Query.reinitialize()` (chosen), or tapping the
  CLI's stdout through `spawnClaudeCodeProcess` to see the raw answer. The SDK
  already redelivers permissions and dialogs from a `reinitialize()` answer
  and dedupes ids it is answering; a tap would put a frame parser in front of
  every production frame for one read.
- **Rendering each request once.** The SDK skips a redelivery only while its
  first delivery is open, so a re-read that crosses the bridge's answer would
  raise a second card for a resolved request. One ledger per CLI
  (`claude-control-requests.ts`) shares an open answer, refuses an answered id
  (deny), withdraws every open card when the process ends and refuses any
  later delivery. Alternatives were relying on the SDK alone (the crossing
  case shows a dead card) or replaying the recorded answer (would keep tool
  inputs in memory for a case the CLI ignores anyway); a refusal fails closed.
- **Withdrawn and dead-CLI requests.** Question and plan-approval cards now
  withdraw on the SDK's signal like tool approvals, and every kind is taken
  down in the same tick, so an answer cannot land in between.
- **Absent inventory.** Treated as unknown: nothing is withdrawn or raised for
  a missing list. Withdrawing a held card because a present list omits it was
  not built, because the caller cannot see the lists; a CLI that withdraws a
  request says so with `control_cancel_request`, which the signal carries.
- **Elicitations.** Recovery of CLI-only elicitations is deferred until a
  CLI/SDK pair lists pending elicitations and the SDK redelivers them or offers
  a response API. The live probe held a real MCP form request open. The
  pinned CLI `2.1.326` omitted it from initialize and SDK `0.3.326` neither
  exposed inventory nor replayed the held request. The pin in `live-claude-control.test.ts` flags a public SDK
  return-type change. No released version with both capabilities was
  qualified.

### Tasks 5, 6 and 9: keep deferred

Chose the recommended option for each: MCP Apps widgets stay deferred until a
user-visible MCP server needs them; the other Claude and Codex surfaces stay as
candidates and are rechecked on each bump; a second ACP agent waits for a user
to ask for a specific one. Nothing in the current pins changes those reasons.

### Task 6: Codex dynamic tools deferred (2026-11-18)

Task 6, Codex dynamic tools. Chose to defer, the recommended option above.
The consumer examined was the workflow-result submit tool, compared with the
`orkestrator` MCP server that serves it today; the investigation under task 6
has the comparison, including the admission check for confirmed missing
tools. A dynamic tool would add an experimental opt-in, a second backend
credential in the bridge and a Codex-only path.

The router now answers an `item/tool/call` with exactly one failure: no
JSON-RPC error, `success: false` and one `inputText` item naming the requested
tool and saying the session registers no dynamic tools, so the model does not
retry an empty result. The transcript notice names the tool too; the call's
arguments are never echoed. The tool label is single-line and capped at 120
Unicode code points before the ellipsis. An unusable tool name gets a generic
failure notice. The call still counts as an invariant violation, because
the bridge registers no dynamic tools.

What would justify adoption, all of:

1. `dynamicTools` in the stable protocol, so it appears in the committed
   generated `ThreadStartParams` without `experimentalApi`.
2. Registration on `thread/resume` or `turn/start`, or documented persistence
   of registered tools across `thread/resume`, so an idle detach, a reload
   and a bridge restart keep them.
3. A consumer the shared MCP server cannot serve: a tool whose implementation
   needs bridge-local state (the app-server child or the live thread), or a
   recorded failure of the MCP path (the 424 refusal firing for users, or the
   reload losing the tool) that a dynamic tool would avoid.

If adopted, the tool is registered per thread from the session's execution
policy. Each call gets one answer within that policy. A name the thread did
not register keeps today's explicit failure. A call pending when its
generation dies is abandoned as a dead generation's approval is. Logs stay
content-free.

### Task 7: still blocked

`@cursor/sdk` is now `1.2.0`, and the upstream gap is unchanged.

### Task 8: recommendation corrected, left open

The recommended option assumed Claude and Codex could both honour compaction
instructions. At the current pins Codex (`ThreadCompactStartParams` is
`{ threadId }`) and OpenCode (`summarize` takes only a model) cannot. A shared
`instructions` argument would therefore need a capability bit (for example
`actions.compactInstructions`), set for Claude and Pi, and for Grok only if
its `/compact` is shown to take input. That bit should
gate the `/compact` row's argument policy, so the composer refuses arguments
where the provider would silently drop them. That touches the protocol, the
command dispatch, five provider paths and the web submission path, too large
for this batch. Abort and the auto-compaction toggle stay second, as
recommended. Task 8's Context and Decisions now state this capability-gated
recommendation directly, replacing the stale claim that Codex can honour the
shared argument. Task 8 remains open.

### Task 8: instructions built

Recorded 2026-11-03 against `main` at `7b48c23fb` by the worker that built
the instructions half of task 8 (abort and the auto-compaction toggle stay
open, as recommended).

- **Capability bit.** `actions.compactInstructions` in
  `nativeAgentCapabilities`, on for Claude and Pi only. Grok stays off: its
  `/compact` input is still unverified, and turning the bit on later is the
  whole change.
- **Argument policy.** The `/compact` session-action row keeps one id and
  binding revision; where the platform has the bit its `inputPolicy.arguments`
  is `optional` with hint `[instructions]`, elsewhere it stays `none`. Chosen
  over a second command id because a selection made before the capability
  changed still binds, and the renderer and backend already resolve through
  that policy, so nothing else needed a platform check.
- **Wire.** `NativeAgentSessionAction` compact gains `instructions`, trimmed,
  blank meaning none, bounded by `COMPACT_INSTRUCTIONS_MAX_LENGTH` (16 000
  characters). Both backend compact paths (the composer's projection action and
  a `/compact` prompt dispatch) refuse instructions for a platform without the
  bit before calling the provider (`compactInstructionsRefusal`), and the HTTP
  adapter refuses again rather than send them. Bridges read them with the shared
  `parseCompactInstructionsBody`.
- **Bridges.** Claude sends the CLI's own `/compact <instructions>`; Pi calls
  `session.compact(instructions)`, reading the body only after its synchronous
  claim so a prompt cannot slip into the gap. Both answer
  `instructions: "applied"` when they used them, and a plain compaction's answer
  is unchanged.
- **Older bridges.** Chose the echo (Decisions above). The backend records
  `compact.instructions-ignored` and returns an applied outcome with
  `instructionsIgnored`; the composer clears the draft (a retry would compact
  twice) and says the instructions were not used. Registered in
  `version-compatibility.md`.
- **Renderer skew, accepted.** A renderer older than this change talking to a
  newer backend sees the row accept arguments but sends the action without
  them, so it compacts plainly. The opposite pairing is safe: an older backend
  publishes `none` and the newer composer refuses the text.
- Tests use fake providers and bridges only; no billed turn was run.

### Task 8: abort and auto-compaction toggle built

Recorded 2026-11-06 against `main` at `c1724ab74` (Pi `1.4.0`) by the worker
that built the rest of task 8.

- **Stopping a compaction.** Chose the existing Stop (Decisions above). The
  Pi bridge reports `running` and `activity: "compacting"` from `/status` and
  `/session/:id` while `state.compacting`, and the backend's progressive state
  read now maps that `activity` for Pi as it does for Claude. With no prompt
  claim, `/cancel`, `/abort` and `/hard-abort` call `abortCompaction()` on the
  manual compaction the compact route is running, and the session listener
  aborts again on `compaction_start` for a cancel that landed inside
  `compact()`'s own `abort()`. The cancel answers `cancelled: true` once the
  compact route settles having stopped it, `cancelled: false` if Pi finished
  first, and 202 pending past the acknowledgement bound. The compact route
  answers 409 `{ error, cancelled: true }`; the backend shows that error alone,
  so the composer says the compaction was stopped and keeps the draft.
- **Auto-compaction toggle.** Chose the session toggle parameter (Decisions
  above). Every Pi model carries `autoCompaction` (label "Auto-compact",
  `scope: "session"`, default Pi's own `compaction.enabled`), added when the
  composer is published so a catalogue rehydration cannot drop it. A config,
  create, resume or prompt body's `parameterValues.autoCompaction` sets the
  session's choice; the session's `SettingsManager.getCompactionEnabled` is
  replaced on the instance with a live read of that choice, so it holds
  across the manager's `save()` and needs no re-attach. The choice is
  persisted in the bridge's `state.json`; Pi's `settings.json` is never
  written for it. The backend keeps `autoCompaction` across a model switch
  for Pi, as it already keeps Claude's session-default parameters.
- **Compatibility.** An older Pi bridge publishes no toggle and still reports
  `idle` during a manual compaction, which is the behaviour before this
  change. A newer bridge behind an older backend shows Stop for a compaction
  (the older backend just shows no compacting label) and the toggle (the
  older backend already handles toggle parameters generically). No
  version-compatibility entry was needed.
- **Visual.** The renderer is unchanged; the toggle is the shared composer's
  existing toggle-parameter button ("Auto-compact: On/Off"). It was shown with
  a standalone mock, not a live Pi tab (see 7280).
- **Tests.** `bridges/pi-bridge/src/compaction-controls.test.ts` runs the real
  Pi SDK over pi-ai's faux model (the fake engine's model): Stop ends a
  compaction whose summary request never answers, a cancel inside
  `compact()`'s own `abort()` stops it before any summary request, the toggle
  off prevents threshold compaction across three turns and on brings it back,
  Pi's `compaction` settings are unchanged, and the override holds across the
  settings manager's `save()`. No login and no billed turn.

### Task 10: built after a live probe

A signed-in probe on 2026-10-31 answered the open question (Grok forwards
elicitation over `agent stdio`), so the cards were built and proved through the
bridge in the same change.

### Tasks 1, 7, 10 and 11: preserve both branches during the main merge

Resolved on 2026-10-31 against `main` at `751b971623`: kept the upgraded
provider pins and the documented Grok tick scale, together with this branch's
completed Grok elicitation and Cursor compaction adoption. The live elicitation
evidence remains specific to Grok 1.0.67; merging the 1.0.70 pin does not prove
a new live run. Kept task 11 open for the remaining ACP cost qualification.

### Task 11: gate tick conversion on observed billing

Grok 1.0.77 documents 10¹⁰ ticks per USD. The bridge accepts raw ticks
from Grok prompt results and `turn_completed` notifications. It rejects
partial and malformed tick values and requires each attempt of a continued
turn to have a known tick cost.

The accounting keeps the subtotal before the latest turn so a late report can
supply or invalidate that turn's cost. Missing cost is independent of token
counts. The panel can use a cumulative USD snapshot immediately. History uses
a per-turn delta when the preceding total is known, or the turn's own ticks
once qualified. History replaces revised Grok rows by turn ID and revision.

Tick-derived dollars remain disabled in production. Reconcile two distinct
billed increments against their raw ACP usage using checklist 7568 before
enabling the conversion. Store a sanitized two-turn fixture with the result.

### Task 12: drop `find.*`

Chose the recommended option and moved it to "Decided out": Orkestrator owns
workspace file search, and no consumer exists. Session V2 stays with 0008.

### Task 13: fix the living docs now

Chose the recommended option. `agent-engines.md` "Claude Code" and
`upgrade-agents.md` now name the real compatibility surface. "Grok Build" now
describes the `fs/*` and `terminal/*` client methods, the `x.ai/*` reverse
requests, the provider config record, the protocol-version refusal and the
image capability. Grok behaviour that was observed only at `1.0.52` is marked
"not rechecked at 1.0.67" rather than restated as current, because nobody has
observed it at the new pin.

This is one list of the vendor SDK and CLI surfaces Orkestrator does not use,
with the reason for each, and of the product decisions that keep some of them
out. Every entry has already been reviewed against a vendor release and
deliberately deferred or declined. Without this list, the next SDK review
rediscovers the same gaps. It is low priority: nothing here is a defect.

### Pi `responseModel` adopted (2026-11-18)

Moved out of "Candidates" under the maintenance rule. Each Pi assistant row
now names the model that answered (`provider/responseModel`, else the
requested `provider/model`, which is all a session entry an older Pi wrote
carries), live and when a resume replays Pi's file; the composer keeps the
user's selection. A turn's `NativeAgentTurnUsage.modelId` is set only when its
token and cost contributors all identify the same model. Mixed and
unidentified spend goes into usage history without a model ID. How it works is under "Model
attribution" in [`bridges/pi-bridge/AGENTS.md`](../../../bridges/pi-bridge/AGENTS.md#model-attribution).

## Current state

- Pins (upgraded 2026-11-06, 1031 (retired)):
  Claude Agent SDK `0.3.319` / CLI `2.1.319`, Codex `0.167.0`, `@cursor/sdk`
  `1.3.1`, Pi `1.5.0`, Grok `1.0.77`, `@agentclientprotocol/sdk` `2.4.0`.
  OpenCode is the 2.x binary `opencode2` `2.2.6` with no SDK
  (`packages/toolchain/src/manifest.ts`): the 1.x SDK and CLI `1.19.5` were
  retired on 2026-11-11 (see 0008 "OpenCode 1.x retired (2026-11-11)"). `tests/unit/version-drift.test.ts` keeps
  every mirror of each pin in step.
- Drift detection:
  - Each bridge dispatches over its vendor's typed union and turns an unknown
    variant into a runtime-health drift counter and an advisory notice
    (`NativeAgentRuntimeDrift` and the `advisory` notice in
    `packages/protocol/src/native-agent.ts`).
  - Both provider kinds implement `runtimeHealth?()` (`http-bridge-provider.ts`,
    and `opencode2/provider.ts` since the 1.x `opencode-provider.ts` was
    retired on 2026-11-11), and every bridge serves
    `GET /session/:id/runtime-health`.
  - Per-bridge tests feed invented variants: for example
    `bridges/claude-bridge/src/sdk-compatibility.test.ts`,
    `bridges/acp-bridge/src/acp-drift.test.ts`. The OpenCode 1.x one,
    `opencode-drift.test.ts`, was retired with 1.x on 2026-11-11
    (`git show 5f4e27b1c:apps/backend/src/core/opencode-drift.test.ts`).
  - Codex checks its generated protocol with `mise run codex:protocol:check`.
- `nativeAgentCapabilities()` (`packages/protocol/src/native-agent.ts`) is the
  source of truth for what each platform supports. The capability matrix in the
  old coverage review is stale and should not be revived.

## Outstanding work

### Decided out

These are product decisions, not backlog. Do not reopen them without a new
reason.

- **Provider-native code review.** Code review is an Orkestrator pipeline.
  Codex `review/start` stays as it is and is not extended;
  `enteredReviewMode` / `exitedReviewMode` items are not rendered
  (`item-adapter.ts`), and `autoApprovalReview/strictReviewRequired` is ignored.
- **Cursor cloud agents and auto-PR.** The bridge runs `runtime: "local"` only.
- **Codex product surfaces with no Orkestrator counterpart:** plugins and
  marketplace, thread sections, realtime and voice (`thread/realtime/item/*` is
  on the ignore list), the Windows sandbox, managed worktrees and the Windows
  shared daemon. The last two would replace Orkestrator's own worktree and
  process lifecycle. Codex `mcpServer/tool/call` and `resource/read` are also
  out.
- **Codex goals.** Disabled. Correction (2026-10-30): goals were never
  behind an off flag. `features.goals` has been stable and on by default
  since at least `0.164.0`, so every native thread offered the model
  `create_goal`, `get_goal` and `update_goal`. Every bridge now launches
  app-server with `features.goals=false` (`codexAppServerConfigOverrides`;
  the loopback case in `live-network-lock.test.ts` proves Codex's default
  offers the tools and a bridge thread does not). `thread/goal/*`
  notifications are ignored. Superseded 2026-10-31 by the `/goal` plan (#1979
  folded it into [goals.md](../../architecture/goals.md)): `/goal`
  is the backend's own loop on every provider, so Codex's stays off and no turn
  is ever one Codex continued on its own.
- **Claude `createSdkMcpServer()` for the Orkestrator control tools.** One
  HTTP MCP server serves every platform (Pi, Cursor, Codex and Grok reach the
  same one), and the backend, not the bridge, enforces per-tab scope. An
  in-process server would still need a backend credential to proxy each call,
  so the bearer-token hop would move rather than disappear, and Claude would
  diverge from the other bridges.
- **OpenCode `find.*` file search.** Orkestrator owns workspace file search;
  the provider's search has no consumer.
- **Pi provider login.** Status stays read-only (see
  [agent-engines.md](../../architecture/agent-engines.md) § Pi; to-do 0003, retired
  2026-11-13).
- **Codex `thread/delete`.** Never.
- **Claude `verbatimPrompts` / `client_composed`.** It skips the CLI's
  turn-start attachment pass, which is a real behaviour cost with no reported
  problem to solve.
- **Pi `meta` provider hosts.** They fall outside the Pi allowlist's
  mainstream-provider policy. Users can add `api.meta.ai` through the
  environment's `allowedDomains`.
- **Pi prompt-cache warming.** It is on by default, in idle mode since Pi 1.5.1
  (also between runs, until the bridge's idle detach disposes the session). A
  refresh is attributed to the running turn's cost, or to the next turn's when
  it ran between turns, and the shared layer has no setting for it.
- **Grok private `plan_kept` / `plan_cleared` / `plan_executing` updates.** The
  supported `x.ai/exit_plan_mode` reverse request covers plan review; these stay
  private.

### Candidates

Unadopted today. Each line says what blocks it or what decision it needs.

- Claude (`bridges/claude-bridge`):
  - `additionalDirectories`, inline `agents` and the `skills` option. Not used.
  - Pending-permission re-arm on (re)initialize is adopted (task 4): an idle warm rejoin
    calls `Query.reinitialize()` and the SDK redelivers
    `pending_permission_requests` and `pending_user_dialog_requests`
    (`recoverClaudeRequestsOnRejoin` in `live-claude-control.ts`).
  - MCP Apps widgets (`readMcpResource`, the tool's `_meta.ui`), and the Codex
    equivalent. Both need a provider-neutral tool-card field before either
    bridge wires them.
  - `permissions.blockWritesOutsideWorkingDirectories` (Agent SDK 0.3.314).
    A possible worktree-confinement policy; needs a product decision, and it
    also removes EnterWorktree/ExitWorktree. 0.3.319 adds
    `permissions.blockReadsExemptPaths` and `workingDirectoriesAsGiven` (only
    from `--settings` or flag settings), which could let the CLI hold the
    coordinator read boundary beside the hook; same decision.
  - `pending_elicitation_requests` on the initialize answer (0.3.319): blocked
    upstream. SDK `0.3.326` drops it and returns none of the lists to the
    caller, and CLI `2.1.326` did not list a real outstanding form request.
    Wire it into `recoverClaudeRequestsOnRejoin` once the SDK redelivers it to
    `onElicitation` or returns it (the typecheck pin in
    `live-claude-control.test.ts` fails then). `mcp_call.check_permissions`
    (0.3.319) belongs with MCP Apps widgets.
  - `CLAUDE_CODE_SUBAGENT_EFFORT` (2.1.316): since 2.1.317 a subagent on
    another model uses that model's saved effort, not the composer's. It is
    launch-only, which conflicts with restating effort on every join; revisit
    on a user report.
  - `onFailure: 'block'` on hook matchers (2.1.317). The bridge fails its
    boundary hooks closed itself instead (1031 (retired) task 3); adopt once the bridge
    knows the CLI version before building the query.
  - `initializationResult()` is adopted: a running CLI's held answer serves the
    model catalogue and the account (`live-claude-control.ts`). `startup()` /
    `WarmQuery` and `prewarm()` / `claim()` were measured and not adopted at
    0.3.314; the decision and what would reopen it are in
    [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md).
    Recheck on a bump whether `claim()` takes `resume` or inline MCP servers.
    `getSubagentMessages()` and message rewind are tracked in
    0006 (retired 2026-11-14; [agent-engines.md](../../architecture/agent-engines.md#rewinding-a-conversation-and-pi-branches)).
- Codex (`bridges/codex-bridge`):
  - `config/*` writes (only `config/mcpServer/reload` is used), `command/exec`,
    `fs/*`, `feedback/upload`, `gitDiffToRemote`.
  - Dynamic tools. Deferred 2026-11-18 (task 6): the workflow-result submit
    tool, the concrete consumer, is fully served by the `orkestrator` MCP
    server, and registration needs `experimentalApi` and works only on
    `thread/start`. `item/tool/call` is answered as one explicit failure
    naming the tool (`server-request-router.ts`). Adoption needs a stable
    `dynamicTools`, registration that survives `thread/resume`, and a
    consumer MCP cannot serve.
  - `Account.chatgpt.workspaceName` (0.166.0) in the account label. The shared
    account shape (`label`, `plan`) has no workspace field, so it needs a
    protocol field first.
  - Experimental `accountSession/list|switch`, `thread/fork.attachToSource`
    and `thread/memory/read` (0.166.0). Outside the generated surface (no
    experimental flag); revisit if they become stable.
  - Managed application and network requirements (`ConfigRequirementsReadResponse`
    and friends in `src/app-server/generated/`). They are in the generated
    protocol but not projected, pending a provider-neutral requirements surface.
    0.167.0 adds a managed `[permissions.network]` table to them.
  - Declaring `InitializeCapabilities.requiredHumanApproval` (0.167.0,
    experimental only). Without it a host's managed `prompt-user` rule rejects
    matching commands instead of prompting. The bridge already maps a
    `humanCommand` approval onto the shared `humanRequired` marker (1031
    (retired) task 11); declaring the capability waits for the API to leave experimental.
  - `features.respect_system_proxy` (0.167.0, experimental, off): only on a
    corporate-proxy report, as a provider-neutral environment setting.
- Cursor (`bridges/cursor-bridge`):
  - `askQuestion` is in the SDK's `ToolName`, but the SDK has no typed tool-call
    variant and no answer path, so it cannot become a `question` interaction.
  - Root-session `resourceProviderOptions` and `overrideDeleteExecutor`
    (1.2.0) as a coordinator write guard. `LocalToolExecutor` is opaque, so
    the shape of a guard is unclear.
  - `local.hostMcpBridgeUrls` (1.3.0, `@internal`): exempts loopback MCP URLs
    from a team admin allowlist. Only if a team-admin user reports
    Orkestrator's loopback MCP tools blocked.
  - `SendOptions.local.force` and `SDKAgentInfo.archived` are tracked in
    [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md) and
    0006 (retired 2026-11-14; [agent-engines.md](../../architecture/agent-engines.md#rewinding-a-conversation-and-pi-branches)).
- ACP (`bridges/acp-bridge`):
  - A second ACP agent (Gemini CLI, Claude-over-ACP). The launcher now builds
    an `AcpProviderConfig` record (`acp-provider-config.ts`; the Grok record is
    built in the backend launcher and passed as `ACP_PROVIDER_CONFIG`). A new
    agent is that record plus a platform id in
    `packages/protocol/src/agent-platforms.ts`, with packaging covered by
    `tests/unit/bridge-packaging.test.ts`.
  - Grok cost (task 11) parses and accounts for raw ticks. Publishing
    tick-derived dollars waits on the billed qualification below.
  - Grok `GROK_DISABLE_EXPERIMENTS=1` (1.0.70) for bridge children. It would
    stop config-file experiments changing the default model or update channel,
    but also overrides experiments a user joined. Decide with a user report.
  - Grok background-task status `failed` (1.0.77) and
    `PromptResponse._meta.cancelTrigger` (binary strings; capture signed in).
  - ACP unstable `session/archive` (onto `actions.archive`) and `auth/status`
    (onto `NativeAgentAuthStatus`), generically, when an agent advertises
    them; Grok 1.0.77 does not (ACP SDK 2.4.0).
  - Grok `retry_state` session updates (`attempt`, `max_retries`,
    `error_type`, `exhausted`, `is_rate_limited`) for retry UI. Whether they
    reach ACP clients is unverified; belongs with the retry-with-backoff work.
- Pi (`bridges/pi-bridge`, 1.5.0):
  - `ctx.ui.custom({ blocked })` when extension dialogs are routed;
    `PI_SELF_UPDATE_COMMAND` so `pi update` in a terminal tab defers to the
    managed pin.
- OpenCode: `reference.list` and the other Session V2 features wait for
  0008 (retired; `git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`).

### Qualification

The billed Grok `costUsdTicks` run moved to the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md) on
2026-11-10. Complete it before enabling tick-derived dollars.

## Constraints and rationale

- Maintenance rule: on every agent SDK or CLI bump
  ([upgrade-agents.md](../../development/upgrade-agents.md)):
  - check the runtime-health drift counters and the exhaustive dispatch tests,
    and give every new variant a branch, an ignore-list entry with a reason, or
    a line in this file;
  - re-check the candidates here against the new pin;
  - move anything adopted out of this file in the same change.
- Architecture rules for adopting anything here:
  - The backend owns behaviour. State, decisions and long-running work live in
    the bridge, the backend provider layer or the backend service. If a change
    needs `if (platform === …)` in `apps/web`, it belongs one layer lower.
  - Vendor shapes stop at the bridge's translate layer. Above it, everything
    speaks `packages/protocol/src/`.
  - Normalize, then generalize. Add the feature to the shared model first (a
    part kind, an interaction kind, a capability bit, a composer parameter),
    then populate it from adapters. Provider-only features are fine;
    provider-only UI is not.
  - Missing is not an error. A capability a bridge lacks is an empty list, an
    absent field or a `false` bit, never a 404 the backend would read as "older
    bridge".
  - Tests follow the split: an adapter mapping gets a bridge test against a
    recorded or fake payload, a protocol type gets a protocol test, a renderer
    component gets a rendering test with synthetic projections.

## Needs verification

- Grok tick costs (task 11) rest on static evidence from the pinned `1.0.77`
  binary. No billed turn has been reconciled against the xAI dashboard yet;
  that run is in the manual-test checklist. Recheck the `PromptUsage` field
  list on each Grok bump (`strings` over the managed `grok`, search
  `costUsdTicks`).

- Re-check each deferred item against the current pins before scheduling it.
  At Claude SDK `0.3.314` the symbols below are still present
  (`pending_permission_requests`, `reinitialize()`, `McpServerProvenance`,
  `readMcpResource`, `verbatimPrompts`, `additionalDirectories`,
  `createSdkMcpServer`; checked 2026-10-30).
  At Claude SDK `0.3.309`, `pending_permission_requests`, `reinitialize()`,
  `McpServerProvenance`, `readMcpResource`, the tool `_meta.ui` members,
  `verbatimPrompts`, `additionalDirectories` and `createSdkMcpServer` are all
  still present (checked 2026-10-30 in `bridges/claude-bridge/node_modules`).
- Pi's compaction Stop and Auto-compact toggle (task 8) are proved on the real
  SDK with the faux model only; a signed-in Pi tab has not run them
  (to-do 7280, retired 2026-11-10; the live check is in the manual-test
  checklist).
- Re-arm (task 4) is proved on the pinned CLI with a loopback model
  (`claude-rejoin-requests.live.test.ts`). The second bridge prompt recovers a
  deliberately dropped question on the same CLI, and a busy follow-up lets a
  held background PreToolUse hook complete. A signed-in session with a
  naturally lost frame is unverified. Rerun on every Claude CLI or SDK bump.
- The MCP provenance line (task 4) is covered by bridge, backend, protocol and
  card tests with synthetic payloads; nobody has yet seen it on a card raised by
  a real Claude CLI for an `mcp__*` tool under the `ask` policy, nor which
  `source` value the CLI reports for the servers Orkestrator passes through
  `mcpServers` (the SDK's documentation suggests `dynamic`).

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md),
  [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md),
  0006 (retired 2026-11-14; [agent-engines.md](../../architecture/agent-engines.md#rewinding-a-conversation-and-pi-branches)),
  [agent-accounts.md](../../architecture/agent-accounts.md) (to-do 0003, retired 2026-11-13),
  [0004-composer-model-parameters.md](0004-composer-model-parameters.md),
  0008 (retired; `git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`).
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the billed Grok turns of task 11) moved there on 2026-11-10.
- [0039-mcp-management.md](../mcp/0039-mcp-management.md) owns removing the Claude
  `services/mcp-config.ts` parse.
- The Claude command-discovery probe and its terminal-marker check are
  described in [native-agent-commands.md](../../architecture/native-agent-commands.md#provider-notes)
  and checked on every SDK bump in
  [upgrade-agents.md](../../development/upgrade-agents.md#how-to-upgrade-claude)
  (to-do 0016, which owned them, was retired on 2026-11-11).
- [agent-engines.md](../../architecture/agent-engines.md) and
  [upgrade-agents.md](../../development/upgrade-agents.md).
- The living-doc drift once listed here (Grok Build's inbound-request
  description and the Claude compatibility surface in `agent-engines.md` and
  `upgrade-agents.md`) was fixed on 2026-10-30 (task 13).

## Replaces

Every file below was deleted when this to-do replaced it (#991); read one
with `git show cd67b7ad9:<path>`.

- `docs/plans/sdk-coverage-2026-09-06.md` (the unadopted surfaces in §3.11,
  §4.12, §6.10, §6.13, §7.7, §7.9 and §8.10; the stale capability matrix is
  dropped)
- `docs/plans/sdk-coverage/00-index.md` ("Deliberately not planned",
  "Architecture rules every plan follows")
- `docs/plans/sdk-coverage/01-quick-correctness-fixes.md` (done)
- `docs/plans/sdk-coverage/02-typed-engine-boundaries-and-drift.md` (done; the
  drift checks behind the maintenance rule)
- `docs/plans/sdk-coverage/03-transcript-part-coverage.md` (done)
- `docs/plans/sdk-coverage/11-usage-cost-and-limits.md` (Grok
  `costUsdTicks` billed qualification pending)
- `docs/plans/sdk-coverage/14-acp-bridge-generalization.md` (done; the
  second-agent path and the implementation notes for the living-doc fix)
- `docs/plans/sdk-coverage/15-adapter-simplification.md` (the leftovers not
  moved to the steer, titles or MCP files)
- `docs/reviews/2026-09-17-platform-version-audit.md` ("Deferred
  intentionally", "No immediate implementation work")
- `docs/reviews/2026-09-22-platform-version-audit.md` ("Reviewed and
  deliberately not adopted"; both "Known gaps" are closed in code)

The browser and provider runs left over from plans 02, 03, 11, 13 and 14 are in
[0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).
