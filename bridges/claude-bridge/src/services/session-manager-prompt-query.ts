import type { CanUseTool, HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import { AGENT_GOAL_TOOL_NAMES } from "@orkestrator/protocol/native-agent-goal";
import { ARTIFACT_TOOL_NAMES } from "@orkestrator/protocol/transcript-artifacts";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { createHash } from "node:crypto";
import type { SessionState } from "../types/index.js";
import {
  claudeArtifactServerTools,
  claudeWorkflowResultTools,
  createWorkflowResultTurnHook,
} from "./claude-workflow-result-tools.js";
import { readRepositoryInstructions } from "@orkestrator/protocol/node/repository-instructions";
import { claudeSystemPromptAppend } from "./system-prompt-append.js";
import {
  claudeAsksForApproval,
  claudeManagedSettings,
  effectiveClaudeChrome,
  claudePermissionMode,
  claudePolicyPermissionMode,
  claudeTurnPolicy,
  claudeWorkspaceCwd,
  resolveClaudeTurnPlugins,
} from "./claude-query-config.js";
import {
  claudeExecutionSandbox,
  claudeReadOnlyCommandSandbox,
  claudeSandboxRefusal,
} from "./claude-execution-sandbox.js";
import { debugLog } from "./logger.js";
import { claudeMcpToolPrefix } from "./mcp-tool-prefix.js";
import {
  AGENT_MCP_SERVER_NAME,
  claudeAccountOnlyMcpServerNames,
  claudeGrantedMcpServerNames,
  claudeUserMcpQueryOptions,
  getMcpRuntimeConfig,
  mcpSourceScopeForPolicy,
  userMcpServerFilter,
} from "./mcp-config.js";
import { coordinatorResearchMcpServersFromEnv } from "@orkestrator/protocol/coordinator-web-research";
import {
  claudeDeniedTools,
  claudeDisallowedTools,
  claudeReadOnlyAllowedTools,
  createCoordinatorReadOnlyHook,
  isCoordinatorReadOnlyPolicy,
  readOnlyRefusalRole,
} from "./read-only-policy.js";
import { runtimeEnvironmentForSessionQuery, withUnattendedOverloadRetry } from "./runtime-env.js";
import {
  claudeExecutableOptions,
  sdkSessionIdFromBridgeId,
  sessionOperationError,
} from "./session-manager-core.js";
import { answerClaudeElicitation } from "./session-manager-parked-interactions.js";
import { buildSdkPrompt } from "./session-manager-persistence.js";
import {
  commandChangeHookFor,
  recordingHookDenials,
  shellTaskHooks,
} from "./session-manager-prompt-hooks.js";
import {
  type ClaudeRuntimeMcp,
  createStaleMcpServerHook,
  reportedStaleServers,
} from "./session-manager-prompt-mcp-sync.js";
import type { PromptTestHooks, TurnState } from "./session-manager-prompt-turn.js";
import {
  claudeLiveSettings,
  type ClaudeRuntimeTurn,
  claudeTurnSettingSources,
  effectiveClaudeContext1m,
} from "./session-manager-runtime.js";
import { requestsUltracode } from "./ultracode.js";

// The query a turn runs: its policy, MCP servers, plugins, tools and
// permission mode, resolved once per turn, and the SDK options a launch uses.

/**
 * `ProposeGoal` starts Claude Code's own goal loop. Orkestrator's runs in the
 * backend, and two must never stack on one session (`plans/goals.md`, D2).
 */
export function withNativeGoalClosed(disallowed: readonly string[] | undefined): string[] {
  return [...(disallowed ?? []), "ProposeGoal"];
}

export const PLAN_MODE_INSTRUCTIONS = `The user has enabled planning mode. Use this phase to:
1. Thoroughly explore the codebase and its existing patterns.
2. Consider viable approaches and their trade-offs.
3. Design a concrete implementation strategy.
4. When ready, call ExitPlanMode with the plan for approval.
Do not write or edit files until the plan is approved.`;

/** Everything a turn resolved about its query before joining or launching a CLI. */
export type QueryPlan = Awaited<ReturnType<typeof resolveQueryPlan>>;

/**
 * Resolve the query this turn runs. Re-derived at every turn, never read
 * once at create; see `claudeTurnPolicy`.
 */
export async function resolveQueryPlan(
  turn: TurnState,
  sdkTextPrompt: string,
  testHooks: PromptTestHooks | undefined,
) {
  const { session, sessionId, options } = turn;
  // Create the query with Claude Agent SDK
  // Determine effort level: default to "high" if not specified
  const effortLevel = options?.effort ?? "high";
  // Use CWD env var if set (for local environments where bridge runs from its own dir)
  // This allows the Claude SDK to operate on the actual project directory
  const cwd = claudeWorkspaceCwd();

  // Re-derived at every turn, not read once at create. A session restored
  // from disk, or configured before this process took over, must not carry a
  // policy weaker than the one this process was launched to enforce.
  const policy: NativeAgentExecutionPolicy | undefined = claudeTurnPolicy(
    session.executionPolicy,
    options?.readOnly,
  );
  // The prompt route refuses this before accepting the prompt; this covers a
  // turn that reaches the CLI another way, or a host that changed since.
  const sandboxRefusal = claudeSandboxRefusal(policy);
  if (sandboxRefusal) throw sessionOperationError("invalid", sandboxRefusal);
  // What a cold command-discovery probe must reproduce to answer for this
  // session rather than for a default CLI (see `claude-query-config.ts`).
  session.commandDiscoveryInputs = {
    readOnly: options?.readOnly === true,
    includeLocalSettings: options?.includeLocalSettings === true,
  };
  const settingSources = claudeTurnSettingSources(session, options);
  session.commandDiscoveryInputs.includeLocalSettings = settingSources.includes("local");
  // The CLI reads the checkout's CLAUDE.md or AGENTS.md only with the
  // `project` source, which also loads its hooks and settings. Without it the
  // repository's AGENTS.md is appended for writable sessions only.
  const repositoryInstructions =
    options?.readOnly ||
    policy?.id === "coordinator-read-only" ||
    settingSources.includes("project")
      ? undefined
      : await readRepositoryInstructions(cwd);
  // A read-only turn asks for the CLI's sandbox only where it can run; where
  // it cannot, the hook is the boundary and the turn says so.
  const readOnlyCommandSandbox = isCoordinatorReadOnlyPolicy(policy)
    ? claudeReadOnlyCommandSandbox()
    : undefined;
  // Report only after a runtime accepts the turn (`markQueryStarted`). While
  // preparation awaits, an existing CLI still owns the session's boundary.
  // Load MCP servers and plugins from config files. Both resolutions read
  // the same on-disk config, so they run concurrently and each merges once.
  // A coordinator's inline set is the injected Orkestrator server(s) only:
  // `mcpSourceScopeForPolicy` answers `none` for it, so a user-scope stdio
  // server cannot ride in through the one channel the CLI still honours
  // when `settingSources` is empty.
  const [
    { servers: mcpServers, names: mcpServerNames, revision: mcpConfigRevision },
    { plugins, coordinatorSkills },
  ] = await Promise.all([
    getMcpRuntimeConfig(
      cwd,
      process.env,
      options?.agentMcp,
      mcpSourceScopeForPolicy(policy),
      // A graph node loads only the user servers it was granted (item 404).
      userMcpServerFilter(policy),
    ),
    // Installs pass only when the settings this CLI reads enable them. A
    // coordinator also gets the user's and the project's skills, mirrored
    // without their hooks or tool grants (`coordinator-skills.ts`).
    resolveClaudeTurnPlugins(cwd, policy, settingSources),
  ]);
  turn.mcpServerNames = mcpServerNames;
  // On an added account the CLI loads its own copy of the servers; what that
  // copy names and the configuration does not is stale from launch.
  const accountOnlyMcpServers = await claudeAccountOnlyMcpServerNames(
    cwd,
    settingSources,
    mcpServerNames,
    claudeUserMcpQueryOptions(policy).strictMcpConfig === true,
  );

  const mcpServerCount = Object.keys(mcpServers).length;
  const pluginCount = plugins.length;
  // Determine permission mode: the prompt's, capped by the policy.
  // Why: when the user requests "plan" mode we forward it as the SDK's actual
  // `"plan"` permissionMode. The SDK enforces read-only and runs its built-in
  // ExitPlanMode tool natively — without this, ExitPlanMode fails because the
  // CLI has no plan-mode state to exit.
  const policyPermissionMode = claudePolicyPermissionMode(policy);
  const permissionMode = claudePermissionMode(policy, options?.permissionMode);
  turn.permissionMode = permissionMode;
  // When the user approves tools, only tools that read are approved up front.
  // The CLI asks for the rest through `canUseTool`, which parks each one as an
  // approval.
  const defaultAllowedTools = claudeAsksForApproval(policy, options)
    ? ["Read", "Glob", "Grep", "AskUserQuestion", "Task", "Agent"]
    : [
        "Read",
        "Edit",
        "Write",
        "Bash",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
        "AskUserQuestion",
        "Task",
        "Agent",
      ];
  const coordinatorReadOnly = isCoordinatorReadOnlyPolicy(policy);
  // A graph node's granted user servers (item 404) are approved up front like
  // the Orkestrator tools: the template's grant is the approval. A session
  // that asks keeps asking for them.
  const grantedMcpServerNames = claudeAsksForApproval(policy, options)
    ? []
    : claudeGrantedMcpServerNames(policy, mcpServerNames);
  // A worker can always report back, whatever its approval setting: under
  // "deny" only allowed tools run, and the mail tools must be among them. The
  // transcript-artifact tools share that footing: they write only to
  // Orkestrator's own bounded artifact store and never touch the workspace.
  // An explicit toolPolicy deny still wins.
  const agentMailTools = mcpServerNames.has(AGENT_MCP_SERVER_NAME)
    ? [...AGENT_MAIL_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES, ...AGENT_GOAL_TOOL_NAMES].map(
        (name) => `mcp__${AGENT_MCP_SERVER_NAME}__${name}`,
      )
    : [];
  const allowedTools = coordinatorReadOnly
    ? claudeReadOnlyAllowedTools({
        agentMcpServerNames: mcpServerNames.has(AGENT_MCP_SERVER_NAME)
          ? [AGENT_MCP_SERVER_NAME]
          : [],
        policy,
        // Only research servers this session actually loaded: a coordinator's
        // inline set is the launcher's, so these are exactly the user's list.
        researchMcpServerNames: coordinatorResearchMcpServersFromEnv(process.env)
          .map((server) => server.name)
          .filter((name) => mcpServerNames.has(name)),
        skillNames: coordinatorSkills,
        grantedMcpServerNames,
      })
    : [
        ...(policy?.toolPolicy?.allow ?? defaultAllowedTools),
        ...agentMailTools,
        ...claudeWorkflowResultTools(mcpServerNames),
        ...claudeArtifactServerTools(mcpServerNames),
        ...grantedMcpServerNames.map((name) => `${claudeMcpToolPrefix(name)}*`),
      ];
  // Provider tool names, not the policy's own: `toolPolicy.deny` carries
  // Codex's vocabulary, and passing it to `disallowedTools` matches nothing.
  // Any other policy keeps its override and also loses the tools for each
  // capability it denies (a network denial takes WebFetch and WebSearch).
  const disallowedTools = withNativeGoalClosed(
    coordinatorReadOnly ? claudeDeniedTools(policy) : claudeDisallowedTools(policy),
  );

  const fastMode = options?.fastMode === true;
  const ultracode = requestsUltracode(options?.parameterValues);
  session.ultracode = ultracode;
  session.ultracodeApplied = ultracode;

  debugLog("[session-manager] Starting query", {
    sessionId,
    cwd,
    model: options?.model,
    resume: session.sdkSessionId ?? null,
    effortLevel,
    permissionMode,
    fastMode,
    ultracode,
    mcpServerCount,
    mcpServerNames: Array.from(mcpServerNames),
    pluginCount,
    pluginPaths: plugins.map((p) => p.path),
  });
  const envPath = process.env.PATH;
  debugLog("[session-manager] SDK env PATH", { path: envPath });
  const sdkPrompt = await buildSdkPrompt(
    sdkTextPrompt,
    options?.attachments,
    cwd,
    testHooks?.afterAttachmentSymlinkValidation,
    testHooks?.afterAttachmentCanonicalValidation,
    testHooks?.afterAttachmentInitialValidation,
  );

  // A graph agent's policy denies `github.write`: its CLI gets no GitHub credential.
  const queryEnvironment = withUnattendedOverloadRetry(
    session.executionPolicy,
    await runtimeEnvironmentForSessionQuery(policy),
  );
  const liveSettings = claudeLiveSettings({
    model: options?.model,
    permissionMode,
    effort: effortLevel,
    parameterValues: options?.parameterValues,
    fastMode,
  });
  // Content-free identity of the inline MCP servers, which carry credentials.
  const mcpServersKey = createHash("sha256").update(JSON.stringify(mcpServers)).digest("hex");
  return {
    settingSources,
    repositoryInstructions,
    cwd,
    policy,
    effortLevel,
    mcpServers,
    mcpServerNames,
    accountOnlyMcpServers,
    mcpConfigRevision,
    plugins,
    mcpServerCount,
    pluginCount,
    policyPermissionMode,
    permissionMode,
    coordinatorReadOnly,
    readOnlyCommandSandbox,
    allowedTools,
    disallowedTools,
    fastMode,
    ultracode,
    sdkPrompt,
    queryEnvironment,
    liveSettings,
    mcpServersKey,
  };
}

/**
 * The configuration the CLI actually has, recorded only once it has it: a
 * save made while the previous turn ran is "pending" until here, and one
 * made after here is pending for the next turn. `staleServers` names what
 * the CLI still runs although the configuration dropped it, so a removal is
 * never reported done while the server still runs.
 */
export function recordMcpConfigRevision(
  session: SessionState,
  plan: QueryPlan,
  mcp: ClaudeRuntimeMcp,
): void {
  const { mcpConfigRevision } = plan;
  if (!mcpConfigRevision) return;
  const staleServers = reportedStaleServers(mcp);
  session.mcpConfigRevision = {
    ...mcpConfigRevision,
    sources: { ...mcpConfigRevision.sources },
    queryStartedAt: new Date().toISOString(),
    ...(staleServers ? { staleServers } : {}),
  };
}

/**
 * The SDK options for a CLI this turn launches. Hooks and callbacks reach the
 * turn `turnFor` names: the one whose row holds the tool, else the latest.
 * `mcp` is the launching runtime's MCP state, which its hooks read for life.
 */
export function claudeQueryOptions(
  turn: TurnState,
  plan: QueryPlan,
  turnFor: (toolUseId?: string) => ClaudeRuntimeTurn,
  mcp: ClaudeRuntimeMcp,
): Options {
  const { session, sessionId, options, abortController } = turn;
  const {
    cwd,
    policy,
    effortLevel,
    mcpServers,
    plugins,
    mcpServerCount,
    pluginCount,
    policyPermissionMode,
    permissionMode,
    coordinatorReadOnly,
    readOnlyCommandSandbox,
    allowedTools,
    disallowedTools,
    fastMode,
    ultracode,
    queryEnvironment,
  } = plan;
  const managedSettings = claudeManagedSettings(policy);
  const latestTurnHook =
    (pick: (target: ClaudeRuntimeTurn) => HookCallback): HookCallback =>
    (...args) =>
      pick(turnFor())(...args);
  const backgroundTaskHook = latestTurnHook((target) => target.recordBackgroundTaskHook);
  const commandChangeHook = commandChangeHookFor(turnFor, session.id);
  const shellTaskHook = shellTaskHooks(session);
  return {
    cwd,
    ...claudeExecutableOptions(),
    // The SDK replaces (rather than merges) the CLI environment when this
    // option is present. The snapshot therefore carries every ordinary
    // bridge variable plus the latest managed GitHub credential.
    env: queryEnvironment,
    model: options?.model,
    title: session.title,
    agent: options?.agent,
    ...(options?.outputSchema
      ? {
          outputFormat: {
            type: "json_schema" as const,
            schema: options.outputSchema,
          },
        }
      : {}),
    permissionMode,
    // Always given: a later turn can switch this running CLI into plan mode.
    planModeInstructions: PLAN_MODE_INSTRUCTIONS,
    // Required when using bypassPermissions mode, and whenever the policy
    // allows it: a later turn can switch this running CLI into it.
    ...((permissionMode === "bypassPermissions" ||
      policyPermissionMode === "bypassPermissions") && {
      allowDangerouslySkipPermissions: true,
    }),
    // Use effort level to control thinking depth (replaces maxThinkingTokens)
    ...(effortLevel && { effort: effortLevel }),
    // Opus 4.7 defaults adaptive thinking display to "omitted" (signature only,
    // redacted text). Opt back into "summarized" so thinking content renders in the UI.
    thinking:
      options?.parameterValues?.thinking === "disabled"
        ? { type: "disabled" }
        : typeof options?.parameterValues?.thinking === "string" &&
            options.parameterValues.thinking.startsWith("budget-")
          ? {
              type: "enabled",
              budgetTokens: Number(options.parameterValues.thinking.slice("budget-".length)),
              display: "summarized",
            }
          : { type: "adaptive", display: "summarized" },
    ...(effectiveClaudeContext1m(options) ? { betas: ["context-1m-2025-08-07" as const] } : {}),
    // Explicit flags override ambient CLAUDE_CODE_ENABLE_CFC. Chrome is
    // opt-in, and a coordinator's read-only boundary always excludes
    // driving the user's signed-in browser.
    extraArgs: effectiveClaudeChrome(policy, options) ? { chrome: null } : { "no-chrome": null },
    includePartialMessages: true,
    // Preserve the full nested transcript. Every forwarded subagent block
    // carries parent_tool_use_id and is rendered inside its Agent card.
    forwardSubagentText: true,
    allowedTools,
    ...(disallowedTools?.length ? { disallowedTools } : {}),
    ...(policy?.sandbox === "provider" || coordinatorReadOnly
      ? {
          sandbox: claudeExecutionSandbox(policy, claudeAsksForApproval(policy, options), {
            cwd,
            ...(readOnlyCommandSandbox
              ? { commandSandbox: readOnlyCommandSandbox.commandSandbox }
              : {}),
          }),
        }
      : {}),
    abortController,
    // A deterministic UUID makes the bridge id recoverable from the SDK's
    // persisted session store after a bridge restart.
    ...(session.sdkSessionId
      ? { resume: session.sdkSessionId }
      : {
          sessionId: sdkSessionIdFromBridgeId(session.id) ?? crypto.randomUUID(),
        }),
    enableFileCheckpointing: true,
    promptSuggestions: options?.promptSuggestions === true,
    agentProgressSummaries: true,
    perTaskStopAffordance: true,
    // Use Claude Code system prompt with additional instructions
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        coordinatorReadOnly
          ? "You are a read-only coordinator. Inspect the checkout with reading tools and use the trusted research tools available for this turn. Delegate all mutations and artifact creation to worker environments through Orkestrator tools. Present findings directly in your response."
          : claudeSystemPromptAppend(queryEnvironment),
        ...(plan.repositoryInstructions ? [plan.repositoryInstructions] : []),
      ].join("\n\n"),
    },
    // Load user settings (from ~/.claude.json including MCP servers) and project settings (CLAUDE.md files)
    // Using "user" lets the SDK handle MCP server loading natively, which supports all transport types
    // A coordinator loads nothing: user settings can declare their own
    // hooks and MCP servers, both of which run programs this boundary is
    // supposed to exclude.
    settingSources: plan.settingSources,
    // The policy layer: a read-only turn runs no plugin or skill hook and no
    // skill inline shell (`claudeManagedSettings`).
    ...(managedSettings ? { managedSettings } : {}),
    // Fast mode (priority service tier) and Ultracode are Claude Code
    // flag-layer settings, so the user can opt into each per prompt. The
    // CLI keeps neither across processes, and each turn is its own query.
    ...((fastMode || ultracode) && {
      settings: {
        ...(fastMode && { fastMode: true }),
        ...(ultracode && { ultracode: true }),
      },
    }),
    // Also pass MCP servers explicitly for any project-local .mcp.json overrides.
    // The CLI (2.1.280) also loads the servers of every enabled settings
    // source itself — `user` reads `$CLAUDE_CONFIG_DIR/.claude.json` (else
    // `~/.claude.json`), `project` reads `.mcp.json`, `local` reads
    // `projects[cwd]` — and an inline entry wins over a same-named native
    // one. `strictMcpConfig` is deliberately NOT set: it would also drop
    // every plugin-provided MCP server. The coordinator boundary instead
    // rests on `settingSources: []` plus an inline set of `none` scope.
    // A later `setMcpServers` cannot drop these until it has taken them
    // over; see `session-manager-prompt-mcp-sync.ts`.
    mcpServers: mcpServerCount > 0 ? mcpServers : undefined,
    // A policy that selects user servers (a graph node, item 404) needs
    // `strictMcpConfig`: without it the CLI loads every server of its
    // settings sources itself, whatever the inline set says.
    ...claudeUserMcpQueryOptions(policy),
    // Load plugins from user config
    plugins: pluginCount > 0 ? plugins : undefined,
    hooks: {
      // Registered here rather than through settings so a workspace cannot
      // remove the one control that actually holds the boundary.
      // The read-only hook runs first: a call it denies must never be
      // snapshotted, and the measuring hook only opens a window.
      PreToolUse: [
        ...(coordinatorReadOnly && policy
          ? [
              {
                hooks: [
                  recordingHookDenials(
                    createCoordinatorReadOnlyHook(policy, undefined, {
                      ...(readOnlyCommandSandbox
                        ? { commandSandbox: readOnlyCommandSandbox.commandSandbox }
                        : {}),
                      // A graph reviewer or pipeline review is not a coordinator.
                      role: readOnlyRefusalRole(
                        session.executionPolicy,
                        options?.readOnly === true,
                      ),
                    }),
                    session.id,
                  ),
                ],
              },
            ]
          : []),
        {
          hooks: [
            recordingHookDenials(createStaleMcpServerHook(mcp), session.id),
            // A turn's declared workflow-result attempt: each result tool only
            // with the key it answers for, in every permission mode.
            recordingHookDenials(
              createWorkflowResultTurnHook((toolUseId) => turnFor(toolUseId).workflowResultTurn()),
              session.id,
            ),
          ],
        },
        commandChangeHook.PreToolUse,
        shellTaskHook.PreToolUse,
      ],
      PostToolUse: [commandChangeHook.PostToolUse, shellTaskHook.PostToolUse],
      PostToolUseFailure: [commandChangeHook.PostToolUseFailure, shellTaskHook.PostToolUseFailure],
      TaskCreated: [{ hooks: [backgroundTaskHook] }],
      TaskCompleted: [{ hooks: [backgroundTaskHook] }],
      SubagentStart: [{ hooks: [backgroundTaskHook] }],
      SubagentStop: [{ hooks: [backgroundTaskHook] }],
      PreCompact: [{ hooks: [latestTurnHook((target) => target.recordPreCompact)] }],
      PostCompact: [{ hooks: [latestTurnHook((target) => target.recordPostCompact)] }],
    },
    // Hook failures are observable provider-health data. Without these
    // events a failed lifecycle hook would silently leave task or
    // compaction projection stale.
    includeHookEvents: true,
    // AskUserQuestion option previews arrive as Markdown/ASCII, which the
    // question card shows verbatim in a monospace block. Not `html`: the card
    // would have to render model-written HTML. Explicit, so an SDK whose
    // default changes cannot start sending a format the card does not expect.
    toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
    // Pinned against @anthropic-ai/claude-agent-sdk 0.3.314: although the
    // SDK warns that bypassPermissions shadows canUseTool for ordinary
    // tool permission checks, AskUserQuestion is a special case. A live
    // contract probe confirmed it still reaches this callback and the SDK
    // waits for the returned promise. Ordinary tools reach it only in a mode
    // that asks: an `ask` policy runs `default`, and every tool outside the
    // allow list is parked here as a command, file or permission approval.
    // The SDK's own type, rather than a hand-written subset. The third
    // argument carries `suggestions`, `blockedPath`, `decisionReason` and
    // `title` — the last of which is the prompt sentence the CLI already
    // composed, so reconstructing one from `toolName` and `input` produces
    // a worse question than the one the SDK offered.
    canUseTool: ((toolName, input, permissionContext) =>
      turnFor(permissionContext?.toolUseID).canUseTool(
        toolName,
        input,
        permissionContext,
      )) as CanUseTool,
    /**
     * An MCP server asking the user for input: parked as an `mcp-form` or
     * `mcp-url` interaction until the user answers it on the interaction
     * card, its deadline cancels it, or the CLI withdraws it. Unset, these
     * requests sat unanswered until the CLI's own deadline, which the user
     * saw as the tab freezing for minutes with nothing to explain it.
     */
    onElicitation: (request, elicitationOptions) =>
      answerClaudeElicitation(session, sessionId, request, elicitationOptions),
    /**
     * The CLI asking the host to render a blocking dialog.
     *
     * `supportedDialogKinds` is deliberately not declared: this host can
     * render none of them. The only documented kind,
     * `refusal_fallback_prompt`, carries a payload and result the SDK leaves
     * opaque, and the interaction card has nothing to show for it. The SDK
     * documents that a kind is only *sent* to clients that declared it, so
     * in practice this callback should not fire — but a multi-client
     * transport delivers the request to every attached client, so it can.
     * `cancelled` is the correct answer for a kind this host cannot render:
     * the CLI then applies the dialog's own default rather than waiting out
     * its deadline.
     */
    onUserDialog: async () => ({ behavior: "cancelled" as const }),
  };
}
