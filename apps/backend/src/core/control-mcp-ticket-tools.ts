/** The shared ticket tools, on this node's board or, for a coordinator, another node's. */
import type { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { normalizeTicketLabelName, ticketLabelKey } from "@orkestrator/protocol/ticket-labels";
import { isCriterionCommit } from "@orkestrator/protocol/ticket-sections";
import { describe, refine, str, toolInput, withDefault } from "./tool-schema.js";
import {
  ticketKindField,
  ticketLabelColorField,
  ticketLabelDescriptionField,
  ticketLabelNameField,
  ticketLabelsField,
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
  operatorCreateTicketLabel,
  operatorGetTicket,
  operatorListTicketLabels,
  operatorListTickets,
  operatorSetTicketLabel,
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
    labels: Array.isArray(task.labels) ? task.labels : [],
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

function ticketDetail(task: JsonRecord, environmentHead?: string): JsonRecord {
  return {
    ...ticketSummary(task),
    ...ticketStructuredOutput(
      task as Parameters<typeof ticketStructuredOutput>[0],
      environmentHead,
    ),
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    comments: Array.isArray(task.comments) ? task.comments.slice(-50) : [],
  };
}

/** How long `get_ticket` waits for the build environment's HEAD before answering without it. */
const CRITERIA_HEAD_TIMEOUT_MS = 5_000;

/**
 * The HEAD of the ticket's build environment, when a recorded Verify check
 * names a commit to compare it with. Best effort: a deleted, stopped or slow
 * environment answers undefined, and the criteria then show their commit
 * with no claim either way about the current code.
 */
async function criteriaEnvironmentHead(
  invoke: ControlMcpToolContext["invoke"],
  task: JsonRecord,
): Promise<string | undefined> {
  const environmentId = typeof task.environmentId === "string" ? task.environmentId : "";
  if (!environmentId || !hasRecordedCommit(task)) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      invoke<{ head?: unknown }>("get_environment_uncommitted_paths", { environmentId }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CRITERIA_HEAD_TIMEOUT_MS);
      }),
    ]);
    const head = isRecord(result) && typeof result.head === "string" ? result.head : "";
    return isCriterionCommit(head.toLowerCase()) ? head.toLowerCase() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function hasRecordedCommit(task: JsonRecord): boolean {
  const sections = isRecord(task.sections) ? task.sections : null;
  const criteria =
    sections && Array.isArray(sections.acceptanceCriteria) ? sections.acceptanceCriteria : [];
  return criteria.some(
    (criterion) =>
      isRecord(criterion) && isRecord(criterion.check) && isCriterionCommit(criterion.check.commit),
  );
}

/**
 * `list_tickets`, `get_ticket`, `create_ticket`, `update_ticket`,
 * `add_ticket_comment`, and the label tools `list_ticket_labels`,
 * `create_ticket_label` and `set_ticket_label`.
 */
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
      inputSchema: toolInput(
        Schema.Struct({
          projectId: str({ trim: true, min: 1, max: 200 }),
          status: Schema.optionalKey(Schema.Literals(["backlog", "in-progress", "review", "done"])),
          label: Schema.optionalKey(
            describe(ticketLabelNameField, "Only tickets with this label."),
          ),
          nodeId: nodeIdField,
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ projectId, status, label, nodeId }) => {
      if (operator)
        return operatorListTickets(callerOnNode(operator, nodeId), {
          projectId,
          ...(status ? { status } : {}),
          ...(label ? { label } : {}),
        });
      const remote = await nodeTickets(nodeId, projectId, "list", {});
      const tasks = asArray(
        remote ? remote.tickets : await invoke("get_kanban_tasks", { projectId }),
      )
        .filter((task) => !status || task.status === status)
        .filter((task) => !label || hasLabel(task, label))
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
        "Read one ticket after verifying it belongs to the selected project. Ticket ids are the same on every machine that syncs this board; with nodeId, read that machine's copy. A criterion Verify checked says in judged which commit it was judged on and whether the branch has moved since.",
      inputSchema: toolInput(
        Schema.Struct({
          projectId: str({ trim: true, min: 1, max: 200 }),
          ticketId: str({ trim: true, min: 1, max: 200 }),
          nodeId: nodeIdField,
        }),
      ),
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
      // Another machine's environment cannot be read from here; its criteria
      // still name their commit, just without the comparison.
      const head = remote ? undefined : await criteriaEnvironmentHead(invoke, task);
      return toolResult({
        ticket: ticketDetail(task, head),
        ...(remote ? nodeTicketTag(remote) : {}),
      });
    },
  );

  server.registerTool(
    "create_ticket",
    {
      title: "Create a Kanban ticket",
      description:
        "Create a ticket in one configured project. Give either sections (structured) or description and acceptanceCriteria (plain text); both forms are kept in step. " +
        "With nodeId, the ticket is created on this board and synced to that machine (now, or when it reconnects: sync.state says which), so start_build_pipeline with the same nodeId can build it by this id. A machine too old to sync gets a ticket of its own instead (sync.state update-required).",
      inputSchema: toolInput(
        Schema.Struct({
          requestId: str({ trim: true, min: 1, max: 256 }),
          projectId: str({ trim: true, min: 1, max: 200 }),
          title: str({ trim: true, min: 1, max: 500 }),
          kind: ticketKindField,
          sections: ticketSectionsField,
          description: withDefault(str({ max: 100_000 }), ""),
          acceptanceCriteria: withDefault(str({ max: 100_000 }), ""),
          status: withDefault(
            Schema.Literals(["backlog", "in-progress", "review", "done"]),
            "backlog",
          ),
          labels: ticketLabelsField,
          nodeId: nodeIdField,
        }),
      ),
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
      labels,
      nodeId,
    }) => {
      const structured = {
        ...(kind ? { kind } : {}),
        ...(sections ? { sections } : {}),
        ...(labels ? { labels: [...labels] } : {}),
      };
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
      inputSchema: toolInput(
        Schema.Struct({
          requestId: Schema.optionalKey(str({ trim: true, min: 1, max: 256 })),
          projectId: str({ trim: true, min: 1, max: 200 }),
          ticketId: str({ trim: true, min: 1, max: 200 }),
          title: Schema.optionalKey(str({ trim: true, min: 1, max: 500 })),
          kind: ticketKindField,
          sections: ticketSectionsField,
          description: Schema.optionalKey(str({ max: 100_000 })),
          acceptanceCriteria: Schema.optionalKey(str({ max: 100_000 })),
          status: Schema.optionalKey(Schema.Literals(["backlog", "in-progress", "review", "done"])),
          labels: ticketLabelsField,
          nodeId: nodeIdField,
        }).check(
          refine(
            ({ title, kind, sections, description, acceptanceCriteria, status, labels }) =>
              title !== undefined ||
              kind !== undefined ||
              sections !== undefined ||
              description !== undefined ||
              acceptanceCriteria !== undefined ||
              status !== undefined ||
              labels !== undefined,
            "Provide at least one field to update",
          ),
        ),
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
      inputSchema: toolInput(
        Schema.Struct({
          requestId: str({ trim: true, min: 1, max: 256 }),
          projectId: str({ trim: true, min: 1, max: 200 }),
          ticketId: str({ trim: true, min: 1, max: 200 }),
          text: str({ trim: true, min: 1, max: 20_000 }),
          nodeId: nodeIdField,
        }),
      ),
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

  registerTicketLabelTools(server, { invoke, operator });
}

function hasLabel(task: JsonRecord, label: string): boolean {
  const key = ticketLabelKey(normalizeTicketLabelName(label));
  return asLabels(task).some((name) => ticketLabelKey(name) === key);
}

function asLabels(task: JsonRecord): string[] {
  return Array.isArray(task.labels)
    ? task.labels.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * The label tools act on this machine's board, which syncs to every machine
 * with the project; `update_ticket` with `nodeId` and `labels` labels a ticket
 * that exists only on another machine.
 */
function registerTicketLabelTools(
  server: McpServer,
  { invoke, operator }: Pick<ControlMcpToolContext, "invoke" | "operator">,
): void {
  const projectIdField = str({ trim: true, min: 1, max: 200 });
  server.registerTool(
    "list_ticket_labels",
    {
      title: "List Kanban ticket labels",
      description:
        "List the labels a project's tickets can carry: its label catalogue and every label in use, with ticketCount.",
      inputSchema: toolInput(Schema.Struct({ projectId: projectIdField })),
      annotations: readAnnotations(),
    },
    async ({ projectId }) => {
      if (operator) return operatorListTicketLabels(operator, { projectId });
      const project = await invoke<unknown>("get_project", { projectId });
      if (!isRecord(project)) throw new Error(`Project not found: ${projectId}`);
      const labels = asArray(await invoke("get_kanban_labels", { projectId }));
      return toolResult({ labels, total: labels.length });
    },
  );

  server.registerTool(
    "create_ticket_label",
    {
      title: "Create a Kanban ticket label",
      description:
        "Add a label to a project's catalogue so tickets can use it. An existing name (any case) is kept, taking a color or description given here.",
      inputSchema: toolInput(
        Schema.Struct({
          requestId: str({ trim: true, min: 1, max: 256 }),
          projectId: projectIdField,
          name: ticketLabelNameField,
          color: ticketLabelColorField,
          description: ticketLabelDescriptionField,
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId, projectId, name, color, description }) => {
      const label = {
        name,
        ...(color !== undefined ? { color } : {}),
        ...(description !== undefined ? { description } : {}),
      };
      if (operator) return operatorCreateTicketLabel(operator, { requestId, projectId, ...label });
      const project = await invoke<unknown>("get_project", { projectId });
      if (!isRecord(project)) throw new Error(`Project not found: ${projectId}`);
      const result = await invoke<unknown>("create_kanban_label", { projectId, ...label });
      if (!isRecord(result) || !isRecord(result.label)) {
        throw new Error("Label creation returned no label");
      }
      return toolResult({ label: result.label, created: result.created === true });
    },
  );

  server.registerTool(
    "set_ticket_label",
    {
      title: "Add or remove a ticket label",
      description:
        "Add one label to a ticket, or remove it with present false. A name the project already uses keeps its spelling; a new name starts a label.",
      inputSchema: toolInput(
        Schema.Struct({
          requestId: Schema.optionalKey(str({ trim: true, min: 1, max: 256 })),
          projectId: projectIdField,
          ticketId: str({ trim: true, min: 1, max: 200 }),
          name: ticketLabelNameField,
          present: describe(withDefault(Schema.Boolean, true), "False removes the label."),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId, projectId, ticketId, name, present }) => {
      if (operator) {
        return operatorSetTicketLabel(operator, { requestId, projectId, ticketId, name, present });
      }
      const existing = asArray(await invoke("get_kanban_tasks", { projectId })).find(
        (candidate) => candidate.id === ticketId,
      );
      if (!existing) throw new Error(`Kanban ticket not found in project: ${ticketId}`);
      const task = await invoke<unknown>("set_kanban_task_label", {
        taskId: ticketId,
        name,
        present,
        projectId,
      });
      if (!isRecord(task)) throw new Error("Ticket label change returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );
}
