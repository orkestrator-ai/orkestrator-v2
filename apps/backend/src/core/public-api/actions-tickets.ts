import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import type {
  PublicTicketDetail,
  PublicTicketSummary,
} from "@orkestrator/protocol/public-api-resources";
import type { KanbanTask } from "../storage-shared-core.js";
import { paginate, requireProject } from "./actions-discovery.js";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  oneOf,
  onlyActionKeys,
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
  };
}

function publicTicketDetail(task: KanbanTask): PublicTicketDetail {
  return {
    ...publicTicketSummary(task),
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    comments: task.comments.slice(-50).map((comment) => ({
      id: comment.id,
      text: comment.text,
      createdAt: comment.createdAt,
    })),
  };
}

async function requireTicket(
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

const ticketList: ReadActionHandler<{
  projectId: string;
  status?: TicketStatus;
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
      limit: optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.pageMaxItems),
      cursor: optionalString(input, "cursor", 512),
    };
  },
  async run(input, context) {
    await requireProject(context, input.projectId);
    const tickets = (await context.command.storage.kanban.getKanbanTasks(input.projectId))
      .filter((task) => !input.status || task.status === input.status)
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
    return {
      result: publicTicketDetail(await requireTicket(context, input.projectId, input.ticketId)),
    };
  },
};

interface CreateInput {
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: TicketStatus;
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
  set: { title?: string; description?: string; acceptanceCriteria?: string; status?: TicketStatus };
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

export const TICKET_HANDLERS: PublicActionHandler[] = [
  ticketList,
  ticketGet,
  ticketCreate,
  ticketUpdate,
  ticketComment,
];
