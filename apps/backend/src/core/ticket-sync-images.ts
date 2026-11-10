import { ticketImageUnavailableMessage } from "@orkestrator/protocol/ticket-sync";

import type { CommandContext } from "./commands-context.js";

/**
 * An image's bytes for the board (docs/architecture/tickets.md, "Sync across
 * machines"). An image attached here, or a copy kept from an earlier read, is
 * read from disk. One on a synced ticket whose bytes are on another machine
 * is read over the node link: a command node reads it from the leaf that holds
 * it; a leaf, which never reaches its command node, asks for it and waits for
 * the command node to deliver it on its next collection. Either keeps a copy,
 * so it crosses the link once.
 */
export async function readKanbanImageData(
  context: Pick<CommandContext, "storage" | "nodeCoordination" | "nodes">,
  imageId: string,
): Promise<string> {
  try {
    return await context.storage.kanban.getKanbanImageData(imageId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
    const found = await context.storage.ticketSync.findTicketImage(imageId);
    const holder = found?.image.nodeId;
    if (!found || !holder) throw error;
    const replica = found.task.sync?.replica;
    const controllerName = replica
      ? context.nodes
          ?.listControllers()
          .find((entry) => entry.controllerId === replica.controllerId)?.displayName
      : undefined;
    const name = found.image.nodeName ?? controllerName ?? holder;
    const unavailable = ticketImageUnavailableMessage(name);
    if (replica) {
      const wants = context.nodeCoordination?.ticketImages;
      if (!wants) throw new Error(unavailable);
      await wants.want(replica.controllerId, imageId, unavailable);
      return context.storage.kanban.getKanbanImageData(imageId);
    }
    const sync = context.nodeCoordination?.ticketSync;
    if (!sync) throw new Error(unavailable);
    return sync.readImage(holder, imageId, found.image.nodeName);
  }
}
