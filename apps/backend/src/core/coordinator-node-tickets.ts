import { isBackendId } from "@orkestrator/protocol/federation";
import {
  normalizeTicketLabels,
  ticketLabelKey,
  isTicketLabelList,
} from "@orkestrator/protocol/ticket-labels";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import {
  olderLeafTicketMessage,
  type TicketSyncNodeState,
} from "@orkestrator/protocol/ticket-sync";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { coordinatorNodeTicketCommand } from "@orkestrator/protocol/contract/domains/ticket-sync";

import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { requireCoordinatorConversation } from "./coordinator-action-scope.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import type { KanbanTask } from "./storage-shared.js";
import { leafSyncsTickets } from "./nodes/index.js";

/**
 * A command node coordinator's ticket tools with a `nodeId`
 * (docs/architecture/coordinator.md, "Tickets on other machines").
 *
 * Tickets live on the command node's board, which every leaf with the same
 * repository syncs (`nodes/node-ticket-sync.ts`). So a ticket "on" a leaf is a
 * ticket on this board: it is created and changed here, and reaches the leaf
 * now when it is connected, or when it reconnects. Reads with a `nodeId` show
 * the leaf's own board, which also holds any tickets made only there.
 *
 * A leaf too old to sync still works as before: its own tickets are read and
 * changed there, a ticket created for it is created there (and stays there),
 * and the answer says to update that machine.
 */

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface TicketNode {
  nodeId: string;
  nodeName: string;
  /** The node's copy of the coordinator's project. */
  projectId: string;
  online: boolean;
  /** It syncs tickets with this board (advertised now, or seen syncing before while offline). */
  syncs: boolean;
  call<T>(command: string, args: JsonRecord, requestKey?: string): Promise<T>;
}

async function ticketNode(
  context: CommandContext,
  projectId: string,
  nodeId: string,
): Promise<TicketNode | null> {
  if (!context.nodePortal || !context.nodes) {
    throw new Error("Cross-node coordination is not available in this backend.");
  }
  const portal = context.nodePortal;
  const status = await context.nodes.status();
  if (status.mode === "leaf") {
    throw new Error(
      "This node is in leaf mode: coordination happens on the command node that controls it.",
    );
  }
  if (nodeId === status.nodeId) return null;
  const node = (await portal.summaries([nodeId])).nodes[0];
  if (!node) throw new Error(`No connected node has ID ${nodeId}. Call list_nodes.`);
  const name = node.view.displayName;
  const hint = repositoryHint((await context.storage.getProject(projectId))?.gitUrl);
  const copy = hint ? node.projects.find((entry) => entry.repositoryHint === hint) : undefined;
  if (!copy) {
    throw new Error(
      `${name} has no copy of this project. Ask the user to copy it there first (request_project_on_node).`,
    );
  }
  const link = isBackendId(nodeId) ? context.nodes.link(nodeId) : null;
  const online = node.available && Boolean(link?.connected);
  // The ticket-sync domain client: version 1 syncs, a pre-contract leaf by its
  // capability. Unknown while offline: keep edits on the authoritative board.
  const syncs = online && link ? leafSyncsTickets(link) : true;
  const call = async <T>(command: string, args: JsonRecord, requestKey?: string): Promise<T> => {
    if (!online) throw new Error(`${name} is not connected; changes to it are disabled.`);
    const routed = await portal
      .invokeOnNode({ nodeId, command, args, ...(requestKey ? { requestKey } : {}) })
      .catch((error: unknown) => {
        if (incompatibility(error, command)?.code === "unknown-command") {
          throw new Error(
            `${name} runs an older Orkestrator that cannot do this yet; update it, then retry.`,
          );
        }
        throw error;
      });
    if (routed.outcome !== "ok") {
      throw Object.assign(
        new Error(
          `The connection to ${name} was lost before it answered ${command}. Its outcome is unknown and it was not resent; read the tickets there before trying again.`,
        ),
        { code: "outcome-unknown" },
      );
    }
    return routed.result as T;
  };
  return { nodeId, nodeName: name, projectId: copy.ref.projectId, online, syncs, call };
}

/** The leaf's state after this board changed, syncing it now when it is connected. */
async function syncState(
  context: CommandContext,
  node: TicketNode,
  projectId: string,
): Promise<Pick<TicketSyncNodeState, "state" | "message">> {
  const service = context.nodeCoordination?.ticketSync;
  if (!node.online || !service) {
    return {
      state: "offline",
      message: `Queued until ${node.nodeName} reconnects: it gets this change then.`,
    };
  }
  const state = await service.syncAndReport(node.nodeId, projectId).catch(() => null);
  if (!state) return { state: "error", message: "The ticket sync did not run; it is retried." };
  return { state: state.state, ...(state.message ? { message: state.message } : {}) };
}

/** Counted: a coordinator used a leaf too old to sync tickets (version-compatibility.md). */
function olderLeaf(node: TicketNode): JsonRecord {
  compatibilityPathUsage.record("ticket-sync.older-node");
  return {
    synced: false,
    sync: {
      state: "update-required",
      message: `${olderLeafTicketMessage(node.nodeName)} Until then its tickets exist only there.`,
    },
  };
}

/** Older commands can accept an unknown field and silently ignore it. Check the answer. */
function labelUpdateWarning(node: TicketNode, input: JsonRecord, ticket: KanbanTask): JsonRecord {
  if (input.labels === undefined) return {};
  const requested = normalizeTicketLabels(input.labels).map(ticketLabelKey);
  const actual = ticket.labels ?? [];
  const matches =
    isTicketLabelList(actual) &&
    actual.length === requested.length &&
    requested.every((key) => actual.some((name) => ticketLabelKey(name) === key));
  if (matches) return {};
  return {
    synced: false,
    sync: {
      state: "update-required",
      message: `${node.nodeName} returned a ticket without the requested labels. Update that machine and read the ticket before retrying; other requested changes may have been applied.`,
    },
  };
}

function offline(node: TicketNode): never {
  throw new Error(
    `${node.nodeName} is not connected, and it cannot sync tickets with this board, so nothing was changed. Retry when it reconnects (list_nodes).`,
  );
}

function belongs(task: KanbanTask | null, projectId: string): task is KanbanTask {
  return Boolean(task) && task!.projectId === projectId && !task!.sync?.replica;
}

function where(node: TicketNode): JsonRecord {
  return { nodeId: node.nodeId, node: node.nodeName };
}

function contentInput(input: JsonRecord): JsonRecord {
  const content: JsonRecord = {};
  for (const key of [
    "title",
    "description",
    "acceptanceCriteria",
    "status",
    "kind",
    "sections",
    "labels",
  ]) {
    if (input[key] !== undefined) content[key] = input[key];
  }
  return content;
}

export function registerCoordinatorNodeTicketCommands(register: CommandRegistrar): void {
  // Lenient keys (`ticket-sync` domain): the handler checks each with its own message.
  register(
    coordinatorNodeTicketCommand,
    async ({ scope, nodeId, action, input }, context) => {
      if (!record(scope)) throw new Error("Coordinator scope is required");
      const projectId = asNonBlankString(scope.projectId, "projectId");
      await requireCoordinatorConversation(
        context,
        projectId,
        asNonBlankString(scope.coordinatorId, "coordinatorId"),
        asNonBlankString(scope.conversationId, "conversationId"),
      );
      const args = record(input) ? input : {};
      const node = await ticketNode(context, projectId, asNonBlankString(nodeId, "nodeId"));
      const kanban = context.storage.kanban;
      if (!node) return { self: true };

      switch (action) {
        case "create": {
          const requestId = asNonBlankString(args.requestId, "requestId");
          const title = asNonBlankString(args.title, "title");
          if (node.syncs) {
            const ticket = await kanban.addKanbanTask(
              projectId,
              title,
              typeof args.description === "string" ? args.description : "",
              {
                requestId,
                ...(typeof args.acceptanceCriteria === "string"
                  ? { acceptanceCriteria: args.acceptanceCriteria }
                  : {}),
                ...(typeof args.status === "string" ? { status: args.status as never } : {}),
                ...(typeof args.kind === "string" ? { kind: args.kind as never } : {}),
                ...(record(args.sections) ? { sections: args.sections as never } : {}),
                ...(Array.isArray(args.labels) ? { labels: args.labels as string[] } : {}),
              },
            );
            return {
              ticket,
              ...where(node),
              synced: true,
              sync: await syncState(context, node, projectId),
            };
          }
          if (!node.online) offline(node);
          const ticket = await node.call<KanbanTask>(
            "add_kanban_task",
            // Every backend's add_kanban_task takes a description, even an empty one.
            { projectId: node.projectId, requestId, description: "", ...contentInput(args) },
            `ticket:${requestId}`,
          );
          return {
            ticket,
            ...where(node),
            ...olderLeaf(node),
            ...labelUpdateWarning(node, args, ticket),
          };
        }
        case "list":
        case "get": {
          if (!node.online) {
            if (!node.syncs) offline(node);
            const tickets = (await kanban.getKanbanTasks(projectId)).filter(
              (task) => !task.sync?.replica,
            );
            const note = `${node.nodeName} is not connected. This is the command node's board, which it catches up with when it reconnects; tickets made only on ${node.nodeName} are not listed.`;
            return { tickets, ...where(node), synced: true, note };
          }
          const tickets = await node.call<KanbanTask[]>("get_kanban_tasks", {
            projectId: node.projectId,
          });
          return {
            tickets: Array.isArray(tickets) ? tickets : [],
            ...where(node),
            ...(node.syncs ? { synced: true } : olderLeaf(node)),
          };
        }
        case "update":
        case "comment": {
          const ticketId = asNonBlankString(args.ticketId, "ticketId");
          const own = await kanban.getKanbanTask(ticketId);
          if (belongs(own, projectId) && node.syncs) {
            const ticket =
              action === "update"
                ? await kanban.updateKanbanTask(ticketId, contentInput(args) as never, projectId)
                : await kanban.addKanbanComment(
                    ticketId,
                    asNonBlankString(args.text, "text"),
                    projectId,
                    typeof args.requestId === "string" ? args.requestId : undefined,
                  );
            return {
              ticket,
              ...where(node),
              synced: true,
              sync: await syncState(context, node, projectId),
            };
          }
          if (!node.online) offline(node);
          const theirs = await node.call<KanbanTask[]>("get_kanban_tasks", {
            projectId: node.projectId,
          });
          if (!Array.isArray(theirs) || !theirs.some((task) => task.id === ticketId)) {
            throw new Error(
              `Kanban ticket not found in this project on ${node.nodeName} or on this board: ${ticketId}`,
            );
          }
          const requestKey =
            typeof args.requestId === "string" ? `ticket:${action}:${args.requestId}` : undefined;
          const ticket =
            action === "update"
              ? await node.call<KanbanTask>(
                  "update_kanban_task",
                  { taskId: ticketId, ...contentInput(args) },
                  requestKey,
                )
              : await node.call<KanbanTask>(
                  "add_kanban_comment",
                  {
                    taskId: ticketId,
                    text: asNonBlankString(args.text, "text"),
                    projectId: node.projectId,
                    ...(typeof args.requestId === "string" ? { requestId: args.requestId } : {}),
                  },
                  requestKey,
                );
          return {
            ticket,
            ...where(node),
            ...(node.syncs
              ? {
                  synced: false,
                  note: `This ticket exists only on ${node.nodeName}; it is not on this board.`,
                }
              : olderLeaf(node)),
            ...(action === "update" ? labelUpdateWarning(node, args, ticket) : {}),
          };
        }
        default:
          throw new Error("Unknown ticket action.");
      }
    },
    ASYNC_HANDLER,
  );
}

/**
 * Before `start_build_pipeline` with a `nodeId`: when `taskId` is a ticket on
 * this board, make sure the node has its copy now, so the node links the
 * build to the same id. A leaf too old to sync cannot build a ticket of this
 * board; that is refused with what to do instead. Returns whether the ticket
 * is this board's (the caller then records where its build runs).
 */
export async function prepareRemoteBuildTicket(
  context: CommandContext,
  projectId: string,
  node: { nodeId: string; nodeName: string; syncsTickets(): boolean },
  taskId: unknown,
): Promise<boolean> {
  const ticketId = typeof taskId === "string" ? taskId.trim() : "";
  const own = ticketId ? await context.storage.kanban.getKanbanTask(ticketId) : null;
  if (!belongs(own, projectId)) return false;
  if (!node.syncsTickets()) {
    compatibilityPathUsage.record("ticket-sync.older-node");
    throw Object.assign(
      new Error(
        `${node.nodeName} runs an older Orkestrator that cannot sync tickets, so it cannot build ticket ${ticketId} from this board. Update that machine, or create a ticket there with create_ticket and nodeId (it stays on that machine) and start the build with that ticket's id.`,
      ),
      { code: "coordinator-build-ticket-required" },
    );
  }
  const service = context.nodeCoordination?.ticketSync;
  if (!service) throw new Error("Ticket sync is not available in this backend.");
  const state = await service.sync(node.nodeId);
  if (state?.state !== "in-sync") {
    throw Object.assign(
      new Error(
        `Ticket ${ticketId} could not be handed to ${node.nodeName} (${state?.message ?? "its ticket sync did not finish"}). Nothing was started; retry.`,
      ),
      { code: "coordinator-build-ticket-required" },
    );
  }
  const target = await ticketNode(context, projectId, node.nodeId);
  const copies = await target?.call<KanbanTask[]>("get_kanban_tasks", {
    projectId: target.projectId,
  });
  const copy = copies?.find((ticket) => ticket.id === ticketId);
  if (!copy || (copy.sync?.replica?.seq ?? -1) < (own!.sync?.seq ?? 0)) {
    throw Object.assign(
      new Error(`Ticket ${ticketId} has not reached ${node.nodeName}. Nothing was started; retry.`),
      { code: "coordinator-build-ticket-required" },
    );
  }
  return true;
}
