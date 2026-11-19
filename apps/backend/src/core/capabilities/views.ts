/**
 * The bounded, redacted views the Capabilities page reads: library rows, a
 * package's "Where available" matrix, and machine summaries. Every status
 * here comes from a receipt, an unsupported or blocked reason, or runtime
 * evidence; a cell with none of those says so.
 */
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  capabilityStatusNeedsAttention,
  describePackageSource,
  type CapabilityAvailabilityCell,
  type CapabilityMachineSummary,
  type CapabilityPackageDetail,
  type CapabilityPackageSummary,
  type CapabilityTargetStatus,
  type ComponentKind,
} from "@orkestrator/protocol/capability-resources";

import { desiredStateForNode, type NodeDesiredState } from "./planning.js";
import { effectiveReceiptStatus } from "./runtime-evidence.js";
import type { CapabilityState } from "./types.js";

export interface MachineFact {
  nodeId: string;
  name: string;
  connected: boolean;
  self: boolean;
}

/** Desired state for every enrolled machine, computed once per view. */
export function desiredByNode(
  state: CapabilityState,
  machines: readonly MachineFact[],
): Map<string, NodeDesiredState> {
  const result = new Map<string, NodeDesiredState>();
  for (const machine of machines) {
    if (state.machines[machine.nodeId]?.enrolled === false) continue;
    result.set(
      machine.nodeId,
      desiredStateForNode(state, machine.nodeId, state.machines[machine.nodeId]?.inventory),
    );
  }
  return result;
}

const REMEDIES: Partial<Record<CapabilityTargetStatus, string>> = {
  offline: "It applies the latest setup when the machine reconnects.",
  drifted: "Open Local changes to keep, adopt or replace them.",
  "needs-auth": "Add the credentials in MCP servers settings on that machine.",
  "needs-approval": "Review and approve the pending change.",
  failed: "Retry from Activity, or open the native configuration.",
  "installed-next-session": "Start a new session to load it.",
  "queued-until-idle": "It loads when the running session is idle.",
  "outcome-unknown": "Orkestrator is checking what the machine applied.",
};

/** The cells for one package: every machine, provider and component it is meant for. */
export function availabilityCells(
  state: CapabilityState,
  packageId: string,
  machines: readonly MachineFact[],
  desired: ReadonlyMap<string, NodeDesiredState>,
  scopeNames?: ReadonlyMap<string, string>,
): CapabilityAvailabilityCell[] {
  const pkg = state.packages[packageId];
  if (!pkg) return [];
  const cells: CapabilityAvailabilityCell[] = scopedAvailabilityCells(
    state,
    packageId,
    machines,
    scopeNames,
  );
  for (const machine of machines) {
    const nodeDesired = desired.get(machine.nodeId);
    if (!nodeDesired) continue;
    for (const provider of AGENT_PLATFORMS) {
      for (const componentId of pkg.componentIds) {
        const undeliverable = nodeDesired.undeliverable.find(
          (entry) => entry.provider === provider && entry.componentId === componentId,
        );
        if (undeliverable) {
          cells.push({
            target: { nodeId: machine.nodeId, provider },
            nodeName: machine.name,
            componentId,
            status: undeliverable.status,
            verification: "requested",
            reason: undeliverable.reason,
          });
          continue;
        }
        const installation = nodeDesired.installations.find(
          (entry) => entry.componentId === componentId && entry.providers.includes(provider),
        );
        if (!installation) continue;
        const receipt = state.receipts[installation.key];
        if (
          !machine.connected &&
          !machine.self &&
          (!receipt || receipt.packageDigest !== installation.digest)
        ) {
          cells.push({
            target: { nodeId: machine.nodeId, provider },
            nodeName: machine.name,
            componentId,
            status: "offline",
            verification: "requested",
            locationId: installation.locationId,
            reason: "Waiting for the machine to connect.",
            remedy: REMEDIES.offline!,
          });
          continue;
        }
        const drift = state.drift[`drift:${installation.key}`];
        if (drift?.state === "open" || drift?.state === "kept-local") {
          cells.push({
            target: { nodeId: machine.nodeId, provider },
            nodeName: machine.name,
            componentId,
            status: "drifted",
            verification: "requested",
            locationId: installation.locationId,
            reason: "A conflicting local item was left untouched.",
            remedy: REMEDIES.drifted!,
          });
          continue;
        }
        if (!receipt) {
          cells.push({
            target: { nodeId: machine.nodeId, provider },
            nodeName: machine.name,
            componentId,
            status: "pending",
            verification: "requested",
            locationId: installation.locationId,
            ...(installation.alsoVisibleTo.length > 0
              ? { alsoVisibleTo: installation.alsoVisibleTo }
              : {}),
          });
          continue;
        }
        const stale = receipt.packageDigest !== installation.digest;
        const effective = effectiveReceiptStatus(receipt);
        const status: CapabilityTargetStatus = stale ? "pending" : effective.status;
        cells.push({
          target: { nodeId: machine.nodeId, provider },
          nodeName: machine.name,
          componentId,
          status,
          verification: effective.verification,
          installedDigest: receipt.packageDigest,
          locationId: installation.locationId,
          ...(installation.alsoVisibleTo.length > 0
            ? { alsoVisibleTo: installation.alsoVisibleTo }
            : {}),
          ...(receipt.reason
            ? { reason: receipt.reason }
            : stale
              ? { reason: "An older revision is installed; the new one is on its way." }
              : {}),
          ...(REMEDIES[status] ? { remedy: REMEDIES[status] } : {}),
          ...(effective.lastVerifiedAt ? { lastVerifiedAt: effective.lastVerifiedAt } : {}),
        });
      }
    }
  }
  return cells;
}

/**
 * Rows for scoped copies (`scoped-delivery.ts`): one worktree's project
 * delivery or one account's private directory, each its own target, so the
 * matrix shows them per environment and per account beside the machine row.
 */
export function scopedAvailabilityCells(
  state: CapabilityState,
  packageId: string,
  machines: readonly MachineFact[],
  scopeNames?: ReadonlyMap<string, string>,
): CapabilityAvailabilityCell[] {
  const cells: CapabilityAvailabilityCell[] = [];
  for (const receipt of Object.values(state.receipts)) {
    if (receipt.packageId !== packageId) continue;
    if (receipt.environmentId === undefined && receipt.accountHomeId === undefined) continue;
    const machine = machines.find((entry) => entry.nodeId === receipt.nodeId);
    if (!machine) continue;
    const scopeKey = receipt.environmentId
      ? `env:${receipt.environmentId}`
      : `account:${receipt.accountHomeId}`;
    const scopeName =
      scopeNames?.get(scopeKey) ??
      (receipt.environmentId ? `worktree ${receipt.environmentId.slice(0, 8)}` : "added account");
    const effective = effectiveReceiptStatus(receipt);
    const stale = state.packages[packageId]?.artifactDigest !== receipt.packageDigest;
    for (const provider of receipt.providers) {
      cells.push({
        target: {
          nodeId: receipt.nodeId,
          provider,
          ...(receipt.environmentId ? { environmentId: receipt.environmentId } : {}),
          ...(receipt.accountHomeId ? { accountHomeId: receipt.accountHomeId } : {}),
        },
        nodeName: `${machine.name} · ${scopeName}`,
        componentId: receipt.componentId,
        status: effective.status,
        verification: effective.verification,
        installedDigest: receipt.packageDigest,
        locationId: receipt.locationId,
        ...(receipt.alsoVisibleTo.length > 0 ? { alsoVisibleTo: receipt.alsoVisibleTo } : {}),
        ...(receipt.reason
          ? { reason: receipt.reason }
          : stale
            ? {
                reason:
                  "An older revision is in place; the newest setup replaces it on the next pass.",
              }
            : {}),
        ...(REMEDIES[effective.status] ? { remedy: REMEDIES[effective.status] } : {}),
        ...(effective.lastVerifiedAt ? { lastVerifiedAt: effective.lastVerifiedAt } : {}),
      });
    }
  }
  return cells;
}

export function packageSummary(
  state: CapabilityState,
  packageId: string,
  cells: readonly CapabilityAvailabilityCell[],
): CapabilityPackageSummary | null {
  const pkg = state.packages[packageId];
  if (!pkg) return null;
  const components = pkg.componentIds
    .map((id) => state.components[id])
    .filter((component) => component !== undefined);
  const assignedSetupIds = Object.values(state.setups)
    .filter((setup) =>
      setup.packageSelections.some((selection) => selection.packageId === packageId),
    )
    .map((setup) => setup.id)
    .sort();
  const attention = cells.filter((cell) => capabilityStatusNeedsAttention(cell.status)).length;
  const pending = cells.some(
    (cell) =>
      cell.status === "pending" || cell.status === "outcome-unknown" || cell.status === "offline",
  );
  const kinds = [...new Set(components.map((component) => component.kind))] as ComponentKind[];
  // "Ready" needs runtime evidence on every target that can take the package.
  const deliverable = cells.filter(
    (cell) => cell.status !== "unsupported" && cell.status !== "blocked-policy",
  );
  return {
    id: pkg.id,
    displayName: pkg.displayName,
    ...(pkg.description ? { description: pkg.description } : {}),
    source: pkg.source,
    sourceLabel: describePackageSource(pkg.source),
    revision: pkg.revision,
    artifactDigest: pkg.artifactDigest,
    provenance: pkg.provenance,
    risk: pkg.risk,
    ...(pkg.diverged ? { diverged: pkg.diverged } : {}),
    ...(pkg.derivedFrom
      ? {
          derivedFrom: {
            packageId: pkg.derivedFrom.packageId,
            revision: pkg.derivedFrom.revision,
            at: pkg.derivedFrom.at,
          },
        }
      : {}),
    kinds,
    componentCount: components.length,
    components: components.map((component) => ({
      id: component.id,
      kind: component.kind,
      name: component.name,
      risk: component.risk,
    })),
    assignedSetupIds,
    readiness:
      assignedSetupIds.length === 0
        ? "unassigned"
        : attention > 0
          ? "needs-attention"
          : pending
            ? "pending"
            : deliverable.length > 0 && deliverable.every((cell) => cell.status === "ready")
              ? "ready"
              : deliverable.length > 0
                ? "installed"
                : "pending",
    attention,
    updateAvailable: Object.values(state.updates).some(
      (update) => update.packageId === packageId && update.state === "pending",
    ),
    pinned: pkg.pinned === true,
    paused: pkg.paused === true,
    updatedAt: pkg.updatedAt,
  };
}

export function packageDetail(
  state: CapabilityState,
  packageId: string,
  machines: readonly MachineFact[],
  desired: ReadonlyMap<string, NodeDesiredState>,
  scopeNames?: ReadonlyMap<string, string>,
): CapabilityPackageDetail | null {
  const pkg = state.packages[packageId];
  if (!pkg) return null;
  const availability = availabilityCells(state, packageId, machines, desired, scopeNames);
  const summary = packageSummary(state, packageId, availability)!;
  const artifact = state.artifacts[pkg.artifactDigest];
  return {
    package: summary,
    components: pkg.componentIds
      .map((id) => state.components[id])
      .filter((component) => component !== undefined),
    availability,
    previousRevisions: pkg.previousRevisions ?? [],
    files: (artifact?.files ?? []).slice(0, 500).map((file) => ({
      path: file.path,
      bytes: file.bytes,
      executable: file.executable,
    })),
  };
}

export function machineSummaries(
  state: CapabilityState,
  machines: readonly MachineFact[],
  desired: ReadonlyMap<string, NodeDesiredState>,
): CapabilityMachineSummary[] {
  return machines.map((machine) => {
    const record = state.machines[machine.nodeId];
    const counts: Partial<Record<CapabilityTargetStatus, number>> = {};
    for (const receipt of Object.values(state.receipts)) {
      if (receipt.nodeId !== machine.nodeId) continue;
      counts[receipt.status] = (counts[receipt.status] ?? 0) + 1;
    }
    const pendingOperationIds = Object.values(state.operations)
      .filter(
        (operation) =>
          (operation.state === "applying" || operation.state === "observing") &&
          operation.targets.some((target) => target.target.nodeId === machine.nodeId),
      )
      .map((operation) => operation.id);
    const providers = (record?.inventory?.providers ?? []).map((entry) => ({
      provider: entry.provider as AgentPlatform,
      available: entry.available,
      ...(entry.version ? { version: entry.version } : {}),
    }));
    const desiredDigest = desired.get(machine.nodeId)?.manifestDigest;
    return {
      nodeId: machine.nodeId,
      name: machine.name,
      enrolled: record?.enrolled ?? state.settings.enrollNewMachines,
      groups: record?.groups ?? [],
      connection: machine.self ? "self" : machine.connected ? "connected" : "offline",
      ...(record?.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
      ...(record?.lastObservedAt ? { lastObservedAt: record.lastObservedAt } : {}),
      ...(record?.appliedManifestDigest
        ? { appliedManifestDigest: record.appliedManifestDigest }
        : {}),
      ...(desiredDigest ? { desiredManifestDigest: desiredDigest } : {}),
      pendingOperationIds,
      ...(record?.inventory?.os ? { os: record.inventory.os } : {}),
      providers,
      counts,
    };
  });
}
