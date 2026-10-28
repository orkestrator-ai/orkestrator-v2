import {
  DISPATCH_OUTCOME_LOST_KIND,
  dispatchOutcomeLostMessage,
} from "@orkestrator/protocol/native-agent";
import {
  PromptRejectedError,
  type BridgeConnection,
  type ProviderSendOptions,
} from "./agent-provider-contract.js";
import type { HttpBridgeAgent } from "./http-bridge-catalog.js";
import { withoutRetiredParameterValues } from "./native-agent-retired-parameters.js";

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
    parameterValues: withoutRetiredParameterValues(agent, options.parameterValues),
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
              : (options.approvalMode ?? "bypassPermissions"),
          // Also sent on plan turns: it decides who approves tools once the
          // plan is accepted.
          ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
        }
      : agent === "codex"
        ? {
            fastMode: options.fastMode ?? connection.fastMode,
            agentMcp: options.agentMcp,
            workflowResultTool: options.workflowResultTool,
            ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
          }
        : agent === "cursor" || agent === "grok" || agent === "pi"
          ? {
              fastMode: options.fastMode ?? connection.fastMode,
              model: options.model ?? connection.model,
              reasoningEffort: options.effort ?? connection.effort,
              mode: options.mode,
              agentMcp: options.agentMcp,
              // Grok and Pi gate tools in the bridge, so a read-only turn needs
              // to know which attempt's tools it may let through.
              ...(agent !== "cursor" &&
              options.agentMcp &&
              options.workflowResultTool &&
              options.workflowResultKey
                ? {
                    workflowResultTool: options.workflowResultTool,
                    workflowResultKey: options.workflowResultKey,
                  }
                : {}),
            }
          : { fastMode: options.fastMode ?? connection.fastMode }),
  };
}

/**
 * Refuse a prompt whose request id the bridge has retired.
 *
 * The bridge restored a recorded id without its outcome
 * (HTTP 410, `kind: "dispatch-outcome-lost"`). Retrying can never
 * help, so say what happened in the user's terms rather than the bridge's
 * request-id wording, and mark the id retired.
 */
export function assertPromptOutcomeKnown(
  agent: HttpBridgeAgent,
  status: number,
  detail: Record<string, unknown> | null | undefined,
): void {
  if (status !== 410 || detail?.kind !== DISPATCH_OUTCOME_LOST_KIND) return;
  throw new PromptRejectedError(dispatchOutcomeLostMessage(agent), { requestIdRetired: true });
}
