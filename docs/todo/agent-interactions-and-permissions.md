# Agent interactions and permissions

Checked against `main` at `2459b05c` (2026-10-15).

Every question, approval, elicitation and dialog a provider raises should either
reach the user through the shared interaction contract and its one generic card,
or be resolved by backend policy. The backend execution policy, not the bridges,
decides what a session may do without asking. The contract, the capability bit,
the unattended policy and the execution policy are in place. What is left is
durable "always allow" rules, honest Grok approval kinds, and retiring the
per-bridge environment overrides that predate the execution policy.

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
  - MCP elicitations and tool approvals are parked in one store
    (`session-manager-parked-interactions.ts`), served by
    `GET /session/:id/interactions` and answered through
    `POST /session/:id/interactions/:interactionId` (`accept`, `decline`,
    `cancel`). The backend maps them in `mapClaudeInteraction`
    (`http-bridge-interactions.ts`).
    - `onElicitation` parks `mcp-form` and `mcp-url` requests. One the card
      cannot render (a `url` request without a URL, or a schema over the text
      limit) is still declined with a status row naming the server.
    - `onUserDialog` answers `cancelled`, and `supportedDialogKinds` is
      deliberately left undeclared: the only documented kind,
      `refusal_fallback_prompt`, has an opaque payload and the card has nothing
      to show for it. The capability table therefore no longer claims
      `elicitation` for Claude.
  - `ask` and `deny` policies both run in `default`. `claudePermissionMode`
    (`claude-query-config.ts`) caps the prompt's mode there: the backend still
    sends `bypassPermissions` with every build prompt, and the bridge lowers
    it. A prompt may narrow the mode to `plan` or `dontAsk`; read-only turns
    still arrive as `dontAsk`.
  - Under `ask`, `canUseTool` (`session-manager-prompt-can-use-tool.ts`) parks
    every tool that reaches it as `command-approval` (Bash), `file-approval`
    (Edit, MultiEdit, Write, NotebookEdit) or `permission`. Only reading tools
    are pre-approved.
  - Under `deny`, `canUseTool` refuses every tool that reaches it, after
    questions and plan approvals are handled. That is what `dontAsk` does,
    except that the pinned CLI (SDK 0.3.296) refuses AskUserQuestion outright
    in `dontAsk` without consulting `canUseTool`, so a coordinator could not
    ask the user anything. A real-CLI probe with a loopback model showed a
    coordinator in `default` running its whole allow list (Read, Glob, Grep,
    read-only Bash, Agent, ToolSearch, `mcp__orkestrator__*`) with only
    AskUserQuestion reaching the callback; Write, Edit, WebFetch and mutating
    Bash stayed refused, in subagents too.
  - Under `auto-approve` a tool that reaches `canUseTool` runs.
  - An approval never returns the SDK's permission `suggestions`, because no
    revoke surface exists and returning them "would silently widen permissions
    after an allow-once decision". `approve-for-session` is refused.
  - Denials are recorded on the tool row or as a status row
    (`handlePermissionDenied`, `session-manager-prompt-handlers/system.ts`).
    `NativeAgentContextUsage` carries `permissionDenials` and
    `permissionDenialDetails`.
- Grok: `publicApprovals` (`bridges/acp-bridge/src/acp-public.ts`) reports each
  ACP permission request in ACP's own shape (title from `permissionTitle`,
  plus the agent's options), which the native branch of `mapAcpApproval`
  offers as a required choice. While any request is held, `/activity` answers
  `waiting`. Plan approvals and questions use the separate
  `x.ai/exit_plan_mode` and `x.ai/ask_user_question` reverse requests.
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
    `EnvironmentSettingsDialog.tsx`). An override cannot claim a container a
    host lacks, and a container session reports the network its firewall
    enforces, which follows the environment (`reconcileContainerBoundary`).
  - Shown in Agent Info through `describeNativeAgentExecutionPolicy`
    (`AgentInfoButton.tsx`), which renders the policy's effects
    (`nativeAgentPolicyEffects`, `packages/protocol/src/native-agent-policy-effects.ts`)
    from the policy each bridge reports. A bridge reports what it applies:
    Cursor, Pi, Grok, Codex and OpenCode rewrite an axis they cannot honour and
    say why in `note` (`withoutProviderSandbox`, `codexReportedPolicy`,
    `acpReportedPolicy`, `effectiveOpenCodePolicy`).
  - Held to the adapters by the execution-policy conformance suite
    (`tests/conformance/execution-policy/`). For each platform and ten policy
    shapes it captures the options the SDK or CLI receives, decodes them into
    the same effects and compares them with the summary. The only tolerated
    differences are the stricter ones listed in `narrowings.ts`.
- Pausing a countdown. Clicking the timer on a native question, plan, command,
  file or permission card pauses the deadline where it is enforced, and
  clicking again restarts a fresh window:
  - Every bridge timer is an `InteractionDeadline`
    (`packages/protocol/src/agent-interaction-deadline.ts`). A pause re-arms it
    at `AGENT_INTERACTION_HOLD_CEILING_MS` (24 h) or the provider's own sooner
    limit, so an unanswered request is still declined in the end and older
    backends, which require a deadline, keep the card.
  - Bridges publish `hold` (`AgentInteractionHold`) beside `expiresAt` and serve
    `POST /session/:id/{family}/:requestId/hold` with `{ held }`. The backend
    calls it through `holdInteraction` (`http-bridge-interactions.ts`) and the
    `hold_native_agent_interaction` command. A bridge that publishes no `hold`
    is mapped to `bridge-outdated`: the countdown shows but is not clickable.
  - Limits: Grok pauses only until its turn deadline (`ACP_PROMPT_TIMEOUT_MS`)
    and, for questions, its own `ask_user_question` timeout; Pi until its turn
    budget; a Codex question with `autoResolutionMs` until then; MCP prompts
    pause but warn that their server may stop waiting first. OpenCode publishes
    no deadline, so there is nothing to pause.
  - Claude in tmux shows the countdown as not pausable yet (item 9).
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
2. **Grok approval kind.** Every Grok approval reaches the card as a
   `permission` titled by the tool call, with the agent's own options. The
   native ACP branch of `mapAcpApproval`
   (`apps/backend/src/core/http-bridge-interactions.ts`) hard-codes
   `kind: "permission"`. Derive the kind from the ACP `toolCall.kind` in the
   bridge: report `execute` as a command approval and `edit` as a file change,
   with the fields those kinds carry, and keep `permission` for everything
   else. The backend then maps them onto `command-approval` and
   `file-approval`. Carry the request's blocking hint if ACP supplies one.
3. **Claude question previews.** Set `toolConfig.askUserQuestion.previewFormat`
   once the question card's rendering mode (plain or html) is decided. Nothing
   sets it today.
4. **Retire the deprecated policy env overrides.**
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
5. **Delete the unused OpenCode auto-answer branch.** No production caller sets
   `autoAnswerRequests: true`. Remove the branch in `OpenCodeProvider`
   (`registerSession`, the reconcile hook and the `permission.asked` /
   `question.asked` replies) and move the tests that use it onto the journaled
   path. If a future owner wants provider-side answering, it should follow
   `agentInteractionPolicyAction` instead of always rejecting.
6. **Codex project resources.** A Codex worker loads a trusted project's own
   `.codex` configuration whatever `projectResources` says, so the bridge now
   reports the axis as on with a note (`codexReportedPolicy`). Make it honour
   `false` instead, by pinning the checkout untrusted for that thread as the
   coordinator does process-wide, after checking live that a per-thread
   `projects.<root>.trust_level` override takes effect. Then delete
   `codexReportedPolicy` and let the suite prove it.
7. **Read-only turns.** Claude, Cursor and Grok run a `readOnly` turn under the
   coordinator policy but keep reporting the session's. Agent Info then
   understates the turn's restrictions (never overstates them).
8. **Codex `on-request` in a container.** Under an `auto-approve` policy a user
   who picks `on-request` in a container gets a mode that never asks, because
   Codex asks only at the edge of a sandbox the container keeps off. Under
   `ask` the bridge now runs it as `untrusted`; decide whether the composer
   should do the same, or describe the mode honestly there.

9. **Pause in Claude tmux mode.** The deadline there is the `sleep` in the hook
   script (`tmux-hooks.ts` `hookScript`), and Claude Code kills a command hook
   after its own 600 s default. Pausing needs: a hold sidecar the script's wait
   loop honours (re-arming on resume), a `timeout` on the PreToolUse,
   PermissionRequest and Elicitation hooks above the hold ceiling,
   `parseBlockingHookTiming` accepting a moved deadline, a backend command, and
   re-emitting the hook event (blocking ids are emitted once today). Cards then
   drop `TMUX_PROMPT_DEADLINE`. Detect an installed script that predates the
   sidecar and keep its countdown unpausable.
10. **Pause Grok past its own limits.** A Grok pause ends at the 30-minute turn
    deadline, and a question also at Grok's `ask_user_question` timeout. Lifting
    that means pausing the bridge's `session/prompt` timeout while a request is
    held and raising Grok's question timeout to match; the bridge also does not
    read Grok's `config.toml` `[toolset.ask_user_question]`, so a shorter value
    set there is not reflected in the published limit.
11. **Pause from the public CLI and API.** `session interactions list` shows the
    moved `expiresAt` but not `hold`, and there is no hold action. Add `hold` to
    the listing and a `session.interaction.hold` action that calls
    `hold_native_agent_interaction`.

### Qualification

- Live pause on each provider: pause a Claude question, a Claude tool approval
  under `ask`, a Codex command approval, a Grok permission and a Pi approval;
  leave each paused past ten minutes, then answer it and confirm the turn
  continues with that answer. Only the Claude bridge is covered end to end, by
  `e2e/ClaudeInteractions.spec.ts` against a fake SDK; no real CLI has been
  left waiting longer than the old five minutes.

- Browser: raise an MCP elicitation (Codex or Claude), answer it, reload
  mid-question, and confirm it rehydrates from `/session/:id/interactions`. On
  a Claude environment overridden to `approvals: "ask"`, confirm a Bash or Edit
  call raises an approval card and that approve, deny and cancel turn reach the
  CLI. On one set to `deny`, confirm a tool outside the allow list is refused
  without a card while a question still appears. Run a real coordinator turn
  that delegates and asks a question.
- `mise run test:agent:docker` for the container cells on Cursor and Pi.
- On a real Claude CLI, confirm that a provider-sandboxed auto-approve session
  can neither leave the sandbox (`allowUnsandboxedCommands: false`) nor reach a
  domain off its allowlist when the network is restricted (`strictAllowlist`).
  The conformance suite proves the options; only the CLI proves the behaviour.

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
- A prompt's permission mode may narrow an `ask` or `deny` policy (plan mode,
  a read-only turn's `dontAsk`) but never widen it.
- `deny` is enforced by `canUseTool` in `default`, not by `dontAsk`, so a
  denying session can still ask the user questions.
- The coordinator policy is not user-overridable.
- Hosts default to no sandbox and auto-approve because every vendor sandbox
  holds `.git` read-only, which stalls ordinary Git work in a worktree (#613).
  `ask` stays available as an override.
- Key entry and other secrets go through an interaction, never a renderer form.
- Agent Info's policy summary is checked against what each adapter actually
  sends, not by a one-off look. The decisions behind that check:
  - One semantic model (`NativeAgentPolicyEffects`: isolation, approvals,
    project resources, network and what holds a network restriction) is both
    what the summary renders and what each runner decodes the received options
    into. No test compares summary strings.
  - The summary describes the policy the bridge reports, and the bridge reports
    what it applies. An axis an agent cannot honour is rewritten to the truth
    with a `note`, at report time only, so no gate or persisted policy changes.
    The alternative, a per-platform caveat table in the renderer, would have
    put provider knowledge back in the web app.
  - Runners capture the real hand-off (Claude's mocked `query()` options,
    Codex's `thread/start` and `turn/start` requests plus its `-c` overrides,
    Cursor's `Agent.create` options, Pi's loader options and approval gate,
    Grok's command line and permission answers, OpenCode's `session.create`
    rules). Approvals are observed behaviourally: each runner hands its gate an
    action nothing pre-approved and records whether it asks, refuses or runs.
  - An adapter may be stricter than its summary only where `narrowings.ts`
    says so with a reason. The suite fails if a narrowing is looser, or if it
    stops being observed, so an entry cannot outlive its cause.
  - "Restricted network" means the agent's own commands. Hosted tools that
    reach the internet without running a command here (web fetch, web search)
    are described by the effects model's network denial and hosted-search
    exception; the provider network-policy tests verify their tool restrictions.
  - A provider sandbox that the model can leave unseen holds nothing, so
    Claude only offers the way out (`allowUnsandboxedCommands`) when a person
    approves it, and a restricted sandbox uses a strict allowlist.

## Open questions

- Pi, Grok and OpenCode have no sandbox of their own, so a `provider` sandbox
  or a restricted network on a host runs unsandboxed with full network access,
  reported as such with a note. Should the backend refuse such a session, as
  Cursor refuses `deny`, rather than run it?

- Should Orkestrator expose "always allow" at all, given there is no revoke UI
  yet?
- `previewFormat`: plain or html?
- Claude MCP OAuth: the bridge's `authenticate` MCP action reconnects the server
  and expects the sign-in URL through `onElicitation`
  (`session-manager-catalog.ts`). With a live CLI that URL now arrives as a
  parked `mcp-url` card. With no live CLI the action runs on a `createProbe()`
  query that has no `onElicitation`, so the link never reaches anyone. Is the
  parked `mcp-url` card the intended route for that sign-in, or should MCP
  management own a separate flow? Decide with
  [mcp-management.md](mcp-management.md).

## Needs verification

- Whether every bridge has per-kind tests for park, render, resolve and
  fail-closed timeout. Codex and Pi have `interactions.test.ts` and Claude has
  `session-manager-parked-interactions.test.ts`; the full matrix was not
  confirmed.
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
