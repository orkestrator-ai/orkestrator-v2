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
  }): Promise<void>;
}

export class NodeMailCollector {
  private readonly running = new Map<BackendId, Promise<void>>();
  private readonly again = new Set<BackendId>();

  constructor(private readonly deps: CollectorDeps) {}

  /** Read-model events from a node's stream. */
  handleNodeEvent(event: string, payload: unknown, nodeId: BackendId): void {
    if (event !== NODE_OUTBOX_READY_EVENT) return;
    void this.deps.selfId().then((selfId) => {
      const target = (payload as { controllerId?: unknown } | null)?.controllerId;
      if (target === selfId) void this.collect(nodeId);
    });
  }

  /** Collect everything queued for this command node on one node. Coalesced per node. */
  collect(nodeId: BackendId): Promise<void> {
    const running = this.running.get(nodeId);
    if (running) {
      this.again.add(nodeId);
      return running;
    }
    const run = this.collectOnce(nodeId).finally(() => {
      this.running.delete(nodeId);
      if (this.again.delete(nodeId)) void this.collect(nodeId);
    });
    this.running.set(nodeId, run);
    return run;
  }

  private async collectOnce(nodeId: BackendId): Promise<void> {
    const link = this.deps.link(nodeId);
    if (!link?.connected) return;
    const controllerId = await this.deps.selfId();
    const name = await this.deps.nodeName(nodeId);
    for (let round = 0; round < 20; round += 1) {
      const batch = await link.invoke<{ items: OutboxItem[]; more: boolean }>(
        "collect_node_outbox",
        { controllerId, after: 0 },
      );
      if (!batch?.items?.length) return;
      let delivered = 0;
      for (const item of batch.items) {
        try {
          await this.deps.deliver({
            ...(item.toCoordinator ? { toCoordinator: item.toCoordinator } : {}),
            ...(item.repositoryHint ? { repositoryHint: item.repositoryHint } : {}),
            ...(item.subject ? { subject: item.subject } : {}),
            body: describeLeafMail(item, { nodeId, name }),
            // Stable per item, so a redelivery after a lost ack is deduplicated.
            requestId: `node:${nodeId}:${item.requestId}`.slice(0, 256),
          });
          delivered = item.seq;
        } catch (error) {
          console.warn(
            "[nodes] Leaf mail could not be delivered to a coordinator yet:",
            error instanceof Error ? error.name : "unknown",
          );
          break;
        }
      }
      if (delivered > 0) {
        await link.invoke("ack_node_outbox", { controllerId, upTo: delivered });
      }
      if (delivered < (batch.items.at(-1)?.seq ?? 0) || !batch.more) return;
    }
  }
}
