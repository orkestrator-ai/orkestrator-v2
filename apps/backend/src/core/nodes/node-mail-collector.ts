import { nodeMailClient, type NodeMailApi } from "@orkestrator/protocol/contract/domains/node-mail";
import type { BackendId } from "@orkestrator/protocol/federation";

import type { MailAttachmentBatch } from "../mail-attachments.js";
import {
  describeLeafCoordinatorMail,
  describeLeafMail,
  NODE_OUTBOX_READY_EVENT,
  type OutboxItem,
} from "./node-mail.js";
import { linkDomainApi, type EnvelopeLink } from "./node-domain-clients.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("nodes");

/**
 * The command node's side of leaf mail: when a leaf announces mail for this
 * command node (`node-outbox-ready` on its event stream), and on every
 * reconnect, collect it, deliver each item to the right coordinator
 * conversation here, and only then acknowledge it on the leaf. A delivery
 * that fails leaves the item in the leaf's outbox for the next attempt.
 *
 * The leaf is called through the `node-mail` domain client
 * (`@orkestrator/protocol/contract/domains/node-mail`, plan item 1010).
 */

export interface CollectorLink extends EnvelopeLink {
  readonly connected: boolean;
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
    nodePrefix?: string;
    nodeParent?: { id: string; threadId: string; hopCount: number };
    requestId: string;
    /** Images to fetch from the sender's node before delivering it. */
    attachments?: MailAttachmentBatch;
    /** The agent that sent it, on its node: node mail is authenticated by the link. */
    from: {
      nodeId: string;
      nodeName: string;
      environmentId: string;
      tabId: string;
      environmentName?: string;
      tabName?: string;
      /** The leaf's main coordinator for the project, not an agent. */
      coordinator?: boolean;
    };
  }): Promise<void>;
  /**
   * This node's side of coordinator notices. `declined` hands one back to the
   * leaf's own coordinator: this node has no copy of its repository. A throw
   * leaves it in the leaf's outbox for the next attempt.
   */
  notices?: {
    repositoryHints(): Promise<string[]>;
    deliver(
      item: OutboxItem,
      node: { nodeId: string; name: string },
    ): Promise<"delivered" | "declined" | "deferred">;
  };
}

/** What one collection learned about a node's outbox. */
interface CollectionResult {
  /** Every item was delivered or handed back, across every pass of the run. */
  complete: boolean;
  /** The last pass read the outbox to its end, so every item still in it was seen. */
  drained: boolean;
  /** Senders (`senderKey`) with an item the last pass failed to deliver. */
  failedSenders: ReadonlySet<string>;
}

const NOT_DRAINED: CollectionResult = { complete: false, drained: false, failedSenders: new Set() };

function senderKey(environmentId: string, tabId: string): string {
  return `${environmentId}\0${tabId}`;
}

export class NodeMailCollector {
  private readonly running = new Map<BackendId, Promise<CollectionResult>>();
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
    return this.run(nodeId).then((result) => result.complete);
  }

  /**
   * Collect, and say whether nothing this one sender queued is still waiting:
   * the outbox was read to its end and none of its items failed to deliver.
   *
   * A delegation on this node waits only for its own worker's mail. Asking
   * for a complete drain instead let any other item that keeps failing, such
   * as a notice for a coordinator whose mailbox is full, hold every worker on
   * that node open for good.
   */
  collectFrom(
    nodeId: BackendId,
    sender: { environmentId: string; tabId: string },
  ): Promise<boolean> {
    return this.run(nodeId).then(
      (result) =>
        result.drained && !result.failedSenders.has(senderKey(sender.environmentId, sender.tabId)),
    );
  }

  private run(nodeId: BackendId): Promise<CollectionResult> {
    if (this.disposed) return Promise.resolve(NOT_DRAINED);
    const running = this.running.get(nodeId);
    if (running) {
      this.again.add(nodeId);
      return running;
    }
    const run = (async (): Promise<CollectionResult> => {
      let complete = true;
      let last = NOT_DRAINED;
      for (let pass = 0; pass < 20; pass++) {
        this.again.delete(nodeId);
        last = await this.collectOnce(nodeId).catch(() => NOT_DRAINED);
        complete = last.complete && complete;
        if (!this.again.has(nodeId) || this.disposed) break;
      }
      // A caller joined after the last pass read the outbox: its mail may be unread.
      if (this.again.delete(nodeId)) {
        complete = false;
        last = NOT_DRAINED;
      }
      if (!complete) this.retry(nodeId);
      if (this.disposed) return NOT_DRAINED;
      return { ...last, complete };
    })().finally(() => {
      this.running.delete(nodeId);
    });
    this.running.set(nodeId, run);
    return run;
  }

  private async collectOnce(nodeId: BackendId): Promise<CollectionResult> {
    const link = this.deps.link(nodeId);
    if (!link?.connected) return NOT_DRAINED;
    const mail = linkDomainApi(link, nodeMailClient);
    const controllerId = await this.deps.selfId();
    const name = await this.deps.nodeName(nodeId);
    let after = 0;
    let failed = false;
    let deliveredPrefix = 0;
    let deferred = false;
    const failedSenders = new Set<string>();
    const notices = this.deps.notices;
    const repositoryHints = notices ? await notices.repositoryHints() : [];
    for (let round = 0; round < 20; round += 1) {
      const batch = (await mail.collectOutbox({
        controllerId,
        after,
        coordinatorMail: true,
        ...(notices ? { coordinatorNotices: { repositoryHints } } : {}),
        attachmentMail: true,
      })) as { items?: OutboxItem[]; more?: boolean };
      if (!batch?.items?.length) {
        const drained = !batch?.more;
        return { complete: drained && !failed, drained, failedSenders };
      }
      const delivered: number[] = [];
      const declined: number[] = [];
      for (const item of batch.items) {
        try {
          if (item.coordinatorNotice) {
            if (!notices) throw new Error("This node does not take coordinator notices.");
            const outcome = await notices.deliver(item, { nodeId, name });
            if (outcome === "deferred") {
              this.retry(nodeId);
              // Do not acknowledge this item or advance the contiguous prefix across it.
              deferred = true;
              continue;
            }
            if (outcome === "declined") declined.push(item.seq);
            else delivered.push(item.seq);
            if (!failed && !deferred) deliveredPrefix = item.seq;
            continue;
          }
          await this.deps.deliver({
            ...(item.toCoordinator ? { toCoordinator: item.toCoordinator } : {}),
            ...(item.repositoryHint ? { repositoryHint: item.repositoryHint } : {}),
            ...(item.subject ? { subject: item.subject } : {}),
            body: item.fromCoordinator ? item.body : describeLeafMail(item, { nodeId, name }),
            ...(item.fromCoordinator
              ? {
                  nodePrefix: describeLeafCoordinatorMail({ ...item, body: "" }, { nodeId, name }),
                  ...(item.nodeParent ? { nodeParent: item.nodeParent } : {}),
                }
              : {}),
            // Stable per item, so a redelivery after a lost ack is deduplicated.
            requestId: `node:${nodeId}:${item.seq}`,
            ...(item.attachments ? { attachments: item.attachments } : {}),
            from: {
              nodeId,
              nodeName: name,
              environmentId: item.fromEnvironmentId,
              tabId: item.fromTabId,
              ...(item.fromEnvironmentName ? { environmentName: item.fromEnvironmentName } : {}),
              ...(item.fromTabName ? { tabName: item.fromTabName } : {}),
              ...(item.fromCoordinator ? { coordinator: true } : {}),
            },
          });
          delivered.push(item.seq);
          if (!failed && !deferred) deliveredPrefix = item.seq;
        } catch (error) {
          if (await this.handBack(mail, controllerId, item, error)) {
            delivered.push(item.seq);
            if (!failed) deliveredPrefix = item.seq;
            continue;
          }
          log.warn("mail.delivery-deferred", { error: formatLogError(error, { message: false }) });
          failed = true;
          failedSenders.add(senderKey(item.fromEnvironmentId, item.fromTabId));
        }
      }
      if (delivered.length || declined.length) {
        // Older leaves understand only upTo. Retain the safe contiguous
        // acknowledgement while newer leaves can also remove later successes.
        await mail.ackOutbox({
          controllerId,
          upTo: deliveredPrefix,
          coordinatorMail: true,
          ...(notices ? { coordinatorNotices: { declined } } : {}),
          attachmentMail: true,
          sequences: delivered,
        });
      }
      after = batch.items.at(-1)?.seq ?? after;
      if (failed) this.retry(nodeId);
      if (!batch.more) {
        if (!failed && !deferred) this.delays.delete(nodeId);
        return { complete: !failed, drained: true, failedSenders };
      }
    }
    this.retry(nodeId);
    return NOT_DRAINED;
  }

  /**
   * An agent's mail to "coordinator" for a repository with no coordinator here
   * goes back to the leaf's own. True once the leaf has taken it. Anything else
   * stays in the outbox: mail addressed to a conversation, a coordinator's own
   * mail, or a leaf with no coordinator either.
   */
  private async handBack(
    mail: NodeMailApi,
    controllerId: BackendId,
    item: OutboxItem,
    error: unknown,
  ): Promise<boolean> {
    if (
      (error as { code?: unknown } | null)?.code !== "no-coordinator" ||
      item.toCoordinator ||
      item.fromCoordinator ||
      item.allowLocalFallback === false
    ) {
      return false;
    }
    return mail
      .returnOutboxMail({ controllerId, seq: item.seq })
      .then(() => {
        log.recovered("mail.return-deferred", `${controllerId}:${item.seq}`);
        return true;
      })
      .catch((error: unknown) => {
        log.throttled("warn", "mail.return-deferred", {
          scope: `${controllerId}:${item.seq}`,
          error,
          fields: () => ({ error: formatLogError(error) }),
        });
        return false;
      });
  }
}
