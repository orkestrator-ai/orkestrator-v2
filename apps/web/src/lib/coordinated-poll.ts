import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { getReadCoordinator, readCoordinatorFor, type ReadPriority } from "@/lib/read-coordinator";

const log = createLogger("web.read-coordinator");

export interface CoordinatedPollOptions {
  /** Names the poll in the coordinator's diagnostics. */
  resource: string;
  /** What it reads, when several instances can run (an environment, a machine). */
  target?: string;
  intervalMs: number;
  /** How soon it reads on the window's return. Defaults to `standard`. */
  priority?: ReadPriority;
  /** The caller's own read; applying the result stays with the caller. */
  read: () => unknown;
  /**
   * The node the read goes to: the poll is scheduled on that scope's
   * coordinator, so its connectivity and reconnects pause and reconcile it.
   * Defaults to the command scope.
   */
  scope?: NodeScope;
}

let nextInstance = 0;

/**
 * A `setInterval` for a read, owned by the shared read coordinator: no read
 * while the window is hidden or the transport has declared itself disconnected,
 * and one read soon after it returns if the interval has passed meanwhile. A
 * tick that lands while the last read is running is skipped. Returns the stop
 * function, so it replaces `setInterval` and `clearInterval` where they stand.
 *
 * Reads only: never drive a mutation from this, as it does not run while the
 * window is hidden. A failed read keeps the same interval, as an interval did;
 * the caller reports failures itself.
 */
export function startCoordinatedPoll({
  resource,
  target = "",
  intervalMs,
  priority = "standard",
  read,
  scope,
}: CoordinatedPollOptions): () => void {
  nextInstance += 1;
  const coordinator = scope ? readCoordinatorFor(scope) : getReadCoordinator();
  const subscription = coordinator.subscribe<void>({
    // Each poll applies its own result, so no two are equivalent reads.
    key: { resource, target, view: `poll-${nextInstance}` },
    demand: { intervalMs, priority },
    readOnSubscribe: false,
    retainOnDispose: false,
    read: async () => {
      try {
        await read();
      } catch (error) {
        log.warn("poll.read-failed", { resource, error: formatLogError(error) });
      }
    },
  });
  return () => subscription.dispose();
}
