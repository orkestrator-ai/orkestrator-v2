/**
 * One environment's own capability copies, for its settings card and for
 * container creation (docs/architecture/agent-capabilities-management.md,
 * "Runtime connection points").
 *
 * - A local worktree shows its project-setup receipts (`scoped-delivery.ts`).
 * - A container shows the manifest staged into its inputs revision against
 *   the manifest the current setup would stage (`container-staging.ts`);
 *   when they differ the card offers the existing rebuild, which re-stages.
 */
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CapabilityTarget,
  EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityEnvironmentDelivery,
  CapabilityEnvironmentDeliveryItem,
} from "@orkestrator/protocol/capability-resources-api";
import { capabilityLocation } from "@orkestrator/protocol/capability-resources-support";

import type { CapabilityArtifactStore } from "./artifact-store.js";
import {
  containerCapabilityPlan,
  stageContainerCapabilities,
  type ContainerCapabilityPlan,
  type ContainerCapabilityRecord,
} from "./container-staging.js";
import { projectCapabilityLocation } from "./scoped-locations.js";
import {
  desiredProjectState,
  revisionComponent,
  type ScopedEnvironment,
  type ScopedTargetSources,
} from "./scoped-delivery.js";
import { desiredStateForNode } from "./planning.js";
import type { CapabilitiesStorage } from "../storage-capabilities.js";
import type { CapabilityState } from "./types.js";

export interface EnvironmentDeliveryContext {
  storage: { capabilities: CapabilitiesStorage };
  artifacts: CapabilityArtifactStore;
  selfId(): Promise<string>;
  resolve(state: CapabilityState, target: CapabilityTarget): EffectiveAgentResources;
  sources: ScopedTargetSources;
  now(): string;
}

/** Every stage name a container can have: each provider and the shared skills root. */
const ALL_STAGES = [...AGENT_PLATFORMS, "agents-skills"];

/**
 * The plan a new container's inputs revision should carry, and the hook that
 * stages it into the partial revision (`StagingOptions.beforeCommit`).
 */
export async function containerStaging(
  context: EnvironmentDeliveryContext,
  input: {
    environmentId: string;
    projectId?: string;
    providers: readonly AgentPlatform[];
    stages: readonly string[];
  },
): Promise<{
  plan: ContainerCapabilityPlan;
  stage(partialDirectory: string): Promise<ContainerCapabilityRecord>;
}> {
  const state = await context.storage.capabilities.loadCapabilityState();
  const plan = containerCapabilityPlan(
    state,
    {
      nodeId: await context.selfId(),
      environmentId: input.environmentId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      providers: input.providers,
      stages: new Set(input.stages),
    },
    context.resolve,
  );
  return {
    plan,
    stage: (partialDirectory) =>
      stageContainerCapabilities(plan, context.artifacts, partialDirectory, context.now),
  };
}

function nameOf(state: CapabilityState, packageId: string, componentId: string, digest: string) {
  const component =
    revisionComponent(state, packageId, componentId, digest) ?? state.components[componentId];
  return { name: component?.name ?? componentId, kind: component?.kind ?? "skill" };
}

/** The environment card's view of its own copies. */
export async function environmentDeliveryView(
  context: EnvironmentDeliveryContext,
  environment: ScopedEnvironment,
): Promise<CapabilityEnvironmentDelivery> {
  const state = await context.storage.capabilities.loadCapabilityState();
  const nodeId = await context.selfId();
  if (environment.environmentType === "local") {
    const items: CapabilityEnvironmentDeliveryItem[] = [];
    for (const receipt of Object.values(state.receipts)) {
      if (receipt.nodeId !== nodeId || receipt.environmentId !== environment.id) continue;
      const { name, kind } = nameOf(
        state,
        receipt.packageId,
        receipt.componentId,
        receipt.packageDigest,
      );
      items.push({
        componentId: receipt.componentId,
        name,
        kind,
        packageId: receipt.packageId,
        providers: receipt.providers,
        locationId: receipt.locationId,
        locationLabel: projectCapabilityLocation(receipt.locationId)?.label ?? receipt.locationId,
        status: receipt.status,
        installedDigest: receipt.packageDigest,
        currentDigest: state.packages[receipt.packageId]?.artifactDigest ?? receipt.packageDigest,
        ...(receipt.alsoVisibleTo.length > 0 ? { alsoVisibleTo: receipt.alsoVisibleTo } : {}),
        ...(receipt.reason ? { reason: receipt.reason } : {}),
      });
    }
    const host = desiredStateForNode(state, nodeId, state.machines[nodeId]?.inventory);
    const desired = desiredProjectState(state, nodeId, environment, host, context.resolve);
    for (const installation of desired.installations) {
      if (
        items.some(
          (item) =>
            item.componentId === installation.componentId &&
            item.locationId === installation.locationId,
        )
      )
        continue;
      const { name, kind } = nameOf(
        state,
        installation.packageId,
        installation.componentId,
        installation.digest,
      );
      items.push({
        componentId: installation.componentId,
        name,
        kind,
        packageId: installation.packageId,
        providers: installation.providers,
        locationId: installation.locationId,
        locationLabel:
          projectCapabilityLocation(installation.locationId)?.label ?? installation.locationId,
        status: "pending",
        currentDigest: installation.digest,
        ...(installation.alsoVisibleTo.length > 0
          ? { alsoVisibleTo: installation.alsoVisibleTo }
          : {}),
      });
    }
    for (const entry of desired.undeliverable) {
      const { name, kind } = nameOf(state, entry.packageId, entry.componentId, "");
      items.push({
        componentId: entry.componentId,
        name,
        kind,
        packageId: entry.packageId,
        providers: [entry.provider],
        status: entry.status,
        reason: entry.reason,
      });
    }
    return {
      environmentId: environment.id,
      kind: items.length > 0 ? "worktree" : "none",
      stale: items.some((item) => item.status === "pending"),
      items: items.slice(0, 500),
    };
  }

  const delivered = environment.containerId
    ? await context.sources.containerDelivery?.(environment.id).catch(() => null)
    : null;
  const record =
    delivered?.record && delivered.labelDigest === delivered.record.digest
      ? delivered.record
      : null;
  const current = containerCapabilityPlan(
    state,
    {
      nodeId,
      environmentId: environment.id,
      projectId: environment.projectId,
      providers: record?.providers ?? AGENT_PLATFORMS,
      stages: new Set(record?.stages ?? ALL_STAGES),
    },
    context.resolve,
  );
  const items: CapabilityEnvironmentDeliveryItem[] = [];
  for (const item of current.items) {
    const staged = record?.items.find(
      (entry) => entry.componentId === item.componentId && entry.locationId === item.locationId,
    );
    const { name, kind } = nameOf(state, item.packageId, item.componentId, item.packageDigest);
    const upToDate = staged?.status === "staged" && staged.packageDigest === item.packageDigest;
    items.push({
      componentId: item.componentId,
      name,
      kind,
      packageId: item.packageId,
      providers: item.providers,
      locationId: item.locationId,
      locationLabel: capabilityLocation(item.locationId)?.label ?? item.locationId,
      status: upToDate
        ? "installed-next-session"
        : staged && staged.status !== "staged"
          ? "failed"
          : "restart-required",
      ...(staged ? { installedDigest: staged.packageDigest } : {}),
      currentDigest: item.packageDigest,
      ...(staged?.reason
        ? { reason: staged.reason }
        : upToDate
          ? {}
          : {
              reason: staged
                ? "An older revision is staged in this container; rebuild it to stage the current one."
                : "Not staged in this container yet; rebuild it to stage the current setup.",
            }),
    });
  }
  for (const staged of record?.items ?? []) {
    if (
      current.items.some(
        (item) => item.componentId === staged.componentId && item.locationId === staged.locationId,
      )
    )
      continue;
    const { name, kind } = nameOf(
      state,
      staged.packageId,
      staged.componentId,
      staged.packageDigest,
    );
    items.push({
      componentId: staged.componentId,
      name,
      kind,
      packageId: staged.packageId,
      providers: staged.providers,
      locationId: staged.locationId,
      locationLabel: capabilityLocation(staged.locationId)?.label ?? staged.locationId,
      status: "restart-required",
      installedDigest: staged.packageDigest,
      reason: "No longer in this environment's setup; a rebuild leaves it out.",
    });
  }
  const installedDigest = record?.digest;
  return {
    environmentId: environment.id,
    kind: environment.containerId || items.length > 0 ? "container" : "none",
    ...(installedDigest ? { installedDigest } : {}),
    currentDigest: current.digest,
    stale:
      installedDigest !== current.digest && (items.length > 0 || installedDigest !== undefined),
    ...(record?.stagedAt ? { stagedAt: record.stagedAt } : {}),
    items: items.slice(0, 500),
  };
}
