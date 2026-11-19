/**
 * Update discovery (docs/architecture/agent-capabilities-management.md,
 * "Updates"). For each Git-sourced package the checker asks the remote for
 * the newest commit of the package's channel without fetching content (a
 * registry package: its index's latest version); only
 * when the commit moved does it fetch and inspect the new revision, compare
 * it component by component, and file an update proposal. Approval is the
 * default. A trusted-source rule lets an update apply on its own only when
 * nothing in it raises the package's risk; a pinned package never moves.
 */
import { randomBytes } from "node:crypto";

import {
  capabilityUpdateApproval,
  compareCapabilityRevisions,
} from "@orkestrator/protocol/capability-resources-resolve";
import type {
  CapabilityPackage,
  CapabilityUpdatePolicy,
  CapabilityUpdateProposal,
} from "@orkestrator/protocol/capability-resources";

import type { InspectedPackage } from "./source-inspection.js";
import type { CapabilityState, SourceInspectionRecord } from "./types.js";

export interface UpdateCheckDeps {
  remoteHead(pkg: CapabilityPackage): Promise<string | null>;
  inspect(pkg: CapabilityPackage): Promise<InspectedPackage>;
  storeArtifact(inspected: InspectedPackage): Promise<void>;
  now(): string;
}

/** The strictest update policy among the setups that select the package. */
export function packageUpdatePolicy(
  state: CapabilityState,
  packageId: string,
): CapabilityUpdatePolicy {
  const policies = Object.values(state.setups)
    .filter((setup) =>
      setup.packageSelections.some((selection) => selection.packageId === packageId),
    )
    .map((setup) => setup.updatePolicy);
  if (state.packages[packageId]?.pinned || policies.includes("pinned")) return "pinned";
  if (policies.length === 0 || policies.includes("approve")) return "approve";
  return "trusted-auto";
}

export function isTrustedSource(state: CapabilityState, packageId: string): boolean {
  return state.settings.trustedSources.some(
    (prefix) => prefix.length > 0 && packageId.startsWith(prefix),
  );
}

/**
 * A package that diverged from its source (adopted or merged local changes)
 * is treated as pinned against silent updates: the proposal always needs
 * approval and says that taking it replaces the local changes.
 */
export function divergedApproval(
  pkg: CapabilityPackage,
  approval: { requiresApproval: boolean; autoApply: boolean; reasons: string[] },
): { requiresApproval: boolean; autoApply: boolean; reasons: string[] } {
  if (!pkg.diverged) return approval;
  return {
    requiresApproval: true,
    autoApply: false,
    reasons: [
      `This package diverged from its source when local changes were ${pkg.diverged.reason === "merged-local" ? "merged" : "adopted"}; taking this update replaces them.`,
      ...approval.reasons.filter((reason) => reason !== "Updates need approval."),
    ],
  };
}

export interface UpdateCandidate {
  proposal: CapabilityUpdateProposal;
  inspection: SourceInspectionRecord;
  autoApply: boolean;
}

/** Checks one package. `null` when there is nothing new (or it cannot be checked). */
export async function checkPackageUpdate(
  state: CapabilityState,
  pkg: CapabilityPackage,
  deps: UpdateCheckDeps,
): Promise<UpdateCandidate | null> {
  // Git: the channel's newest commit. Registry: the index's latest version (`registry.ts`).
  if (pkg.source.kind !== "git" && pkg.source.kind !== "registry") return null;
  const head = await deps.remoteHead(pkg);
  // A diverged package holds adopted local changes: only a moved upstream is news.
  const upstream = pkg.diverged?.upstreamRevision ?? pkg.revision;
  if (!head || head === upstream) return null;
  if (
    Object.values(state.updates).some(
      (update) =>
        update.packageId === pkg.id &&
        update.toRevision === head &&
        update.state !== "failed" &&
        (update.state !== "pending" ||
          Date.parse(state.inspections[`update:${update.id}`]?.expiresAt ?? "") >
            Date.parse(deps.now())),
    )
  ) {
    return null;
  }
  const inspected = await deps.inspect(pkg);
  if (inspected.artifactDigest === (pkg.diverged?.upstreamDigest ?? pkg.artifactDigest))
    return null;
  if (inspected.secretsFound.length === 0) await deps.storeArtifact(inspected);
  const before = pkg.componentIds
    .map((id) => state.components[id])
    .filter((component) => component !== undefined);
  const oldFiles = state.artifacts[pkg.artifactDigest]?.files;
  const changes = compareCapabilityRevisions(before, inspected.components, (id) => {
    if (!oldFiles) return true;
    const component = inspected.components.find((entry) => entry.id === id)!;
    const entryPath = component.pathOrKey;
    const directory = entryPath ? `${entryPath}/` : "";
    const wholeArtifact = component.kind === "native-plugin" || component.kind === "hook";
    const belongs = (file: { path: string }) =>
      wholeArtifact ||
      file.path === entryPath ||
      (component.kind === "skill" && file.path.startsWith(directory));
    const fingerprint = (files: typeof oldFiles) =>
      files
        .filter(belongs)
        .map(({ path, sha256, executable }) => `${path}:${sha256}:${executable}`)
        .sort()
        .join("\n");
    return fingerprint(oldFiles) !== fingerprint(inspected.files);
  });
  const policy = packageUpdatePolicy(state, pkg.id);
  const approval = divergedApproval(
    pkg,
    capabilityUpdateApproval(policy, changes, isTrustedSource(state, pkg.id)),
  );
  const id = `upd_${randomBytes(8).toString("hex")}`;
  const now = deps.now();
  return {
    proposal: {
      id,
      packageId: pkg.id,
      fromRevision: pkg.revision,
      toRevision: inspected.revision,
      fromDigest: pkg.artifactDigest,
      toDigest: inspected.artifactDigest,
      detectedAt: now,
      state: "pending",
      requiresApproval: approval.requiresApproval,
      ...(pkg.diverged ? { diverged: true } : {}),
      reasons: [
        ...approval.reasons,
        ...(inspected.secretsFound.length > 0
          ? [
              `The new revision contains what looks like a ${inspected.secretsFound.join(", ")}; it cannot be applied.`,
            ]
          : []),
      ],
      changes,
    },
    inspection: {
      id: `update:${id}`,
      source: pkg.source,
      packageId: pkg.id,
      displayName: inspected.displayName,
      ...(inspected.description ? { description: inspected.description } : {}),
      revision: inspected.revision,
      artifactDigest: inspected.artifactDigest,
      ...(inspected.publisher ? { publisher: inspected.publisher } : {}),
      components: inspected.secretsFound.length > 0 ? [] : inspected.components,
      ...(inspected.secretsFound.length > 0 ? { secretsFound: inspected.secretsFound } : {}),
      createdAt: now,
      // Kept until the update is handled; the proposal names it.
      expiresAt: new Date(Date.parse(now) + 30 * 24 * 60 * 60_000).toISOString(),
    },
    autoApply: approval.autoApply && inspected.secretsFound.length === 0,
  };
}
