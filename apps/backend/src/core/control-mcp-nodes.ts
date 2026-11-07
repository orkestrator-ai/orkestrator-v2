import { offlineLaunchMessage } from "@orkestrator/protocol/ticket-sync";
import type { McpServer } from "@modelcontextprotocol/server";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { NodeStatus } from "@orkestrator/protocol/command-nodes";
import { repositoryHint, type NodeSummariesResult } from "@orkestrator/protocol/node-summaries";
import { Schema } from "effect";
import { describe, int, list, str, toolInput, withDefault } from "./tool-schema.js";

import { APP_VERSION, BUILD_COMMIT } from "./constants.js";
import { readNodeMachineLoad, readOwnMachineLoad } from "./control-mcp-machine-load.js";
import {
  compactMessages,
  environmentSummary,
  nativeTab,
  paneTabs,
  type ControlMcpInvoker,
} from "./control-shared-actions.js";

/**
 * Cross-node coordinator tools (docs/architecture/command-nodes.md,
 * "Coordinators"). A coordinator on a command node can:
 * - list the connected nodes, each machine's version, OS and load;
 * - read a file, diff and test results of an environment on another node;
 * - ask the user to delete an environment.
 *
 * Everything else a coordinator does on another node goes through the
 * ordinary tools with nodeId (launch_environment, start_environment,
 * send_prompt_to_tab, send_message and the reads), which `createNodeTargets`
 * below routes. It never deletes one itself: the
 *   request waits for the user's explicit confirmation naming the node and
 *   the environment.
 *
 * Each node's copy of the coordinator's project is matched by repository
 * identity. In leaf mode every tool here refuses: coordination belongs to
 * the command node above.
 */

type JsonRecord = Record<string, unknown>;

export interface NodeToolScope {
  projectId: string;
  coordinatorId: string;
  conversationId: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function result(value: JsonRecord) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const MAX_TRANSCRIPT_MESSAGES = 100;

const nodeIdSchema = describe(str({ trim: true, min: 1, max: 200 }), "A nodeId from list_nodes.");

export class LeafModeError extends Error {
  constructor(controllers: string) {
    super(
      `This node is in leaf mode, controlled by ${controllers}. Cross-node tools are unavailable here; coordination happens on ${controllers}. Handle requests as an agent on this node.`,
    );
    this.name = "LeafModeError";
  }
}

/**
 * Resolves the nodes a coordinator acts on: its own node's status, its
 * project's repository identity, one node's copy of the project with a routed
 * invoker, and the conversation's mailbox where that node's reports go.
 */
export function createNodeTargets(invoke: ControlMcpInvoker, scope: NodeToolScope) {
  const status = async (): Promise<NodeStatus> => {
    const value = await invoke<NodeStatus>("get_node_status");
    if (value.mode === "leaf") {
      throw new LeafModeError(value.controllers.map((entry) => entry.displayName).join(", "));
    }
    return value;
  };

  const ownRepository = async (): Promise<string | undefined> => {
    const projects = await invoke<unknown>("get_projects");
    const project = (Array.isArray(projects) ? projects : []).find(
      (entry) => isRecord(entry) && entry.id === scope.projectId,
    ) as JsonRecord | undefined;
    return repositoryHint(project?.gitUrl);
  };

  /**
   * One node's copy of this coordinator's project, and a routed invoker for
   * it; `null` when `nodeId` is this node.
   */
  const targetOrSelf = async (nodeId: string) => {
    const self = await status();
    if (nodeId === self.nodeId) return null;
    const summaries = await invoke<NodeSummariesResult>("get_node_summaries", {
      nodeIds: [nodeId],
    });
    const node = summaries.nodes[0];
    if (!node) throw new Error(`No connected node has ID ${nodeId}. Call list_nodes.`);
    if (!node.available) {
      throw new Error(offlineLaunchMessage(node.view.displayName));
    }
    const hint = await ownRepository();
    const project = hint ? node.projects.find((entry) => entry.repositoryHint === hint) : undefined;
    if (!project) {
      throw new Error(
        `${node.view.displayName} has no copy of this project. Ask the user before creating one there (request_project_on_node).`,
      );
    }
    const call = async <T>(
      command: string,
      args: JsonRecord = {},
      requestKey?: string,
    ): Promise<T> => {
      const routed = await invoke<{ outcome: string; result?: T; requestKey?: string }>(
        "invoke_on_node",
        {
          nodeId,
          command,
          args,
          ...(requestKey ? { requestKey } : {}),
        },
      );
      if (routed.outcome !== "ok") {
        throw new Error(
          `The connection to ${node.view.displayName} was lost before it answered ${command}. Its outcome is unknown and it was not resent; check the environment before trying again.`,
        );
      }
      return routed.result as T;
    };
    const environment = async (environmentId: string): Promise<JsonRecord> => {
      const value = await call<unknown>("get_environment", { environmentId });
      if (!isRecord(value) || value.projectId !== project.ref.projectId) {
        throw new Error("That environment does not belong to this project on that node.");
      }
      if (value.projectHome === true) {
        throw new Error("The node's project checkout is not a worker environment.");
      }
      return value;
    };
    return {
      self,
      node,
      nodeId,
      nodeName: node.view.displayName,
      projectId: project.ref.projectId,
      call,
      /** The same routed calls, shaped as the local invoker. */
      invoke: (<T>(command: string, args?: JsonRecord) =>
        call<T>(command, args)) as ControlMcpInvoker,
      environment,
    };
  };

  const nodeTarget = async (nodeId: string) => {
    const target = await targetOrSelf(nodeId);
    if (!target) {
      throw new Error(
        "That is this node; use the ordinary tools (list_environments, launch_environment…).",
      );
    }
    return target;
  };

  /** This conversation's mailbox on the command node, where leaf replies go. */
  const mailbox = async () => {
    const snapshot = await invoke<unknown>("get_project_coordinator", {
      projectId: scope.projectId,
    });
    const workspace =
      isRecord(snapshot) && isRecord(snapshot.workspace) ? snapshot.workspace : null;
    const conversation = (
      Array.isArray(workspace?.conversations) ? workspace.conversations : []
    ).find((entry) => isRecord(entry) && entry.id === scope.conversationId) as
      JsonRecord | undefined;
    if (!conversation || typeof conversation.tabId !== "string") {
      throw new Error("This coordinator conversation has no mailbox.");
    }
    return {
      coordinatorEnvironmentId: coordinatorRuntimeId(scope.coordinatorId, scope.conversationId),
      coordinatorTabId: conversation.tabId,
    };
  };

  return { status, ownRepository, targetOrSelf, nodeTarget, mailbox };
}

export type NodeTarget = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createNodeTargets>["targetOrSelf"]>>
>;

export function registerNodeTools(
  server: McpServer,
  invoke: ControlMcpInvoker,
  scope: NodeToolScope,
  options: { machineLoadTimeoutMs?: number } = {},
): void {
  const { status, ownRepository, nodeTarget, mailbox } = createNodeTargets(invoke, scope);

  server.registerTool(
    "list_nodes",
    {
      title: "List connected nodes",
      description:
        "This command node and the nodes it controls, with availability, mode, version, buildCommit, whether each has a copy of this project, and in machine its OS, size and average CPU and RAM percent over 5 minutes, 1 hour and 24 hours. version is the Orkestrator version the machine is running now, from its current connection; null means the node is not connected (disconnected, disabled or reconnecting), so its version is unknown, not that it is old. Builds can share a version number and hold different code, so a version alone does not prove a specific fix is on that machine. buildCommit is the Git commit the machine's running backend was built from. null means that commit is unknown: the node is not connected, runs an Orkestrator that does not report one, or runs a development, test or modified build. It does not mean a fix is missing. coveredSeconds below windowSeconds means that average rests on less history than its window. status unavailable means the load is unknown, not that the machine is idle.",
      inputSchema: toolInput(Schema.Struct({})),
      annotations: READ,
    },
    async () => {
      const self = await status();
      const [summaries, hint, ownMachine] = await Promise.all([
        invoke<NodeSummariesResult>("get_node_summaries"),
        ownRepository(),
        readOwnMachineLoad(invoke),
      ]);
      const nodes = await Promise.all(
        summaries.nodes.map(async (node) => ({
          nodeId: node.nodeId,
          name: node.view.displayName,
          available: node.available,
          state: node.view.connection.state,
          mode: node.view.connection.remoteMode ?? null,
          version: node.version ?? null,
          buildCommit: node.buildCommit ?? null,
          hasProject: Boolean(
            hint && node.projects.some((project) => project.repositoryHint === hint),
          ),
          machine: await readNodeMachineLoad(
            invoke,
            { nodeId: node.nodeId, name: node.view.displayName, available: node.available },
            options.machineLoadTimeoutMs,
          ),
        })),
      );
      return result({
        self: {
          nodeId: self.nodeId,
          mode: self.mode,
          version: APP_VERSION,
          buildCommit: BUILD_COMMIT,
          machine: ownMachine,
        },
        nodes,
        total: nodes.length,
      });
    },
  );

  server.registerTool(
    "read_node_environment",
    {
      title: "Read an environment on a connected node",
      description:
        "Read a text file (include file, with path) of an environment on another node, with its state and tabs; include diff and tests add its Git status and diff and its build pipeline results. Read-only. For state, tabs and transcripts use get_environment, list_tabs, get_tab_state and get_tab_transcript with nodeId; for a worker's changes, get_worker_changes with nodeId.",
      inputSchema: toolInput(
        Schema.Struct({
          nodeId: nodeIdSchema,
          environmentId: str({ trim: true, min: 1, max: 200 }),
          tabId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          limit: withDefault(int({ min: 1, max: MAX_TRANSCRIPT_MESSAGES }), 30),
          include: Schema.optionalKey(list(Schema.Literals(["diff", "file", "tests"]), { max: 3 })),
          path: Schema.optionalKey(
            describe(str({ trim: true, min: 1, max: 1024 }), "The file to read with include file."),
          ),
        }),
      ),
      annotations: READ,
    },
    async ({ nodeId, environmentId, tabId, limit, include, path }) => {
      const target = await nodeTarget(nodeId);
      const environment = await target.environment(environmentId);
      const layout = await target.call<unknown>("get_pane_layout", { environmentId });
      const tabs = paneTabs(layout);
      const details = include?.length
        ? await target.call<JsonRecord>("read_environment_details", {
            environmentId,
            include,
            ...(path ? { path } : {}),
          })
        : null;
      const base = {
        nodeId,
        node: target.nodeName,
        environment: environmentSummary(environment),
        tabs,
        ...(details ? { details } : {}),
      };
      if (!tabId) return result(base);
      const native = nativeTab(layout, tabId);
      if (!native)
        return result({ ...base, tabId, transcript: null, note: "Not a native agent tab." });
      const projection = await target.call<unknown>("get_native_agent_projection", {
        environmentId,
        agent: native.agent,
        logicalSessionKey: `env-${environmentId}:${tabId}`,
        messageLimit: limit,
      });
      const messages =
        isRecord(projection) && Array.isArray(projection.messages) ? projection.messages : [];
      return result({ ...base, tabId, agent: native.agent, ...compactMessages(messages) });
    },
  );

  server.registerTool(
    "request_environment_deletion",
    {
      title: "Ask the user to confirm deleting an environment",
      description:
        "Only when the user asked you to delete an environment: create a deletion request the user confirms in Orkestrator, naming the node and the environment. Never call this on your own initiative. Nothing is deleted until the user approves; you are told the outcome by mail.",
      inputSchema: toolInput(
        Schema.Struct({
          nodeId: describe(
            nodeIdSchema,
            "The environment's node; use this node's ID from list_nodes for a local one.",
          ),
          environmentId: str({ trim: true, min: 1, max: 200 }),
          reason: describe(
            str({ trim: true, min: 1, max: 500 }),
            "What the user asked, in their words.",
          ),
        }),
      ),
      annotations: WRITE,
    },
    async ({ nodeId, environmentId, reason }) => {
      const self = await status();
      let nodeName: string;
      let environmentName: string;
      if (nodeId === self.nodeId) {
        const environment = await invoke<unknown>("get_environment", { environmentId });
        if (!isRecord(environment) || environment.projectId !== scope.projectId) {
          throw new Error("That environment does not belong to this project.");
        }
        if (environment.projectHome === true)
          throw new Error("The project checkout cannot be deleted.");
        nodeName = "this node";
        environmentName = typeof environment.name === "string" ? environment.name : environmentId;
      } else {
        const target = await nodeTarget(nodeId);
        const environment = await target.environment(environmentId);
        nodeName = target.nodeName;
        environmentName = typeof environment.name === "string" ? environment.name : environmentId;
      }
      const request = await invoke<JsonRecord>("create_node_action_request", {
        kind: "delete-environment",
        targets: [{ nodeId, nodeName, environmentId, environmentName }],
        requestedBy: { ...(await mailbox()), projectId: scope.projectId },
        reason,
      });
      return result({
        requestId: request.requestId,
        state: "pending",
        note: `Waiting for the user to confirm deleting “${environmentName}” on ${nodeName}. Nothing has been deleted.`,
      });
    },
  );
}

/**
 * Node tools and the capability each needs (mirrors the coordinator capability map).
 *
 * The older `*_node_*` forms of list_environments, launch_environment,
 * start_environment, stop_environment, send_prompt_to_tab and send_message
 * were removed: those tools take nodeId and do more (they validate the
 * selection, check outstanding delegations and carry the async contract).
 * `read_node_environment` stays for the one thing no nodeId tool reads, a
 * file in another node's environment. See `RETIRED_COORDINATOR_TOOLS`.
 */
export const NODE_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ["list_nodes", "discovery"],
  ["read_node_environment", "environments"],
  ["request_environment_deletion", "environments"],
];
