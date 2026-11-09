import { ticketSyncStatusChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import type { BackendEmit } from "../backend-emit.js";
import {
  ticketSyncClient,
  type TicketSyncApi,
} from "@orkestrator/protocol/contract/domains/ticket-sync";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import {
  offlineTicketMessage,
  olderLeafTicketMessage,
  parseTicketSyncOutboxItem,
  TICKET_SYNC_OUTBOX_READY_EVENT,
  type TicketSyncItem,
  type TicketSyncNodeState,
  type TicketSyncOutboxItem,
  type TicketSyncStatusResult,
} from "@orkestrator/protocol/ticket-sync";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import type { TicketSyncStorage } from "../storage-kanban-sync-repository.js";
import { linkDomainApi, type EnvelopeLink } from "./node-domain-clients.js";

const log = createLogger("nodes");

/**
 * The command node's side of Kanban sync (docs/architecture/tickets.md, "Sync
 * across machines"). For each leaf that has a copy of one of this node's
 * repositories, and advertises `ticket-sync`:
 *
 * 1. Up: collect the changes the leaf queued for this node, apply them to the
 *    board in order and exactly once, and only then acknowledge them.
 * 2. Down: read the leaf's cursor and send it every change after it, in this
 *    node's change order, until it is current.
 *
 * It runs on every (re)connect and stream resync, when the leaf announces
 * queued changes, and shortly after any change to a synced board here. A
 * failure leaves everything where it was (the leaf's outbox, the leaf's
 * cursor) for the next run; nothing is dropped. An older leaf is reported as
 * needing an update and left as it is.
 *
 * The leaf is called through the `ticket-sync` domain client (plan item
 * 1010): a leaf that advertises the domain syncs; a pre-contract leaf syncs
 * when its hello names the `ticket-sync` capability, as before.
 */

export interface TicketSyncLink extends EnvelopeLink {
  readonly connected: boolean;
}

/** The leaf's ticket-sync API, or `null` when it cannot sync with this node. */
function ticketSyncApi(link: EnvelopeLink): TicketSyncApi | null {
  try {
    const api = linkDomainApi(link, ticketSyncClient);
    return api.syncs ? api : null;
  } catch {
    // No version in common (`unsupported-version`): reported like an older leaf.
    return null;
  }
}

/** Whether the leaf behind `link` syncs tickets with this node (connected or not). */
export function leafSyncsTickets(link: EnvelopeLink): boolean {
  return ticketSyncApi(link) !== null;
}

export interface TicketSyncNode {
  nodeId: string;
  displayName: string;
  available: boolean;
  projects: Array<{ projectId: string; repositoryHint?: string }>;
}

export interface NodeTicketSyncDeps {
  selfId(): Promise<string>;
  link(nodeId: string): TicketSyncLink | null;
  /** The nodes this one controls, with their last-known projects. */
  nodes(): Promise<TicketSyncNode[]>;
  /** This node's projects. */
  localProjects(): Promise<Array<{ id: string; gitUrl?: string | null }>>;
  ticketSync: Pick<
    TicketSyncStorage,
    | "ticketSyncChangesSince"
    | "applyTicketSyncOps"
    | "recordTicketSyncPeer"
    | "getTicketSyncOverview"
  >;
  emit: BackendEmit;
  retryDelayMs?: number;
  /** Delay before a board change here is sent out, so a burst of edits goes once. */
  debounceMs?: number;
}

export interface NodeTicketSyncResult {
  nodeId: string;
  state: TicketSyncNodeState["state"];
  message?: string;
  /** Leaf changes applied here, and how many of them lost a conflict. */
  applied: number;
  conflicts: number;
  /** Snapshots and tombstones sent down. */
  sent: number;
}

const MAX_ROUNDS = 200;

export class NodeTicketSync {
  private readonly running = new Map<string, Promise<NodeTicketSyncResult>>();
  private readonly again = new Set<string>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delays = new Map<string, number>();
  private readonly pendingProjects = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly outcomes = new Map<
    string,
    { state: TicketSyncNodeState["state"]; message?: string }
  >();
  private disposed = false;

  constructor(private readonly deps: NodeTicketSyncDeps) {}

  dispose(): void {
    this.disposed = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    for (const timer of this.pendingProjects.values()) clearTimeout(timer);
    this.retries.clear();
    this.pendingProjects.clear();
  }

  /** Read-model events from a node's stream. */
  handleNodeEvent(event: string, payload: unknown, nodeId: string): void {
    if (event === "native-event-stream-connected" || event === "resync") {
      void this.sync(nodeId);
      return;
    }
    if (event !== TICKET_SYNC_OUTBOX_READY_EVENT) return;
    void this.deps
      .selfId()
      .then((selfId) => {
        const target = (payload as { controllerId?: unknown } | null)?.controllerId;
        if (target === selfId) void this.sync(nodeId);
      })
      .catch(() => this.retry(nodeId));
  }

  /** A ticket of this node's project changed here: send it to the leaves that have the project. */
  noteLocalChange(projectId: string): void {
    if (this.disposed || this.pendingProjects.has(projectId)) return;
    const timer = setTimeout(() => {
      this.pendingProjects.delete(projectId);
      void this.syncProject(projectId);
    }, this.deps.debounceMs ?? 250);
    timer.unref?.();
    this.pendingProjects.set(projectId, timer);
  }

  /** Every connected node, for a periodic reconcile. */
  async syncAll(): Promise<NodeTicketSyncResult[]> {
    const nodes = await this.deps.nodes();
    return Promise.all(
      nodes.filter((node) => node.available).map((node) => this.sync(node.nodeId)),
    );
  }

  /** The leaves sharing one of this node's projects. */
  async syncProject(projectId: string): Promise<NodeTicketSyncResult[]> {
    const pairs = await this.nodesWithProject(projectId);
    return Promise.all(pairs.map(({ node }) => this.sync(node.nodeId)));
  }

  /**
   * Syncs one node now. Concurrent calls share a run, and a call during a run
   * starts one more after it, so nothing that changed meanwhile is missed.
   */
  sync(nodeId: string): Promise<NodeTicketSyncResult> {
    if (this.disposed) {
      return Promise.resolve({ nodeId, state: "error", applied: 0, conflicts: 0, sent: 0 });
    }
    const running = this.running.get(nodeId);
    if (running) {
      this.again.add(nodeId);
      return running;
    }
    const run = (async () => {
      let total: NodeTicketSyncResult = {
        nodeId,
        state: "in-sync",
        applied: 0,
        conflicts: 0,
        sent: 0,
      };
      for (let pass = 0; pass < 10; pass += 1) {
        this.again.delete(nodeId);
        const result = await this.syncOnce(nodeId).catch((error: unknown) => {
          log.warn("ticket-sync.failed", { error: formatLogError(error, { message: false }) });
          return {
            nodeId,
            state: "error" as const,
            message: "The last ticket sync with this machine failed; it is retried.",
            applied: 0,
            conflicts: 0,
            sent: 0,
          };
        });
        total = {
          ...result,
          applied: total.applied + result.applied,
          conflicts: total.conflicts + result.conflicts,
          sent: total.sent + result.sent,
        };
        if (!this.again.has(nodeId) || this.disposed || result.state !== "in-sync") break;
      }
      this.outcomes.set(nodeId, {
        state: total.state,
        ...(total.message ? { message: total.message } : {}),
      });
      if (total.state === "error") this.retry(nodeId);
      else this.delays.delete(nodeId);
      this.deps.emit(ticketSyncStatusChangedEvent, { nodeId });
      return total;
    })().finally(() => {
      this.running.delete(nodeId);
    });
    this.running.set(nodeId, run);
    return run;
  }

  private retry(nodeId: string): void {
    if (this.disposed || this.retries.has(nodeId) || !this.deps.link(nodeId)?.connected) return;
    const delay = Math.min(
      60_000,
      (this.delays.get(nodeId) ?? this.deps.retryDelayMs ?? 1_000) * 2,
    );
    this.delays.set(nodeId, delay);
    const timer = setTimeout(() => {
      this.retries.delete(nodeId);
      void this.sync(nodeId);
    }, delay);
    timer.unref?.();
    this.retries.set(nodeId, timer);
  }

  /** Pairs this node's projects with the node's copies, by repository identity. */
  private async pairs(
    node: TicketSyncNode,
  ): Promise<Array<{ projectId: string; leafProjectId: string }>> {
    const local = await this.deps.localProjects();
    const pairs: Array<{ projectId: string; leafProjectId: string }> = [];
    const usedHints = new Set<string>();
    for (const project of local) {
      const hint = repositoryHint(project.gitUrl);
      // One board per repository: the first project with it here, and the
      // first copy of it there, so a ticket id names one row on each side.
      if (!hint || usedHints.has(hint)) continue;
      usedHints.add(hint);
      const copy = node.projects.find((entry) => entry.repositoryHint === hint);
      if (copy) pairs.push({ projectId: project.id, leafProjectId: copy.projectId });
    }
    return pairs;
  }

  private async nodesWithProject(
    projectId: string,
  ): Promise<Array<{ node: TicketSyncNode; leafProjectId: string }>> {
    const nodes = await this.deps.nodes();
    const result: Array<{ node: TicketSyncNode; leafProjectId: string }> = [];
    for (const node of nodes) {
      const pair = (await this.pairs(node)).find((entry) => entry.projectId === projectId);
      if (pair) result.push({ node, leafProjectId: pair.leafProjectId });
    }
    return result;
  }

  private async syncOnce(nodeId: string): Promise<NodeTicketSyncResult> {
    const empty = { nodeId, applied: 0, conflicts: 0, sent: 0 };
    const node = (await this.deps.nodes()).find((entry) => entry.nodeId === nodeId);
    const link = this.deps.link(nodeId);
    if (!node || !link?.connected) {
      return {
        ...empty,
        state: "offline",
        message: offlineTicketMessage(node?.displayName ?? nodeId),
      };
    }
    const sync = ticketSyncApi(link);
    if (!sync) {
      return {
        ...empty,
        state: "update-required",
        message: olderLeafTicketMessage(node.displayName),
      };
    }
    const controllerId = await this.deps.selfId();
    const pairs = await this.pairs(node);
    const localIds = new Set((await this.deps.localProjects()).map((project) => project.id));
    let applied = 0;
    let conflicts = 0;
    let sent = 0;

    // Up first, so the leaf's queued changes are decided before it is sent the board.
    let after = 0;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const batch = await sync.collectOutbox({ controllerId, after });
      if (!batch?.epoch || !Array.isArray(batch.items) || batch.items.length === 0) break;
      let items: TicketSyncOutboxItem[];
      try {
        items = batch.items.map(parseTicketSyncOutboxItem);
      } catch {
        // A newer leaf's change this backend cannot read: keep it queued there.
        return {
          ...empty,
          applied,
          conflicts,
          state: "error",
          message: `${node.displayName} sent a ticket change this machine cannot read. Update this machine to sync tickets with it.`,
        };
      }
      // A change for a project that no longer exists here has nowhere to go.
      const firstUnknown = items.findIndex((item) => !localIds.has(item.sourceProjectId));
      const known = firstUnknown < 0 ? items : items.slice(0, firstUnknown);
      if (known.length !== items.length) log.warn("ticket-sync.unknown-project");
      const result = await this.deps.ticketSync.applyTicketSyncOps({
        nodeId,
        nodeName: node.displayName,
        epoch: batch.epoch,
        items: known,
      });
      applied += result.applied;
      conflicts += result.conflicts.length;
      const upTo = known.at(-1)?.seq;
      if (upTo !== undefined) {
        await sync.ackOutbox({ controllerId, epoch: batch.epoch, upTo });
        after = upTo;
      }
      if (firstUnknown >= 0)
        return {
          ...empty,
          applied,
          conflicts,
          state: "error",
          message:
            "Ticket changes for an unknown project remain queued on the leaf. Restore the project to resume sync.",
        };
      if (!batch.more) break;
    }

    for (const pair of pairs) {
      const position = await sync.cursor({ controllerId, projectId: pair.leafProjectId });
      let cursor =
        typeof position?.cursor === "number" && Number.isSafeInteger(position.cursor)
          ? position.cursor
          : 0;
      let epoch = typeof position?.epoch === "string" ? position.epoch : undefined;
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const changes = await this.deps.ticketSync.ticketSyncChangesSince(
          pair.projectId,
          cursor,
          epoch,
        );
        if (changes.items.length === 0 && !changes.reset) break;
        const answer = await sync.apply({
          controllerId,
          projectId: pair.leafProjectId,
          sourceProjectId: pair.projectId,
          epoch: changes.epoch,
          items: changes.items satisfies TicketSyncItem[],
          cursor: changes.cursor,
          ...(changes.reset ? { reset: true, liveIds: changes.liveIds ?? [] } : {}),
        });
        sent += changes.items.length;
        cursor =
          typeof answer?.cursor === "number" && Number.isSafeInteger(answer.cursor)
            ? answer.cursor
            : changes.cursor;
        epoch = changes.epoch;
        if (!changes.more) break;
      }
      await this.deps.ticketSync.recordTicketSyncPeer(
        nodeId,
        pair.projectId,
        pair.leafProjectId,
        cursor,
      );
    }
    return { nodeId, state: "in-sync", applied, conflicts, sent };
  }

  /** Where each leaf with a copy of the project stands, for the board and the tools. */
  async status(projectId: string): Promise<TicketSyncStatusResult> {
    const [overview, withProject] = await Promise.all([
      this.deps.ticketSync.getTicketSyncOverview(projectId),
      this.nodesWithProject(projectId),
    ]);
    const nodes: TicketSyncNodeState[] = withProject.map(({ node, leafProjectId }) => {
      const peer = overview.peers.find((entry) => entry.nodeId === node.nodeId);
      const link = this.deps.link(node.nodeId);
      const base = {
        nodeId: node.nodeId,
        nodeName: node.displayName,
        projectId: leafProjectId,
        latestSeq: overview.latestSeq,
        cursor: peer?.cursor ?? 0,
        ...(peer?.syncedAt ? { lastSyncedAt: peer.syncedAt } : {}),
      };
      if (!node.available || !link?.connected) {
        return { ...base, state: "offline", message: offlineTicketMessage(node.displayName) };
      }
      if (!ticketSyncApi(link)) {
        return {
          ...base,
          state: "update-required",
          message: olderLeafTicketMessage(node.displayName),
        };
      }
      if (this.running.has(node.nodeId)) return { ...base, state: "syncing" };
      const outcome = this.outcomes.get(node.nodeId);
      if (outcome?.state === "error") {
        return {
          ...base,
          state: "error",
          ...(outcome.message ? { message: outcome.message } : {}),
        };
      }
      if (!peer || peer.cursor < overview.latestSeq) {
        return {
          ...base,
          state: "behind",
          message: `${node.displayName} has not received every change to this board yet.`,
        };
      }
      return { ...base, state: "in-sync" };
    });
    return { projectId, nodes, conflicts: overview.conflicts.slice(-20) };
  }

  /** One node's state for one project, after syncing it now. */
  async syncAndReport(nodeId: string, projectId: string): Promise<TicketSyncNodeState | null> {
    await this.sync(nodeId);
    return (await this.status(projectId)).nodes.find((entry) => entry.nodeId === nodeId) ?? null;
  }
}
