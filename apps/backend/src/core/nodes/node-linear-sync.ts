import type {
  AnyCommandDef,
  EncodedArgsOf,
  EncodedResultOf,
} from "@orkestrator/protocol/contract/command";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import {
  applyLinearSyncStateCommand,
  getLinearSyncStateCommand,
} from "@orkestrator/protocol/contract/domains/ticket-sync";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import {
  applyLinearSyncState,
  readLinearSyncState,
  type LinearSyncStorage,
} from "../linear-sync-state.js";

const log = createLogger("linear");

/**
 * The command node's side of Linear sync (docs/architecture/tickets.md,
 * "Linear"). For each connected leaf it reads the leaf's board links,
 * disconnects and connection, merges them here (for each link, whichever
 * machine changed it last wins; a disconnect clears every copy of that key
 * connected before it), and sends the merged set back. A leaf never reaches
 * this node, so a change made on a leaf arrives at the next pass: on
 * (re)connect, when the leaf's projects are read, after a change here, and at
 * the minute reconcile.
 *
 * Only non-secret state travels here: links keyed by repository, and
 * disconnects and connections by the key's fingerprint. The one key copy is
 * `copy_linear_connection_from_node`, and only when the user asks.
 */

export interface LinearSyncLink {
  readonly connected: boolean;
  invokeCommand<C extends AnyCommandDef>(
    def: C,
    args: EncodedArgsOf<C>,
  ): Promise<EncodedResultOf<C>>;
}

export interface LinearNodeConnection {
  nodeId: string;
  nodeName?: string;
  connected: boolean;
  viewerName?: string;
  keyFingerprint?: string;
  readAt: string;
}

export interface NodeLinearSyncDeps {
  selfId(): Promise<string>;
  link(nodeId: string): LinearSyncLink | null;
  nodes(): Promise<Array<{ nodeId: string; displayName?: string; available: boolean }>>;
  storage: LinearSyncStorage;
  /** Whether this node is a command node now; a leaf syncs nothing itself. */
  isCommandNode(): boolean;
  debounceMs?: number;
  now?: () => Date;
}

export class NodeLinearSync {
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly connections = new Map<string, LinearNodeConnection>();
  private readonly olderNodes = new Set<string>();
  private pending: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: NodeLinearSyncDeps) {}

  dispose(): void {
    this.disposed = true;
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }

  /** Read-model events from a node's stream. */
  handleNodeEvent(event: string, _payload: unknown, nodeId: string): void {
    if (event === "native-event-stream-connected" || event === "resync") void this.sync(nodeId);
  }

  /** A link, disconnect or connection changed here: send it to every leaf shortly. */
  noteLocalChange(): void {
    if (this.disposed || this.pending || !this.deps.isCommandNode()) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.syncAll();
    }, this.deps.debounceMs ?? 250);
    this.pending.unref?.();
  }

  /** Every available node. */
  async syncAll(): Promise<void> {
    if (this.disposed || !this.deps.isCommandNode()) return;
    const nodes = await this.deps.nodes().catch(() => []);
    await Promise.all(nodes.filter((node) => node.available).map((node) => this.sync(node.nodeId)));
  }

  /** Each other machine's connection as last read. Never a key. */
  nodeConnections(): LinearNodeConnection[] {
    return [...this.connections.values()].sort((a, b) =>
      (a.nodeName ?? a.nodeId).localeCompare(b.nodeName ?? b.nodeId),
    );
  }

  /** Syncs one node; concurrent calls share a run, and a call during one runs once more after it. */
  sync(nodeId: string): Promise<void> {
    if (this.disposed || !this.deps.isCommandNode()) return Promise.resolve();
    const running = this.running.get(nodeId);
    if (running) {
      this.again.add(nodeId);
      return running;
    }
    const run = (async () => {
      for (let pass = 0; pass < 3; pass += 1) {
        this.again.delete(nodeId);
        try {
          await this.syncOnce(nodeId);
        } catch (error) {
          log.warn("sync.failed", { error: formatLogError(error, { message: false }) });
          return;
        }
        if (!this.again.has(nodeId) || this.disposed) return;
      }
    })().finally(() => this.running.delete(nodeId));
    this.running.set(nodeId, run);
    return run;
  }

  private async syncOnce(nodeId: string): Promise<void> {
    const link = this.deps.link(nodeId);
    if (!link?.connected) return;
    const controllerId = await this.deps.selfId();
    let remote: EncodedResultOf<typeof getLinearSyncStateCommand>;
    try {
      remote = await link.invokeCommand(getLinearSyncStateCommand, { controllerId });
    } catch (error) {
      if (incompatibility(error, getLinearSyncStateCommand.name)?.code === "unknown-command") {
        if (!this.olderNodes.has(nodeId)) log.info("sync.older-node");
        this.olderNodes.add(nodeId);
        this.connections.delete(nodeId);
        return;
      }
      throw error;
    }
    this.olderNodes.delete(nodeId);

    const before = await readLinearSyncState(this.deps.storage);
    await applyLinearSyncState(this.deps.storage, {
      links: remote?.links ?? [],
      revocations: remote?.revocations ?? [],
    });
    const merged = await readLinearSyncState(this.deps.storage);
    const result = await link.invokeCommand(applyLinearSyncStateCommand, {
      controllerId,
      links: merged.links,
      revocations: merged.revocations,
    });

    const name = (await this.deps.nodes().catch(() => [])).find(
      (node) => node.nodeId === nodeId,
    )?.displayName;
    const connection = remote?.connection;
    const stillConnected = Boolean(connection?.connected) && result?.cleared !== true;
    this.connections.set(nodeId, {
      nodeId,
      ...(name ? { nodeName: name } : {}),
      connected: stillConnected,
      ...(stillConnected && connection?.viewerName ? { viewerName: connection.viewerName } : {}),
      ...(stillConnected && connection?.keyFingerprint
        ? { keyFingerprint: connection.keyFingerprint }
        : {}),
      readAt: (this.deps.now?.() ?? new Date()).toISOString(),
    });

    // Something from this leaf changed here: the other leaves hear it now.
    if (JSON.stringify(before) !== JSON.stringify(merged)) this.noteLocalChange();
  }
}
