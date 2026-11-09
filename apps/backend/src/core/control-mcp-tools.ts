/**
 * Builds the Control MCP server for one request: its instructions, the
 * coordinator capability map, the listing filter and the node routing the
 * tool modules share. The tools every operator and coordinator credential
 * shares live in their own modules (`control-mcp-environment-tools.ts`,
 * `-launch-tools.ts`, `-ticket-tools.ts`, `-mail-tools.ts`); the
 * coordinator-only workflow tools in `control-mcp-coordinator-tools.ts`.
 * `control-mcp-server.ts` owns the listener and authentication; it rebuilds
 * this server for every request.
 */
import { McpServer } from "@modelcontextprotocol/server";
import {
  COORDINATOR_ASYNC_CONTRACT,
  COORDINATOR_MESSAGING_OFF_NOTE,
  COORDINATOR_ENVIRONMENT_CHOICE_RULE,
  COORDINATOR_LAUNCH_DEFAULTS_RULE,
  COORDINATOR_PR_RULE,
  COORDINATOR_REQUEST_ID_RULE,
  COORDINATOR_TIMERS_AND_ACCOUNTS_RULE,
  COORDINATOR_VALIDATION_RULE,
  coordinatorIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";
import type { CoordinatorPollGuard } from "./control-mcp-poll-guard.js";
import type { ControlMcpCaller } from "./control-mcp-caller.js";
import { registerCoordinatorWorkflowTools } from "./control-mcp-coordinator-tools.js";
import { isRecord, type JsonRecord } from "./control-mcp-tool-support.js";
import { registerDirectTools } from "./control-mcp-direct-tools.js";
import { registerGatewayTools } from "./control-mcp-gateway.js";
import {
  operatorCoordinatorLayout,
  operatorNode,
  operatorToolListed,
} from "./control-mcp-operator-tools.js";
import { registerVoiceTools } from "./control-mcp-voice.js";
import { registerAgentVoiceChatTools } from "./control-mcp-agent-voice-chat.js";
import { registerOperatorWorkflowTools } from "./control-mcp-operator-workflow-tools.js";
import { createNodeTargets, NODE_TOOL_CAPABILITIES, type NodeTarget } from "./control-mcp-nodes.js";
import { NODE_FILE_TOOL_CAPABILITIES } from "./control-mcp-node-files.js";
import { COORDINATOR_ENVIRONMENT_ACTIONS } from "./control-mcp-coordinator-environment-scope.js";
import { COORDINATOR_SURFACE_TOOL_CAPABILITIES } from "./control-mcp-coordinator-surfaces.js";
import { COORDINATOR_WORKER_TOOL_CAPABILITIES } from "./control-mcp-coordinator-worker-tools.js";
import { WORKER_TURN_TOOL_CAPABILITIES } from "./control-mcp-coordinator-worker-turns.js";
import { ACCOUNT_TOOL_CAPABILITIES } from "./control-mcp-account-tools.js";
import { COORDINATOR_GOAL_TOOL_CAPABILITIES } from "./control-mcp-coordinator-goals.js";
import { COORDINATOR_SUBORK_TOOL_CAPABILITIES } from "./control-mcp-coordinator-suborks.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";
import {
  LAUNCH_DEFAULTS_GUIDANCE,
  registerLaunchOptionsTool,
  registerLaunchTools,
} from "./control-mcp-launch-tools.js";
import {
  registerEnvironmentTools,
  registerProjectTools,
  registerPromptTool,
} from "./control-mcp-environment-tools.js";
import { registerTicketTools } from "./control-mcp-ticket-tools.js";
import { registerMailTools } from "./control-mcp-mail-tools.js";
import { coordinatorNodeRefused, type ControlMcpToolContext } from "./control-mcp-tools-shared.js";

export const COORDINATOR_TOOL_CAPABILITY = new Map<string, string>([
  ["list_projects", "discovery"],
  ["list_agents", "discovery"],
  ["get_launch_options", "discovery"],
  ["get_repository_context", "discovery"],
  ["mark_topic", "discovery"],
  ["mark_question", "discovery"],
  ["list_workflows", "discovery"],
  ["adopt_workflow", "discovery"],
  ["list_environments", "environments"],
  ["get_environment", "environments"],
  ["list_tabs", "environments"],
  ["get_tab_state", "environments"],
  ["get_tab_transcript", "environments"],
  ["launch_environment", "environments"],
  ["start_environment", "environments"],
  ["stop_environment", "environments"],
  ["list_tickets", "tickets"],
  ["get_ticket", "tickets"],
  ["create_ticket", "tickets"],
  ["update_ticket", "tickets"],
  ["add_ticket_comment", "tickets"],
  ["list_ticket_labels", "tickets"],
  ["create_ticket_label", "tickets"],
  ["set_ticket_label", "tickets"],
  ["launch_job", "jobs"],
  ["send_prompt_to_tab", "jobs"],
  ["start_build_pipeline", "build-pipelines"],
  ["get_build_pipeline", "build-pipelines"],
  ["pause_build_pipeline", "build-pipelines"],
  ["resume_build_pipeline", "build-pipelines"],
  ["cancel_build_pipeline", "build-pipelines"],
  ["restart_build_pipeline_step", "build-pipelines"],
  ["launch_multi_review", "multi-review"],
  ["open_multi_review", "multi-review"],
  ["open_multi_review_fix", "multi-review"],
  ["get_multi_review", "multi-review"],
  ["cancel_multi_review", "multi-review"],
  ["address_multi_review", "multi-review"],
  ["custom_fix_multi_review", "multi-review"],
  // Saved graph templates (item 214, D6): run, never author.
  ["list_graph_templates", "graphs"],
  ["launch_graph", "graphs"],
  ["get_graph_run", "graphs"],
  ["cancel_graph_run", "graphs"],
  ["list_mailboxes", "mail"],
  ["send_message", "mail"],
  ["read_messages", "mail"],
  ["get_message", "mail"],
  ["get_message_status", "mail"],
  ["ack_message", "mail"],
  ["create_schedule", "schedules"],
  ["list_schedules", "schedules"],
  ["cancel_schedule", "schedules"],
  ["pause_schedule", "schedules"],
  ["resume_schedule", "schedules"],
  ["update_schedule", "schedules"],
  ...NODE_TOOL_CAPABILITIES,
  ...NODE_FILE_TOOL_CAPABILITIES,
  ...COORDINATOR_SURFACE_TOOL_CAPABILITIES,
  ...COORDINATOR_WORKER_TOOL_CAPABILITIES,
  ...WORKER_TURN_TOOL_CAPABILITIES,
  ...ACCOUNT_TOOL_CAPABILITIES,
  ...COORDINATOR_GOAL_TOOL_CAPABILITIES,
  ...COORDINATOR_SUBORK_TOOL_CAPABILITIES,
]);
export const COORDINATOR_CAPABILITIES = new Set(COORDINATOR_TOOL_CAPABILITY.values());

/**
 * Coordinator tools that were removed, with what does the same job now.
 *
 * Each duplicated a tool that takes nodeId (or, for start_multi_review, the
 * complete launch_multi_review) and did less. A saved schedule naming one is
 * refused at fire time with this replacement, and paused, rather than
 * failing as an unknown tool. The backend commands behind them stay, so an
 * older command node or leaf that calls them is unaffected.
 */
export const RETIRED_COORDINATOR_TOOLS: ReadonlyMap<string, string> = new Map([
  ["list_node_environments", "list_environments with nodeId"],
  ["launch_node_environment", "launch_environment with nodeId"],
  ["start_node_environment", "start_environment with nodeId"],
  ["stop_node_environment", "stop_environment with nodeId"],
  ["send_prompt_to_node_tab", "send_prompt_to_tab with nodeId"],
  ["send_node_message", "send_message with nodeId"],
  ["start_multi_review", "launch_multi_review"],
]);

/**
 * What a conversation's credential may do. A side agent reads the project,
 * talks to the main coordinator and schedules its own reminders; it launches
 * nothing, so every worker reports to one place.
 */
export function coordinatorRoleCapabilities(role: "main" | "side"): string[] {
  return role === "side"
    ? ["discovery", "mail", "schedules"]
    : [
        "discovery",
        "tickets",
        "environments",
        "jobs",
        "build-pipelines",
        "multi-review",
        "graphs",
        "mail",
        "schedules",
        "accounts",
      ];
}

/** Whether a coordinator scope may call `tool` (listed and granted). */
export function coordinatorToolGranted(
  scope: Pick<CoordinatorControlScope, "capabilities">,
  tool: string,
): boolean {
  const required = COORDINATOR_TOOL_CAPABILITY.get(tool);
  return Boolean(required && scope.capabilities.includes(required));
}

export type CoordinatorControlScope = {
  role: "coordinator";
  projectId: string;
  coordinatorId: string;
  conversationId: string;
  mailboxIncarnationId: string;
  capabilities: readonly string[];
};

export type { CoordinatorPollGuard };

/**
 * Registers only the tools a credential may use, so `tools/list` never offers
 * a tool its `tools/call` would refuse. Coordinator tools are granted by
 * their capability; operator tools by the public actions they use and the
 * credential's profile.
 */
function filteredToolServer(
  server: McpServer,
  listed: (tool: string) => boolean,
  finishResult: (result: unknown) => unknown = (result) => result,
  beforeCall?: (tool: string, input: unknown) => Promise<void>,
): McpServer {
  return {
    registerTool: ((name: string, ...rest: unknown[]) => {
      if (!listed(name)) return undefined;
      const handler = rest.at(-1) as (...args: unknown[]) => unknown;
      return (server.registerTool as (...args: unknown[]) => unknown)(
        name,
        ...rest.slice(0, -1),
        async (...args: unknown[]) => {
          await beforeCall?.(name, args[0]);
          return finishResult(await handler(...args));
        },
      );
    }) as McpServer["registerTool"],
  } as McpServer;
}

const OPERATOR_INSTRUCTIONS =
  "Control Orkestrator through public actions. overview says what is going on; resolve_target turns spoken names into IDs and never guesses. " +
  "Every mutation needs a new requestId; reuse one only to retry after an ambiguous response. " +
  "When a result is confirmation-required, read its description aloud, get explicit confirmation, then repeat the identical call with confirmToken. " +
  "Report that work started and check back later with run_status rather than waiting. find_actions and describe_action reveal every other action; run_action runs one.";

/**
 * A coordinator tool result while agent messaging is off: tools still run, but
 * every wake they would promise is mail, so the promise (`wake`, the next step
 * it implies, the poll guard's restated contract) becomes the note saying so.
 */
export function withoutWakePromise(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const rewrite = (value: JsonRecord): JsonRecord => {
    if (typeof value.wake !== "string" && value.instruction !== COORDINATOR_ASYNC_CONTRACT) {
      return value;
    }
    const rewritten: JsonRecord = { ...value, wake: COORDINATOR_MESSAGING_OFF_NOTE };
    delete rewritten.nextStep;
    if (value.instruction === COORDINATOR_ASYNC_CONTRACT) delete rewritten.instruction;
    return rewritten;
  };
  const rewriteBlock = (block: unknown): unknown => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return block;
    try {
      const parsed: unknown = JSON.parse(block.text);
      return isRecord(parsed) ? { ...block, text: JSON.stringify(rewrite(parsed)) } : block;
    } catch {
      return block;
    }
  };
  return {
    ...result,
    ...(Array.isArray(result.content) ? { content: result.content.map(rewriteBlock) } : {}),
    ...(isRecord(result.structuredContent)
      ? { structuredContent: rewrite(result.structuredContent) }
      : {}),
  };
}

export async function createControlMcp(
  invoke: ControlMcpInvoker,
  coordinatorScope?: CoordinatorControlScope,
  pollGuard?: CoordinatorPollGuard,
  operatorCaller?: (messagingEnabled: boolean) => ControlMcpCaller,
): Promise<McpServer> {
  const config = await invoke<unknown>("get_config");
  const messagingEnabled =
    isRecord(config) &&
    isRecord(config.global) &&
    isRecord(config.global.agentMessaging) &&
    config.global.agentMessaging.enabled === true;
  // Scheduling is experimental; its tools are listed only while it is on.
  const schedulingEnabled =
    isRecord(config) && isRecord(config.global) && config.global.experimentalScheduling === true;
  const operator = coordinatorScope ? undefined : operatorCaller?.(messagingEnabled);
  const mcp = new McpServer(
    { name: "orkestrator-control", version: "1.0.0" },
    {
      instructions:
        "Control Orkestrator through project IDs returned by list_projects. " +
        "Use launch_environment for a new workspace and launch_job for an independent " +
        "agent tab in an existing ready environment. " +
        (coordinatorScope
          ? "Every launch_environment call requires baseBranch and baseCommit; copy coordinatorBase from get_launch_options, the latest commit of the repository's base branch, unless the user asks to build on the current checkout (checkoutBase). Use launch_multi_review for a Multi Review, and open_multi_review or open_multi_review_fix to focus saved work. "
          : "") +
        // Operator instructions below carry the operator's own request-id rule.
        (coordinatorScope
          ? `${COORDINATOR_REQUEST_ID_RULE} `
          : operator
            ? ""
            : "Every mutation needs a new requestId; reuse one only to retry after an ambiguous response. ") +
        (coordinatorScope ? COORDINATOR_LAUNCH_DEFAULTS_RULE : LAUNCH_DEFAULTS_GUIDANCE) +
        // Side agents launch nothing, so these rules are the main coordinator's.
        // With messaging off they promise wakes, so the note below stands instead.
        (coordinatorScope?.capabilities.includes("environments") && messagingEnabled
          ? ` ${COORDINATOR_ENVIRONMENT_CHOICE_RULE} ${COORDINATOR_PR_RULE} ${COORDINATOR_VALIDATION_RULE}`
          : "") +
        (coordinatorScope?.capabilities.includes("accounts") &&
        schedulingEnabled &&
        messagingEnabled
          ? ` ${COORDINATOR_TIMERS_AND_ACCOUNTS_RULE}`
          : "") +
        (coordinatorScope
          ? ` ${messagingEnabled ? COORDINATOR_ASYNC_CONTRACT : COORDINATOR_MESSAGING_OFF_NOTE}`
          : "") +
        (operator ? ` ${OPERATOR_INSTRUCTIONS}` : ""),
    },
  );
  const server = filteredToolServer(
    mcp,
    (tool) => {
      if (coordinatorScope) {
        const capability = COORDINATOR_TOOL_CAPABILITY.get(tool);
        if (capability === "schedules" && !schedulingEnabled) return false;
        return capability !== undefined && coordinatorScope.capabilities.includes(capability);
      }
      // Operator credentials: the original tools are part of every profile
      // except voice, and each needs the public actions it runs.
      if (!operator) return true;
      return operator.profile !== "voice" && operatorToolListed(operator, tool);
    },
    coordinatorScope && !messagingEnabled ? withoutWakePromise : undefined,
    coordinatorScope
      ? async (tool, input) => {
          const target = COORDINATOR_ENVIRONMENT_ACTIONS.get(tool)?.(isRecord(input) ? input : {});
          if (
            typeof target?.environmentId !== "string" &&
            typeof target?.pipelineId !== "string" &&
            typeof target?.workflowId !== "string"
          )
            return;
          await invoke("assert_coordinator_environment_scope", {
            scope: coordinatorScope,
            // Nested: the invoker's own environment check would look it up again.
            target: {
              environmentId: target.environmentId,
              pipelineId: target.pipelineId,
              workflowId: target.workflowId,
              ...(typeof target.nodeId === "string" ? { nodeId: target.nodeId } : {}),
            },
          });
        }
      : undefined,
  );

  /**
   * The node a coordinator's call names, with a routed invoker for that
   * node's copy of this project; `null` for this node. Only coordinators act
   * across nodes: any other credential is refused a `nodeId`.
   */
  const nodes = coordinatorScope
    ? createNodeTargets(invoke, {
        projectId: coordinatorScope.projectId,
        coordinatorId: coordinatorScope.coordinatorId,
        conversationId: coordinatorScope.conversationId,
      })
    : null;
  const onNode = async (nodeId: string | undefined): Promise<NodeTarget | null> => {
    if (!nodeId) return null;
    if (!nodes) throw new Error("nodeId is available to coordinators only.");
    return nodes.targetOrSelf(nodeId);
  };
  const onNodeResult = (target: NodeTarget | null): JsonRecord =>
    target ? { nodeId: target.nodeId, node: target.nodeName } : {};
  /**
   * A coordinator's ticket tool with a `nodeId`: the backend acts on this
   * board, which that node syncs, or on the node's own board for tickets made
   * only there (`coordinator-node-tickets.ts`). `null` for this node.
   */
  const nodeTickets = async (
    nodeId: string | undefined,
    projectId: string,
    action: "create" | "get" | "list" | "update" | "comment",
    input: JsonRecord,
  ): Promise<JsonRecord | null> => {
    if (!nodeId) return null;
    if (!coordinatorScope) coordinatorNodeRefused(nodeId);
    if (projectId !== coordinatorScope!.projectId) {
      throw new Error("A coordinator's tickets with nodeId are its own project's.");
    }
    const result = await invoke<unknown>("coordinator_node_ticket", {
      scope: coordinatorScope,
      nodeId,
      action,
      input,
    });
    if (!isRecord(result)) throw new Error("That node returned no ticket answer");
    return result.self === true ? null : result;
  };
  /** The invoker for one environment's node, after checking it is this project's worker there. */
  const environmentInvoker = async (
    nodeId: string | undefined,
    environmentId: string,
  ): Promise<{
    inv: ControlMcpInvoker;
    target: NodeTarget | null;
    where: JsonRecord;
    layout(): Promise<unknown>;
  }> => {
    const layoutOf = (inv: ControlMcpInvoker) => () =>
      inv<unknown>("get_pane_layout", { environmentId });
    if (operator) {
      // An operator's nodeId names any machine; no project scope applies.
      const node = await operatorNode(operator, nodeId);
      return {
        inv: node.invoke,
        target: null,
        where: node.tag,
        layout: coordinatorIdFromRuntimeId(environmentId)
          ? () => operatorCoordinatorLayout(node, environmentId)
          : layoutOf(node.invoke),
      };
    }
    const target = await onNode(nodeId);
    if (!target) return { inv: invoke, target: null, where: {}, layout: layoutOf(invoke) };
    await target.environment(environmentId);
    return {
      inv: target.invoke,
      target,
      where: onNodeResult(target),
      layout: layoutOf(target.invoke),
    };
  };

  const tools: ControlMcpToolContext = {
    invoke,
    coordinatorScope,
    operator,
    pollGuard,
    messagingEnabled,
    nodes,
    onNode,
    onNodeResult,
    nodeTickets,
    environmentInvoker,
  };

  // Registration order is the `tools/list` order clients see; keep it.
  registerProjectTools(server, tools);
  registerLaunchOptionsTool(server, tools);
  registerEnvironmentTools(server, tools);
  registerTicketTools(server, tools);
  registerLaunchTools(server, tools);
  registerPromptTool(server, tools);

  if (coordinatorScope) {
    registerCoordinatorWorkflowTools(server, {
      invoke,
      coordinatorScope,
      onNode,
      environmentInvoker,
      onNodeResult,
      pollGuard,
    });
  }

  registerMailTools(server, tools);

  if (operator) {
    // Tier 0 and 1 for every operator profile; tier 2 direct tools for all
    // but voice, whose clients load a fixed list at session start.
    registerOperatorWorkflowTools(server, operator);
    registerVoiceTools(mcp, operator);
    registerAgentVoiceChatTools(mcp, operator);
    registerGatewayTools(mcp, operator);
    if (operator.profile !== "voice") registerDirectTools(mcp, operator);
  }

  return mcp;
}
