# Provider SDK adoption backlog

Checked against `main` at `2459b05c` (2026-10-15).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

The "Decided out" list is product decisions, not tasks; only where the current
pins undercut one of them is it raised below (task 1).

### Tasks

1. **Re-check the backlog against current pins**: the "Needs verification" item; every pin in "Current state" has moved. Status: open (the file's pins are out of date).
2. **Delete the dead Claude compaction guard**: remove `isSdkCompactBoundaryMessage` and its imports. Status: open.
3. **Claude in-process MCP server**: decide `createSdkMcpServer()` versus the HTTP loopback for Orkestrator tools. Status: open (decision).
4. **Claude permission lifecycle surfaces**: pending-permission re-arm on (re)initialize and MCP permission provenance. Status: open (decision).
5. **MCP Apps widgets**: Claude `readMcpResource` / `_meta.ui` and the Codex equivalent. Status: deferred (on a provider-neutral tool-card field).
6. **Other unused Claude and Codex surfaces**: Claude `additionalDirectories` / `agents` / `skills`; Codex `config/*` writes, `command/exec`, `fs/*`, `feedback/upload`, `gitDiffToRemote`, dynamic tools, config requirements. Status: deferred.
7. **Cursor `askQuestion`**: no typed tool-call variant or answer path. Status: blocked (upstream Cursor SDK).
8. **Pi compaction controls**: custom instructions, `abortCompaction`, auto-compaction toggle. Status: open.
9. **Second ACP agent**: Gemini CLI or Claude-over-ACP through `AcpProviderConfig`. Status: deferred.
10. **Grok MCP elicitation**: UI only once Grok advertises a contract. Status: blocked (upstream Grok).
11. **Grok `costUsdTicks` qualification**: one billed Grok turn to establish the tick unit. Status: open (needs Grok credentials).
12. **OpenCode `find.*` and Session V2 features**: unused 1.x file search; V2 waits on 0008. Status: deferred.
13. **Living-doc drift**: fix `agent-engines.md` (Grok Build, Claude compatibility surface) and `upgrade-agents.md`. Status: open (still present).

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

**Investigation.** Still dead. Defined at `bridges/claude-bridge/src/types/index.ts:242`; imported only by `services/session-manager-core.ts:41` and `services/session-manager-session.ts:35` (two modules, not four as the file says) and called only in `src/types/index.test.ts`.

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

**Decisions.**

- **Adopt re-arm?**
  - **Yes, after 0001's live runs, re-arming as a fresh card that still denies on timeout (recommended).**
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

**Investigation.** Claude `additionalDirectories` / `skills` are referenced only in a comment (`bridges/claude-bridge/src/services/coordinator-skills.ts:6`). Codex uses only `config/mcpServer/reload` among config writes (`bridges/codex-bridge/src/engine/app-server-engine.ts:2161,2175`); `item/tool/call` still fails with a transcript explanation (`bridges/codex-bridge/src/app-server/server-request-router.ts:593-600`); `configRequirements/read` exists in the generated protocol and is not projected.

**Decisions.**

- **Keep these as candidates or move them to "Decided out"?**
  - **Keep as candidates, recheck on each bump (recommended).**
    - Pros: some (Codex config requirements, Claude `additionalDirectories` for multi-repo environments) have plausible future consumers.
    - Cons: the list stays long.
  - **Move to "Decided out".**
    - Pros: shorter backlog.
    - Cons: needs a real product decision for each, which nobody has made.

### 7. Cursor `askQuestion`

**Problem.** Cursor's question tool cannot become a `question` interaction.

**Context.** Upstream gap.

**Investigation.** Still blocked at `@cursor/sdk` `1.0.40`: `askQuestion` is only a member of the `ToolName` string union (`bridges/cursor-bridge/node_modules/@cursor/sdk/dist/cjs/options.d.ts:378`, and `agent/options.d.ts`), with no typed call or answer API.

**Decisions.** None: blocked upstream; recheck on the next Cursor bump.

### 8. Pi compaction controls

**Problem.** Pi users cannot pass compaction instructions, abort a compaction or toggle auto-compaction.

**Context.** Shared layer has no compaction-parameter surface yet; other providers would need the same field to avoid Pi-only UI.

**Investigation.** The bridge calls `session.compact()` with no arguments (`bridges/pi-bridge/src/http.ts:911`). Pi `1.4.0` exposes `compact(customInstructions?)`, `abortCompaction()` and `setAutoCompactionEnabled()` / `autoCompactionEnabled` (`bridges/pi-bridge/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:726,730,771-773`).

**Decisions.**

- **What to adopt first?**
  - **Custom instructions through an optional argument on the shared `compact` action, which Claude and Codex can also honour (recommended).**
    - Pros: provider-neutral; small; useful.
    - Cons: needs a composer affordance.
  - **Abort and auto-toggle first.**
    - Pros: abort fixes a real "stuck compaction" case.
    - Cons: abort interacts with the claim and cancel logic in `http.ts:900-912`; the toggle is a Pi-only setting.

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

**Context.** Grok's ACP client does not advertise elicitation.

**Investigation.** The ACP bridge has no elicitation handling (no hits under `bridges/acp-bridge/src`). The `2.0.1` ACP SDK does carry elicitation types (`dist/nes/acp.d.ts`, `dist/v1/acp.js`), so the client-side contract now exists; whether Grok `1.0.67` sends it is unchecked.

**Decisions.**

- **Recheck now or wait?**
  - **Probe Grok 1.0.67 once during the next Grok live run (task 11 or 0031) for an elicitation request (recommended).**
    - Pros: cheap to fold into an existing run; settles whether it is still blocked.
    - Cons: needs an MCP server that elicits.
  - **Wait for Grok release notes.**
    - Pros: no effort.
    - Cons: Grok's release notes rarely name ACP changes.

### 11. Grok `costUsdTicks` qualification

**Problem.** Grok turns show no cost because the tick unit is undocumented.

**Context.** Batched with 0031's live provider runs.

**Investigation.** Still ignored (`bridges/acp-bridge/src/usage.ts:87,154`).

**Decisions.**

- **What counts as a pass?**
  - **Two billed turns of different sizes whose tick ratio matches the billed ratio, recorded in the `usage.ts` comment (recommended).**
    - Pros: one turn cannot distinguish a scale from an offset.
    - Cons: twice the spend; billing dashboards may round small amounts.
  - **One billed turn, as the file says.**
    - Pros: cheapest.
    - Cons: a single sample can mislead.

### 12. OpenCode `find.*` and Session V2 features

**Problem.** OpenCode file search is unused, and V2-only features wait.

**Context.** Session V2 is owned by 0008. `find.*` has no consumer: Orkestrator's own file search already covers workspaces.

**Investigation.** No `find.*` call under `apps/backend/src`.

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

This is one list of the vendor SDK and CLI surfaces Orkestrator does not use,
with the reason for each, and of the product decisions that keep some of them
out. Every entry has already been reviewed against a vendor release and
deliberately deferred or declined. Without this list, the next SDK review
rediscovers the same gaps. It is low priority: nothing here is a defect.

## Current state

- Pins: Claude Agent SDK `0.3.296` / CLI `2.1.296`, Codex `0.162.1`, OpenCode
  SDK and CLI `1.19.0`, `@cursor/sdk` `1.0.37`, Pi `1.2.0`, Grok `1.0.52`,
  `@agentclientprotocol/sdk` `1.8.0`. `tests/unit/version-drift.test.ts` keeps
  every mirror of each pin in step.
- Drift detection:
  - Each bridge dispatches over its vendor's typed union and turns an unknown
    variant into a runtime-health drift counter and an advisory notice
    (`NativeAgentRuntimeDrift` and the `advisory` notice in
    `packages/protocol/src/native-agent.ts`).
  - Both provider kinds implement `runtimeHealth?()` (`http-bridge-provider.ts`,
    `opencode-provider.ts`), and every bridge serves
    `GET /session/:id/runtime-health`.
  - Per-bridge tests feed invented variants: for example
    `bridges/claude-bridge/src/sdk-compatibility.test.ts`,
    `bridges/acp-bridge/src/acp-drift.test.ts` and
    `apps/backend/src/core/opencode-drift.test.ts`.
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
- **Codex goals.** Disabled: the pinned app-server has no stable goal RPC.
  `thread/goal/*` notifications are ignored and there is no `/goal` command.
- **Pi provider login.** Status stays read-only (see
  [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md)).
- **Codex `thread/delete`.** Never.
- **Claude `verbatimPrompts` / `client_composed`.** It skips the CLI's
  turn-start attachment pass, which is a real behaviour cost with no reported
  problem to solve.
- **Pi `meta` provider hosts.** They fall outside the Pi allowlist's
  mainstream-provider policy. Users can add `api.meta.ai` through the
  environment's `allowedDomains`.
- **Pi prompt-cache warming.** It is on by default in streaming mode and already
  attributed to the running turn's cost, and the shared layer has no setting for
  it.
- **Grok private `plan_kept` / `plan_cleared` / `plan_executing` updates.** The
  supported `x.ai/exit_plan_mode` reverse request covers plan review; these stay
  private.

### Candidates

Unadopted today. Each line says what blocks it or what decision it needs.

- Claude (`bridges/claude-bridge`):
  - `additionalDirectories`, inline `agents` and the `skills` option. Not used.
  - `createSdkMcpServer()` for the Orkestrator control tools, so the
    bearer-token loopback hop disappears. Decide against the coordinator's
    scoped-credential requirement; if other processes must reach the same
    server, keep HTTP and say why.
  - Pending-permission re-arm on (re)initialize: `pending_permission_requests` on
    the initialize response and `Query.reinitialize()`. This touches the
    authorization lifecycle.
  - MCP permission provenance (`McpServerProvenance`, `mcp_server` on
    permission requests). Needs a decision on how provenance shows in the shared
    interaction card.
  - MCP Apps widgets (`readMcpResource`, the tool's `_meta.ui`), and the Codex
    equivalent. Both need a provider-neutral tool-card field before either
    bridge wires them.
  - Dead compaction guard. The compaction row already comes only from the
    `PostCompact` hook, and `compact_boundary` is counted as a notice.
    `isSdkCompactBoundaryMessage` (`src/types/index.ts`) is imported by four
    service modules but called only in its own test. Delete it and the imports.
  - `startup()` / `WarmQuery` and `initializationResult()` are tracked in
    [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md).
    `getSubagentMessages()` and message rewind are tracked in
    [0006-session-titles-and-history.md](0006-session-titles-and-history.md).
- Codex (`bridges/codex-bridge`):
  - `config/*` writes (only `config/mcpServer/reload` is used), `command/exec`,
    `fs/*`, `feedback/upload`, `gitDiffToRemote`.
  - Dynamic tools. `item/tool/call` is answered as a failure with a transcript
    explanation (`server-request-router.ts`).
  - Managed application and network requirements (`ConfigRequirementsReadResponse`
    and friends in `src/app-server/generated/`). They are in the generated
    protocol but not projected, pending a provider-neutral requirements surface.
- Cursor (`bridges/cursor-bridge`):
  - `askQuestion` is in the SDK's `ToolName`, but the SDK has no typed tool-call
    variant and no answer path, so it cannot become a `question` interaction.
  - `SendOptions.local.force` and `SDKAgentInfo.archived` are tracked in
    [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md) and
    [0006-session-titles-and-history.md](0006-session-titles-and-history.md).
- Pi (`bridges/pi-bridge`): compaction controls (custom instructions,
  `abortCompaction`, an auto-compaction toggle). `session.compact()` is called
  with no instructions (`http.ts`).
- ACP (`bridges/acp-bridge`):
  - A second ACP agent (Gemini CLI, Claude-over-ACP). The launcher now builds
    an `AcpProviderConfig` record (`acp-provider-config.ts`; the Grok record is
    built in the backend launcher and passed as `ACP_PROVIDER_CONFIG`). A new
    agent is that record plus a platform id in
    `packages/protocol/src/agent-platforms.ts`, with packaging covered by
    `tests/unit/bridge-packaging.test.ts`.
  - Grok MCP elicitation. Grok's ACP client does not advertise it. Add UI only
    once Grok exposes a supported reverse-request contract; inventing one would
    not activate anything.
  - Grok cost. `costUsdTicks` is ignored on purpose because the tick has no
    documented scale (`bridges/acp-bridge/src/usage.ts`), and cost is taken only
    from an explicit USD `usage_update.cost`. Accept it once the qualification
    below confirms the unit.
- OpenCode: the `find.*` file search is on the 1.x surface the provider already
  drives and is unused. `reference.list` and the other Session V2 features wait
  for [0008-opencode-v2.md](0008-opencode-v2.md).

### Qualification

- Grok `costUsdTicks`: run one real billed Grok turn, compare the ticks against
  the provider's billed amount, then record the conversion and the evidence in
  the `usage.ts` comment before accepting it. Needs Grok credentials; see
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

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

- Re-check each deferred item against the current pins before scheduling it.
  At Claude SDK `0.3.296`, `pending_permission_requests`, `reinitialize()`,
  `McpServerProvenance`, `readMcpResource`, the tool `_meta.ui` members,
  `verbatimPrompts`, `additionalDirectories` and `createSdkMcpServer` are all
  still present. The Grok `1.0.52` elicitation and `costUsdTicks` behaviour has
  not been rechecked.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md),
  [0005-mid-turn-steer-and-interrupt.md](0005-mid-turn-steer-and-interrupt.md),
  [0006-session-titles-and-history.md](0006-session-titles-and-history.md),
  [0003-agent-accounts-and-sign-in.md](0003-agent-accounts-and-sign-in.md),
  [0004-composer-model-parameters.md](0004-composer-model-parameters.md),
  [0008-opencode-v2.md](0008-opencode-v2.md).
- [0039-mcp-management.md](../mcp/0039-mcp-management.md) owns removing the Claude
  `services/mcp-config.ts` parse.
- [0016-slash-command-catalogue.md](../cli-and-slash-commands/0016-slash-command-catalogue.md) owns the Claude
  command-discovery probe.
- [agent-engines.md](../../architecture/agent-engines.md) and
  [upgrade-agents.md](../../development/upgrade-agents.md).
- Living-doc drift to fix:
  - [agent-engines.md](../../architecture/agent-engines.md) "Grok Build" says the
    bridge answers only `session/update` and `session/request_permission` and
    refuses every other inbound request with `-32601`. It now also serves the
    ACP client `fs/*` and `terminal/*` methods (`acp-client-methods.ts`,
    workspace-confined, bounded terminals) and the `x.ai/exit_plan_mode` /
    `x.ai/ask_user_question` reverse requests. The provider config record,
    protocol-version refusal and Grok's undeclared image capability are not
    described there either.
  - [agent-engines.md](../../architecture/agent-engines.md) "Claude Code" and
    [upgrade-agents.md](../../development/upgrade-agents.md) (the Claude
    compatibility-surface paragraph and the "Review `session-manager.ts`" step)
    name `services/session-manager.ts` as the compatibility surface. It is a
    12-line barrel. The real surface is `session-manager-prompt-handlers/*`,
    `session-manager-messages.ts`, `types/index.ts` and
    `sdk-compatibility.test.ts`.

## Replaces

- `docs/plans/sdk-coverage-2026-09-06.md` (the unadopted surfaces in §3.11,
  §4.12, §6.10, §6.13, §7.7, §7.9 and §8.10; the stale capability matrix is
  dropped)
- `docs/plans/sdk-coverage/00-index.md` ("Deliberately not planned",
  "Architecture rules every plan follows")
- `docs/plans/sdk-coverage/01-quick-correctness-fixes.md` (done)
- `docs/plans/sdk-coverage/02-typed-engine-boundaries-and-drift.md` (done; the
  drift checks behind the maintenance rule)
- `docs/plans/sdk-coverage/03-transcript-part-coverage.md` (done)
- `docs/plans/sdk-coverage/11-usage-cost-and-limits.md` (code done; the Grok
  `costUsdTicks` evidence check)
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
