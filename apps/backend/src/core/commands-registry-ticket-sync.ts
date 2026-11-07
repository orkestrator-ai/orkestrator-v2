import { isBackendId } from "@orkestrator/protocol/federation";
import {
  ackTicketSyncOutboxCommand,
  applyTicketSyncCommand,
  collectTicketSyncOutboxCommand,
  getTicketSyncCursorCommand,
  getTicketSyncStatusCommand,
  syncNodeTicketsCommand,
} from "@orkestrator/protocol/contract/domains/ticket-sync";
import { parseTicketSyncItem, TICKET_SYNC_LIMITS } from "@orkestrator/protocol/ticket-sync";

import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";

/**
 * Kanban sync commands (docs/architecture/tickets.md, "Sync across machines").
 *
 * Leaf side, called by an attached command node over its link only (never
 * routable through a portal, workspace grant or relay; see `node-routing.ts`):
 * `apply_ticket_sync`, `get_ticket_sync_cursor`, `collect_ticket_sync_outbox`
 * and `ack_ticket_sync_outbox`.
 *
 * Command node side: `get_ticket_sync_status` for the board, and
 * `sync_node_tickets` to sync now.
 *
 * All six are defined (`@orkestrator/protocol/contract/domains/ticket-sync`,
 * plan item 1010): their arguments decode tolerantly (an unknown key is
 * dropped, not refused), and the checks below keep their own messages.
 */

function nonBlank(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`Expected ${name}.`);
  }
  return value;
}

function sequence(value: unknown, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected ${name}.`);
  }
  return value;
}

/** The calling command node, which must be attached to this node. */
function attachedController(
  args: { readonly controllerId?: unknown },
  context: CommandContext,
): string {
  const controllerId = args.controllerId;
  if (!isBackendId(controllerId)) throw new Error("Expected controllerId to be a node identity.");
  if (!context.nodes?.listControllers().some((entry) => entry.controllerId === controllerId)) {
    throw new Error("That command node is not attached to this node.");
  }
  return controllerId;
}

function ticketSync(context: CommandContext) {
  const service = context.nodeCoordination?.ticketSync;
  if (!service) throw new Error("Ticket sync is not available in this backend.");
  return service;
}

export function registerTicketSyncCommands(register: CommandRegistrar): void {
  register(applyTicketSyncCommand, async (args, context) => {
    const controllerId = attachedController(args, context);
    const projectId = nonBlank(args.projectId, "projectId");
    if (!(await context.storage.getProject(projectId))) {
      throw new Error("That project does not exist on this node.");
    }
    if (!Array.isArray(args.items) || args.items.length > TICKET_SYNC_LIMITS.maxBatchItems) {
      throw new Error("Expected at most a batch of ticket items.");
    }
    const liveIds = args.liveIds;
    if (
      liveIds !== undefined &&
      !(
        Array.isArray(liveIds) &&
        liveIds.length <= 100_000 &&
        liveIds.every((id) => typeof id === "string" && id.length <= 200)
      )
    ) {
      throw new Error("Expected liveIds to be ticket ids.");
    }
    return context.storage.kanban.applyTicketSync({
      controllerId,
      projectId,
      sourceProjectId: nonBlank(args.sourceProjectId, "sourceProjectId"),
      epoch: nonBlank(args.epoch, "epoch"),
      items: args.items.map(parseTicketSyncItem),
      cursor: sequence(args.cursor, "cursor"),
      ...(args.reset === true ? { reset: true } : {}),
      ...(liveIds ? { liveIds: liveIds as string[] } : {}),
    });
  });

  register(getTicketSyncCursorCommand, async (args, context) => {
    const controllerId = attachedController(args, context);
    return context.storage.kanban.getTicketSyncCursor(
      controllerId,
      nonBlank(args.projectId, "projectId"),
    );
  });

  register(collectTicketSyncOutboxCommand, async (args, context) => {
    const controllerId = attachedController(args, context);
    return context.storage.kanban.collectTicketSyncOutbox(
      controllerId,
      sequence(args.after, "after"),
    );
  });

  register(ackTicketSyncOutboxCommand, async (args, context) => {
    const controllerId = attachedController(args, context);
    return context.storage.kanban.ackTicketSyncOutbox(
      controllerId,
      nonBlank(args.epoch, "epoch"),
      sequence(args.upTo, "upTo"),
    );
  });

  register(getTicketSyncStatusCommand, async (args, context) => {
    const projectId = nonBlank(args.projectId, "projectId");
    const service = context.nodeCoordination?.ticketSync;
    if (!service) return { projectId, nodes: [], conflicts: [] };
    return service.status(projectId);
  });

  register(syncNodeTicketsCommand, async (args, context) => {
    const service = ticketSync(context);
    if (args.nodeId === undefined) return { nodes: await service.syncAll() };
    return { nodes: [await service.sync(nonBlank(args.nodeId, "nodeId"))] };
  });
}
