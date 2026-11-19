/**
 * One target's effective resources from the capabilities store
 * (docs/architecture/agent-capabilities-management.md, "Resolution"). The
 * layers are built here from the setups and assignments; the resolver itself
 * is `resolveEffectiveAgentResources` in the protocol package.
 */
import {
  MY_SETUP_ID,
  type CapabilityPackageSelection,
  type CapabilityTarget,
  type EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilityInventory } from "@orkestrator/protocol/capability-resources-api";
import {
  resolveEffectiveAgentResources,
  type CapabilityLayer,
  type CapabilityPermissionCeiling,
} from "@orkestrator/protocol/capability-resources-resolve";

import { sha256, supportFor } from "./planning.js";
import { scopedRequiredDelivery, type ScopedEvidence } from "./scoped-delivery.js";
import type { CapabilityState } from "./types.js";

export interface CapabilityResolveInput {
  target: CapabilityTarget;
  setupIds?: string[];
  selections?: CapabilityPackageSelection[];
  exclusions?: string[];
  templateId?: string;
  graphNode?: string;
  sessionKey?: string;
  ceiling: CapabilityPermissionCeiling;
  launchInventory?: CapabilityInventory;
  forLaunch?: boolean;
  /** A worktree's, account's or container's own copies (`scoped-delivery.ts`). */
  scopedEvidence?: ScopedEvidence;
}

/** The setups one scope is assigned (`project:<id>`, `session:<key>`, ...). */
export function assignmentSetups(
  state: CapabilityState,
  scope: string,
  id: string | undefined,
): string[] {
  if (!id) return [];
  return state.assignments[`${scope}:${id}`]?.setupIds ?? [];
}

/**
 * One target's effective resources: My setup (when the machine is
 * enrolled), then the project, template, graph-node and session
 * assignments, then any explicit selections, all narrowed by `ceiling`.
 */
export function resolveCapabilityTarget(
  state: CapabilityState,
  input: CapabilityResolveInput,
  now: () => string,
): EffectiveAgentResources {
  const machine = state.machines[input.target.nodeId];
  const layers: CapabilityLayer[] = [
    { scope: "my-setup", setupIds: [MY_SETUP_ID] },
    {
      scope: "toolkit",
      setupIds: Object.values(state.setups)
        .filter(
          (setup) =>
            setup.id !== MY_SETUP_ID &&
            (!setup.targetSelectors || setup.targetSelectors.length === 0) &&
            setup.machineSelectors.length > 0,
        )
        .map((setup) => setup.id),
    },
    {
      scope: "project",
      setupIds: assignmentSetups(state, "project", input.target.projectId),
    },
    {
      scope: "template",
      setupIds: [
        ...assignmentSetups(state, "template", input.templateId),
        ...assignmentSetups(state, "environment", input.target.environmentId),
      ],
    },
    {
      scope: "graph-node",
      setupIds: assignmentSetups(state, "graph-node", input.graphNode),
    },
    {
      scope: "session",
      setupIds: [
        ...assignmentSetups(state, "session", input.sessionKey),
        ...(input.setupIds ?? []),
      ],
      selections: input.selections ?? [],
      exclusions: input.exclusions ?? [],
    },
  ];
  return resolveEffectiveAgentResources({
    facts: {
      target: input.target,
      groups: machine?.groups ?? [],
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.graphNode ? { graphNode: input.graphNode } : {}),
      enrolled: machine?.enrolled ?? state.settings.enrollNewMachines,
    },
    layers,
    setups: new Map(Object.entries(state.setups)),
    packages: new Map(Object.entries(state.packages)),
    components: new Map(Object.entries(state.components)),
    support: supportFor(
      input.launchInventory ?? machine?.inventory,
      input.target.provider,
      input.target.environmentIncarnation !== undefined ? "container" : "host",
    ),
    ...(input.forLaunch
      ? {
          requiredDelivery: (component, digest) => {
            // Containers, added accounts and worktrees answer from their own copies first.
            const scoped = scopedRequiredDelivery({
              state,
              target: input.target,
              ...(input.scopedEvidence ? { evidence: input.scopedEvidence } : {}),
              component,
              digest,
            });
            if (scoped.kind === "verified") return undefined;
            if (scoped.kind === "refused") return scoped.reason;
            // A Claude plugin's parts are delivered by the plugin's own receipt.
            const deliveredBy = new Set([
              component.id,
              ...(input.target.provider === "claude"
                ? component.dependencies.filter(
                    (id) => state.components[id]?.kind === "native-plugin",
                  )
                : []),
            ]);
            const matching = Object.values(state.receipts).some((receipt) => {
              if (
                receipt.nodeId !== input.target.nodeId ||
                !receipt.providers.includes(input.target.provider) ||
                !deliveredBy.has(receipt.componentId) ||
                receipt.packageDigest !== digest ||
                receipt.outcomeUnknown ||
                (receipt.status !== "installed-next-session" && receipt.status !== "ready")
              )
                return false;
              return (
                input.launchInventory?.items.some(
                  (item) =>
                    item.ownership === "managed" &&
                    item.componentId === receipt.componentId &&
                    item.locationId === receipt.locationId &&
                    !item.drifted &&
                    item.digest === receipt.digest,
                ) === true
              );
            });
            return matching
              ? undefined
              : `The required revision of ${component.name} is not verified on this machine.`;
          },
        }
      : {}),
    ceiling: input.ceiling,
    admin: {
      forbiddenSources: state.settings.forbiddenSources,
      forbiddenComponents: state.settings.forbiddenComponents,
    },
    hash: sha256,
    now,
  });
}
