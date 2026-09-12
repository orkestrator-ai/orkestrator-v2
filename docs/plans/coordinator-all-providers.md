# Coordinator for every provider — implementation plan

Status: Done — implemented. Proposed 2026-09-07; the tier table, unassigned-first
conversations, and per-platform enforcement now live in
`apps/backend/src/core/coordinator-providers.ts` and
[`docs/architecture/coordinator.md`](../architecture/coordinator.md). This file is the original plan,
not the product doc.

> Later note (2026-09-11): native Pi now has a bridge-owned MCP client and
> `{canPull,canSend,canInject}=true`, so coordinator delegation is available
> there. The Pi-bridge row below described the earlier vendor-client gap.

## Goal

A coordinator conversation can be started on any enabled agent platform, the
platform and model are chosen before the first prompt, and the read-only
boundary is real for every platform Orkestrator calls "qualified" — or is
honestly labelled where it is not.

Non-goals: changing what the coordinator is allowed to do (it stays
read-only with delegation through Control MCP), changing worker environments,
or letting a conversation switch provider after its first turn.

## Where things stand

The vendor-neutral execution policy already reaches every bridge. It is
computed once in `apps/backend/src/core/native-agent-execution-policy.ts`,
persisted immutably on the native-agent session, posted to every bridge on
`/session/create`, re-applied on resume and `/config`, and the Control MCP
connection is injected out-of-band of it. That plumbing needs no change.

What is Codex-specific is enforcement inside the bridges and a handful of
explicit gates:

| Gate | Location |
| --- | --- |
| Supported-provider set | `apps/backend/src/core/coordinator-service.ts:16` |
| Runtime resolver | `apps/backend/src/core/coordinator-runtime.ts:59` |
| Bridge launcher | `apps/backend/src/core/commands-servers.ts:872` |
| Trusted session input | `apps/backend/src/core/native-agent-service-base.ts:415` |
| Coordinator model catalogue | `apps/backend/src/core/commands-registry-projects.ts:498` (Codex cache only) |
| Conversation close | `apps/backend/src/core/commands-registry-coordinator.ts:151` (`stop_local_codex_server_cmd`) |
| Persisted bridge identity | `codexBridgePort` / `codexBridgePid` on `CoordinatorConversation` |
| Model picker | `AgentNativeTab.controller.tsx:1807` (`platformSelectionLocked`, one enabled platform) |
| Coordinator context prompt | `native-agent-service-base.ts:438-452` ("Codex subagents…") |

Per-bridge enforcement today (from a survey of each bridge on this commit):

| Bridge | Mechanism for `approvals: "deny"` | Strength |
| --- | --- | --- |
| codex-bridge | OS permission profile, `sandbox: "read-only"`, `approvalPolicy: "never"`, private `CODEX_HOME`, network off, features off, re-stamped on every create/resume/fork/turn, fails closed if the profile is not echoed back | Enforced |
| claude-bridge | `permissionMode: "dontAsk"`, `allowedTools`/`disallowedTools`, `sandbox.enabled`, `settingSources` trimming. No `PreToolUse` hook. Deny list uses Codex tool names, so it is a no-op here | Achievable, not built |
| pi-bridge | In-process `tool_call` gate with `READ_ONLY_TOOLS` whitelist plus `setActiveToolsByName`; project resources off | Enforced at dispatch. Later: bridge-owned MCP client and native mail flags, so delegation is available (see later note) |
| OpenCode | `session.create/update({ permission })` from `openCodePermissionRules`; `effectiveOpenCodePolicy` **throws** for coordinator because project config cannot be disabled | SDK-enforced, currently refused |
| cursor-bridge | `sandboxOptions.enabled`, `disallowedTools`; `approvals: "deny"` **refuses attach** because the SDK has no approval callback | Provider-configured only |
| acp-bridge (Grok) | Strips `--always-approve`; answers every permission request `cancelled`; no tool policy applied | Advisory only |

## Design decisions

1. **Qualification tiers, not a boolean.** Each platform gets a tier the
   backend computes per host and the UI displays: `enforced`,
   `provider-configured`, `advisory`, `unavailable`. Lower tiers are opt-in
   through a global setting. One table replaces the four gates.
2. **Provider is chosen per conversation, at first send.** A new conversation
   has no agent until the user sends the first prompt from the existing
   unassigned composer (`UnassignedNativeAgentComposer`). Assignment is
   explicit, one-way, and persisted, so "never silently switch providers"
   still holds.
3. **Neutral capability ids for the coordinator deny list.** The policy's
   `toolPolicy` strings are provider tool names and are also the user-override
   surface, so their meaning must not change. Add a separate
   `capabilityPolicy` the coordinator sets and each bridge translates.
4. **Process-level authority for every bridge.** Codex reads
   `CODEX_BRIDGE_EXECUTION_POLICY` from its environment and re-stamps every
   session with the coordinator policy so a permissive persisted record cannot
   survive a restart. Generalise this to `ORKESTRATOR_BRIDGE_EXECUTION_POLICY`,
   honoured by all bridges: when set to `coordinator-read-only`, a bridge
   refuses any session whose policy is anything else.
5. **One conformance suite defines "qualified".** A platform enters the
   `enforced` tier only when it passes the same read-only conformance test as
   Codex.

## Phase 0 — Neutral plumbing, no behaviour change

Goal: remove the Codex assumptions from types, storage, and the launcher while
keeping Codex the only allowed provider. Ships alone; nothing user-visible.

### Protocol (`packages/protocol/src`)

- `coordinator.ts`
  - `CoordinatorConversation.agent` becomes optional (`agent?: AgentPlatform`).
    An absent agent means "unassigned". Validator at `:193` accepts
    `undefined` or a valid platform.
  - Rename `codexBridgePort`/`codexBridgePid` to `bridgePort`/`bridgePid` on
    both `CoordinatorConversation` and `CoordinatorWorkspace`. Keep the old
    names readable for one release in the storage migration.
  - Add:
    ```ts
    export type CoordinatorProviderTier = "enforced" | "provider-configured" | "advisory" | "unavailable";
    export interface CoordinatorProviderQualification {
      tier: CoordinatorProviderTier;
      available: boolean;      // tier allowed by settings on this host
      reason?: string;         // why unavailable, or the caveat for lower tiers
      delegation: boolean;     // Control MCP tools reachable on this platform
    }
    ```
    `CoordinatorSnapshot.providerAvailability` becomes
    `Partial<Record<AgentPlatform, CoordinatorProviderQualification>>`. Keep
    `available` so the current panel keeps compiling until Phase 1.
- `native-agent.ts`
  - Add `NativeAgentCapability = "file.write" | "file.patch" | "shell.mutate" | "shell" | "network"`
    and `capabilityPolicy?: { deny: NativeAgentCapability[] }` on
    `NativeAgentExecutionPolicy`. Extend `isNativeAgentExecutionPolicy` and
    `describeNativeAgentExecutionPolicy`.
- `agent-settings.ts`
  - Global setting `coordinatorProviderTiers: "enforced" | "provider-configured" | "advisory"`
    (default `enforced`), normalised like the other tiers.

### Backend (`apps/backend/src/core`)

- New `coordinator-providers.ts`:
  ```ts
  export function coordinatorProviderQualification(platform, host: { os, sandboxAvailable }): CoordinatorProviderQualification
  export function coordinatorProviderAllowed(platform, settings): boolean
  ```
  Table for this phase: codex → `enforced`; everything else → `unavailable`
  with the existing "read-only boundary has not been qualified" reason.
  Consumers: `coordinator-service.ts` (replace `SUPPORTED_COORDINATOR_PROVIDERS`
  and the availability map in `snapshot()`), `coordinator-runtime.ts:59`,
  `commands-servers.ts:872`, `native-agent-service-base.ts:415`.
- `native-agent-execution-policy.ts`: coordinator policy gains
  `capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] }`.
  Keep the existing `toolPolicy.deny` for Codex compatibility.
- Extract coordinator launch steps out of `startLocalServer` in
  `commands-servers.ts` into `commands-servers-coordinator.ts`:
  - `prepareCoordinatorLaunch(kind, coordinator, env)`: scrub inherited
    `ORKESTRATOR_AGENT_MCP_*`, revoke and re-issue the per-conversation Control
    MCP credential (`:1056-1076`), set
    `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`, and call a
    per-kind `prepareCoordinatorHome(kind, dir)` that today only has the Codex
    branch (`prepareCoordinatorCodexHome`, `CODEX_HOME`, permission profile,
    readable runtime root).
  - Persist `bridgePort`/`bridgePid` regardless of kind (`:1141`, `:1183`,
    `:1216`, and `commands-local-server-lifecycle.ts:269` which currently
    checks `kind === "codex"`).
- `commands-registry-coordinator.ts:151`: stop the conversation's bridge by
  its own kind (`stop_local_<kind>_server_cmd`), not always Codex.
- `local-server-reaper.ts`: the coordinator sweep reads the neutral fields.
- `storage-shared-core.ts` / `storage-projects.ts:553`: validate the neutral
  fields, migrate `codexBridge*` → `bridge*` on load, accept `agent` absent.
- `native-agent-service-base.ts:438-452`: reword the context prompt so it does
  not name Codex ("Provider sub-agents remain inside this coordinator
  session…").
- `commands-registry-projects.ts:498`: the environment-less coordinator branch
  returns the cached catalogue for every platform whose qualification is
  `available`, not only `cache.codex`.

### Codex bridge

- Read `ORKESTRATOR_BRIDGE_EXECUTION_POLICY` in addition to
  `CODEX_BRIDGE_EXECUTION_POLICY` (keep the old name as an alias). No other
  change.

### Tests

- `coordinator-service.test.ts`, `commands-registry-coordinator.test.ts`,
  `commands-servers-coordinator.test.ts`: update for renamed fields; add a
  migration test for a persisted workspace carrying `codexBridgePort`.
- `packages/protocol/src/coordinator.test.ts`: validator accepts an
  unassigned conversation and rejects an unknown agent.
- `native-agent-execution-policy.test.ts`: coordinator policy carries the
  capability deny list and is still not overridable.

Acceptance: `mise run test` green; an existing Codex coordinator conversation
still opens, dispatches, restarts, and closes exactly as before.

## Phase 1 — Provider choice per conversation

Goal: the screenshot behaviour. New conversations start unassigned, the
composer offers every qualified platform with its models, and the first send
assigns the provider. Codex remains the only `enforced` platform, so this
ships without any safety change.

### Backend

- `coordinator-service.ts`
  - `createConversation` creates with no agent. Drop the "inherit the
    selected conversation's agent" logic.
  - New `assignConversationAgent(projectId, conversationId, agent)`:
    rejects a closed conversation, an unqualified or disabled platform, and a
    conversation whose native-agent session already exists in storage
    (`getNativeAgentSession` for its key). Sets `agent`, bumps `updatedAt`,
    returns the snapshot. Re-assignment before materialisation is allowed so a
    failed first send does not strand the conversation.
  - `ensure()` no longer errors the workspace when the configured default is
    unqualified; the initial conversation is simply unassigned. Remove the
    "Select Codex in project defaults" startup error path.
  - `setPaused` resume check: allow when the selected conversation is
    unassigned or its agent is allowed.
  - `reconcileWorkflowNotifications` and mail injection: skip unassigned
    conversations (no session to inject into); the durable message stays
    stored, matching paused behaviour.
- `commands-registry-coordinator.ts`: register
  `assign_coordinator_conversation_agent { projectId, conversationId, agent }`.
- `coordinator-runtime.ts`: an unassigned conversation resolves as
  `unavailable` with reason `"unassigned"` and a message asking for a first
  prompt, so any stray session call fails clearly.

### Web (`apps/web/src`)

- `lib/backend/coordinator.ts`: add `assignCoordinatorConversationAgent`.
- `components/native-agent/AgentNativeTab.tsx`
  - New optional prop `onAssignPlatform?: (platform, prompt, options) => Promise<void>`.
    When present, `lockAndSend` calls it instead of the pane store's
    `lockTabNativePlatform`; `lockAndResume` is disabled for coordinators
    (resume of an arbitrary rollout would bypass ownership).
- `components/native-agent/AgentNativeTab.helpers.tsx`
  (`UnassignedNativeAgentComposer`)
  - New optional props `platformFilter?: AgentPlatform[]` (intersected with
    the global enabled set), `defaultPlatform?: AgentPlatform`,
    `coordinatorProjectId?: string` (so `resolvedPlatformSettings` and
    `resolvedDefaultAgent` read the repository tier, mirroring the fix in
    #594), and `placeholder`.
  - Model catalogue: keep the existing `get_native_agent_model_catalog`
    request keyed by the coordinator runtime id; Phase 0 made that return all
    qualified platforms.
  - Show the tier badge and caveat beside the platform rail when a
    `qualification` map is supplied.
- `components/projects/CoordinatorPanel.tsx`
  - Pass `data.platform = selected.agent` (undefined for unassigned).
  - `onAssignPlatform`: call `assignCoordinatorConversationAgent`, set the
    snapshot, and hand `initialPrompt`, `initialAgentModel`,
    `initialReasoningEffort`, `initialFastMode`, `initialConversationMode`
    to the now-assigned `AgentNativeTab` through panel state keyed by
    conversation id. The compose draft in `useNativeComposeStore` is cleared
    only after the first dispatch succeeds, so a reload between assignment and
    dispatch still shows the text.
  - Replace the "X is unavailable for Coordinator" screen: it now appears only
    for an *assigned* conversation whose platform became unavailable (setting
    changed, host lost sandbox support).
  - Tab strip shows the platform icon per conversation once assigned.
- `components/settings/agent/AgentDefaultsPane.tsx` (or a coordinator
  settings section): radio for `coordinatorProviderTiers` with the three
  labels and one sentence each on what the tier guarantees.

### Tests

- `CoordinatorPanel.test.tsx`: unassigned conversation renders the composer
  with only qualified platforms; first send calls the assign command then
  mounts the agent tab with the prompt; reload after assignment rehydrates the
  assigned platform from the snapshot; an unavailable assigned platform shows
  the explanation.
- `AgentNativeTab.test.tsx`: `onAssignPlatform` replaces the pane store path;
  resume is not offered for coordinators.
- `coordinator-service.test.ts`: assign rules (closed, unqualified, already
  materialised, re-assign before materialisation).
- Browser QA per AGENTS.md §4–5 on a `dev:test` profile: create conversation,
  pick Codex model, reload before sending, send, switch project tab while the
  turn runs, return, reload.

Acceptance: a brand-new coordinator conversation lets the user pick any
qualified platform and model before the first prompt; after the first prompt
the picker is locked to that platform exactly as today.

## Phase 2 — Claude as an `enforced` provider

Goal: the highest-value addition, with the same strength as Codex.

### claude-bridge (`bridges/claude-bridge/src`)

- `services/session-manager-prompt.ts`, policy translation (`:561-597`, `:897-936`):
  - Translate `capabilityPolicy.deny` to Claude names:
    `file.write`/`file.patch` → `Write`, `Edit`, `MultiEdit`, `NotebookEdit`;
    `network` → `WebFetch`, `WebSearch`; `shell.mutate` → handled by the hook
    below. Emit them as `disallowedTools` (bare-name deny removes the tool
    from context and holds even under `bypassPermissions`).
  - Under the coordinator policy: `permissionMode: "dontAsk"`,
    `allowedTools` = `Read`, `Glob`, `Grep`, `Bash`, `Task`, `Agent`,
    `TodoWrite`, plus `mcp__orkestrator__*` when an agent MCP connection is
    present. Supplying an allowlist replaces the default one, so the MCP
    entry is mandatory or delegation is denied by `dontAsk`.
  - Sandbox: `{ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, excludedCommands: [], network: { allowLocalBinding: false, strictAllowlist: true, allowedDomains: [] }, filesystem: <no writable roots> }`.
    Verify the exact `SandboxFilesystemConfig` shape against the pinned SDK
    (0.3.261) with a live probe before relying on it; if it cannot express
    "no writable paths", fall back to the hook denying every `Bash` call that
    is not on a conservative read-only allowlist (`git status|log|diff|show|
    blame|ls-files`, `rg`, `ls`, `cat`, `head`, `tail`, `wc`, `find` without
    `-delete`/`-exec`).
  - Register a bridge-owned `PreToolUse` hook (hooks run first and a deny
    is final). It denies: any tool in the translated deny set, `Bash` with
    `dangerouslyDisableSandbox`, `Bash` matching the mutation allowlist
    failure above, and any MCP tool not under `mcp__orkestrator__`. It logs
    the denial as a transcript system note so the user sees why a turn
    stopped. The hook is registered programmatically, never from settings, so
    a workspace cannot remove it.
  - `settingSources`: `[]` under the coordinator policy (not `["user"]`):
    user settings can carry hooks and MCP servers that run commands.
- Honour `ORKESTRATOR_BRIDGE_EXECUTION_POLICY`: on startup and on every
  `/session/create`, `/config`, and resume, replace the incoming policy with
  the coordinator policy and fail closed if a persisted session carries
  another id (mirror `app-server-runtime-lifecycle.ts:166-184`).
- `services/mcp-config.ts`: unchanged; the reserved `orkestrator` server is
  already backend-authoritative.

### Backend

- `commands-servers-coordinator.ts`: Claude branch of `prepareCoordinatorHome`
  creates a private `CLAUDE_CONFIG_DIR` under
  `coordinator-runtime/<id>/conversations/<cid>/claude-home` (`0o700`), copies
  only the credential file when one exists (same symlink and mode rules as
  `prepareCoordinatorCodexHome`), and still runs
  `applyClaudeHostCredentialEnvironment` for keychain/env delivery. No
  `settings.json`, no plugins, no hooks.
- `coordinator-providers.ts`: claude → `enforced` when the host sandbox is
  available (Linux with bubblewrap or macOS seatbelt), otherwise
  `provider-configured` with the reason "Claude's command sandbox is not
  available on this host; file tools are denied but shell commands are only
  filtered". Probe once at backend start via the SDK's sandbox availability
  check and cache it.

### Tests

- `bridges/claude-bridge/src/services/session-manager-prompt.test.ts`: option
  translation for the coordinator policy (allowlist contents, deny names,
  sandbox block, `settingSources: []`, hook registered); hook unit tests for
  each deny branch; process-authority re-stamp on resume.
- Conformance suite (Phase 6) run against Claude.

Acceptance: the conformance suite passes for Claude on Linux and macOS; a
coordinator conversation on Claude can list environments through Control MCP
and cannot create a file, edit a file, run `touch`, or fetch a URL.

## Phase 3 — OpenCode as `provider-configured`

- `opencode-provider-helpers.ts`
  - `effectiveOpenCodePolicy`: stop throwing for the coordinator. Return the
    policy with `projectResources: true` and a note: "OpenCode always loads
    project configuration; MCP servers declared in the checkout's
    `opencode.json` run on this host."
  - `openCodePermissionRules` for the coordinator: base `{ "*": deny }` plus
    explicit `allow` for the read tools (`read`, `glob`, `grep`, `list`,
    `todoread`, `todowrite`) and the `orkestrator` MCP tool ids. Today the
    base deny with an empty allow list would block reads too.
  - Pin `executionAgent: "plan"` for coordinator prompts (OpenCode's plan
    agent is its read-only profile) and refuse `build`.
- `commands-servers-coordinator.ts`: OpenCode branch gives the server a
  per-conversation `XDG_DATA_HOME`/session directory so coordinator sessions
  do not mix with environment sessions, and registers the Control MCP server
  through the existing `/mcp` POST.
- `coordinator-providers.ts`: opencode → `provider-configured`, delegation
  true.
- Tests: helper unit tests for the new rule set; conformance suite.

## Phase 4 — Pi as `enforced`, without delegation first

- `bridges/pi-bridge`: the `tool_call` gate already blocks everything outside
  `READ_ONLY_TOOLS` under `state.readOnly`/`approvals: "deny"`. Map the
  coordinator policy to `readOnly: true` on create and honour
  `ORKESTRATOR_BRIDGE_EXECUTION_POLICY`.
- Backend: Pi branch of `prepareCoordinatorHome` sets a private
  `PI_AGENT_DIR` containing only `auth.json`, and separate
  `PI_SESSION_DIR`/`PI_BRIDGE_STATE_DIR` under the coordinator runtime dir.
- `coordinator-providers.ts`: pi → `enforced`, `delegation: false` at the
  time of this plan. Done later in #714: bridge-owned MCP client + native
  mail flags, so `delegation` is now true.
- Follow-up (separate PR): ~~bridge-registered Pi custom tools that proxy
  Control MCP over HTTP~~ done via the bridge-owned MCP client in #714.

## Phase 5 — Cursor as `provider-configured`, Grok as `advisory`

- `bridges/cursor-bridge/src/agent-session.ts:137-162`: replace the refusal
  for `approvals: "deny"` with `sandboxOptions.enabled: true`,
  `autoReview: false`, `disallowedTools` from the capability map (Cursor tool
  names: `Write`, `Edit`, `Delete`, `Shell`; verify against `@cursor/sdk`
  1.0.31), and `settingSources: ["user"]`. Keep the refusal when the sandbox
  cannot be enabled.
- `coordinator-providers.ts`: cursor → `provider-configured` ("Cursor's SDK
  applies the restriction but exposes no approval callback to verify it");
  grok → `advisory` ("Grok is asked to request permission; nothing stops a
  tool that does not ask").
- Both are hidden unless the global tier setting includes them.

## Phase 6 — Conformance suite and documentation

- New opt-in suite `tests/agent/coordinator-read-only.test.ts` driven like
  `test:agent:docker`: it needs a `dev:test` profile with credentials for the
  platform under test (`--credential-source <name>`). For each platform in
  the qualification table it:
  1. creates a coordinator conversation on the fixture project and assigns
     the platform;
  2. hashes the fixture tree;
  3. sends one prompt that asks the agent, in order, to create a file, edit
     an existing file, run a shell command that writes, fetch a URL, and then
     call the Control MCP discovery tool;
  4. asserts the tree hash is unchanged, the transcript shows each mutation
     denied, and the discovery tool returned (or, for `delegation: false`,
     was never offered).
- `coordinator-providers.test.ts` asserts the table: every platform marked
  `enforced` is in the conformance suite's list.
- Docs: rewrite the provider paragraph in `docs/architecture/coordinator.md`; add a
  "Coordinator qualification" subsection to `AGENTS.md` under the bridge
  sections stating that a platform may not be moved to `enforced` without the
  conformance suite and the process-authority env var; add the new setting
  to the settings docs.

## Delivery order and size

| PR | Content | Risk |
| --- | --- | --- |
| 1 | Phase 0 | Low: refactor with migration test |
| 2 | Phase 1 | Medium: UI flow, storage semantics for unassigned conversations |
| 3 | Phase 2 | High: security boundary; needs live SDK probes on both OSes |
| 4 | Phase 3 + Phase 4 | Medium |
| 5 | Phase 5 | Low: behind an opt-in setting |
| 6 | Phase 6 can land with PR 3 and grow per PR | — |

## Verification per PR

```bash
mise run test:logged --name backend-typecheck -- bun run --cwd apps/backend typecheck
mise run test:logged --name web-typecheck -- bun run --cwd apps/web typecheck
mise run test:logged --name coordinator-backend -- bun test apps/backend/src/core/coordinator-service.test.ts apps/backend/src/core/commands-registry-coordinator.test.ts apps/backend/src/core/commands-servers-coordinator.test.ts --parallel=2 --only-failures
mise run test:logged --name coordinator-web -- bun --cwd=apps/web test src/components/projects/CoordinatorPanel.test.tsx --parallel=2 --only-failures
mise run test:logged --name bridge-tests -- bun test bridges --parallel=2 --only-failures
mise run test
```

Plus the browser cycle from AGENTS.md for PRs 2 and 3, including the
inactive-tab and reload paths, on a task-specific `dev:test` profile.

## Risks and open questions

- **Claude sandbox on Windows.** No OS sandbox there; the tier drops to
  `provider-configured` automatically through the host probe. Decide whether
  that is acceptable or whether Windows should stay Codex-only.
- **Bash under Claude.** If the SDK filesystem config cannot express "no
  writable roots", the hook's command allowlist is the boundary. That is
  weaker than Codex's OS profile; the tier label must say so.
- **OpenCode project config.** A checkout's `opencode.json` can declare
  command-backed MCP servers that run on the host. The coordinator runs
  against the user's own checkout, which they already trust, but the note
  must be visible in the picker, not only in the docs.
- **Unassigned conversations and mail.** Messages addressed to a conversation
  that has never been assigned stay stored and are injected on first turn.
  Confirm that matches how paused conversations behave in
  `reconcileWorkflowNotifications`.
- **Conversation limit.** Unassigned conversations count toward the 16 open
  limit; consider auto-closing unassigned conversations with an empty draft
  when a new one is created.
- **Model favourites across platforms.** The favourites view lists every
  platform; with `platformFilter` the picker should hide, not dim,
  favourites for unavailable platforms so the dimmed state in the screenshot
  does not recur.
