import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import { createLogger, logErrorKind } from "@orkestrator/protocol/logger";
import type { StorageService } from "./storage.js";

const log = createLogger("coordinator");

/** How long a refused attempt is worth a wake; older ones are dropped unannounced. */
export const NODE_RECONNECT_WAKE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** At most this many disconnected nodes are remembered at once. */
export const NODE_RECONNECT_WAKE_MAX_NODES = 64;
/** At most this many coordinators are remembered per node. */
export const NODE_RECONNECT_WAKE_MAX_WAITERS = 32;

export interface CoordinatorNodeAttempt {
  projectId: string;
  coordinatorId: string;
  nodeId: string;
  /** The node's display name when the refusal knew it; looked up on reconnect otherwise. */
  nodeName?: string;
}

interface Waiter {
  projectId: string;
  coordinatorId: string;
  firstAt: number;
  lastAt: number;
  attempts: number;
}

export interface CoordinatorNodeReconnectContext {
  storage: Pick<StorageService, "sendAgentMail">;
  /**
   * The coordinator's main conversation address, starting one if the user
   * closed it, as other coordinator notices do. Only the main launches, and
   * side conversations take mail from the main alone. Null when the
   * coordinator is gone.
   */
  mainAddress(coordinatorId: string): Promise<{ environmentId: string; tabId: string } | null>;
  /** A node's display name, best effort; the id when it cannot be read. */
  nodeName(nodeId: string): Promise<string>;
  now?: () => number;
  /** Overrides {@link NODE_RECONNECT_WAKE_MAX_AGE_MS}; for tests. */
  maxAgeMs?: number;
}

/**
 * Wakes for coordinators whose call on a node was refused because the node
 * was not connected (3800 task 8).
 *
 * Launches, builds and reviews on a disconnected node are refused, never
 * queued: a queued launch would start from a stale base, and an outcome lost
 * to a disconnect could not be resolved without risking a second run. So
 * nothing about the work is kept here, only who tried. When the node
 * reconnects, each coordinator that tried hears once, in its main
 * conversation, that it is back, and decides for itself whether to retry,
 * with a fresh base.
 *
 * In memory and bounded: a restart forgets the attempts (the coordinator
 * already holds the refusal it was given), an attempt older than
 * {@link NODE_RECONNECT_WAKE_MAX_AGE_MS} is dropped when the node returns, and
 * the oldest node or coordinator is evicted past the count bounds.
 */
export class CoordinatorNodeReconnectWakes {
  private readonly waiting = new Map<string, Map<string, Waiter>>();
  private readonly names = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly context: CoordinatorNodeReconnectContext) {
    this.now = context.now ?? Date.now;
  }

  /** A coordinator's call naming `nodeId` was refused: the node is not connected. */
  noteRefused(attempt: CoordinatorNodeAttempt): void {
    const now = this.now();
    let waiters = this.waiting.get(attempt.nodeId);
    if (waiters) {
      // Most recent node last, so the eviction below drops the stalest.
      this.waiting.delete(attempt.nodeId);
    } else {
      waiters = new Map();
    }
    this.waiting.set(attempt.nodeId, waiters);
    if (attempt.nodeName) this.names.set(attempt.nodeId, attempt.nodeName);
    while (this.waiting.size > NODE_RECONNECT_WAKE_MAX_NODES) {
      const oldest = this.waiting.keys().next().value as string;
      this.waiting.delete(oldest);
      this.names.delete(oldest);
    }
    const key = attempt.coordinatorId;
    const existing = waiters.get(key);
    waiters.delete(key);
    waiters.set(key, {
      projectId: attempt.projectId,
      coordinatorId: attempt.coordinatorId,
      firstAt: existing?.firstAt ?? now,
      lastAt: now,
      attempts: (existing?.attempts ?? 0) + 1,
    });
    while (waiters.size > NODE_RECONNECT_WAKE_MAX_WAITERS) {
      const oldest = waiters.keys().next().value as string;
      waiters.delete(oldest);
    }
  }

  /** How many coordinators wait on `nodeId`; for tests and diagnostics. */
  waitingOn(nodeId: string): number {
    return this.waiting.get(nodeId)?.size ?? 0;
  }

  /**
   * `nodeId` connected (again). Each coordinator that tried it while it was
   * disconnected is told once. Never throws: a notice that cannot be sent is
   * logged and dropped, since the coordinator already holds the refusal.
   */
  async nodeConnected(nodeId: string): Promise<void> {
    const waiters = this.waiting.get(nodeId);
    if (!waiters) return;
    this.waiting.delete(nodeId);
    const known = this.names.get(nodeId);
    this.names.delete(nodeId);
    const now = this.now();
    const maxAge = this.context.maxAgeMs ?? NODE_RECONNECT_WAKE_MAX_AGE_MS;
    const due = [...waiters.values()].filter((waiter) => now - waiter.lastAt <= maxAge);
    if (due.length === 0) return;
    const looked = await this.context.nodeName(nodeId).catch(() => nodeId);
    const name = looked === nodeId && known ? known : looked;
    for (const waiter of due) {
      try {
        await this.tell(nodeId, name, waiter);
      } catch (error) {
        log.throttled("warn", "node-reconnect.notice-failed", {
          scope: nodeId,
          error,
          fields: () => ({ nodeId, kind: logErrorKind(error) }),
        });
      }
    }
  }

  private async tell(nodeId: string, name: string, waiter: Waiter): Promise<void> {
    const address = await this.context.mainAddress(waiter.coordinatorId);
    if (!address) return;
    const first = new Date(waiter.firstAt).toISOString();
    const last = new Date(waiter.lastAt).toISOString();
    const when =
      waiter.attempts === 1
        ? `at ${first}`
        : `${waiter.attempts} times between ${first} and ${last}`;
    try {
      await this.context.storage.sendAgentMail(
        { kind: "system", projectId: waiter.projectId, source: "workflow", resourceId: nodeId },
        {
          requestId: `node-reconnect-${nodeId}-${waiter.coordinatorId}-${first}`,
          toEnvironmentId: address.environmentId,
          toTabId: address.tabId,
          subject: `Machine ${name} reconnected`,
          body:
            `Machine ${name} (nodeId ${nodeId}) is connected again. You tried to use it ${when} while it was disconnected, and nothing was started or queued there. ` +
            `If that work is still wanted, retry it now: take a fresh baseBranch and baseCommit from get_launch_options with this nodeId first, since the base you had may be stale. ` +
            `If it already ran on another machine, or is no longer needed, there is nothing to do.`,
        },
      );
    } catch (error) {
      if (error instanceof AgentMailError && error.code === "idempotency-conflict") return;
      throw error;
    }
  }
}

/** Shared production subscription; returns the source's explicit cleanup handle. */
export function connectCoordinatorNodeWakes(
  source: { onNodeConnected(listener: (nodeId: string) => void): () => void },
  target: { nodeConnected(nodeId: string): Promise<void> },
): () => void {
  return source.onNodeConnected((nodeId) => void target.nodeConnected(nodeId));
}
