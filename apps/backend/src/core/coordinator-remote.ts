import type { AgentTabState } from "@orkestrator/protocol/agent-registry";

/**
 * How the coordinator reads work it started on another node.
 *
 * A coordinator's delegations and workflow associations stay on the command
 * node, with the `nodeId` of the node that holds the resource. Settling a
 * delegation and reducing a workflow to a status wake need that resource's
 * state, which only its node has: this is the read side of the node link the
 * coordinator service and status wakes use for it. Every read is bounded and
 * content-free apart from an assistant excerpt, exactly as the local reads.
 *
 * `"unavailable"` means the node cannot be asked right now (not connected, or
 * the call failed). Callers treat it as "no news": a delegation is never
 * closed and a wake never sent on the strength of a node that did not answer.
 */
export type RemoteWorkerState =
  | "unavailable"
  | {
      /** The environment's lifecycle on its node. */
      environment: "missing" | "deleting" | "error" | "stopped" | "running" | "creating";
      /** The worker tab's turn state; `unknown` when its node does not report it. */
      tab: AgentTabState | "unknown";
      name?: string;
      /**
       * Coordinator mail to that tab has not reached a turn yet, so the turn
       * that ends now cannot be its answer (always false for older nodes).
       */
      requestPending?: boolean;
    };

/** A workflow's persisted record on its node: what the local status reducers read. */
export interface RemoteWorkflowRecord {
  snapshot: unknown;
  revision?: number;
  updatedAt?: string;
  environmentId?: string;
}

export interface CoordinatorRemoteAccess {
  workerState(nodeId: string, environmentId: string, tabId: string): Promise<RemoteWorkerState>;
  /** The worker's last assistant text, best effort. */
  lastAssistantExcerpt(
    nodeId: string,
    environmentId: string,
    tabId: string,
  ): Promise<string | undefined>;
  workflow(
    nodeId: string,
    kind: "build-pipeline" | "multi-review",
    id: string,
  ): Promise<RemoteWorkflowRecord | null | "unavailable">;
  /** An environment's PR fields, for a review's auto-PR report. */
  environmentPr(
    nodeId: string,
    environmentId: string,
  ): Promise<{ prUrl?: unknown; prState?: unknown }>;
  nodeName(nodeId: string): Promise<string>;
  /** True only after a complete outbox drain, including coalesced follow-ups. */
  collectMail?(nodeId: string): Promise<boolean>;
}
