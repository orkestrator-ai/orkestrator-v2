import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import type {
  CoordinatorNodeRelease,
  CoordinatorWorkflowAssociation,
} from "@orkestrator/protocol/coordinator";
import { createLogger, logErrorKind } from "@orkestrator/protocol/logger";
import type { StorageService } from "./storage.js";

const log = createLogger("coordinator");

/** How long a node goes unread before its coordinators hear about it once. */
export const NODE_OFFLINE_NOTICE_MS = 24 * 60 * 60 * 1000;

/** At most this many records are named in one notice; the rest are counted. */
const MAX_NOTICE_ITEMS = 20;

export interface CoordinatorNodeReleaseContext {
  storage: StorageService;
  /**
   * The coordinator's main conversation address, starting one if the user
   * closed it, as a delegation wake does. Null when the coordinator is gone.
   */
  mainAddress(coordinatorId: string): Promise<{ environmentId: string; tabId: string } | null>;
  /** A node's display name, best effort; the id when it cannot be read. */
  nodeName(nodeId: string): Promise<string>;
  now?: () => number;
  /** Overrides {@link NODE_OFFLINE_NOTICE_MS}; for tests. */
  offlineNoticeMs?: number;
}

/**
 * Coordinator work on nodes that are gone from here, or have been silent for
 * a long time.
 *
 * Released (`release`): the user forgot a node or handed it to another
 * command node. Whatever this command node was waiting on there can no longer
 * arrive, so its records close in one write (`releaseCoordinatorNodeWorkflows`)
 * and each coordinator with live work there hears one notice. Records that
 * name a node missing from the registry, such as those of a node forgotten
 * before this existed, are released the same way by `releaseUnregistered` on
 * the sweep. A notice that could not be sent stays owed on the record and is
 * retried by `deliverNotices`.
 *
 * Offline (`noteRead`): an unreachable node is no news, and its delegations
 * stay open so a report collected on reconnect is still delivered. After
 * {@link NODE_OFFLINE_NOTICE_MS} of failed reads with no success between,
 * each coordinator waiting on the node is told once for that episode. The
 * clock is in memory: a restart only restarts it.
 */
export class CoordinatorNodeReleases {
  private readonly offline = new Map<string, { since: number; told: Set<string>; done: boolean }>();
  private readonly offlineChecks = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly context: CoordinatorNodeReleaseContext) {
    this.now = context.now ?? Date.now;
  }

  /**
   * Close the work on a node this command node no longer controls, and say
   * so. Returns the ids of the records whose live work it closed.
   */
  async release(
    nodeId: string,
    reason: CoordinatorNodeRelease["reason"],
    name?: string,
  ): Promise<string[]> {
    this.offline.delete(nodeId);
    const closed = await this.context.storage.coordinators.releaseCoordinatorNodeWorkflows(
      nodeId,
      reason,
      new Date(this.now()).toISOString(),
    );
    await this.deliverNotices(name ? new Map([[nodeId, name]]) : undefined);
    return closed.map((association) => association.id);
  }

  /** Release every node a record names that the registry no longer holds. */
  async releaseUnregistered(registered: ReadonlySet<string>): Promise<void> {
    for (const nodeId of await this.context.storage.coordinators.listCoordinatorWorkflowNodeIds()) {
      if (registered.has(nodeId)) continue;
      log.info("node-release.unregistered", { nodeId });
      this.offline.delete(nodeId);
      await this.context.storage.coordinators.releaseCoordinatorNodeWorkflows(
        nodeId,
        "unregistered",
        new Date(this.now()).toISOString(),
      );
    }
    await this.deliverNotices();
  }

  /** Send every owed release notice: one per coordinator, node and release. */
  async deliverNotices(names?: ReadonlyMap<string, string>): Promise<void> {
    const owed = await this.context.storage.coordinators.listCoordinatorNodeReleaseNoticesOwed();
    const groups = new Map<string, CoordinatorWorkflowAssociation[]>();
    for (const association of owed) {
      const key = [association.coordinatorId, association.nodeId, association.nodeRelease!.at].join(
        "\0",
      );
      groups.set(key, [...(groups.get(key) ?? []), association]);
    }
    for (const group of groups.values()) {
      const first = group[0]!;
      const nodeId = first.nodeId!;
      try {
        const name =
          names?.get(nodeId) ?? (await this.context.nodeName(nodeId).catch(() => nodeId));
        const sent = await this.sendNotice(first.coordinatorId, first.projectId, nodeId, {
          requestId: `node-release-${nodeId}-${first.coordinatorId}-${first.nodeRelease!.at}`,
          ...releaseNotice(first.nodeRelease!.reason, name, nodeId, group),
        });
        // A coordinator that is gone has nobody left to tell.
        await this.context.storage.coordinators.markCoordinatorNodeReleaseNotified(
          group.map((association) => association.id),
          new Date(this.now()).toISOString(),
        );
        if (!sent) log.debug("node-release.no-coordinator", { nodeId });
      } catch (error) {
        // Owed until sent; the sweep retries, so say it once per failure run.
        log.throttled("warn", "node-release.notice-failed", {
          scope: nodeId,
          error,
          fields: () => ({ nodeId, kind: logErrorKind(error) }),
        });
      }
    }
  }

  /**
   * One read of a worker on `nodeId` answered or did not. A failed read starts
   * or continues the node's offline episode; any answer ends it.
   */
  noteRead(nodeId: string, answered: boolean): Promise<void> {
    if (answered) {
      this.offline.delete(nodeId);
      return Promise.resolve();
    }
    const now = this.now();
    let episode = this.offline.get(nodeId);
    if (!episode) {
      episode = { since: now, told: new Set(), done: false };
      this.offline.set(nodeId, episode);
    }
    const threshold = this.context.offlineNoticeMs ?? NODE_OFFLINE_NOTICE_MS;
    if (episode.done || now - episode.since < threshold) return Promise.resolve();
    // Several delegations on one node are read in the same sweep: one check at a time.
    const running = this.offlineChecks.get(nodeId);
    if (running) return running;
    const check = this.tellOffline(nodeId, episode).finally(() => {
      if (this.offlineChecks.get(nodeId) === check) this.offlineChecks.delete(nodeId);
    });
    this.offlineChecks.set(nodeId, check);
    return check;
  }

  private async tellOffline(
    nodeId: string,
    episode: { since: number; told: Set<string>; done: boolean },
  ): Promise<void> {
    const open = (await this.context.storage.coordinators.listOpenCoordinatorDelegations()).filter(
      (association) => association.nodeId === nodeId,
    );
    const byCoordinator = new Map<string, CoordinatorWorkflowAssociation[]>();
    for (const association of open) {
      if (episode.told.has(association.coordinatorId)) continue;
      byCoordinator.set(association.coordinatorId, [
        ...(byCoordinator.get(association.coordinatorId) ?? []),
        association,
      ]);
    }
    let failed = false;
    const since = new Date(episode.since).toISOString();
    const name = await this.context.nodeName(nodeId).catch(() => nodeId);
    for (const [coordinatorId, group] of byCoordinator) {
      try {
        await this.sendNotice(coordinatorId, group[0]!.projectId, nodeId, {
          requestId: `node-offline-${nodeId}-${coordinatorId}-${since}`,
          subject: `Machine ${name} unreachable since ${since}`,
          body:
            `Machine ${name} (nodeId ${nodeId}) has not answered since ${since}. ` +
            `Your ${group.length === 1 ? "delegation" : "delegations"} to ${describeWork(group)} ${group.length === 1 ? "stays" : "stay"} open: the work may still finish there, and a report collected when the machine reconnects is still delivered to you. ` +
            `You will not be told again while it stays unreachable. If the machine is gone for good, ask the user to forget it in Machines settings, which closes this work here.`,
        });
        episode.told.add(coordinatorId);
      } catch (error) {
        failed = true;
        log.throttled("warn", "node-offline.notice-failed", {
          scope: nodeId,
          error,
          fields: () => ({ nodeId, kind: logErrorKind(error) }),
        });
      }
    }
    // A failed send is retried on the next failed read of the same episode.
    if (!failed && this.offline.get(nodeId) === episode) episode.done = true;
  }

  /**
   * Store one system notice for a coordinator's main conversation. False when
   * the coordinator is gone. A notice already stored under the same id counts
   * as sent.
   */
  private async sendNotice(
    coordinatorId: string,
    projectId: string,
    nodeId: string,
    mail: { requestId: string; subject: string; body: string },
  ): Promise<boolean> {
    const address = await this.context.mainAddress(coordinatorId);
    if (!address) return false;
    try {
      await this.context.storage.sendAgentMail(
        { kind: "system", projectId, source: "workflow", resourceId: nodeId },
        {
          requestId: mail.requestId,
          toEnvironmentId: address.environmentId,
          toTabId: address.tabId,
          subject: mail.subject,
          body: mail.body,
        },
      );
    } catch (error) {
      if (error instanceof AgentMailError && error.code === "idempotency-conflict") return true;
      throw error;
    }
    return true;
  }
}

function releaseNotice(
  reason: CoordinatorNodeRelease["reason"],
  name: string,
  nodeId: string,
  group: readonly CoordinatorWorkflowAssociation[],
): { subject: string; body: string } {
  const work = describeWork(group);
  const machine = `Machine ${name} (nodeId ${nodeId})`;
  if (reason === "handed-over")
    return {
      subject: `Machine ${name} handed over: no longer controlled here`,
      body:
        `${machine} was handed over to another command node, so it is no longer controlled here. ` +
        `Its work may still be running under that command node, but it cannot report here: ${work}. ` +
        `Do not wait on it; ask the user if you need its results.`,
    };
  if (reason === "forgotten")
    return {
      subject: `Machine ${name} forgotten: its work closed here`,
      body:
        `The user forgot ${machine} on this command node. Nothing on it was stopped or deleted, but it can no longer be reached from here, so this work was closed as stopped and will not report here: ${work}. ` +
        `A report that already arrived is delivered as ordinary mail. Do not wait on it; ask the user if the work still matters.`,
    };
  return {
    subject: `Machine ${name} no longer registered here`,
    body:
      `${machine} is no longer registered on this command node (it was forgotten or handed to another command node), so this work cannot report here and was closed: ${work}. ` +
      `A report that already arrived is delivered as ordinary mail. Do not wait on it; ask the user if the work still matters.`,
  };
}

/** The records a notice is about, named and bounded. */
function describeWork(group: readonly CoordinatorWorkflowAssociation[]): string {
  const named = group
    .slice(0, MAX_NOTICE_ITEMS)
    .map((association) =>
      association.kind === "environment"
        ? `worker environment ${association.resourceId}${association.delegation ? ` (tab ${association.delegation.workerTabId})` : ""}`
        : `${association.kind} ${association.resourceId}`,
    );
  const more = group.length - named.length;
  return `${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
