import type { BridgeConnection, ProviderSendOptions } from "./agent-provider-contract.js";
import type { HttpBridgeAgent } from "./http-bridge-catalog.js";

/**
 * The JSON body of `POST /session/:id/prompt` for an HTTP bridge.
 *
 * Every bridge reads the shared fields; each agent adds the controls its
 * bridge understands. `allowProviderCommands` and `command` are sent
 * explicitly so a bridge can honour literal intent and revalidate a resolved
 * command. A legacy bridge ignores both, which is why the backend only ever
 * sets `command` for a descriptor from that bridge's enhanced catalogue.
 */
export function bridgePromptBody(
  agent: HttpBridgeAgent,
  connection: BridgeConnection,
  prompt: string,
  options: ProviderSendOptions,
  attachments: unknown,
): Record<string, unknown> {
  return {
    prompt,
    requestId: options.requestId,
    attachments,
    outputSchema: options.schema,
    readOnly: options.readOnly ?? (options.mode === "build" ? false : undefined),
    parameterValues: options.parameterValues,
    persistDefaults: options.persistDefaults,
    ...(options.allowProviderCommands === undefined
      ? {}
      : { allowProviderCommands: options.allowProviderCommands }),
    ...(options.command ? { command: options.command } : {}),
    ...(agent === "claude"
      ? {
          model: options.model ?? connection.model,
          effort: options.effort ?? connection.effort,
          fastMode: options.fastMode ?? connection.fastMode,
          agent: options.subAgent,
          includeLocalSettings: options.includeLocalSettings,
          promptSuggestions: options.promptSuggestions,
          agentMcp: options.agentMcp,
          permissionMode: options.readOnly
            ? "dontAsk"
            : options.mode === "plan"
              ? "plan"
              : typeof options.parameterValues?.permissionMode === "string"
                ? options.parameterValues.permissionMode
                : "bypassPermissions",
        }
      : agent === "codex"
        ? {
            fastMode: options.fastMode ?? connection.fastMode,
            agentMcp: options.agentMcp,
            workflowResultTool: options.workflowResultTool,
          }
        : agent === "cursor" || agent === "grok" || agent === "pi"
          ? {
              fastMode: options.fastMode ?? connection.fastMode,
              model: options.model ?? connection.model,
              reasoningEffort: options.effort ?? connection.effort,
              mode: options.mode,
              agentMcp: options.agentMcp,
            }
          : { fastMode: options.fastMode ?? connection.fastMode }),
  };
}
