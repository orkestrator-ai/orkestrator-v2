/** The shared ticket tools, on this node's board or, for a coordinator, another node's. */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ticketKindField,
  ticketSectionsField,
  ticketStructuredOutput,
} from "./ticket-tool-fields.js";
import { onNode as callerOnNode } from "./control-mcp-caller.js";
import {
  asArray,
  isRecord,
  nodeIdField,
  readAnnotations,
  toolResult,
  type JsonRecord,
} from "./control-mcp-tool-support.js";
import {
  operatorAddTicketComment,
  operatorCreateTicket,
  operatorGetTicket,
  operatorListTickets,
  operatorUpdateTicket,
} from "./control-mcp-operator-tools.js";
import type { ControlMcpToolContext } from "./control-mcp-tools-shared.js";

function ticketSummary(task: JsonRecord): JsonRecord {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    order: task.order,
    createdAt: task.createdAt,
    commentCount: Array.isArray(task.comments) ? task.comments.length : 0,
    imageCount: Array.isArray(task.images) ? task.images.length : 0,
    environmentId: task.environmentId,
    prUrl: task.prUrl,
    prState: task.prState,
    ...ticketSyncSummary(task),
  };
}

/** Whether a ticket is a copy of a command node's, and which machine its work runs on. */
function ticketSyncSummary(task: JsonRecord): JsonRecord {
  const sync = isRecord(task.sync) ? task.sync : null;
  const work = sync && isRecord(sync.work) ? sync.work : null;
  return {
    ...(sync && isRecord(sync.replica) ? { syncedFromCommandNode: true } : {}),
    ...(work
      ? {
          runsOn: {
            nodeId: work.nodeId,
            node: work.nodeName,
            ...(work.buildPipelineId ? { pipelineId: work.buildPipelineId } : {}),
            ...(work.environmentId ? { environmentId: work.environmentId } : {}),
            ...(work.prUrl ? { prUrl: work.prUrl } : {}),
          },
        }
      : {}),
  };
}

/** A node-qualified ticket answer: the node, whether the ticket syncs, and its sync state. */
function nodeTicketTag(result: JsonRecord): JsonRecord {
  return {
    nodeId: result.nodeId,
    node: result.node,
    ...(typeof result.synced === "boolean" ? { synced: result.synced } : {}),
    ...(isRecord(result.sync) ? { sync: result.sync } : {}),
    ...(typeof result.note === "string" ? { note: result.note } : {}),
  };
}

function ticketDetail(task: JsonRecord): JsonRecord {
  return {
    ...ticketSummary(task),
    ...ticketStructuredOutput(task as Parameters<typeof ticketStructuredOutput>[0]),
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    comments: Array.isArray(task.comments) ? task.comments.slice(-50) : [],
  };
}

/** `list_tickets`, `get_ticket`, `create_ticket`, `update_ticket` and `add_ticket_comment`. */
export function registerTicketTools(
  server: McpServer,
  { invoke, operator, nodeTickets }: ControlMcpToolContext,
): void {
  server.registerTool(
    "list_tickets",
    {
      title: "List Kanban tickets",
      description:
        "List Kanban tickets for one configured project. With nodeId, list that machine's board: this board's tickets synced there plus any made only there (syncedFromCommandNode marks synced copies). runsOn names the machine a ticket's build or environment runs on.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200),
        status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, status, nodeId }) => {
      if (operator)
        return operatorListTickets(callerOnNode(operator, nodeId), {
          projectId,
          ...(status ? { status } : {}),
        });
      const remote = await nodeTickets(nodeId, projectId, "list", {});
      const tasks = asArray(
        remote ? remote.tickets : await invoke("get_kanban_tasks", { projectId }),
      )
        .filter((task) => !status || task.status === status)
        .map(ticketSummary);
      return toolResult({
        tickets: tasks,
        total: tasks.length,
        ...(remote ? nodeTicketTag(remote) : {}),
      });
    },
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Read a Kanban ticket",
      description:
        "Read one ticket after verifying it belongs to the selected project. Ticket ids are the same on every machine that syncs this board; with nodeId, read that machine's copy.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200),
        ticketId: z.string().trim().min(1).max(200),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, ticketId, nodeId }) => {
      if (operator)
        return operatorGetTicket(callerOnNode(operator, nodeId), { projectId, ticketId });
      const remote = await nodeTickets(nodeId, projectId, "get", {});
      const task = asArray(
        remote ? remote.tickets : await invoke("get_kanban_tasks", { projectId }),
      ).find((candidate) => candidate.id === ticketId);
      if (!task) throw new Error(`Kanban ticket not found in project: ${ticketId}`);
      return toolResult({ ticket: ticketDetail(task), ...(remote ? nodeTicketTag(remote) : {}) });
    },
  );

  server.registerTool(
    "create_ticket",
    {
      title: "Create a Kanban ticket",
      description:
        "Create a ticket in one configured project. Give either sections (structured) or description and acceptanceCriteria (plain text); both forms are kept in step. " +
        "With nodeId, the ticket is created on this board and synced to that machine (now, or when it reconnects: sync.state says which), so start_build_pipeline with the same nodeId can build it by this id. A machine too old to sync gets a ticket of its own instead (sync.state update-required).",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        projectId: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(500),
        kind: ticketKindField,
        sections: ticketSectionsField,
        description: z.string().max(100_000).default(""),
        acceptanceCriteria: z.string().max(100_000).default(""),
        status: z.enum(["backlog", "in-progress", "review", "done"]).default("backlog"),
        nodeId: nodeIdField,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      requestId,
      projectId,
      title,
      kind,
      sections,
      description,
      acceptanceCriteria,
      status,
      nodeId,
    }) => {
      const structured = { ...(kind ? { kind } : {}), ...(sections ? { sections } : {}) };
      if (operator) {
        return operatorCreateTicket(callerOnNode(operator, nodeId), {
          requestId,
          projectId,
          title,
          description,
          acceptanceCriteria,
          status,
          ...structured,
        });
      }
      const remote = await nodeTickets(nodeId, projectId, "create", {
        requestId,
        title,
        description,
        acceptanceCriteria,
        status,
        ...structured,
      });
      if (remote) {
        if (!isRecord(remote.ticket)) throw new Error("Kanban ticket creation returned no ticket");
        return toolResult({ ticket: ticketDetail(remote.ticket), ...nodeTicketTag(remote) });
      }
      const project = await invoke<unknown>("get_project", { projectId });
      if (!isRecord(project)) throw new Error(`Project not found: ${projectId}`);
      const task = await invoke<unknown>("add_kanban_task", {
        projectId,
        title,
        description,
        acceptanceCriteria,
        status,
        requestId,
        ...structured,
      });
      if (!isRecord(task)) throw new Error("Kanban ticket creation returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "update_ticket",
    {
      title: "Update a Kanban ticket",
      description:
        "Update specified editable fields of a ticket in one project; sections replaces only the sections it names. Changes to a synced ticket reach every machine with this project; with nodeId the answer also says whether that machine has it yet.",
      inputSchema: z
        .object({
          requestId: z.string().trim().min(1).max(256).optional(),
          projectId: z.string().trim().min(1).max(200),
          ticketId: z.string().trim().min(1).max(200),
          title: z.string().trim().min(1).max(500).optional(),
          kind: ticketKindField,
          sections: ticketSectionsField,
          description: z.string().max(100_000).optional(),
          acceptanceCriteria: z.string().max(100_000).optional(),
          status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
          nodeId: nodeIdField,
        })
        .refine(
          ({ title, kind, sections, description, acceptanceCriteria, status }) =>
            title !== undefined ||
            kind !== undefined ||
            sections !== undefined ||
            description !== undefined ||
            acceptanceCriteria !== undefined ||
            status !== undefined,
          "Provide at least one field to update",
        ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectId, ticketId, requestId, ...fields }) => {
      const { nodeId, ...updates } = fields;
      if (operator)
        return operatorUpdateTicket(callerOnNode(operator, nodeId), {
          projectId,
          ticketId,
          requestId,
          ...updates,
        });
      const remote = await nodeTickets(nodeId, projectId, "update", {
        ticketId,
        ...(requestId ? { requestId } : {}),
        ...updates,
      });
      if (remote) {
        if (!isRecord(remote.ticket)) throw new Error("Kanban ticket update returned no ticket");
        return toolResult({ ticket: ticketDetail(remote.ticket), ...nodeTicketTag(remote) });
      }
      const existing = asArray(await invoke("get_kanban_tasks", { projectId })).find(
        (candidate) => candidate.id === ticketId,
      );
      if (!existing) throw new Error(`Kanban ticket not found in project: ${ticketId}`);
      const task = await invoke<unknown>("update_kanban_task", { taskId: ticketId, ...updates });
      if (!isRecord(task)) throw new Error("Kanban ticket update returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "add_ticket_comment",
    {
      title: "Add a Kanban ticket comment",
      description:
        "Append a durable comment to a ticket in one project. Comments sync with the ticket to every machine with this project.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        projectId: z.string().trim().min(1).max(200),
        ticketId: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(20_000),
        nodeId: nodeIdField,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId, projectId, ticketId, text, nodeId }) => {
      if (operator)
        return operatorAddTicketComment(callerOnNode(operator, nodeId), {
          requestId,
          projectId,
          ticketId,
          text,
        });
      const remote = await nodeTickets(nodeId, projectId, "comment", { ticketId, text, requestId });
      if (remote) {
        if (!isRecord(remote.ticket)) throw new Error("Kanban comment creation returned no ticket");
        return toolResult({ ticket: ticketDetail(remote.ticket), ...nodeTicketTag(remote) });
      }
      const existing = asArray(await invoke("get_kanban_tasks", { projectId })).find(
        (candidate) => candidate.id === ticketId,
      );
      if (!existing) throw new Error(`Kanban ticket not found in project: ${ticketId}`);
      const task = await invoke<unknown>("add_kanban_comment", {
        taskId: ticketId,
        text,
        projectId,
        requestId,
      });
      if (!isRecord(task)) throw new Error("Kanban comment creation returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );
}
