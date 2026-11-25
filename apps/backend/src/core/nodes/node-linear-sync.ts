import type {
  AnyCommandDef,
  EncodedArgsOf,
  EncodedResultOf,
} from "@orkestrator/protocol/contract/command";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import {
  applyLinearSyncStateCommand,
  claimLinearWritesCommand,
  getLinearSyncStateCommand,
  settleLinearWritesCommand,
} from "@orkestrator/protocol/contract/domains/ticket-sync";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import {
  applyLinearSyncState,
  readLinearSyncState,
  type LinearSyncStorage,
} from "../linear-sync-state.js";
import {
  MAX_LINEAR_WRITES_PER_CLAIM,
  LINEAR_WRITE_CLAIM_MS,
  parseLinearOwedWrite,
  performLinearWrite,
} from "../linear-write-relay.js";

import type { LinearStorage } from "../storage/index.js";
import { LINEAR_WRITE_TIMEOUT_MS } from "../linear-write-drain.js";

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
 * After each pass it also lands what a leaf with no key owes Linear
 * (`deliverWrites`, `linear-write-relay.ts`).
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
  storage: LinearSyncStorage & { linear: Pick<LinearStorage, "getLinearBoardLink"> };
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
  private readonly delivering = new Map<string, Promise<void>>();
  private readonly withoutRelay = new Set<string>();
  private readonly stop = new AbortController();
  private pending: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: NodeLinearSyncDeps) {}

  dispose(): void {
    this.disposed = true;
    this.stop.abort(new Error("Linear sync stopped"));
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

  /**
   * Each other machine's connection as last read. Never a key. A reading of a
   * key this node has since seen disconnected (here, or merged from another
   * machine) reports that machine as disconnected: the leaf clears that key
   * at its next pass, and offering it meanwhile would copy a revoked key back.
   */
  async nodeConnections(): Promise<LinearNodeConnection[]> {
    const revocations = await this.deps.storage.linear.listLinearRevocations().catch(() => []);
    return [...this.connections.values()]
      .map((connection) => {
        const revoked =
          connection.connected &&
          connection.keyFingerprint !== undefined &&
          revocations.some(
            (revocation) =>
              revocation.keyFingerprint === connection.keyFingerprint &&
              Date.parse(revocation.revokedAt) >= Date.parse(connection.readAt),
          );
        if (!revoked) return connection;
        const { viewerName: _viewerName, keyFingerprint: _keyFingerprint, ...rest } = connection;
        return { ...rest, connected: false };
      })
      .sort((a, b) => (a.nodeName ?? a.nodeId).localeCompare(b.nodeName ?? b.nodeId));
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
        // Not awaited: slow Linear writes must not hold up the links.
        void this.deliverWrites(nodeId);
        if (!this.again.has(nodeId) || this.disposed) return;
      }
    })().finally(() => this.running.delete(nodeId));
    this.running.set(nodeId, run);
    return run;
  }

  /**
   * Writes to Linear, with this node's key, what a leaf without one owes.
   * Nothing is claimed while this node holds no key either. Never throws; a
   * call during a run joins it.
   */
  deliverWrites(nodeId: string): Promise<void> {
    if (this.disposed || !this.deps.isCommandNode()) return Promise.resolve();
    const running = this.delivering.get(nodeId);
    if (running) return running;
    const run = this.deliverOnce(nodeId)
      .catch((error: unknown) => {
        if (incompatibility(error, claimLinearWritesCommand.name)?.code === "unknown-command") {
          // An older node keeps what it owes until it is updated.
          if (!this.withoutRelay.has(nodeId)) log.info("relay.older-node");
          this.withoutRelay.add(nodeId);
          return;
        }
        if (!this.disposed) {
          log.warn("relay.failed", { error: formatLogError(error, { message: false }) });
        }
      })
      .finally(() => this.delivering.delete(nodeId));
    this.delivering.set(nodeId, run);
    return run;
  }

  private async deliverOnce(nodeId: string): Promise<void> {
    const link = this.deps.link(nodeId);
    if (!link?.connected) return;
    if (!(await this.deps.storage.kanban.getLinearAuth())?.apiKey) return;
    const controllerId = await this.deps.selfId();
    const clock = () => this.deps.now?.().getTime() ?? performance.now();
    // Start the budget before the RPC, so transport time and clock skew cannot
    // let a command node use a lease past the leaf's deadline.
    const deadline = clock() + LINEAR_WRITE_CLAIM_MS;
    const claimed = await link.invokeCommand(claimLinearWritesCommand, {
      controllerId,
      leased: true,
    });
    this.withoutRelay.delete(nodeId);
    const writes = Array.isArray(claimed?.writes) ? claimed.writes : [];
    for (const value of writes.slice(0, MAX_LINEAR_WRITES_PER_CLAIM)) {
      if (
        this.disposed ||
        !this.deps.isCommandNode() ||
        this.deps.link(nodeId) !== link ||
        !link.connected
      )
        return;
      const write = parseLinearOwedWrite(value);
      if (!write) continue;
      // Read per write: a disconnect during the run stops it.
      const apiKey = (await this.deps.storage.kanban.getLinearAuth())?.apiKey;
      if (!apiKey) return;
      const remaining = Math.floor(deadline - clock());
      if (remaining < LINEAR_WRITE_TIMEOUT_MS) return;
      const result = await performLinearWrite(
        this.deps.storage,
        apiKey,
        write,
        this.stop.signal,
        async () => {
          if (
            this.disposed ||
            !this.deps.isCommandNode() ||
            this.deps.link(nodeId) !== link ||
            !link.connected ||
            clock() >= deadline
          )
            return false;
          const response = await link.invokeCommand(claimLinearWritesCommand, {
            controllerId,
            leased: true,
            revalidate: write,
          });
          return (
            response.valid === true &&
            !this.disposed &&
            this.deps.isCommandNode() &&
            this.deps.link(nodeId) === link &&
            link.connected &&
            clock() < deadline
          );
        },
        remaining,
      );
      if (this.disposed) return;
      if (!("error" in result)) {
        log.info("relay.written", { kind: write.kind, issue: write.issueId });
      }
      await link.invokeCommand(settleLinearWritesCommand, { controllerId, results: [result] });
    }
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
