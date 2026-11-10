import { eventSink } from "../backend-emit.js";
import { registrarFrom } from "../commands-registry-contracts.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import { TICKET_SYNC_OUTBOX_READY_EVENT } from "@orkestrator/protocol/ticket-sync";

import type { CommandContext, CommandHandler } from "../commands-context.js";
import { registerTicketSyncCommands } from "../commands-registry-ticket-sync.js";
import { createProject, StorageService } from "../storage.js";
import type { ContractEnvelope } from "./node-link.js";
import { LeafTicketImageWants } from "./node-ticket-images.js";
import { NodeTicketSync, type TicketSyncLink } from "./node-ticket-sync.js";

/**
 * Kanban sync between a command node and a leaf, each a real storage service
 * in its own data directory, over an in-process link that runs the leaf's real
 * sync commands. `link.connected = false` is a disconnected leaf.
 */

export const COMMAND_ID = "bk_command";
export const LEAF_ID = "bk_leaf";
export const REPO = "https://github.com/acme/repo.git";

const cleanups: Array<() => Promise<void>> = [];

/** Closes every fleet's stores and timers; each suite calls it in `afterEach`. */
export async function cleanupFleets(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}

export async function storageIn(name: string): Promise<StorageService> {
  const dir = await mkdtemp(path.join(tmpdir(), `ork-ticket-sync-${name}-`));
  const storage = new StorageService(dir);
  await storage.init();
  cleanups.push(async () => {
    storage.close?.();
    await rm(dir, { recursive: true, force: true });
  });
  return storage;
}

export type Fleet = Awaited<ReturnType<typeof fleet>>;

export async function fleet(
  options: {
    capability?: boolean;
    /** The leaf's hello `domains` (plan item 1010); absent is a pre-contract leaf. */
    domains?: Record<string, { min: number; max: number }>;
    /** How long the leaf waits for an image it asked for. */
    imageTimeoutMs?: number;
    /** While true, the command node has not read the leaf's projects yet. */
    summaryPending?: () => boolean;
    retryDelayMs?: number;
  } = {},
) {
  const command = await storageIn("command");
  const leaf = await storageIn("leaf");
  const commandProject = await command.addProject(createProject(REPO));
  const leafProject = await leaf.addProject(createProject(REPO));
  const handlers = new Map<string, CommandHandler>();
  registerTicketSyncCommands(registrarFrom((name, handler) => handlers.set(name, handler)));
  // The leaf's wants reach the command node as its stream event would.
  const leafImages = new LeafTicketImageWants({
    announce: (controllerId) =>
      sync.handleNodeEvent(TICKET_SYNC_OUTBOX_READY_EVENT, { controllerId }, LEAF_ID),
    timeoutMs: options.imageTimeoutMs ?? 2_000,
  });
  cleanups.push(async () => leafImages.dispose());
  const leafContext = {
    storage: leaf,
    nodes: { listControllers: () => [{ controllerId: COMMAND_ID, displayName: "Command" }] },
    nodeCoordination: { ticketImages: leafImages },
  } as unknown as CommandContext;
  const received: string[] = [];
  const envelopes: Array<{ command: string; envelope: ContractEnvelope | undefined }> = [];
  const failNext = new Set<string>();
  const link: TicketSyncLink & { connected: boolean } = {
    connected: true,
    hello: {
      capabilities: options.capability === false ? {} : { "ticket-sync": 1 },
      ...(options.domains ? { domains: options.domains } : {}),
    },
    async invoke<T>(
      name: string,
      args: Record<string, unknown> = {},
      invokeOptions?: { envelope?: ContractEnvelope },
    ): Promise<T> {
      if (!link.connected) throw new Error("fetch failed");
      received.push(name);
      envelopes.push({ command: name, envelope: invokeOptions?.envelope });
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Unknown command: ${name}`);
      // The leaf's registry gets the envelope as the gateway passes it.
      const result = await handler(structuredClone(args), leafContext, invokeOptions?.envelope);
      // An answer lost on the way back: the leaf acted, the command node never heard.
      if (failNext.delete(name)) throw new Error("connection lost");
      return structuredClone(result) as T;
    },
  };
  const events: Array<{ event: string; payload: unknown }> = [];
  const sync = new NodeTicketSync({
    selfId: async () => COMMAND_ID,
    link: () => link,
    // Every project on the leaf, as its summary lists them.
    nodes: async () => [
      {
        nodeId: LEAF_ID,
        displayName: "Leaf machine",
        available: link.connected,
        projects: (await leaf.loadProjects()).map((project) => ({
          projectId: project.id,
          name: project.name,
          ...(repositoryHint(project.gitUrl)
            ? { repositoryHint: repositoryHint(project.gitUrl) }
            : {}),
        })),
        ...(options.summaryPending?.() ? { summaryPending: true, projects: [] } : {}),
      },
    ],
    localProjects: () => command.loadProjects(),
    ticketSync: command.ticketSync,
    localImage: (imageId) => command.kanban.getKanbanImageData(imageId).catch(() => null),
    emit: eventSink((event, payload) => events.push({ event, payload })),
    debounceMs: 1,
    retryDelayMs: options.retryDelayMs ?? 60_000,
  });
  cleanups.push(async () => sync.dispose());
  const leafTicket = async (id: string) => leaf.kanban.getKanbanTask(id);
  const commandTicket = async (id: string) => command.kanban.getKanbanTask(id);
  const commandContext = {
    storage: command,
    nodeCoordination: { ticketSync: sync },
  } as unknown as CommandContext;
  return {
    command,
    leaf,
    commandProject,
    leafProject,
    link,
    sync,
    handlers,
    leafContext,
    commandContext,
    leafImages,
    received,
    envelopes,
    failNext,
    events,
    leafTicket,
    commandTicket,
  };
}
