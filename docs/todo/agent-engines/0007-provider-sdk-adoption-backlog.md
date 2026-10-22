# Provider SDK adoption backlog

Checked against `main` at `2459b05c` (2026-10-15).

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
