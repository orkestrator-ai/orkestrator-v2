import type {
  CoordinatorDelegation,
  CoordinatorDelegationRequest,
  CoordinatorWorkflowAssociation,
} from "./coordinator.js";

/**
 * Worker tabs on this backend whose launch overrode the saved default, for the
 * marker on the tab. Derived from the delegations the coordinator store already
 * holds, so a tab with no delegation is simply absent. A worker on another node
 * is absent too: its delegation is on the command node, while its tab renders
 * through that node's scope and reads that node's backend.
 */
export interface CoordinatorLaunchOverride {
  environmentId: string;
  tabId: string;
  model?: string;
  reasoning?: string;
}

export interface CoordinatorLaunchOverridesSnapshot {
  overrides: CoordinatorLaunchOverride[];
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

/** Every local worker tab whose launch was `requested`, from a store's associations. */
export function coordinatorLaunchOverrides(
  associations: readonly CoordinatorWorkflowAssociation[],
): CoordinatorLaunchOverride[] {
  const tabs = new Map<
    string,
    { environmentId: string; tabId: string; delegations: CoordinatorDelegation[] }
  >();
  for (const association of associations) {
    const delegation = association.delegation;
    if (association.kind !== "environment" || association.pending || association.nodeId) continue;
    if (!delegation) continue;
    const key = `${association.resourceId}\u0000${delegation.workerTabId}`;
    const tab = tabs.get(key);
    if (tab) tab.delegations.push(delegation);
    else {
      tabs.set(key, {
        environmentId: association.resourceId,
        tabId: delegation.workerTabId,
        delegations: [delegation],
      });
    }
  }
  return Array.from(tabs.values()).flatMap(({ environmentId, tabId, delegations }) => {
    const launch = coordinatorTabLaunchRequest(delegations);
    if (launch?.source !== "requested") return [];
    return [
      {
        environmentId,
        tabId,
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.reasoning ? { reasoning: launch.reasoning } : {}),
      },
    ];
  });
}

/** Accepts a snapshot from any backend; anything malformed reads as no override. */
export function parseCoordinatorLaunchOverrides(
  value: unknown,
): CoordinatorLaunchOverridesSnapshot {
  const raw = (value as { overrides?: unknown } | null | undefined)?.overrides;
  if (!Array.isArray(raw)) return { overrides: [] };
  return {
    overrides: raw.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const { environmentId, tabId, model, reasoning } = entry as Record<string, unknown>;
      if (typeof environmentId !== "string" || !environmentId) return [];
      if (typeof tabId !== "string" || !tabId) return [];
      return [
        {
          environmentId,
          tabId,
          ...(typeof model === "string" && model ? { model } : {}),
          ...(typeof reasoning === "string" && reasoning ? { reasoning } : {}),
        },
      ];
    }),
  };
}
