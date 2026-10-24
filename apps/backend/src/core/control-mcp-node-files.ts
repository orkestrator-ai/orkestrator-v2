import type { McpServer } from "@modelcontextprotocol/server";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { NodeStatus } from "@orkestrator/protocol/command-nodes";
import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import { z } from "zod";

import { LeafModeError, type NodeToolScope } from "./control-mcp-nodes.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

/**
 * Coordinator file tools across nodes (docs/architecture/command-nodes.md,
 * "Coordinators" and "Projects on leaf nodes"):
 * - `transfer_files` copies files between environments or project roots on
 *   any connected nodes; the result is a receipt, never content;
 * - `compare_project_files` shows how each node's `.env` and selected files
 *   differ from this node's, by fingerprint (values never shown);
 * - `request_project_file_update`, `request_env_value_reveal` and
 *   `request_project_on_node` only create requests the user approves.
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function result(value: JsonRecord) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const pathSchema = z.string().trim().min(1).max(1024);
const nodeIdSchema = z.string().trim().min(1).max(200);
const endpointSchema = z.object({
  nodeId: nodeIdSchema.describe("A nodeId from list_nodes (this node's own ID for local files)."),
  environmentId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("An environment's workspace."),
  projectRoot: z
    .boolean()
    .optional()
    .describe("The node's copy of this project instead of an environment."),
});

export function registerNodeFileTools(
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

  const ownHint = async () => {
    const projects = await invoke<unknown>("get_projects");
    const project = (Array.isArray(projects) ? projects : []).find(
      (entry) => isRecord(entry) && entry.id === scope.projectId,
    ) as JsonRecord | undefined;
    return repositoryHint(project?.gitUrl);
  };

  /** This project's copy on a node: its ID there, and the node's name. */
  const projectOn = async (nodeId: string, self: NodeStatus) => {
    if (nodeId === self.nodeId) return { projectId: scope.projectId, nodeName: "this node" };
    const summaries = await invoke<NodeSummariesResult>("get_node_summaries", {
      nodeIds: [nodeId],
    });
    const node = summaries.nodes[0];
    if (!node) throw new Error(`No connected node has ID ${nodeId}.`);
    const hint = await ownHint();
    const project = hint ? node.projects.find((entry) => entry.repositoryHint === hint) : undefined;
    return {
      projectId: project?.ref.projectId ?? null,
      nodeName: node.view.displayName,
      available: node.available,
    };
  };

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
      projectId: scope.projectId,
    };
  };

  const endpoint = async (
    input: z.infer<typeof endpointSchema>,
    self: NodeStatus,
    destination = false,
  ) => {
    const project = await projectOn(input.nodeId, self);
    if (!project.projectId) throw new Error("That node has no copy of this project.");
    if (input.projectRoot) {
      if (destination)
        throw new Error("Project checkout updates require request_project_file_update approval.");
      return { nodeId: input.nodeId, scope: { projectId: project.projectId } };
    }
    if (!input.environmentId) throw new Error("Name an environmentId, or set projectRoot.");
    const environment =
      input.nodeId === self.nodeId
        ? await invoke<unknown>("get_environment", { environmentId: input.environmentId })
        : (
            await invoke<NodeSummariesResult>("get_node_summaries", { nodeIds: [input.nodeId] })
          ).nodes
            .find((node) => node.nodeId === input.nodeId)
            ?.environments.find((entry) => entry.ref.environmentId === input.environmentId);
    if (
      !isRecord(environment) ||
      environment.projectId !== project.projectId ||
      environment.projectHome === true ||
      environment.isProjectHome === true
    ) {
      throw new Error("Coordinator credential cannot access that environment or project home.");
    }
    return { nodeId: input.nodeId, scope: { environmentId: input.environmentId } };
  };

  server.registerTool(
    "transfer_files",
    {
      title: "Transfer files between nodes",
      description:
        "Copy files between environments (or project roots) on this node and connected nodes. Content moves backend to backend and is never shown to you; the result is a receipt with sizes and hashes. Existing files are kept unless overwrite is true.",
      inputSchema: z.object({
        from: endpointSchema,
        to: endpointSchema,
        files: z.array(pathSchema).min(1).max(1000),
        toDirectory: pathSchema.optional(),
        overwrite: z.boolean().default(false),
      }),
      annotations: WRITE,
    },
    async (input) => {
      const self = await status();
      const receipt = await invoke<JsonRecord>("transfer_node_files", {
        from: await endpoint(input.from, self),
        to: await endpoint(input.to, self, true),
        files: input.files,
        ...(input.toDirectory ? { toDirectory: input.toDirectory } : {}),
        overwrite: input.overwrite,
        actor: `coordinator ${scope.coordinatorId}`,
      });
      return result({ receipt });
    },
  );

  server.registerTool(
    "compare_project_files",
    {
      title: "Compare project files across nodes",
      description:
        "For each node with this project: which of its .env and selected files are missing, extra, the same or different from this node's, and for .env files which keys were added, removed or changed. Values are compared by fingerprint and never shown.",
      inputSchema: z.object({ nodeIds: z.array(nodeIdSchema).max(64).optional() }),
      annotations: READ,
    },
    async ({ nodeIds }) => {
      await status();
      const comparison = await invoke<JsonRecord>("compare_project_files", {
        projectId: scope.projectId,
        ...(nodeIds ? { nodeIds } : {}),
      });
      return result(comparison);
    },
  );

  server.registerTool(
    "request_project_file_update",
    {
      title: "Ask the user to update project files on nodes",
      description:
        "Ask the user to push this node's version of chosen project files (or only chosen .env keys) to some or all nodes. The user approves a list of nodes and files; the content is copied node to node without passing through you.",
      inputSchema: z.object({
        nodeIds: z.array(nodeIdSchema).min(1).max(64),
        files: z.array(pathSchema).min(1).max(200),
        keys: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
        reason: z.string().trim().min(1).max(500),
      }),
      annotations: { ...WRITE, destructiveHint: false },
    },
    async ({ nodeIds, files, keys, reason }) => {
      const self = await status();
      const targets = [];
      for (const nodeId of nodeIds) {
        const project = await projectOn(nodeId, self);
        if (!project.projectId) throw new Error(`${project.nodeName} has no copy of this project.`);
        targets.push({
          nodeId,
          nodeName: project.nodeName,
          projectId: project.projectId,
          files,
          ...(keys?.length ? { keys } : {}),
        });
      }
      const request = await invoke<JsonRecord>("create_node_action_request", {
        kind: "update-project-files",
        targets,
        requestedBy: await mailbox(),
        reason,
      });
      return result({
        requestId: request.requestId,
        state: "pending",
        note: "Waiting for the user's approval; nothing has changed yet.",
      });
    },
  );

  server.registerTool(
    "request_env_value_reveal",
    {
      title: "Ask the user to show .env values",
      description:
        "Only when the user explicitly asks to see a value in plain text: ask for one or more .env keys from a node. If the user approves, the values arrive in this conversation by mail.",
      inputSchema: z.object({
        nodeId: nodeIdSchema,
        file: pathSchema,
        keys: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
        reason: z.string().trim().min(1).max(500).describe("What the user asked, in their words."),
      }),
      annotations: { ...WRITE, destructiveHint: false },
    },
    async ({ nodeId, file, keys, reason }) => {
      const self = await status();
      const project = await projectOn(nodeId, self);
      if (!project.projectId) throw new Error(`${project.nodeName} has no copy of this project.`);
      const request = await invoke<JsonRecord>("create_node_action_request", {
        kind: "reveal-env-value",
        targets: [
          { nodeId, nodeName: project.nodeName, projectId: project.projectId, files: [file], keys },
        ],
        requestedBy: await mailbox(),
        reason,
      });
      return result({ requestId: request.requestId, state: "pending" });
    },
  );

  server.registerTool(
    "request_project_on_node",
    {
      title: "Ask the user to copy this project to a node",
      description:
        "Ask the user to copy this project to a connected node: a clone of its Git remote, plus the untracked or ignored files the user picks there (the files you suggest are pre-selected; dependency folders such as node_modules are meant to be installed on that node, not copied). Omit location to use that node's default projects folder. The user approves the location and files in Orkestrator; you are told the outcome by mail. Never create a project on a node without this approval.",
      inputSchema: z.object({
        nodeId: nodeIdSchema,
        location: z
          .string()
          .trim()
          .min(1)
          .max(1024)
          .optional()
          .describe("Absolute directory on that node; omit for its default projects folder."),
        files: z
          .array(pathSchema)
          .max(200)
          .optional()
          .describe(
            "Untracked or ignored paths of this project to suggest copying (a directory ends with /), such as .env files.",
          ),
        reason: z.string().trim().min(1).max(500),
      }),
      annotations: { ...WRITE, destructiveHint: false },
    },
    async ({ nodeId, location, files, reason }) => {
      const self = await status();
      if (nodeId === self.nodeId) throw new Error("This project already exists on this node.");
      if (location !== undefined && !location.startsWith("/"))
        throw new Error("The location must be an absolute path on that node.");
      for (const file of files ?? []) {
        if (file.startsWith("/") || file.split("/").includes(".."))
          throw new Error("Files are paths inside this project.");
      }
      const projects = await invoke<unknown>("get_projects");
      const project = (Array.isArray(projects) ? projects : []).find(
        (entry) => isRecord(entry) && entry.id === scope.projectId,
      ) as JsonRecord | undefined;
      if (typeof project?.gitUrl !== "string" || !project.gitUrl) {
        throw new Error("This project has no Git remote to clone from.");
      }
      const existing = await projectOn(nodeId, self);
      if (existing.projectId) throw new Error(`${existing.nodeName} already has this project.`);
      const request = await invoke<JsonRecord>("create_node_action_request", {
        kind: "create-project",
        targets: [
          {
            nodeId,
            nodeName: existing.nodeName,
            gitRemote: project.gitUrl,
            projectName: typeof project.name === "string" ? project.name : undefined,
            ...(location ? { location } : {}),
            ...(files?.length ? { files } : {}),
          },
        ],
        requestedBy: await mailbox(),
        reason,
      });
      return result({ requestId: request.requestId, state: "pending" });
    },
  );
}

export const NODE_FILE_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ["transfer_files", "environments"],
  ["compare_project_files", "discovery"],
  ["request_project_file_update", "environments"],
  ["request_env_value_reveal", "environments"],
  ["request_project_on_node", "environments"],
];
