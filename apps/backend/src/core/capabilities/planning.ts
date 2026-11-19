/**
 * From desired setups to per-machine installation plans
 * (docs/architecture/agent-capabilities-management.md, "Plan" and
 * "Shared physical files").
 *
 * For each enrolled machine and each provider the resolver gives the
 * components that target should have. File components are then grouped by
 * the set of providers that want them and placed with
 * `planCapabilityLocations`, so providers that read the same directory share
 * one physical copy, and every provider that also sees that copy is named.
 * Each physical copy is one installation key (`<node>|<location>|<component>`)
 * with every setup that references it: removing one setup does not remove a
 * copy another still needs.
 *
 * The diff is against what the machine *reports* (its inventory), not
 * against what was last sent: after an unknown outcome the next plan is
 * computed from a fresh observation, so a write is never blindly repeated.
 */
import { createHash } from "node:crypto";

import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  MY_SETUP_ID,
  type CapabilityComponent,
  type CapabilityLiveSemantics,
  type CapabilityPackage,
  type CapabilityPlannedTarget,
  type CapabilitySetup,
  type CapabilityTargetStatus,
  type EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilityInventory } from "@orkestrator/protocol/capability-resources-api";
import {
  canonicalCapabilityJson,
  resolveEffectiveAgentResources,
  UNRESTRICTED_CAPABILITY_CEILING,
  type CapabilityLayer,
} from "@orkestrator/protocol/capability-resources-resolve";
import {
  capabilityLocation,
  describeCapabilitySupport,
  planCapabilityLocations,
  type CapabilitySupportMatrix,
} from "@orkestrator/protocol/capability-resources-support";

import type { NodePlanTarget } from "./executor.js";
import { installName } from "./native-ownership.js";
import type { CapabilityState } from "./types.js";

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** One physical installation the desired state calls for. */
export interface DesiredInstallation {
  key: string;
  nodeId: string;
  /** A file location id, or `mcp:<provider>` / `plugin:<provider>`. */
  locationId: string;
  componentId: string;
  packageId: string;
  digest: string;
  providers: AgentPlatform[];
  alsoVisibleTo: AgentPlatform[];
  references: string[];
}

/** A component a target wanted but cannot have, with the reason. */
export interface UndeliverableComponent {
  nodeId: string;
  provider: AgentPlatform;
  componentId: string;
  packageId: string;
  status: CapabilityTargetStatus;
  reason: string;
}

export interface NodeDesiredState {
  nodeId: string;
  installations: DesiredInstallation[];
  undeliverable: UndeliverableComponent[];
  manifestDigest: string;
  effective: EffectiveAgentResources[];
}

export function installationKey(nodeId: string, locationId: string, componentId: string): string {
  return `${nodeId}|${locationId}|${componentId}`;
}

/**
 * The setups that install files machine-wide: My setup, every toolkit with
 * no narrower target selectors, and every toolkit an assignment uses (its
 * files must be present for the sessions that select it).
 */
export function machineWideSetupIds(state: CapabilityState): string[] {
  const ids = new Set<string>([MY_SETUP_ID]);
  for (const setup of Object.values(state.setups)) {
    if (!setup.targetSelectors || setup.targetSelectors.length === 0) ids.add(setup.id);
  }
  for (const assignment of Object.values(state.assignments)) {
    for (const id of assignment.setupIds) if (state.setups[id]) ids.add(id);
  }
  return [...ids].sort();
}

/** Which setups reference a package, for the installation's reference list. */
function referencingSetups(
  state: CapabilityState,
  packageId: string,
  setupIds: readonly string[],
): string[] {
  return setupIds
    .filter((id) =>
      state.setups[id]?.packageSelections.some((selection) => selection.packageId === packageId),
    )
    .map((id) => `setup:${id}`);
}

export function supportFor(
  inventory: CapabilityInventory | undefined,
  provider: AgentPlatform,
): CapabilitySupportMatrix {
  const entry = inventory?.providers.find((candidate) => candidate.provider === provider);
  return describeCapabilitySupport(provider, {
    location: "host",
    ...(entry ? { available: entry.available } : {}),
    ...(entry?.version ? { providerVersion: entry.version } : {}),
  });
}

function maps(state: CapabilityState) {
  return {
    setups: new Map<string, CapabilitySetup>(Object.entries(state.setups)),
    packages: new Map<string, CapabilityPackage>(Object.entries(state.packages)),
    components: new Map<string, CapabilityComponent>(Object.entries(state.components)),
  };
}

/** The desired installations on one machine. */
export function desiredStateForNode(
  state: CapabilityState,
  nodeId: string,
  inventory: CapabilityInventory | undefined,
): NodeDesiredState {
  const machine = state.machines[nodeId];
  const setupIds = machineWideSetupIds(state);
  const { setups, packages, components } = maps(state);
  const layers: CapabilityLayer[] = [
    { scope: "my-setup", setupIds: [MY_SETUP_ID] },
    { scope: "toolkit", setupIds: setupIds.filter((id) => id !== MY_SETUP_ID) },
  ];
  const effective: EffectiveAgentResources[] = [];
  const undeliverable: UndeliverableComponent[] = [];
  /** componentId -> providers wanting it, with the digest. */
  const wanted = new Map<
    string,
    { providers: Set<AgentPlatform>; digest: string; packageId: string }
  >();
  const plain: DesiredInstallation[] = [];

  for (const provider of AGENT_PLATFORMS) {
    const support = supportFor(inventory, provider);
    const resolved = resolveEffectiveAgentResources({
      facts: {
        target: { nodeId, provider },
        groups: machine?.groups ?? [],
        // A machine seen for the first time follows the enrolment default.
        enrolled: machine?.enrolled ?? state.settings.enrollNewMachines,
      },
      layers,
      setups,
      packages,
      components,
      support,
      ceiling: UNRESTRICTED_CAPABILITY_CEILING,
      admin: {
        forbiddenSources: state.settings.forbiddenSources,
        forbiddenComponents: state.settings.forbiddenComponents,
      },
      hash: sha256,
      now: () => "",
    });
    effective.push(resolved);
    for (const entry of resolved.unsupported) {
      const component = components.get(entry.componentId);
      if (!component) continue;
      // A component with a provider hint for another provider was never meant for this one.
      if (component.providerHints.length > 0 && !component.providerHints.includes(provider))
        continue;
      undeliverable.push({
        nodeId,
        provider,
        componentId: entry.componentId,
        packageId: component.packageId,
        status: "unsupported",
        reason: entry.reason,
      });
    }
    for (const entry of resolved.blocked) {
      const component = components.get(entry.componentId);
      undeliverable.push({
        nodeId,
        provider,
        componentId: entry.componentId,
        packageId: component?.packageId ?? entry.componentId,
        status: "blocked-policy",
        reason: entry.reason,
      });
    }
    for (const pkg of resolved.resolvedPackages) {
      const source = packages.get(pkg.id)?.source;
      for (const componentId of pkg.components) {
        const component = components.get(componentId)!;
        if (component.providerHints.length > 0 && !component.providerHints.includes(provider))
          continue;
        if (component.kind === "mcp-server") {
          const locationId = `mcp:${provider}`;
          plain.push({
            key: installationKey(nodeId, locationId, componentId),
            nodeId,
            locationId,
            componentId,
            packageId: pkg.id,
            digest: pkg.artifactDigest,
            providers: [provider],
            alsoVisibleTo: [],
            references: referencingSetups(state, pkg.id, setupIds),
          });
          continue;
        }
        if (component.kind === "native-plugin") {
          if (provider !== "claude" || source?.kind !== "provider-marketplace") {
            undeliverable.push({
              nodeId,
              provider,
              componentId,
              packageId: pkg.id,
              status: "unsupported",
              reason:
                provider === "claude"
                  ? "Claude installs plugins from a marketplace; this package's other components are delivered individually."
                  : (support.kinds["native-plugin"].install.reason ??
                    "Native plugins are not supported for this provider."),
            });
            continue;
          }
          const locationId = `plugin:${provider}`;
          plain.push({
            key: installationKey(nodeId, locationId, componentId),
            nodeId,
            locationId,
            componentId,
            packageId: pkg.id,
            digest: pkg.artifactDigest,
            providers: [provider],
            alsoVisibleTo: [],
            references: referencingSetups(state, pkg.id, setupIds),
          });
          continue;
        }
        if (component.kind === "hook") {
          undeliverable.push({
            nodeId,
            provider,
            componentId,
            packageId: pkg.id,
            status: "unsupported",
            reason:
              support.kinds.hook.install.reason ??
              "Hooks are delivered only inside a native plugin installed through the provider.",
          });
          continue;
        }
        const entry = wanted.get(componentId) ?? {
          providers: new Set<AgentPlatform>(),
          digest: pkg.artifactDigest,
          packageId: pkg.id,
        };
        entry.providers.add(provider);
        wanted.set(componentId, entry);
      }
    }
  }

  const installations: DesiredInstallation[] = [...plain];
  for (const [componentId, entry] of [...wanted.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const component = components.get(componentId)!;
    const providers = AGENT_PLATFORMS.filter((provider) => entry.providers.has(provider));
    const placement = planCapabilityLocations(component.kind, providers);
    for (const location of placement.locations) {
      const readBy = capabilityLocation(location.id)?.readBy ?? [];
      installations.push({
        key: installationKey(nodeId, location.id, componentId),
        nodeId,
        locationId: location.id,
        componentId,
        packageId: entry.packageId,
        digest: entry.digest,
        providers: location.providers,
        alsoVisibleTo: readBy.filter((provider) => !providers.includes(provider)),
        references: referencingSetups(state, entry.packageId, setupIds),
      });
    }
    for (const provider of placement.uncovered) {
      undeliverable.push({
        nodeId,
        provider,
        componentId,
        packageId: entry.packageId,
        status: "unsupported",
        reason: `${provider} reads no location Orkestrator can write a ${component.kind} to.`,
      });
    }
  }
  installations.sort((a, b) => a.key.localeCompare(b.key));
  const manifestDigest = sha256(
    canonicalCapabilityJson(installations.map((entry) => [entry.key, entry.digest])),
  );
  return { nodeId, installations, undeliverable, manifestDigest, effective };
}

/** What the machine reports at a key: the managed item's package, component and digest. */
export interface ObservedInstallation {
  key: string;
  packageId?: string;
  componentId?: string;
  digest?: string;
  drifted: boolean;
  external: boolean;
}

/** Observed managed items by installation key, and external ones by `<location>/<name>`. */
export function observedInstallations(
  nodeId: string,
  inventory: CapabilityInventory | undefined,
): { byKey: Map<string, ObservedInstallation>; external: Map<string, ObservedInstallation> } {
  const byKey = new Map<string, ObservedInstallation>();
  const external = new Map<string, ObservedInstallation>();
  for (const item of inventory?.items ?? []) {
    if (item.ownership === "managed" && item.componentId) {
      const key = installationKey(nodeId, item.locationId, item.componentId);
      byKey.set(key, {
        key,
        ...(item.packageId ? { packageId: item.packageId } : {}),
        componentId: item.componentId,
        ...(item.digest ? { digest: item.digest } : {}),
        drifted: item.drifted === true,
        external: false,
      });
    } else if (
      item.ownership === "external" &&
      item.locationId !== "mcp" &&
      item.locationId !== "plugin"
    ) {
      external.set(`${item.locationId}/${item.name}`, {
        key: item.id,
        ...(item.digest ? { digest: item.digest } : {}),
        drifted: false,
        external: true,
      });
    }
  }
  return { byKey, external };
}

export interface NodePlan {
  nodeId: string;
  /** Sent to the machine. */
  targets: NodePlanTarget[];
  /** Shown in the preview and the operation: every desired or removed installation. */
  planned: CapabilityPlannedTarget[];
  manifestDigest: string;
}

/**
 * The plan for one machine: install what is missing, update what has an old
 * package digest, remove managed copies nothing references any more, and
 * keep the rest. Removal happens only for items Orkestrator owns.
 */
export function planNode(
  state: CapabilityState,
  desired: NodeDesiredState,
  options: {
    connected: boolean;
    sessionRunning?: boolean;
    forceKeys?: ReadonlySet<string>;
    /** Installations with open local changes: skipped until the user decides. */
    driftKeys?: ReadonlySet<string>;
  },
): NodePlan {
  const targets: NodePlanTarget[] = [];
  const planned: CapabilityPlannedTarget[] = [];
  const desiredKeys = new Set(desired.installations.map((entry) => entry.key));
  const receipts = Object.values(state.receipts).filter(
    (receipt) => receipt.nodeId === desired.nodeId,
  );

  for (const installation of desired.installations) {
    const component = state.components[installation.componentId];
    if (!component) continue;
    const receipt = state.receipts[installation.key];
    const fileLocation = capabilityLocation(installation.locationId);
    const upToDate =
      receipt !== undefined &&
      receipt.packageDigest === installation.digest &&
      receipt.packageId === installation.packageId &&
      !receipt.outcomeUnknown &&
      receipt.status !== "failed" &&
      receipt.status !== "outcome-unknown" &&
      receipt.status !== "drifted";
    if (options.driftKeys?.has(installation.key) && !options.forceKeys?.has(installation.key)) {
      planned.push({
        key: installation.key,
        target: { nodeId: desired.nodeId, provider: installation.providers[0]! },
        componentId: installation.componentId,
        packageId: installation.packageId,
        action: "skip",
        locationId: installation.locationId,
        status: "drifted",
        reason:
          "Local changes on this machine are kept until you choose to keep them, adopt them or replace them.",
      });
      continue;
    }
    const action: CapabilityPlannedTarget["action"] = upToDate
      ? "keep"
      : receipt && receipt.status !== "failed"
        ? "update"
        : "install";
    const provider = installation.providers[0]!;
    const locationProvider =
      installation.locationId.startsWith("mcp:") || installation.locationId.startsWith("plugin:")
        ? (installation.locationId.split(":")[1] as AgentPlatform)
        : undefined;
    const liveSemantics: CapabilityLiveSemantics =
      component.kind === "mcp-server"
        ? options.sessionRunning
          ? "queued-until-idle"
          : "available-next-turn"
        : component.kind === "native-plugin" || component.kind === "subagent"
          ? "new-session-required"
          : "new-session-required";
    const status: CapabilityTargetStatus = !options.connected
      ? "offline"
      : action === "keep"
        ? (receipt?.status ?? "installed-next-session")
        : "pending";
    planned.push({
      key: installation.key,
      target: { nodeId: desired.nodeId, provider },
      componentId: installation.componentId,
      packageId: installation.packageId,
      action,
      ...(receipt?.digest ? { fromDigest: receipt.digest } : {}),
      toDigest: installation.digest,
      locationId: installation.locationId,
      ...(installation.alsoVisibleTo.length > 0
        ? { alsoVisibleTo: installation.alsoVisibleTo }
        : {}),
      status,
      liveSemantics,
      ...(installation.references.length > 1
        ? { sharedWith: installation.references.length - 1 }
        : {}),
    });
    if (action === "keep") continue;
    const pkg = state.packages[installation.packageId];
    targets.push({
      key: installation.key,
      action: action === "update" ? "update" : "install",
      kind: component.kind,
      packageId: installation.packageId,
      componentId: installation.componentId,
      componentName: component.name,
      pathOrKey: component.pathOrKey,
      ...(fileLocation ? { locationId: installation.locationId } : {}),
      ...(locationProvider ? { provider: locationProvider } : {}),
      artifactDigest: installation.digest,
      ...(options.forceKeys?.has(installation.key) ? { force: true } : {}),
      ...(pkg?.source.kind === "provider-marketplace"
        ? { qualifiedId: pkg.source.qualifiedId }
        : {}),
    });
  }

  for (const receipt of receipts) {
    if (desiredKeys.has(receipt.id)) continue;
    if (receipt.status === "unsupported") continue;
    // Still referenced by an account or a project outside the fleet setups.
    if (receipt.references.some((reference) => !reference.startsWith("setup:"))) continue;
    if (options.driftKeys?.has(receipt.id) && !options.forceKeys?.has(receipt.id)) continue;
    const component = state.components[receipt.componentId];
    const fileLocation = capabilityLocation(receipt.locationId);
    const locationProvider =
      receipt.locationId.startsWith("mcp:") || receipt.locationId.startsWith("plugin:")
        ? (receipt.locationId.split(":")[1] as AgentPlatform)
        : undefined;
    planned.push({
      key: receipt.id,
      target: { nodeId: desired.nodeId, provider: receipt.providers[0] ?? "claude" },
      componentId: receipt.componentId,
      packageId: receipt.packageId,
      action: "remove",
      fromDigest: receipt.digest,
      locationId: receipt.locationId,
      status: options.connected ? "pending" : "offline",
      liveSemantics: "new-session-required",
    });
    targets.push({
      key: receipt.id,
      action: "remove",
      kind:
        component?.kind ??
        (locationProvider
          ? receipt.locationId.startsWith("mcp:")
            ? "mcp-server"
            : "native-plugin"
          : "skill"),
      packageId: receipt.packageId,
      componentId: receipt.componentId,
      componentName: component?.name ?? receipt.componentId.split(":").pop() ?? "component",
      pathOrKey: component?.pathOrKey ?? "",
      ...(fileLocation ? { locationId: receipt.locationId } : {}),
      ...(locationProvider ? { provider: locationProvider } : {}),
      ...(options.forceKeys?.has(receipt.id) ? { force: true } : {}),
      ...(state.packages[receipt.packageId]?.source.kind === "provider-marketplace"
        ? {
            qualifiedId: (state.packages[receipt.packageId]!.source as { qualifiedId: string })
              .qualifiedId,
          }
        : {}),
    });
  }

  for (const entry of desired.undeliverable) {
    planned.push({
      key: `${desired.nodeId}|${entry.provider}|${entry.componentId}`,
      target: { nodeId: desired.nodeId, provider: entry.provider },
      componentId: entry.componentId,
      packageId: entry.packageId,
      action: "skip",
      status: entry.status,
      reason: entry.reason,
    });
  }
  return { nodeId: desired.nodeId, targets, planned, manifestDigest: desired.manifestDigest };
}

/** The installed-name collision a component would have with an external item at a location. */
export function externalCollision(
  component: CapabilityComponent,
  locationId: string,
  external: ReadonlyMap<string, ObservedInstallation>,
): boolean {
  const location = capabilityLocation(locationId);
  if (!location) return false;
  const name = installName(component.name, component.pathOrKey, location.layout);
  return external.has(`${locationId}/${location.layout === "file" ? name : name}`);
}
