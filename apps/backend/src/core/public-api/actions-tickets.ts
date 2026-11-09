import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import type {
  PublicTicketDetail,
  PublicTicketSummary,
} from "@orkestrator/protocol/public-api-resources";
import {
  normalizeTicketLabelName,
  normalizeTicketLabels,
  ticketLabelKey,
  TICKET_LABEL_LIMITS,
} from "@orkestrator/protocol/ticket-labels";
import {
  isTicketKind,
  parseTicketSectionsPatch,
  ticketCriteriaSummary,
  TICKET_KINDS,
  type TicketKind,
  type TicketSectionsPatch,
} from "@orkestrator/protocol/ticket-sections";
import { criteriaEnvironmentHead } from "../ticket-criteria-head.js";
import type { KanbanTask } from "../storage-shared-core.js";
import { parseKanbanLabelInput } from "../storage-kanban-labels.js";
import { paginate, requireProject } from "./actions-discovery.js";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  oneOf,
  onlyActionKeys,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requiredId,
  requiredString,
} from "./input.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Kanban tickets. The same storage paths the board and Control MCP use; each
 * mutation passes its operation ID as the store's own request key, so a
 * retried admission can never create a second ticket or comment. Receipts
 * carry the ticket ID only; content is returned by `ticket.get`.
 *
 * Labels (`ticket.labels`, `ticket.label`, `ticket.label.create`, and the
 * `labels` field of create and update) follow
 * `@orkestrator/protocol/ticket-labels`: names match ignoring case and keep
 * the spelling the project already uses.
 */

const TICKET_STATUSES = ["backlog", "in-progress", "review", "done"] as const;
type TicketStatus = (typeof TICKET_STATUSES)[number];

export function publicTicketSummary(task: KanbanTask): PublicTicketSummary {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title.slice(0, 500),
    status: task.status,
    order: task.order,
    createdAt: task.createdAt,
    commentCount: task.comments.length,
    imageCount: task.images.length,
    environmentId: task.environmentId ?? null,
    pr: { url: task.prUrl ?? null, state: task.prState ?? null },
    labels: task.labels ?? [],
  };
}

function publicTicketDetail(task: KanbanTask, currentHead?: string): PublicTicketDetail {
  return {
    ...publicTicketSummary(task),
    kind: task.kind ?? "feature",
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    criteria: ticketCriteriaSummary(task.sections, currentHead),
    ...(task.sections?.delivery?.policy ? { deliveryPolicy: task.sections.delivery.policy } : {}),
    comments: task.comments.slice(-50).map((comment) => ({
      id: comment.id,
      text: comment.text,
      createdAt: comment.createdAt,
    })),
  };
}

export async function requireTicket(
  context: PublicActionContext,
  projectId: string,
  ticketId: string,
): Promise<KanbanTask> {
  await requireProject(context, projectId);
  const task = (await context.command.storage.kanban.getKanbanTasks(projectId)).find(
    (candidate) => candidate.id === ticketId,
  );
  if (!task) throw new PublicActionError("not-found", `Ticket not found in project: ${ticketId}`);
  return task;
}

function ticketText(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(`${key} must be a string`);
  if (value.length > 100_000) {
    throw new PublicActionError("input-too-large", `${key} must be at most 100000 characters`);
  }
  return value;
}

/** A label name from `key`, or an invalid-input error saying why not. */
function labelName(input: Record<string, unknown>, key: string): string {
  try {
    return normalizeTicketLabelName(input[key]);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : `${key} is invalid`);
  }
}

/** `labels` of `ticket.create` and `ticket.update`, when given. */
function ticketLabels(input: Record<string, unknown>): { labels?: string[] } {
  if (input.labels === undefined) return {};
  try {
    return { labels: normalizeTicketLabels(input.labels) };
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "labels is invalid");
  }
}

/** The structured content fields shared by `ticket.create` and `ticket.update`. */
function ticketStructure(input: Record<string, unknown>): {
  kind?: TicketKind;
  sections?: TicketSectionsPatch;
} {
  const { kind, sections } = input;
  if (kind !== undefined && !isTicketKind(kind)) {
    throw invalid(`kind must be one of ${TICKET_KINDS.join(", ")}`);
  }
  let patch: TicketSectionsPatch | undefined;
  if (sections !== undefined) {
    try {
      patch = parseTicketSectionsPatch(sections);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : "sections is invalid");
    }
    if (JSON.stringify(patch).length > 400_000) {
      throw new PublicActionError("input-too-large", "sections must be at most 400000 characters");
    }
  }
  return { ...(kind !== undefined ? { kind } : {}), ...(patch ? { sections: patch } : {}) };
}

const ticketList: ReadActionHandler<{
  projectId: string;
  status?: TicketStatus;
  label?: string;
  limit?: number;
  cursor?: string;
}> = {
  kind: "read",
  action: "ticket.list",
  parse(input) {
    onlyActionKeys(input, "ticket.list");
    return {
      projectId: requiredId(input, "projectId"),
      status: oneOf(input, "status", TICKET_STATUSES),
      ...(input.label !== undefined ? { label: labelName(input, "label") } : {}),
      limit: optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.pageMaxItems),
      cursor: optionalString(input, "cursor", 512),
    };
  },
  async run(input, context) {
    await requireProject(context, input.projectId);
    const tickets = (await context.command.storage.kanban.getKanbanTasks(input.projectId))
      .filter((task) => !input.status || task.status === input.status)
      .filter(
        (task) =>
          input.label === undefined ||
          (task.labels ?? []).some((name) => ticketLabelKey(name) === ticketLabelKey(input.label!)),
      )
      .map(publicTicketSummary);
    return { result: paginate(tickets, input) };
  },
};

const ticketGet: ReadActionHandler<{ projectId: string; ticketId: string }> = {
  kind: "read",
  action: "ticket.get",
  parse(input) {
    onlyActionKeys(input, "ticket.get");
    return { projectId: requiredId(input, "projectId"), ticketId: requiredId(input, "ticketId") };
  },
  async run(input, context) {
    const task = await requireTicket(context, input.projectId, input.ticketId);
    const head = await criteriaEnvironmentHead(context.invoke, task);
    return { result: publicTicketDetail(task, head) };
  },
};

interface CreateInput {
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: TicketStatus;
  kind?: TicketKind;
  sections?: TicketSectionsPatch;
  labels?: string[];
}

const ticketCreate: MutationActionHandler<CreateInput> = {
  kind: "mutation",
  action: "ticket.create",
  parse(input) {
    onlyActionKeys(input, "ticket.create");
    const value: CreateInput = {
      projectId: requiredId(input, "projectId"),
      title: requiredString(input, "title", 500).trim(),
      description: ticketText(input, "description") ?? "",
      acceptanceCriteria: ticketText(input, "acceptanceCriteria") ?? "",
      status: oneOf(input, "status", TICKET_STATUSES) ?? "backlog",
      ...ticketStructure(input),
      ...ticketLabels(input),
    };
    return { value, scope: `project:${value.projectId}`, intent: value };
  },
  async prepare(input, context) {
    await requireProject(context, input.projectId);
    return {
      resources: { projectId: input.projectId },
      async execute(operation) {
        const task = await context.command.storage.kanban.addKanbanTask(
          input.projectId,
          input.title,
          input.description,
          {
            acceptanceCriteria: input.acceptanceCriteria,
            status: input.status,
            requestId: operation.operationId,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.sections ? { sections: input.sections } : {}),
            ...(input.labels ? { labels: input.labels } : {}),
          },
        );
        return {
          state: "succeeded",
          result: { ticketId: task.id, projectId: task.projectId, status: task.status },
        };
      },
    };
  },
};

interface UpdateInput {
  projectId: string;
  ticketId: string;
  set: {
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    status?: TicketStatus;
    kind?: TicketKind;
    sections?: TicketSectionsPatch;
    labels?: string[];
  };
}

const ticketUpdate: MutationActionHandler<UpdateInput> = {
  kind: "mutation",
  action: "ticket.update",
  parse(input) {
    onlyActionKeys(input, "ticket.update");
    const projectId = requiredId(input, "projectId");
    const ticketId = requiredId(input, "ticketId");
    const title = optionalString(input, "title", 500)?.trim();
    const description = ticketText(input, "description");
    const acceptanceCriteria = ticketText(input, "acceptanceCriteria");
    const status = oneOf(input, "status", TICKET_STATUSES);
    const set = {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
      ...(status !== undefined ? { status } : {}),
      ...ticketStructure(input),
      ...ticketLabels(input),
    };
    if (Object.keys(set).length === 0) throw invalid("Nothing to change");
    return {
      value: { projectId, ticketId, set },
      scope: `ticket:${projectId}:${ticketId}`,
      intent: set,
    };
  },
  async prepare(input, context) {
    await requireTicket(context, input.projectId, input.ticketId);
    return {
      resources: { projectId: input.projectId },
      async execute() {
        const task = await context.command.storage.kanban.updateKanbanTask(
          input.ticketId,
          input.set,
          input.projectId,
        );
        return {
          state: "succeeded",
          result: { ticketId: task.id, projectId: task.projectId, status: task.status },
        };
      },
    };
  },
};

const ticketComment: MutationActionHandler<{
  projectId: string;
  ticketId: string;
  text: string;
}> = {
  kind: "mutation",
  action: "ticket.comment",
  parse(input) {
    onlyActionKeys(input, "ticket.comment");
    const value = {
      projectId: requiredId(input, "projectId"),
      ticketId: requiredId(input, "ticketId"),
      text: requiredString(input, "text", 20_000),
    };
    return {
      value,
      scope: `ticket:${value.projectId}:${value.ticketId}`,
      intent: { text: value.text },
    };
  },
  async prepare(input, context) {
    await requireTicket(context, input.projectId, input.ticketId);
    return {
      resources: { projectId: input.projectId },
      async execute(operation) {
        const task = await context.command.storage.kanban.addKanbanComment(
          input.ticketId,
          input.text,
          input.projectId,
          operation.operationId,
        );
        return {
          state: "succeeded",
          result: {
            ticketId: task.id,
            projectId: task.projectId,
            commentCount: task.comments.length,
          },
        };
      },
    };
  },
};

const ticketLabelsList: ReadActionHandler<{ projectId: string }> = {
  kind: "read",
  action: "ticket.labels",
  parse(input) {
    onlyActionKeys(input, "ticket.labels");
    return { projectId: requiredId(input, "projectId") };
  },
  async run(input, context) {
    await requireProject(context, input.projectId);
    const labels = await context.command.storage.kanban.getKanbanLabels(input.projectId);
    return { result: { labels, total: labels.length } };
  },
};

const ticketLabel: MutationActionHandler<{
  projectId: string;
  ticketId: string;
  name: string;
  present: boolean;
}> = {
  kind: "mutation",
  action: "ticket.label",
  parse(input) {
    onlyActionKeys(input, "ticket.label");
    const value = {
      projectId: requiredId(input, "projectId"),
      ticketId: requiredId(input, "ticketId"),
      name: labelName(input, "name"),
      present: optionalBoolean(input, "present") ?? true,
    };
    return {
      value,
      scope: `ticket:${value.projectId}:${value.ticketId}`,
      intent: { name: value.name, present: value.present },
    };
  },
  async prepare(input, context) {
    const task = await requireTicket(context, input.projectId, input.ticketId);
    const labels = task.labels ?? [];
    const has = labels.some((name) => ticketLabelKey(name) === ticketLabelKey(input.name));
    if (input.present && !has && labels.length >= TICKET_LABEL_LIMITS.maxPerTicket) {
      throw invalid(`A ticket can have at most ${TICKET_LABEL_LIMITS.maxPerTicket} labels`);
    }
    return {
      resources: { projectId: input.projectId },
      async execute() {
        const updated = await context.command.storage.kanban.setKanbanTaskLabel(
          input.ticketId,
          input.name,
          input.present,
          input.projectId,
        );
        return {
          state: "succeeded",
          result: {
            ticketId: updated.id,
            projectId: updated.projectId,
            labels: updated.labels ?? [],
          },
        };
      },
    };
  },
};

const ticketLabelCreate: MutationActionHandler<{
  projectId: string;
  name: string;
  color?: string;
  description?: string;
}> = {
  kind: "mutation",
  action: "ticket.label.create",
  parse(input) {
    onlyActionKeys(input, "ticket.label.create");
    const projectId = requiredId(input, "projectId");
    let label: ReturnType<typeof parseKanbanLabelInput>;
    try {
      label = parseKanbanLabelInput({
        name: input.name,
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : "The label is invalid");
    }
    const value = { projectId, ...label };
    return { value, scope: `project:${projectId}`, intent: label };
  },
  async prepare(input, context) {
    await requireProject(context, input.projectId);
    const catalogue = (await context.command.storage.kanban.getKanbanLabels(input.projectId))
      .filter((label) => label.createdAt !== undefined)
      .map((label) => ticketLabelKey(label.name));
    if (
      !catalogue.includes(ticketLabelKey(input.name)) &&
      catalogue.length >= TICKET_LABEL_LIMITS.maxCatalogue
    ) {
      throw new PublicActionError(
        "store-capacity",
        `A project can have at most ${TICKET_LABEL_LIMITS.maxCatalogue} labels in its catalogue`,
      );
    }
    return {
      resources: { projectId: input.projectId },
      async execute() {
        const { projectId, ...label } = input;
        const { label: stored, created } = await context.command.storage.kanban.createKanbanLabel(
          projectId,
          label,
        );
        return {
          state: "succeeded",
          result: { projectId, name: stored.name, created },
        };
      },
    };
  },
};

export const TICKET_HANDLERS: PublicActionHandler[] = [
  ticketList,
  ticketGet,
  ticketCreate,
  ticketUpdate,
  ticketComment,
  ticketLabelsList,
  ticketLabel,
  ticketLabelCreate,
];
