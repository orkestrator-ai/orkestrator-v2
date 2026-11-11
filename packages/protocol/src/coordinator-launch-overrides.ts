import type {
  CoordinatorDelegation,
  CoordinatorDelegationRequest,
  CoordinatorWorkflowAssociation,
} from "./coordinator.js";

/**
 * Worker tabs whose launch by this backend's coordinators overrode the saved
 * default, for the marker on the tab. Derived from the delegations the
 * coordinator store already holds, so a tab with no delegation is simply
 * absent.
 *
 * A worker this node's coordinator launched on another node carries that
 * node's `nodeId`: its delegation is kept here, on the command node, while its
 * tab renders on that node's scope. The renderer looks such a tab up in the
 * command scope's answer by node (docs/architecture/coordinator.md, "Launch defaults").
 */
export interface CoordinatorLaunchOverride {
  /** The node that holds the worker, when it is not the node that answered. */
  nodeId?: string;
  environmentId: string;
  tabId: string;
  model?: string;
  reasoning?: string;
}

/** A worker on another node: the same row, with the node always named. */
export type RemoteCoordinatorLaunchOverride = CoordinatorLaunchOverride & { nodeId: string };

/**
 * The answer of `list_coordinator_launch_overrides`.
 *
 * `overrides` holds the answering node's own tabs, never with a `nodeId`.
 * Workers on other nodes are in `remoteOverrides`, each with its `nodeId`, in a
 * list of their own: an older renderer reads only `overrides`
 * and keys a row by environment and tab alone, so a remote row there would
 * mark whichever of its own tabs had the same ids.
 */
export interface CoordinatorLaunchOverridesSnapshot {
  overrides: CoordinatorLaunchOverride[];
  /** Absent from a backend that predates it, and when there are none. */
  remoteOverrides?: RemoteCoordinatorLaunchOverride[];
}

export const COORDINATOR_LAUNCH_OVERRIDES_COMMAND = "list_coordinator_launch_overrides";

const time = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * What one tab's launch reported: the newest of that tab's requests that states
 * a `source`. Only a launch states one, so mail and commands sent to the worker
 * afterwards do not clear it, and a tab the coordinator only messaged has none.
 */
export function coordinatorTabLaunchRequest(
  delegations: readonly CoordinatorDelegation[],
): CoordinatorDelegationRequest | undefined {
  let newest: CoordinatorDelegation | undefined;
  for (const delegation of delegations) {
    if (!delegation.request?.source) continue;
    if (!newest || time(delegation.requestedAt) >= time(newest.requestedAt)) newest = delegation;
  }
  return newest?.request;
}

/**
 * The key one worker tab's override is held under: its node (empty for the
 * node that answered), environment and tab.
 */
export function coordinatorLaunchOverrideKey(
  nodeId: string | undefined,
  environmentId: string,
  tabId: string,
): string {
  return `${nodeId ?? ""}\u0000${environmentId}\u0000${tabId}`;
}

/**
 * Every worker tab whose launch was `requested`, from a store's associations:
 * this node's own workers, and those its coordinators launched on other nodes
 * (with that node's `nodeId`).
 */
export function coordinatorLaunchOverrides(
  associations: readonly CoordinatorWorkflowAssociation[],
): CoordinatorLaunchOverride[] {
  const tabs = new Map<
    string,
    {
      nodeId: string | undefined;
      environmentId: string;
      tabId: string;
      delegations: CoordinatorDelegation[];
    }
  >();
  for (const association of associations) {
    const delegation = association.delegation;
    if (association.kind !== "environment" || association.pending) continue;
    if (!delegation) continue;
    const nodeId = association.nodeId || undefined;
    const key = coordinatorLaunchOverrideKey(
      nodeId,
      association.resourceId,
      delegation.workerTabId,
    );
    const tab = tabs.get(key);
    if (tab) tab.delegations.push(delegation);
    else {
      tabs.set(key, {
        nodeId,
        environmentId: association.resourceId,
        tabId: delegation.workerTabId,
        delegations: [delegation],
      });
    }
  }
  return Array.from(tabs.values()).flatMap(({ nodeId, environmentId, tabId, delegations }) => {
    const launch = coordinatorTabLaunchRequest(delegations);
    if (launch?.source !== "requested") return [];
    return [
      {
        ...(nodeId ? { nodeId } : {}),
        environmentId,
        tabId,
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.reasoning ? { reasoning: launch.reasoning } : {}),
      },
    ];
  });
}

/** The command's answer from a store's associations: own tabs and other nodes' apart. */
export function coordinatorLaunchOverridesSnapshot(
  associations: readonly CoordinatorWorkflowAssociation[],
): CoordinatorLaunchOverridesSnapshot {
  const all = coordinatorLaunchOverrides(associations);
  const remoteOverrides = all.filter((override): override is RemoteCoordinatorLaunchOverride =>
    Boolean(override.nodeId),
  );
  return {
    overrides: all.filter((override) => !override.nodeId),
    ...(remoteOverrides.length > 0 ? { remoteOverrides } : {}),
  };
}

function parseRows(raw: unknown, remote: boolean): CoordinatorLaunchOverride[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const { nodeId, environmentId, tabId, model, reasoning } = entry as Record<string, unknown>;
    if (typeof environmentId !== "string" || !environmentId) return [];
    if (typeof tabId !== "string" || !tabId) return [];
    // A remote row names its node; an own row naming one is malformed. Either
    // way a doubtful row is dropped rather than allowed to mark a local tab.
    if (remote ? typeof nodeId !== "string" || !nodeId : nodeId !== undefined) return [];
    return [
      {
        ...(remote ? { nodeId: nodeId as string } : {}),
        environmentId,
        tabId,
        ...(typeof model === "string" && model ? { model } : {}),
        ...(typeof reasoning === "string" && reasoning ? { reasoning } : {}),
      },
    ];
  });
}

/** Accepts a snapshot from any backend; anything malformed reads as no override. */
export function parseCoordinatorLaunchOverrides(
  value: unknown,
): CoordinatorLaunchOverridesSnapshot {
  const snapshot = value as { overrides?: unknown; remoteOverrides?: unknown } | null | undefined;
  const overrides = parseRows(snapshot?.overrides, false);
  const remoteOverrides = parseRows(
    snapshot?.remoteOverrides,
    true,
  ) as RemoteCoordinatorLaunchOverride[];
  return { overrides, ...(remoteOverrides.length > 0 ? { remoteOverrides } : {}) };
}
