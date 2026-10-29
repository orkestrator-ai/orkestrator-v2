import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import {
  isWorkflowResultAttemptTool,
  REPORT_FINDING_TOOL_NAME,
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  type WorkflowResultTurn,
  workflowResultToolName,
  workflowResultTurnAllows,
} from "@orkestrator/protocol/workflow-results";
import {
  ARTIFACT_TOOL_NAMES,
  ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
} from "@orkestrator/protocol/transcript-artifacts";
import { AGENT_MCP_SERVER_NAME } from "./mcp-config.js";

/**
 * Only the injected Orkestrator server may report workflow results, and a
 * Multi Review reviewer's provisional findings with them. The backend lists
 * `report_finding` only on a live reviewer's own attempt.
 */
export function claudeWorkflowResultTools(servers: ReadonlySet<string>): string[] {
  if (!servers.has(AGENT_MCP_SERVER_NAME)) return [];
  return [
    ...WORKFLOW_RESULT_KINDS.map(workflowResultToolName),
    WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    "get_workflow_result_status",
    REPORT_FINDING_TOOL_NAME,
  ].map((name) => `mcp__${AGENT_MCP_SERVER_NAME}__${name}`);
}

const AGENT_MCP_TOOL_PREFIX = `mcp__${AGENT_MCP_SERVER_NAME}__`;

/**
 * A call to the turn's own workflow-result attempt, by its qualified name:
 * one of the tools the turn declared (`workflowResultTool` and, for a graph
 * activation, every slot's port tools and the listed extra tools), naming the
 * key that tool answers for. Lets a graph node's per-port tools through a
 * session whose policy would otherwise ask or deny, as the fixed list above
 * does for the kinds' tools.
 */
export function isOwnClaudeWorkflowResultCall(
  servers: ReadonlySet<string>,
  turn: WorkflowResultTurn | undefined,
  toolName: string,
  input: unknown,
): boolean {
  if (!turn || !servers.has(AGENT_MCP_SERVER_NAME) || !toolName.startsWith(AGENT_MCP_TOOL_PREFIX))
    return false;
  return workflowResultTurnAllows(turn, toolName.slice(AGENT_MCP_TOOL_PREFIX.length), input);
}

/**
 * Why a call to an Orkestrator workflow-result tool is not the declared
 * attempt's own, or undefined when it is, or the turn declared none, or the
 * tool is not a workflow-result tool, or the turn is not a graph
 * activation's. A read-only turn allows the whole Orkestrator server, so this
 * is what keeps one slot's tools on that slot's key there.
 */
export function claudeWorkflowResultCallRefusal(
  turn: WorkflowResultTurn | undefined,
  toolName: string,
  input: unknown,
): string | undefined {
  // Only a graph activation's turn (one with slots) is held here. A kind
  // tool's turn keeps today's behaviour: a mistyped key reaches the backend,
  // whose refusal names the attempt's own key so the model can correct it.
  if (!turn?.slots || !toolName.startsWith(AGENT_MCP_TOOL_PREFIX)) return undefined;
  const name = toolName.slice(AGENT_MCP_TOOL_PREFIX.length);
  if (!isWorkflowResultAttemptTool(name) || workflowResultTurnAllows(turn, name, input))
    return undefined;
  return `${name} is not available for this call: this turn may only use its own result tools, each with its own resultKey.`;
}

/**
 * A PreToolUse hook holding every call to an Orkestrator workflow-result tool
 * to the attempt its turn declared. Hooks run before the permission mode and
 * allow rules, so this holds in every mode, a read-only turn's included. A
 * turn that declared no attempt is untouched.
 */
export function createWorkflowResultTurnHook(
  turnFor: (toolUseId: string | undefined) => WorkflowResultTurn | undefined,
): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const reason = claudeWorkflowResultCallRefusal(
      turnFor(input.tool_use_id),
      input.tool_name,
      input.tool_input,
    );
    if (!reason) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
}

/**
 * The artifact tools of a backend workflow turn's own `orkestrator-artifacts`
 * server. Like the result tools they run whatever the turn's approval mode
 * (they write only to Orkestrator's artifact store, never the workspace); an
 * explicit `toolPolicy.deny` still wins.
 */
export function claudeArtifactServerTools(servers: ReadonlySet<string>): string[] {
  if (!servers.has(ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME)) return [];
  return ARTIFACT_TOOL_NAMES.map((name) => `mcp__${ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME}__${name}`);
}
