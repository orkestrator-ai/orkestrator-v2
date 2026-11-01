import type { AgentsMdPrResult } from "./agents-md-pr.js";
import { KeyedSingleFlight } from "./keyed-single-flight.js";

/**
 * Coordinator requests in flight in one backend: receipt attempts per
 * coordinator and request id (`withCoordinatorReceipt`), and AGENTS.md pull
 * request runs per request key (`openAgentsMdPullRequest`). Owned by
 * `BackendRuntime` as `coordinatorRequests` and reached through
 * `context.runtime` at call time.
 */
export class CoordinatorRequestFlights {
  private readonly receipts = new Map<string, Promise<Record<string, unknown>>>();
  private readonly agentsMdPullRequests = new KeyedSingleFlight<AgentsMdPrResult>();

  /** The receipt attempt in flight for `key`, if any. */
  receiptAttempt(key: string): Promise<Record<string, unknown>> | undefined {
    return this.receipts.get(key);
  }

  /** Records `attempt` as the one in flight for `key` until it settles. */
  async trackReceiptAttempt(
    key: string,
    attempt: Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    this.receipts.set(key, attempt);
    try {
      return await attempt;
    } finally {
      if (this.receipts.get(key) === attempt) this.receipts.delete(key);
    }
  }

  /** Joins the request key's AGENTS.md pull request run, or starts one. */
  joinAgentsMdPullRequest(
    key: string,
    open: () => Promise<AgentsMdPrResult>,
  ): Promise<AgentsMdPrResult> {
    return this.agentsMdPullRequests.run(key, open);
  }
}
