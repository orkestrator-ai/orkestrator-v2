import { isBackendId } from "@orkestrator/protocol/federation";
import {
  ackTicketSyncOutboxCommand,
  applyTicketSyncCommand,
  collectTicketSyncOutboxCommand,
  dismissTicketSyncConflictsCommand,
  getTicketSyncCursorCommand,
  getTicketSyncLeafStatusCommand,
  getTicketSyncStatusCommand,
  putTicketImageCommand,
  readTicketImageCommand,
  shareTicketsWithCommandNodeCommand,
  syncNodeTicketsCommand,
} from "@orkestrator/protocol/contract/domains/ticket-sync";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import {
  parseTicketSyncItem,
  TICKET_SYNC_LIMITS,
  type TicketSyncLeafStatus,
} from "@orkestrator/protocol/ticket-sync";

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
 * Images (#2027), leaf side over the link only: `read_ticket_image`
 * (the command node reads a leaf's image) and `put_ticket_image` (it delivers
 * an image the leaf asked for in `wantedImages`).
 *
 * The board (#2027): `get_ticket_sync_leaf_status` and
 * `share_tickets_with_command_node` on a leaf, `dismiss_ticket_sync_conflicts`
 * on a command node.
 *
 * The first six are defined (`@orkestrator/protocol/contract/domains/ticket-sync`,
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
export function attachedController(
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

function idList(value: unknown, name: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > max ||
    !value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)
  ) {
    throw new Error(`Expected ${name} to be ids.`);
  }
  return value as string[];
}

function imageId(value: unknown): string {
  const id = nonBlank(value, "imageId");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Expected imageId.");
  return id;
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
    return context.storage.ticketSync.applyTicketSync({
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
    return context.storage.ticketSync.getTicketSyncCursor(
      controllerId,
      nonBlank(args.projectId, "projectId"),
    );
  });

  register(collectTicketSyncOutboxCommand, async (args, context) => {
    const controllerId = attachedController(args, context);
    const features =
      Array.isArray(args.features) &&
      args.features.length <= 32 &&
      args.features.every((feature) => typeof feature === "string")
        ? (args.features as string[])
        : undefined;
    const batch = await context.storage.ticketSync.collectTicketSyncOutbox(
      controllerId,
      sequence(args.after, "after"),
      TICKET_SYNC_LIMITS.maxCollectItems,
      features ?? [],
    );
    const wantedImages = context.nodeCoordination?.ticketImages?.wanted(controllerId) ?? [];
    return { ...batch, ...(wantedImages.length ? { wantedImages } : {}) };
  });

  register(readTicketImageCommand, async (args, context) => {
    const controllerId = attachedController(args, context);
    const data = await context.storage.ticketSync.readTicketImageFor(
      controllerId,
      imageId(args.imageId),
    );
    return data ? { data } : {};
  });

  register(putTicketImageCommand, async (args, context) => {
    const controllerId = attachedController(args, context);
    const id = imageId(args.imageId);
    const data = args.data;
    if (
      data !== undefined &&
      (typeof data !== "string" || data.length > TICKET_SYNC_LIMITS.maxImageDataChars)
    ) {
      throw new Error("Expected data to be an image's bytes.");
    }
    const stored =
      typeof data === "string" && data.length > 0
        ? await context.storage.ticketSync.storeTicketImageCopy(controllerId, id, data)
        : false;
    context.nodeCoordination?.ticketImages?.answered(controllerId, id, stored);
    return { stored };
  });

  register(getTicketSyncLeafStatusCommand, async (args, context) => {
    const projectId = nonBlank(args.projectId, "projectId");
    const project = await context.storage.getProject(projectId);
    if (!project) throw new Error("That project does not exist on this node.");
    const overview = await context.storage.ticketSync.getTicketSyncLeafOverview(projectId);
    const attached = context.nodes?.listControllers() ?? [];
    const nameOf = (controllerId: string) =>
      attached.find((entry) => entry.controllerId === controllerId)?.displayName ?? controllerId;
    const status: TicketSyncLeafStatus = {
      projectId,
      controllers: overview.links.map((link) => ({
        controllerId: link.controllerId,
        nodeName: nameOf(link.controllerId),
        sourceProjectId: link.sourceProjectId,
        lastSyncedAt: link.appliedAt,
        pending: link.pending,
      })),
      unshared: overview.unshared,
    };
    // One copy of a repository syncs per machine: name it on the others.
    const hint = repositoryHint(project.gitUrl);
    if (!overview.links.length && hint) {
      for (const linked of overview.linkedProjects) {
        if (linked.projectId === projectId) continue;
        const other = await context.storage.getProject(linked.projectId);
        if (other && repositoryHint(other.gitUrl) === hint) {
          status.syncedCopy = {
            projectId: other.id,
            projectName: other.name,
            nodeName: nameOf(linked.controllerId),
          };
          break;
        }
      }
    }
    return status;
  });

  register(shareTicketsWithCommandNodeCommand, async (args, context) => {
    const projectId = nonBlank(args.projectId, "projectId");
    if (!(await context.storage.getProject(projectId))) {
      throw new Error("That project does not exist on this node.");
    }
    const { shared } = await context.storage.ticketSync.shareTicketsWithCommandNode(
      projectId,
      idList(args.taskIds, "taskIds", 10_000),
    );
    return { shared };
  });

  register(dismissTicketSyncConflictsCommand, async (args, context) => {
    const projectId = nonBlank(args.projectId, "projectId");
    return context.storage.ticketSync.dismissTicketSyncConflicts(
      projectId,
      idList(args.ids, "ids", TICKET_SYNC_LIMITS.maxConflicts),
    );
  });

  register(ackTicketSyncOutboxCommand, async (args, context) => {
    const controllerId = attachedController(args, context);
    return context.storage.ticketSync.ackTicketSyncOutbox(
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
