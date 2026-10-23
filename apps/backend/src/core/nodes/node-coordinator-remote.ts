import type { AgentRegistrySnapshot } from "@orkestrator/protocol/agent-registry";
import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";
import { RESOURCE_CHANGED_EVENT, type ResourceChange } from "@orkestrator/protocol/resource-events";

import { nativeTab } from "../control-shared-actions.js";
import type {
  CoordinatorRemoteAccess,
  RemoteWorkerState,
  RemoteWorkflowRecord,
} from "../coordinator-remote.js";
import { lastAssistantText } from "../coordinator-status-wakes.js";

/**
 * The command node's reads of coordinator work on the nodes it controls,
 * through the node link, and the edges that make them prompt: a node's
 * relayed environment and workflow changes settle remote delegations and
 * observe remote workflows within seconds rather than on the next sweep.
 *
 * Reads only. A node that is not connected, or a call that fails, reads as
 * `"unavailable"`, which callers treat as no news.
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export interface NodeCoordinatorRemoteDeps {
  /** Route one read to a node; resolves `{ outcome: "ok", result }` when it answered. */
  invokeOnNode(input: {
    nodeId: string;
    command: string;
    args: Record<string, unknown>;
  }): Promise<{ outcome: string; result?: unknown }>;
  summaries(nodeIds?: string[]): Promise<NodeSummariesResult>;
}

/** A routed read, or `"unavailable"` when the node did not answer. */
async function read<T>(
  deps: NodeCoordinatorRemoteDeps,
  nodeId: string,
  command: string,
  args: Record<string, unknown>,
): Promise<T | "unavailable"> {
  try {
    const routed = await deps.invokeOnNode({ nodeId, command, args });
    return routed.outcome === "ok" ? (routed.result as T) : "unavailable";
  } catch {
    return "unavailable";
  }
}

export class NodeCoordinatorRemote implements CoordinatorRemoteAccess {
  constructor(private readonly deps: NodeCoordinatorRemoteDeps) {}

  async workerState(
    nodeId: string,
    environmentId: string,
    tabId: string,
  ): Promise<RemoteWorkerState> {
    const environment = await read<unknown>(this.deps, nodeId, "get_environment", {
      environmentId,
    });
    if (environment === "unavailable") return "unavailable";
    if (!isRecord(environment)) return { environment: "missing", tab: "unknown" };
    const name = typeof environment.name === "string" ? environment.name : undefined;
    const lifecycle =
      environment.deletionRequestedAt || environment.lifecycleOperation === "deleting"
        ? "deleting"
        : environment.status === "error"
          ? "error"
          : environment.status === "stopped"
            ? "stopped"
            : environment.status === "creating"
              ? "creating"
              : "running";
    if (!tabId || lifecycle !== "running") {
      return { environment: lifecycle, tab: "unknown", ...(name ? { name } : {}) };
    }
    const registry = await read<AgentRegistrySnapshot>(this.deps, nodeId, "get_agent_registry", {
      ...(typeof environment.projectId === "string" ? { projectId: environment.projectId } : {}),
      environmentId,
    });
    if (registry === "unavailable") return "unavailable";
    const entry = (
      isRecord(registry) && Array.isArray(registry.entries) ? registry.entries : []
    ).find((candidate) => candidate.environmentId === environmentId && candidate.tabId === tabId);
    return { environment: lifecycle, tab: entry?.state ?? "unknown", ...(name ? { name } : {}) };
  }

  async lastAssistantExcerpt(
    nodeId: string,
    environmentId: string,
    tabId: string,
  ): Promise<string | undefined> {
    const layout = await read<unknown>(this.deps, nodeId, "get_pane_layout", { environmentId });
    if (layout === "unavailable") return undefined;
    const native = nativeTab(layout, tabId);
    if (!native) return undefined;
    const projection = await read<unknown>(this.deps, nodeId, "get_native_agent_projection", {
      environmentId,
      agent: native.agent,
      logicalSessionKey: `env-${environmentId}:${tabId}`,
      messageLimit: 5,
    });
    if (projection === "unavailable" || !isRecord(projection)) return undefined;
    return lastAssistantText(projection.messages);
  }

  async workflow(
    nodeId: string,
    kind: "build-pipeline" | "multi-review",
    id: string,
  ): Promise<RemoteWorkflowRecord | null | "unavailable"> {
    const value = await read<unknown>(
      this.deps,
      nodeId,
      kind === "build-pipeline" ? "get_build_pipeline" : "get_multi_review_workflow",
      kind === "build-pipeline" ? { pipelineId: id } : { workflowId: id },
    );
    if (value === "unavailable") return "unavailable";
    if (!isRecord(value) || !("snapshot" in value)) return null;
    return {
      snapshot: value.snapshot,
      ...(typeof value.revision === "number" ? { revision: value.revision } : {}),
      ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
      ...(typeof value.environmentId === "string" ? { environmentId: value.environmentId } : {}),
    };
  }

  async environmentPr(
    nodeId: string,
    environmentId: string,
  ): Promise<{ prUrl?: unknown; prState?: unknown }> {
    const environment = await read<unknown>(this.deps, nodeId, "get_environment", {
      environmentId,
    });
    if (!isRecord(environment)) return {};
    return { prUrl: environment.prUrl, prState: environment.prState };
  }

  async nodeName(nodeId: string): Promise<string> {
    const summaries = await this.deps.summaries([nodeId]);
    return summaries.nodes[0]?.view.displayName ?? nodeId;
  }
}

const SETTLE_DEBOUNCE_MS = 1_500;

/**
 * Turn a node's relayed resource changes into prompt coordinator work:
 * settle the delegations an environment answers, and observe a workflow's
 * new state. Debounced per resource, since a running environment saves often.
 */
export function bridgeRemoteCoordinatorEvents(input: {
  onNodeEvent(listener: (event: string, payload: unknown, nodeId: string) => void): () => void;
  settleRemoteWorker(nodeId: string, environmentId: string): Promise<void>;
  noteRemoteWorkflowChange(
    nodeId: string,
    kind: "multi-review" | "build-pipeline",
    id: string,
  ): void;
  timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
  };
}): () => void {
  const pending = new Set<string>();
  const schedule = input.timers?.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  return input.onNodeEvent((event, payload, nodeId) => {
    if (event !== RESOURCE_CHANGED_EVENT || !isRecord(payload)) return;
    const change = payload as Partial<ResourceChange>;
    if (typeof change.id !== "string") return;
    if (change.resource === "multi-review" || change.resource === "build-pipeline") {
      input.noteRemoteWorkflowChange(nodeId, change.resource, change.id);
      return;
    }
    if (change.resource !== "environment") return;
    const key = `${nodeId}\0${change.id}`;
    if (pending.has(key)) return;
    pending.add(key);
    const environmentId = change.id;
    const timer = schedule(() => {
      pending.delete(key);
      void input.settleRemoteWorker(nodeId, environmentId).catch((error: unknown) => {
        console.warn(
          "[coordinator] Could not settle a remote worker:",
          error instanceof Error ? error.message : error,
        );
      });
    }, SETTLE_DEBOUNCE_MS);
    (timer as { unref?: () => void } | null)?.unref?.();
  });
}
