import type { McpServer } from "@modelcontextprotocol/server";
import { SUBORK_TOOL_NAME } from "@orkestrator/protocol/suborks";
import {
  SUBORK_TOOL_ANNOTATIONS,
  SUBORK_TOOL_DESCRIPTION,
  SUBORK_TOOL_INPUT_SCHEMA,
} from "./agent-tools-subork-schema.js";
import type { CoordinatorControlScope } from "./control-mcp-tools.js";
import { toolResult, type JsonRecord } from "./control-mcp-tool-support.js";
import { toolInput } from "./tool-schema.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

/**
 * `ask_agents` for a coordinator conversation, which has no agent tools server:
 * the same name, description and input as on every native tab, behind the
 * `ask_coordinator_suborks` command, which revalidates the authenticated scope.
 * Side agents have it too: a subork is read-only and answers only its asker.
 */

export const COORDINATOR_SUBORK_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  [SUBORK_TOOL_NAME, "discovery"],
];

export function registerCoordinatorSuborkTool(
  server: McpServer,
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
): void {
  server.registerTool(
    SUBORK_TOOL_NAME,
    {
      title: "Ask other agents",
      description: SUBORK_TOOL_DESCRIPTION,
      inputSchema: toolInput(SUBORK_TOOL_INPUT_SCHEMA),
      annotations: SUBORK_TOOL_ANNOTATIONS,
    },
    // `tabId` names a tab on a shared credential; a conversation's own is never shared.
    async ({ targets, prompt, requestId }) =>
      toolResult(
        await invoke<JsonRecord>("ask_coordinator_suborks", {
          scope: {
            projectId: scope.projectId,
            coordinatorId: scope.coordinatorId,
            conversationId: scope.conversationId,
          },
          input: {
            targets,
            ...(prompt !== undefined ? { prompt } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
          },
        }),
      ),
  );
}
