# Agent interactions and permissions

Checked against `main` at `2459b05c` (2026-10-15).

Every question, approval, elicitation and dialog a provider raises should either
reach the user through the shared interaction contract and its one generic card,
or be resolved by backend policy. The backend execution policy, not the bridges,
decides what a session may do without asking. The contract, the capability bit,
the unattended policy and the execution policy are in place. What is left is
durable "always allow" rules, parking Claude's elicitations instead of declining
them, honest Grok approval kinds, and retiring the per-bridge environment
overrides that predate the execution policy.

## Current state

- Contract (`packages/protocol/src/agent-interactions.ts`):
  - `AgentInteractionRequest.blocking` and `AgentInteractionOption.amendment`.
  - `INTERACTIVE_AGENT_INTERACTION_POLICY` and
    `UNATTENDED_AGENT_INTERACTION_POLICY`. The unattended policy declines the
    input bucket, denies the authorization bucket, and names the MCP
    elicitation kinds in its per-kind `kinds` overrides.
- Capability bit: `NativeAgentCapabilities.interactions.kinds`, set per platform
  in `nativeAgentCapabilities()` (`packages/protocol/src/native-agent.ts`).
  - Cursor reports `[]`.
  - Pi reports its live gate through `publicInteractionKinds`
    (`bridges/pi-bridge/src/public.ts`). The backend prefers that answer over
    the table (`interactionKinds` in `http-bridge-provider.ts`).
- Unattended outcomes: every workflow owner resolves interactions through the
  shared journaled path with `agentInteractionPolicyAction`
  (`build-pipeline-service-interactions.ts`, `looped-review-service.ts`).
- Codex answers every server request (`app-server/server-request-router.ts`):
  - exec-policy and network-policy amendments as options
    (`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment` in
    `app-server/approvals.ts`);
  - `serverRequest/resolved` withdraws a parked request (`event-reducer.ts`);
  - dynamic `item/tool/call` is answered as a failure, with a transcript
    explanation.
- Claude (`bridges/claude-bridge/src/services/`):
  - Tool approvals go through `canUseTool` (`session-manager-prompt-can-use-tool.ts`).
    It deliberately does not return the SDK's permission `suggestions`, because
    no revoke surface exists and returning them "would silently widen
    permissions after an allow-once decision".
  - Denials are recorded on the tool row or as a status row
    (`handlePermissionDenied`, `session-manager-prompt-handlers/system.ts`).
    `NativeAgentContextUsage` carries `permissionDenials` and
    `permissionDenialDetails`.
  - `onElicitation` declines with a status row that names the MCP server.
    `onUserDialog` answers `cancelled`, and `supportedDialogKinds` is
    deliberately left undeclared (`session-manager-prompt-query.ts`).
- Grok: `publicApprovals` (`bridges/acp-bridge/src/acp-public.ts`) reports every
  ACP permission request as `kind: "permissions"` with
  `permissions: { fileSystem: true }`. Titles already come from
  `permissionTitle` (`acp-session.ts`). Plan approvals and questions use the
  separate `x.ai/exit_plan_mode` and `x.ai/ask_user_question` reverse requests.
- OpenCode: every production owner creates the provider with
  `autoAnswerRequests: false`, so OpenCode interactions go through the same
  journaled path as everyone else. The `OpenCodeProvider` auto-reject branch
  (`autoAnswerRequests: true`) is reached only from
  `agent-provider-test-support.ts`.
- Execution policy:
  - Resolved once per session by `resolveNativeAgentExecutionPolicy`
    (`apps/backend/src/core/native-agent-execution-policy.ts`).
  - Defaults for host and pipeline sessions: `sandbox: "none"` and
    `approvals: "auto-approve"`. Containers get `sandbox: "container"`, project
    resources on, and the environment's network mode. The coordinator always
    gets `coordinator-read-only`, which cannot be overridden.
  - Overridable per environment (`executionPolicy` in
    `EnvironmentSettingsDialog.tsx`). Shown in Agent Info through
    `describeNativeAgentExecutionPolicy` (`AgentInfoButton.tsx`).
- Deprecated overrides still read by the bridges, with a one-time deprecation
  warning:
  - Cursor: `CURSOR_BRIDGE_SANDBOX` and `CURSOR_BRIDGE_PROJECT_SETTINGS`
    (`bridges/cursor-bridge/src/agent-session.ts`, `config.ts`
    `sandboxEnabled` / `resolveCursorSettingSources`).
  - Pi: `PI_BRIDGE_REQUIRE_APPROVAL` and `PI_BRIDGE_PROJECT_RESOURCES`
    (`bridges/pi-bridge/src/agent-session.ts`, `config.ts`
    `approvalsEnabled` / `projectResourcesEnabled`).
  - ACP: `ACP_APPROVE_PROJECT_MCPS` is no longer read by `bridges/acp-bridge`
    at all. Only a launcher sets it, and comments still cite it.

## Outstanding work

### Code

1. **"Always allow" and saved rules.** Codex execpolicy and network amendments
   are the only path to a persistent rule today. Decide whether Claude offers
   `permission-grant` amendments built from `canUseTool` `suggestions`. If it
   does, add a read and revoke surface first. None of these exist yet:
   - `NativeAgentPermissionRule` (`id`, `label`, `scope`, `source`);
   - `GET /session/:id/permission-rules` and `DELETE /session/:id/permission-rules/:ruleId`;
   - `listPermissionRules?` / `removePermissionRule?` on `NativeAgentRuntimeProvider`.

   Bridges with no saved rules answer an empty list, not 404.
2. **Claude elicitation and dialog parking.** Park `onElicitation` requests as
   `mcp-form` / `mcp-url` interactions and `onUserDialog` as `elicitation`.
   This needs a pending-request map in the Claude bridge, its routes and a
   backend mapping. Declare `supportedDialogKinds` only for kinds the card can
   render. Until this lands, `nativeAgentCapabilities("claude").interactions.kinds`
   over-claims `mcp-form`, `mcp-url` and `elicitation`. Either park them or drop
   the three kinds from the table.
3. **Grok approval kind.** Every Grok approval reaches the card as a generic
   file-system `permission`. `publicApprovals` emits the Codex-shaped envelope
   (`approvalId`, `kind: "permissions"`), which `mapAcpApproval`
   (`apps/backend/src/core/http-bridge-interactions.ts`) hands to
   `mapCodexApproval`. The native ACP branch of `mapAcpApproval` hard-codes
   `kind: "permission"` too. Derive the kind from the ACP `toolCall.kind` in the
   bridge: report `execute` as `command` and `edit` as `file-change`, with the
   fields those kinds carry, and keep `permissions` for everything else. The
   backend then maps them onto `command-approval` and `file-approval`. Carry the
   request's blocking hint if ACP supplies one.
4. **Claude question previews.** Set `toolConfig.askUserQuestion.previewFormat`
   once the question card's rendering mode (plain or html) is decided. Nothing
   sets it today.
5. **Retire the deprecated policy env overrides.**
   - Remove the reads and the deprecation warnings in the Cursor and Pi bridges,
     along with `sandboxEnabled`, `resolveCursorSettingSources`,
     `approvalsEnabled` and `projectResourcesEnabled`. Today
     `publicInteractionKinds` and `bridges/pi-bridge/src/interactions.ts` still
     fall back to them when a session has no policy.
   - `cursorMcpServers` (`bridges/cursor-bridge/src/mcp.ts`) needs more than a
     deletion. It reads project MCP servers only when
     `resolveCursorSettingSources()` includes `project`, which means only when
     `CURSOR_BRIDGE_PROJECT_SETTINGS=1`. No launcher sets that, so the check
     ignores a policy with `projectResources: true`. Make it follow the
     session's policy instead.
   - Then remove the launchers that still set them to `"0"`:
     - `commands-servers.ts`: `CURSOR_BRIDGE_PROJECT_SETTINGS` and
       `PI_BRIDGE_PROJECT_RESOURCES` for coordinator conversations;
     - `host-model-catalog-refresh.ts`: `CURSOR_BRIDGE_PROJECT_SETTINGS` and
       `ACP_APPROVE_PROJECT_MCPS`;
     - `pi-model-catalog-seeding.ts`: `PI_BRIDGE_PROJECT_RESOURCES`.

     The bridges treat any defined value as an override, so these `"0"` values
     also trigger the deprecation warning on every such launch. They exist only
     to close an override inherited from the backend's environment, so they go
     once the bridges stop reading the variables. Coordinator conversations stay
     closed through `ORKESTRATOR_BRIDGE_EXECUTION_POLICY`.
   - Update the stale comments: the Pi row in `nativeAgentCapabilities`, the
     `publicInteractionKinds` doc comment, `bridges/pi-bridge/src/interactions.ts`
     and the `config.ts` comments in both bridges that cite
     `ACP_APPROVE_PROJECT_MCPS`. Root `AGENTS.md` and `bridges/pi-bridge/AGENTS.md`
     still say Pi approvals and project resources are env-gated; update them in
     the same change.
   - Done when no source file outside tests names any of the five variables.
6. **Delete the unused OpenCode auto-answer branch.** No production caller sets
   `autoAnswerRequests: true`. Remove the branch in `OpenCodeProvider`
   (`registerSession`, the reconcile hook and the `permission.asked` /
   `question.asked` replies) and move the tests that use it onto the journaled
   path. If a future owner wants provider-side answering, it should follow
   `agentInteractionPolicyAction` instead of always rejecting.

### Qualification

- Browser: raise an MCP elicitation (Codex today, Claude once item 2 lands),
  answer it, reload mid-question, and confirm it rehydrates from
  `/session/:id/interactions`.
- `mise run test:agent:docker` for the container cells on Cursor and Pi.
- Host browser check that the Agent Info policy summary matches the options the
  adapter actually received, on each platform.

## Constraints and rationale

- Approvals fail closed. A timeout, disconnect or unparseable answer denies.
- Unattended `command-approval` and `file-approval` are `deny-and-fail`; MCP
  elicitations are `decline-and-continue`, because MCP defines `decline` as an
  outcome the server handles.
- `permission` stays `deny-and-fail` when unattended. Codex uses that kind for a
  genuine capability escalation, but OpenCode puts per-tool approvals on it: an
  unattended OpenCode session refused file edits would carry on producing
  nothing. Telling the two apart belongs in the execution policy, not in a
  per-kind default. The reasoning is in the `UNATTENDED_AGENT_INTERACTION_POLICY`
  comment.
- An allow-once decision must never widen durable permissions. No "always
  allow" option ships without a way to list and revoke what it saved.
- Bridges translate the policy; they never decide trust. They cannot reliably
  tell a host from a container.
- The coordinator policy is not user-overridable.
- Hosts default to no sandbox and auto-approve because every vendor sandbox
  holds `.git` read-only, which stalls ordinary Git work in a worktree (#613).
  `ask` stays available as an override.
- Key entry and other secrets go through an interaction, never a renderer form.

## Open questions

- Should Orkestrator expose "always allow" at all, given there is no revoke UI
  yet?
- `previewFormat`: plain or html?
- Claude MCP OAuth: the bridge's `authenticate` MCP action reconnects the server
  and expects the sign-in URL through `onElicitation`
  (`session-manager-catalog.ts`), which today declines `url` mode. Is parking
  `mcp-url` the intended route for that sign-in, or should MCP management own a
  separate flow? Decide with [mcp-management.md](mcp-management.md).

## Needs verification

- Whether every bridge has per-kind tests for park, render, resolve and
  fail-closed timeout. Codex and Pi have `interactions.test.ts`; the full matrix
  was not confirmed.
- Whether a container Cursor session loads the repository's `.cursor/mcp.json`
  today. The SDK gets `settingSources` with `project` from the policy, which may
  load it on its own, independently of `cursorMcpServers`.

## Related

- [mcp-management.md](mcp-management.md) (MCP OAuth and `mcp-url` sign-in).
- [coordinator-read-only-adapters.md](coordinator-read-only-adapters.md)
  (coordinator safety tiers, `coordinator-providers.ts`).
- [agent-accounts-and-sign-in.md](agent-accounts-and-sign-in.md) (secret input
  for OpenCode API keys reuses this contract).
- [provider-sdk-adoption-backlog.md](provider-sdk-adoption-backlog.md)
  (deferred Claude pending-permission re-arm and MCP permission provenance).
- [live-provider-and-platform-qualification.md](live-provider-and-platform-qualification.md)
  for the Docker and provider runs.
- [agent-engines.md](../architecture/agent-engines.md) "Execution policy".
- Living-doc drift to fix:
  - [agent-engines.md](../architecture/agent-engines.md) "Execution policy"
    says interactive host sessions default to provider sandboxing and explicit
    approvals. Since #613 they default to `sandbox: "none"` and
    `approvals: "auto-approve"`.
  - [platform-inconsistencies.md](../architecture/platform-inconsistencies.md)
    still describes `ACP_APPROVE_PROJECT_MCPS` as a live switch.

## Replaces

- `docs/plans/sdk-coverage/04-interactions-elicitation-and-permissions.md`
- `docs/plans/sdk-coverage/12-execution-policy-and-host-container-parity.md`
  (deprecated overrides, Docker and host QA, the documentation drift)
- `docs/plans/sdk-coverage/01-quick-correctness-fixes.md` (done; its Cursor
  host-policy decision is now the execution policy)
- `docs/plans/sdk-coverage-2026-09-06.md` (Claude §3.5, §3.8; Codex §4.4, §4.9;
  OpenCode §5.7; Cursor §6.1; the "Approvals capability bit" and "Host versus
  container parity" cross-cutting notes)
