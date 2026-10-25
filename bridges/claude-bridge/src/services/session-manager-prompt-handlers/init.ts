import type { SDKMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerRuntimeStatus } from "../../types/index.js";
import { sessionHealth } from "../../types/index.js";
import { eventEmitter } from "../event-emitter.js";
import { recordTerminalSlashCommands } from "../claude-terminal-commands.js";
import { pluginStatusesFromInit } from "../init-plugins.js";
import { initMcpServerStatus } from "../mcp-runtime-status.js";
import { debugLog } from "../logger.js";
import { recordInitCommandInventory } from "../session-manager-commands.js";
import {
  beginClaudeUsageQuery,
  claudeCliContinuesResumedUsage,
  persistSessionMetadata,
} from "../session-manager-core.js";
import type { TurnState } from "../session-manager-prompt-turn.js";

/** Bound on the open capability set, which the CLI, not this bridge, sizes. */
const MAX_SDK_CAPABILITIES = 64;

/** `system`/`init`: the CLI's identity, inventory and capabilities for this query. */
export async function handleInitMessage(turn: TurnState, message: SDKMessage): Promise<void> {
  const { session, sessionId } = turn;
  // Store the SDK session ID for resume functionality
  const initMsg = message as SDKSystemMessage & Record<string, unknown>;
  beginClaudeUsageQuery(session, initMsg.claude_code_version);
  if (!claudeCliContinuesResumedUsage(initMsg.claude_code_version)) {
    turn.bootstrapClaudeUsage = false;
  }
  const sdkSessionId = initMsg.session_id;
  if (sdkSessionId) {
    const gainedDurableIdentity = session.sdkSessionId !== sdkSessionId;
    session.sdkSessionId = sdkSessionId;
    debugLog("[session-manager] Session initialized, stored SDK session ID:", sdkSessionId);
    // A plan-mode preference set before the first turn had no durable key
    // to be written under; the id assigned here is that key.
    if (gainedDurableIdentity) await persistSessionMetadata(session);
  }

  // Protocol capabilities the CLI advertises. Kept so later work can
  // feature-detect — `interrupt_receipt_v1` is what plan 05's interrupt
  // ladder needs to know whether a receipt will name the turns that
  // survived — rather than version-sniffing the CLI. An open set: unknown
  // values are retained verbatim and never interpreted here.
  if (Array.isArray(initMsg.capabilities)) {
    session.sdkCapabilities = initMsg.capabilities
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, MAX_SDK_CAPABILITIES)
      .map((entry) => entry.slice(0, 128));
  }

  // Capture MCP servers and plugins from init message
  const allMcpServers = initMsg.mcp_servers || [];

  // Plugin-provided MCP servers are listed with the plugins below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const regularMcpServers = allMcpServers.filter((s: any) => !s.name?.startsWith("plugin:"));

  // Statuses are kept as reported: a server still connecting or waiting for a
  // sign-in is not a failure, and the live panel's no-control fallback reads
  // these rows as they are.
  const mcpServerStatuses: McpServerRuntimeStatus[] = regularMcpServers.map(initMcpServerStatus);

  const { statuses: pluginStatuses, errors: pluginErrors } = pluginStatusesFromInit(initMsg);
  const previousPluginErrors = new Set(session.pluginErrorSignatures);
  session.pluginErrorSignatures = pluginErrors.map(({ plugin, type, message, path, loaded }) =>
    JSON.stringify([plugin, type, message, path, loaded]),
  );
  for (const [index, pluginError] of pluginErrors.entries()) {
    const signature = session.pluginErrorSignatures[index]!;
    if (previousPluginErrors.has(signature)) continue;
    previousPluginErrors.add(signature);
    sessionHealth(session).recordNotice({
      message: pluginError.loaded
        ? `Claude plugin ${pluginError.plugin} loaded with errors`
        : `Claude plugin ${pluginError.plugin} failed to load`,
      // Named like Pi's `extension/load`, so a load failure reads the
      // same whichever harness reported it.
      method: "plugin/load",
      severity: pluginError.loaded ? "warning" : "error",
      source: "provider",
      detail: `${pluginError.type}: ${pluginError.message}`,
    });
  }

  // Store init data in session
  session.initData = {
    mcpServers: mcpServerStatuses,
    plugins: pluginStatuses,
    slashCommands: initMsg.slash_commands,
    ...(Array.isArray(initMsg.terminal_slash_commands)
      ? { terminalSlashCommands: initMsg.terminal_slash_commands.slice(0, 512) }
      : {}),
    skills: Array.isArray(initMsg.skills) ? initMsg.skills : [],
    apiKeySource: typeof initMsg.apiKeySource === "string" ? initMsg.apiKeySource : undefined,
    agents: turn.runtime?.supportedAgents ?? [],
  };

  debugLog("[session-manager] Session init data captured", {
    sessionId,
    mcpServerCount: mcpServerStatuses.length,
    pluginCount: pluginStatuses.length,
    slashCommandCount: initMsg.slash_commands?.length ?? 0,
  });

  // Probe rows of later sessions on this CLI version use this list until
  // their own first init.
  recordTerminalSlashCommands(initMsg.claude_code_version, initMsg.terminal_slash_commands);
  // Init names seed an empty inventory only; they never replace a
  // live read or a `commands_changed` push.
  recordInitCommandInventory(session);

  // Emit session.init event so frontend can update UI
  eventEmitter.emit({
    type: "session.init",
    sessionId,
    data: session.initData,
  });
}
