import type { BackendId } from "@orkestrator/protocol/federation";

import { describeLeafMail, NODE_OUTBOX_READY_EVENT, type OutboxItem } from "./node-mail.js";

/**
 * The command node's side of leaf mail: when a leaf announces mail for this
 * command node (`node-outbox-ready` on its event stream), and on every
 * reconnect, collect it, deliver each item to the right coordinator
 * conversation here, and only then acknowledge it on the leaf. A delivery
 * that fails leaves the item in the leaf's outbox for the next attempt.
 */

export interface CollectorLink {
  readonly connected: boolean;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface CollectorDeps {
  retryDelayMs?: number;
  selfId(): Promise<BackendId>;
  link(nodeId: BackendId): CollectorLink | null;
  nodeName(nodeId: BackendId): Promise<string>;
  /**
   * Deliver one item to a coordinator mailbox on this node. `toCoordinator`
   * names the conversation when known; otherwise the coordinator of the
   * project with the item's repository identity.
   */
  deliver(input: {
    toCoordinator?: { environmentId: string; tabId: string };
    repositoryHint?: string;
    subject?: string;
    body: string;
    requestId: string;
    /** The agent that sent it, on its node: node mail is authenticated by the link. */
    from: {
      nodeId: string;
      nodeName: string;
      environmentId: string;
      tabId: string;
      environmentName?: string;
      tabName?: string;
    };
  }): Promise<void>;
}

export class NodeMailCollector {
  private readonly running = new Map<BackendId, Promise<boolean>>();
  private readonly again = new Set<BackendId>();
  private disposed = false;

  private readonly retries = new Map<
    BackendId,
    { timer: ReturnType<typeof setTimeout>; delay: number }
  >();
  private readonly delays = new Map<BackendId, number>();

  constructor(private readonly deps: CollectorDeps) {}

  private retry(nodeId: BackendId): void {
    if (this.disposed || this.retries.has(nodeId) || !this.deps.link(nodeId)?.connected) return;
    const delay = Math.min(
      60_000,
      (this.delays.get(nodeId) ?? this.deps.retryDelayMs ?? 1_000) * 2,
    );
    this.delays.set(nodeId, delay);
    const timer = setTimeout(() => {
      this.retries.delete(nodeId);
      void this.collect(nodeId);
    }, delay);
    timer.unref?.();
    this.retries.set(nodeId, { timer, delay });
  }

  dispose(): void {
    this.disposed = true;
    for (const { timer } of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    this.delays.clear();
  }

  /** Read-model events from a node's stream. */
  handleNodeEvent(event: string, payload: unknown, nodeId: BackendId): void {
    if (event !== NODE_OUTBOX_READY_EVENT) {
      if (event === "native-event-stream-connected" || event === "resync")
        void this.collect(nodeId);
      return;
    }
    void this.deps
      .selfId()
      .then((selfId) => {
        const target = (payload as { controllerId?: unknown } | null)?.controllerId;
        if (target === selfId) void this.collect(nodeId);
      })
      .catch(() => this.retry(nodeId));
  }

  /** Collect and acknowledge all queued mail. False means a failed or bounded partial drain. */
  collect(nodeId: BackendId): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const running = this.running.get(nodeId);
    if (running) {
      this.again.add(nodeId);
      return running;
    }
    const run = (async () => {
      let complete = true;
      for (let pass = 0; pass < 20; pass++) {
        this.again.delete(nodeId);
        complete = (await this.collectOnce(nodeId).catch(() => false)) && complete;
        if (!this.again.has(nodeId) || this.disposed) break;
      }
      if (this.again.delete(nodeId)) complete = false;
      if (!complete) this.retry(nodeId);
      return complete && !this.disposed;
    })().finally(() => {
      this.running.delete(nodeId);
    });
    this.running.set(nodeId, run);
    return run;
  }

  private async collectOnce(nodeId: BackendId): Promise<boolean> {
    const link = this.deps.link(nodeId);
    if (!link?.connected) return false;
    const controllerId = await this.deps.selfId();
    const name = await this.deps.nodeName(nodeId);
    let after = 0;
    let failed = false;
    let deliveredPrefix = 0;
    for (let round = 0; round < 20; round += 1) {
      const batch = await link.invoke<{ items: OutboxItem[]; more: boolean }>(
        "collect_node_outbox",
        { controllerId, after },
      );
      if (!batch?.items?.length) return !batch?.more && !failed;
      const delivered: number[] = [];
      for (const item of batch.items) {
        try {
          await this.deps.deliver({
            ...(item.toCoordinator ? { toCoordinator: item.toCoordinator } : {}),
            ...(item.repositoryHint ? { repositoryHint: item.repositoryHint } : {}),
            ...(item.subject ? { subject: item.subject } : {}),
            body: describeLeafMail(item, { nodeId, name }),
            // Stable per item, so a redelivery after a lost ack is deduplicated.
            requestId: `node:${nodeId}:${item.seq}`,
            from: {
              nodeId,
              nodeName: name,
              environmentId: item.fromEnvironmentId,
              tabId: item.fromTabId,
              ...(item.fromEnvironmentName ? { environmentName: item.fromEnvironmentName } : {}),
              ...(item.fromTabName ? { tabName: item.fromTabName } : {}),
            },
          });
          delivered.push(item.seq);
          if (!failed) deliveredPrefix = item.seq;
        } catch (error) {
          console.warn(
            "[nodes] Leaf mail could not be delivered to a coordinator yet:",
            error instanceof Error ? error.name : "unknown",
          );
          failed = true;
        }
      }
      if (delivered.length) {
        // Older leaves understand only upTo. Retain the safe contiguous
        // acknowledgement while newer leaves can also remove later successes.
        await link.invoke("ack_node_outbox", {
          controllerId,
          upTo: deliveredPrefix,
          sequences: delivered,
        });
      }
      after = batch.items.at(-1)?.seq ?? after;
      if (failed) this.retry(nodeId);
      if (!batch.more) {
        if (!failed) this.delays.delete(nodeId);
        return !failed;
      }
    }
    this.retry(nodeId);
    return false;
  }
}
