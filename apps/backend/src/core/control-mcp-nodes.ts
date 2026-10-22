import type { McpServer } from "@modelcontextprotocol/server";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { NodeStatus } from "@orkestrator/protocol/command-nodes";
import { repositoryHint, type NodeSummariesResult } from "@orkestrator/protocol/node-summaries";
import { z } from "zod";

import {
  compactMessages,
  environmentSummary,
  launchEnvironmentCreateInput,
  nativeTab,
  paneTabs,
  type ControlMcpInvoker,
} from "./control-shared-actions.js";

/**
 * Cross-node coordinator tools (docs/architecture/command-nodes.md,
 * "Coordinators"). A coordinator on a command node can:
 * - list the connected nodes and their environments for its project;
 * - create environments on a named node (its own node stays the default:
 *   that is launch_environment);
 * - read an environment directly (state, tabs, transcript) and start, stop,
 *   prompt or message it;
 * - ask the user to delete an environment. It never deletes one itself: the
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
const MAX_PROMPT_LENGTH = 100_000;
const MAX_BODY_BYTES = 32 * 1024;

const nodeIdSchema = z.string().trim().min(1).max(200).describe("A nodeId from list_nodes.");

export class LeafModeError extends Error {
  constructor(controllers: string) {
    super(
      `This node is in leaf mode, controlled by ${controllers}. Cross-node tools are unavailable here; coordination happens on ${controllers}. Handle requests as an agent on this node.`,
    );
    this.name = "LeafModeError";
  }
}

export function registerNodeTools(
  server: McpServer,
  invoke: ControlMcpInvoker,
  scope: NodeToolScope,
): void {
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

  /** One node's copy of this coordinator's project, and a routed invoker for it. */
  const nodeTarget = async (nodeId: string) => {
    const self = await status();
    if (nodeId === self.nodeId) {
      throw new Error(
        "That is this node; use the ordinary tools (list_environments, launch_environment…).",
      );
    }
    const summaries = await invoke<NodeSummariesResult>("get_node_summaries", {
      nodeIds: [nodeId],
    });
    const node = summaries.nodes[0];
    if (!node) throw new Error(`No connected node has ID ${nodeId}. Call list_nodes.`);
    if (!node.available) {
      throw new Error(`${node.view.displayName} is not connected; changes to it are disabled.`);
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
      nodeName: node.view.displayName,
      projectId: project.ref.projectId,
      call,
      environment,
    };
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
      | JsonRecord
      | undefined;
    if (!conversation || typeof conversation.tabId !== "string") {
      throw new Error("This coordinator conversation has no mailbox.");
    }
    return {
      coordinatorEnvironmentId: coordinatorRuntimeId(scope.coordinatorId, scope.conversationId),
      coordinatorTabId: conversation.tabId,
    };
  };

  server.registerTool(
    "list_nodes",
    {
      title: "List connected nodes",
      description:
        "This command node and the nodes it controls, with availability, mode and whether each has a copy of this project.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => {
      const self = await status();
      const [summaries, hint] = await Promise.all([
        invoke<NodeSummariesResult>("get_node_summaries"),
        ownRepository(),
      ]);
      const nodes = summaries.nodes.map((node) => ({
        nodeId: node.nodeId,
        name: node.view.displayName,
        available: node.available,
        state: node.view.connection.state,
        mode: node.view.connection.remoteMode ?? null,
        hasProject: Boolean(
          hint && node.projects.some((project) => project.repositoryHint === hint),
        ),
      }));
      return result({ self: { nodeId: self.nodeId, mode: self.mode }, nodes, total: nodes.length });
    },
  );

  server.registerTool(
    "list_node_environments",
    {
      title: "List environments on connected nodes",
      description:
        "Environments of this project on one connected node, or on every connected node when nodeId is omitted. Names, status and agent activity only.",
      inputSchema: z.object({ nodeId: nodeIdSchema.optional() }),
      annotations: READ,
    },
    async ({ nodeId }) => {
      await status();
      const [summaries, hint] = await Promise.all([
        invoke<NodeSummariesResult>("get_node_summaries", nodeId ? { nodeIds: [nodeId] } : {}),
        ownRepository(),
      ]);
      const nodes = summaries.nodes.map((node) => {
        const project = hint
          ? node.projects.find((entry) => entry.repositoryHint === hint)
          : undefined;
        return {
          nodeId: node.nodeId,
          name: node.view.displayName,
          available: node.available,
          freshness: node.freshness,
          environments: project
            ? node.environments
                .filter(
                  (environment) =>
                    environment.projectId === project.ref.projectId && !environment.isProjectHome,
                )
                .map((environment) => ({
                  environmentId: environment.ref.environmentId,
                  name: environment.name,
                  status: environment.status,
                  activity: environment.activity,
                  ...(environment.branch ? { branch: environment.branch } : {}),
                }))
            : [],
          hasProject: Boolean(project),
        };
      });
      return result({ nodes });
    },
  );

  server.registerTool(
    "read_node_environment",
    {
      title: "Read an environment on a connected node",
      description:
        "Read one environment on another node directly: its state and tabs; with tabId a bounded transcript of that tab; with include its Git status and diff, a text file (path) and its build pipeline (test) results. Read-only.",
      inputSchema: z.object({
        nodeId: nodeIdSchema,
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(MAX_TRANSCRIPT_MESSAGES).default(30),
        include: z
          .array(z.enum(["diff", "file", "tests"]))
          .max(3)
          .optional(),
        path: z
          .string()
          .trim()
          .min(1)
          .max(1024)
          .optional()
          .describe("The file to read with include file."),
      }),
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
    "launch_node_environment",
    {
      title: "Launch an environment on a connected node",
      description:
        "Create and start an agent environment on another node, for this project. Use only when the user asks for another node; launch_environment (this node) is the default. The worker reports back to you by mail.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        nodeId: nodeIdSchema,
        environmentType: z.enum(["local", "containerized"]).default("local"),
        name: z.string().trim().min(1).max(200).optional(),
        agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
        modelId: z.string().trim().min(1).max(500).optional(),
        reasoningId: z.string().trim().min(1).max(100).optional(),
        conversationMode: z.enum(["plan", "build"]).default("build"),
        prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
        baseBranch: z.string().trim().min(1).max(500),
        baseCommit: z.string().regex(/^[0-9a-f]{40}$/i),
      }),
      annotations: { ...WRITE, destructiveHint: true },
    },
    async (input) => {
      const target = await nodeTarget(input.nodeId);
      const createInput = launchEnvironmentCreateInput({
        ...input,
        projectId: target.projectId,
        prompt:
          `${input.prompt}\n\n` +
          `You were started by this project's coordinator on the command node that controls this machine. ` +
          `When your work is done, send exactly one report with send_message to toEnvironmentId "coordinator" (no toTabId needed), then end your turn.`,
      } as never);
      const environment = await target.call<unknown>(
        "create_environment",
        { ...createInput, controlRequestId: `node:${input.requestId}` },
        `launch:${input.requestId}`,
      );
      if (!isRecord(environment) || typeof environment.id !== "string") {
        throw new Error("Environment creation on that node returned no environment.");
      }
      await target.call("record_node_environment_origin", {
        environmentId: environment.id,
        controllerId: target.self.nodeId,
        ...(await mailbox()),
      });
      let startError: string | undefined;
      if (environment.status !== "running" && environment.status !== "creating") {
        try {
          await target.call("start_environment_background", { environmentId: environment.id });
        } catch (error) {
          startError = error instanceof Error ? error.message : "Environment start failed";
        }
      }
      return result({
        nodeId: input.nodeId,
        node: target.nodeName,
        environmentId: environment.id,
        tabId: "startup-agent",
        status: startError ? "created" : "accepted",
        ...(startError ? { error: startError } : {}),
      });
    },
  );

  for (const [tool, command, title] of [
    [
      "start_node_environment",
      "start_environment_background",
      "Start an environment on a connected node",
    ],
    ["stop_node_environment", "stop_environment", "Stop an environment on a connected node"],
  ] as const) {
    server.registerTool(
      tool,
      {
        title,
        description: `${title}. It never deletes anything.`,
        inputSchema: z.object({
          nodeId: nodeIdSchema,
          environmentId: z.string().trim().min(1).max(200),
        }),
        annotations: WRITE,
      },
      async ({ nodeId, environmentId }) => {
        const target = await nodeTarget(nodeId);
        await target.environment(environmentId);
        await target.call(command, { environmentId });
        return result({ nodeId, environmentId, status: "accepted" });
      },
    );
  }

  server.registerTool(
    "send_prompt_to_node_tab",
    {
      title: "Prompt an agent tab on a connected node",
      description: "Send a prompt to an existing agent tab of an environment on another node.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        nodeId: nodeIdSchema,
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200),
        prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
      }),
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ requestId, nodeId, environmentId, tabId, prompt }) => {
      const target = await nodeTarget(nodeId);
      await target.environment(environmentId);
      const layout = await target.call<unknown>("get_pane_layout", { environmentId });
      const native = nativeTab(layout, tabId);
      if (!native) throw new Error(`Native agent tab not found: ${tabId}`);
      const outcome = await target.call<unknown>(
        "dispatch_native_agent_intent",
        {
          environmentId,
          agent: native.agent,
          logicalSessionKey: `env-${environmentId}:${tabId}`,
          requestId,
          prompt,
        },
        `prompt:${requestId}`,
      );
      return result({ nodeId, environmentId, tabId, ...(isRecord(outcome) ? outcome : {}) });
    },
  );

  server.registerTool(
    "send_node_message",
    {
      title: "Message an agent on a connected node",
      description:
        "Send mail to an agent tab of an environment on another node. It arrives as an ordinary incoming message; the agent may change what it is doing and reply to you.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        nodeId: nodeIdSchema,
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200).optional(),
        subject: z.string().trim().max(200).optional(),
        body: z
          .string()
          .min(1)
          .refine(
            (value) => Buffer.byteLength(value, "utf8") <= MAX_BODY_BYTES,
            "body must be at most 32 KiB",
          ),
      }),
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ requestId, nodeId, environmentId, tabId, subject, body }) => {
      const target = await nodeTarget(nodeId);
      await target.environment(environmentId);
      const delivered = await target.call<unknown>(
        "deliver_node_mail",
        {
          controllerId: target.self.nodeId,
          ...(await mailbox()),
          requestId,
          toEnvironmentId: environmentId,
          ...(tabId ? { toTabId: tabId } : {}),
          ...(subject ? { subject } : {}),
          body,
        },
        `mail:${requestId}`,
      );
      return result({ nodeId, environmentId, delivered: isRecord(delivered) ? delivered : true });
    },
  );

  server.registerTool(
    "request_environment_deletion",
    {
      title: "Ask the user to confirm deleting an environment",
      description:
        "Only when the user asked you to delete an environment: create a deletion request the user confirms in Orkestrator, naming the node and the environment. Never call this on your own initiative. Nothing is deleted until the user approves; you are told the outcome by mail.",
      inputSchema: z.object({
        nodeId: nodeIdSchema.describe(
          "The environment's node; use this node's ID from list_nodes for a local one.",
        ),
        environmentId: z.string().trim().min(1).max(200),
        reason: z.string().trim().min(1).max(500).describe("What the user asked, in their words."),
      }),
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

/** Node tools and the capability each needs (mirrors the coordinator capability map). */
export const NODE_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ["list_nodes", "discovery"],
  ["list_node_environments", "environments"],
  ["read_node_environment", "environments"],
  ["launch_node_environment", "environments"],
  ["start_node_environment", "environments"],
  ["stop_node_environment", "environments"],
  ["send_prompt_to_node_tab", "jobs"],
  ["send_node_message", "mail"],
  ["request_environment_deletion", "environments"],
];
