/**
 * Durable capability operations and the changes they carry
 * (docs/architecture/agent-capabilities-management.md, "Reconciliation").
 *
 * A change is previewed against a copy of the state; the plan it produces
 * (every target's action and digest) is hashed into the plan digest. Apply
 * re-plans against the current state and refuses unless the digest is the
 * one the user approved, so a package revision or setup that moved since the
 * preview invalidates the approval rather than being applied silently. The
 * change and the operation record commit in one transaction; delivery to
 * machines then follows the *latest* desired state, never a replay of an
 * older operation's writes.
 */
import { randomBytes } from "node:crypto";

import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  CAPABILITY_LIMITS,
  MY_SETUP_ID,
  isTerminalCapabilityOperationState,
  summarizeCapabilityTargets,
  type CapabilityActivityEntry,
  type CapabilityChangeKind,
  type CapabilityOperationSnapshot,
  type CapabilityPackageSelection,
  type CapabilityPlannedTarget,
  type CapabilityTargetStatus,
} from "@orkestrator/protocol/capability-resources";
import {
  canonicalCapabilityJson,
  capabilityInstallApproval,
  compareCapabilityRevisions,
} from "@orkestrator/protocol/capability-resources-resolve";

import { CapabilityError } from "./security.js";
import { sha256 } from "./planning.js";
import type { CapabilityState } from "./types.js";

export type CapabilityChange =
  | {
      kind: "add-to-setup";
      inspectionId: string;
      setupId: string;
      components?: string[];
      required?: boolean;
      /** Providers left out of the default "every compatible provider". */
      excludedProviders?: AgentPlatform[];
      /** Machines left out. */
      excludedMachines?: string[];
      pin?: boolean;
    }
  | { kind: "remove-from-setup"; packageId: string; setupId: string }
  | { kind: "update"; packageId: string; updateId: string }
  | { kind: "rollback"; packageId: string; toRevision: string }
  | { kind: "reconcile"; nodeIds?: string[] }
  | { kind: "adopt"; inspectionId: string; setupId: string }
  | { kind: "import"; importId: string };

/** The internal record: the snapshot plus the change it applies. */
export type CapabilityOperationRecord = CapabilityOperationSnapshot & {
  change?: CapabilityChange;
  /** Revisions the change was planned against, for compare-and-swap at apply. */
  basis?: { setupRevision?: number; packageDigest?: string };
};

export function newOperationId(): string {
  return `capop_${randomBytes(9).toString("hex")}`;
}

export function newCorrelationId(): string {
  return `cap_${randomBytes(6).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asStringArray(value: unknown, max = 64): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new CapabilityError("invalid-request", "Expected a list.");
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length <= 512)
    .slice(0, max);
}

function requireText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CAPABILITY_LIMITS.maxIdChars
  ) {
    throw new CapabilityError("invalid-request", `${key} is required.`);
  }
  return value;
}

/** Validates a client's change. Unknown kinds and fields are refused. */
export function parseCapabilityChange(value: unknown): CapabilityChange {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityError("invalid-request", "Expected a change.");
  }
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "add-to-setup": {
      const excludedProviders = asStringArray(record.excludedProviders)?.filter(
        (provider): provider is AgentPlatform =>
          (AGENT_PLATFORMS as readonly string[]).includes(provider),
      );
      const components = asStringArray(
        record.components,
        CAPABILITY_LIMITS.maxComponentsPerPackage,
      );
      const excludedMachines = asStringArray(record.excludedMachines);
      return {
        kind: "add-to-setup",
        inspectionId: requireText(record, "inspectionId"),
        setupId: typeof record.setupId === "string" ? record.setupId : MY_SETUP_ID,
        ...(components ? { components } : {}),
        ...(record.required === true ? { required: true } : {}),
        ...(excludedProviders?.length ? { excludedProviders } : {}),
        ...(excludedMachines?.length ? { excludedMachines } : {}),
        ...(record.pin === true ? { pin: true } : {}),
      };
    }
    case "remove-from-setup":
      return {
        kind: "remove-from-setup",
        packageId: requireText(record, "packageId"),
        setupId: typeof record.setupId === "string" ? record.setupId : MY_SETUP_ID,
      };
    case "update":
      return {
        kind: "update",
        packageId: requireText(record, "packageId"),
        updateId: requireText(record, "updateId"),
      };
    case "rollback":
      return {
        kind: "rollback",
        packageId: requireText(record, "packageId"),
        toRevision: requireText(record, "toRevision"),
      };
    case "reconcile": {
      const nodeIds = asStringArray(record.nodeIds);
      return { kind: "reconcile", ...(nodeIds ? { nodeIds } : {}) };
    }
    case "adopt":
      return {
        kind: "adopt",
        inspectionId: requireText(record, "inspectionId"),
        setupId: typeof record.setupId === "string" ? record.setupId : MY_SETUP_ID,
      };
    case "import":
      return { kind: "import", importId: requireText(record, "importId") };
    default:
      throw new CapabilityError("invalid-request", "Unknown change kind.");
  }
}

export function changeKind(change: CapabilityChange): CapabilityChangeKind {
  return change.kind;
}

/**
 * Applies `change` to `state` in place. Used twice: on a copy for the
 * preview, and on the real state at apply time (inside the same transaction
 * that records the operation). Throws `conflict` when what the change needs
 * is gone.
 */
export function applyChangeToState(
  state: CapabilityState,
  change: CapabilityChange,
  actor?: string,
): {
  packageIds: string[];
  setupId?: string;
  addedComponentIds: string[];
} {
  const now = nowIso();
  const touchSetup = (setupId: string) => {
    const setup = state.setups[setupId];
    if (!setup) throw new CapabilityError("not-found", "That setup does not exist.");
    setup.revision += 1;
    setup.updatedAt = now;
    if (actor) setup.updatedBy = actor;
    return setup;
  };
  switch (change.kind) {
    case "add-to-setup":
    case "adopt": {
      const inspection = state.inspections[change.inspectionId];
      if (!inspection) {
        throw new CapabilityError("conflict", "The inspection expired; inspect the source again.");
      }
      const existing = state.packages[inspection.packageId];
      const added: string[] = [];
      if (!existing || existing.artifactDigest !== inspection.artifactDigest) {
        for (const component of inspection.components) {
          if (!state.components[component.id]) added.push(component.id);
          state.components[component.id] = component;
        }
        if (existing) {
          for (const id of existing.componentIds) {
            if (!inspection.components.some((component) => component.id === id))
              delete state.components[id];
          }
        }
        state.packages[inspection.packageId] = {
          id: inspection.packageId,
          source: inspection.source,
          displayName: inspection.displayName,
          ...(inspection.description ? { description: inspection.description } : {}),
          revision: inspection.revision,
          artifactDigest: inspection.artifactDigest,
          componentIds: inspection.components.map((component) => component.id),
          provenance:
            change.kind === "adopt"
              ? "managed"
              : inspection.source.kind === "managed"
                ? "managed"
                : "managed",
          risk: inspection.components.reduce(
            (risk, component) =>
              ["instructions", "network", "executable", "privileged"].indexOf(component.risk) >
              ["instructions", "network", "executable", "privileged"].indexOf(risk)
                ? component.risk
                : risk,
            "instructions" as CapabilityState["packages"][string]["risk"],
          ),
          ...(inspection.publisher ? { publisher: inspection.publisher } : {}),
          previousRevisions: existing
            ? [
                {
                  revision: existing.revision,
                  artifactDigest: existing.artifactDigest,
                  replacedAt: now,
                },
                ...(existing.previousRevisions ?? []),
              ].slice(0, 5)
            : [],
          ...(change.kind === "add-to-setup" && change.pin
            ? { pinned: true }
            : existing?.pinned
              ? { pinned: true }
              : {}),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        const artifact = state.artifacts[inspection.artifactDigest];
        if (artifact) {
          artifact.refs = [
            ...new Set([
              ...artifact.refs.filter((ref) => !ref.startsWith(`inspection:`)),
              `package:${inspection.packageId}@${inspection.revision}`,
            ]),
          ];
        }
      }
      const setup = touchSetup(change.setupId);
      const selection: CapabilityPackageSelection = {
        packageId: inspection.packageId,
        version: change.kind === "add-to-setup" && change.pin ? inspection.revision : "latest",
        ...(change.kind === "add-to-setup" && change.components
          ? { components: change.components }
          : {}),
        ...(change.kind === "add-to-setup" && change.required ? { required: true } : {}),
      };
      setup.packageSelections = [
        ...setup.packageSelections.filter((entry) => entry.packageId !== inspection.packageId),
        selection,
      ].slice(0, CAPABILITY_LIMITS.maxSelectionsPerSetup);
      if (change.kind === "add-to-setup") {
        const exclusions = new Set(
          setup.exclusions.filter((entry) => !entry.endsWith(`|${inspection.packageId}`)),
        );
        for (const provider of change.excludedProviders ?? [])
          exclusions.add(`provider:${provider}|${inspection.packageId}`);
        for (const nodeId of change.excludedMachines ?? [])
          exclusions.add(`machine:${nodeId}|${inspection.packageId}`);
        setup.exclusions = [...exclusions].slice(0, CAPABILITY_LIMITS.maxExclusionsPerSetup);
      }
      delete state.inspections[change.inspectionId];
      return { packageIds: [inspection.packageId], setupId: setup.id, addedComponentIds: added };
    }
    case "remove-from-setup": {
      const setup = touchSetup(change.setupId);
      const before = setup.packageSelections.length;
      setup.packageSelections = setup.packageSelections.filter(
        (entry) => entry.packageId !== change.packageId,
      );
      if (setup.packageSelections.length === before) {
        throw new CapabilityError("conflict", "The package is not in that setup.");
      }
      setup.exclusions = setup.exclusions.filter(
        (entry) => !entry.endsWith(`|${change.packageId}`),
      );
      return { packageIds: [change.packageId], setupId: setup.id, addedComponentIds: [] };
    }
    case "update": {
      const update = state.updates[change.updateId];
      const pkg = state.packages[change.packageId];
      if (!update || !pkg || update.packageId !== change.packageId) {
        throw new CapabilityError("not-found", "That update is no longer available.");
      }
      if (update.state !== "pending" && update.state !== "approved") {
        throw new CapabilityError("conflict", "That update was already handled.");
      }
      if (pkg.artifactDigest !== update.fromDigest) {
        throw new CapabilityError(
          "conflict",
          "The package changed since the update was found; check for updates again.",
        );
      }
      const inspection = state.inspections[`update:${update.id}`];
      if (!inspection)
        throw new CapabilityError(
          "conflict",
          "The update's content is no longer staged; check again.",
        );
      const before = pkg.componentIds
        .map((id) => state.components[id])
        .filter((c) => c !== undefined);
      const added = compareCapabilityRevisions(before, inspection.components)
        .filter((entry) => entry.change === "added")
        .map((entry) => entry.componentId);
      for (const id of pkg.componentIds) delete state.components[id];
      for (const component of inspection.components) state.components[component.id] = component;
      pkg.previousRevisions = [
        { revision: pkg.revision, artifactDigest: pkg.artifactDigest, replacedAt: now },
        ...(pkg.previousRevisions ?? []),
      ].slice(0, 5);
      pkg.revision = inspection.revision;
      pkg.artifactDigest = inspection.artifactDigest;
      pkg.componentIds = inspection.components.map((component) => component.id);
      pkg.updatedAt = now;
      update.state = "applied";
      delete state.inspections[`update:${update.id}`];
      const artifact = state.artifacts[inspection.artifactDigest];
      if (artifact)
        artifact.refs = [...new Set([...artifact.refs, `package:${pkg.id}@${pkg.revision}`])];
      return { packageIds: [pkg.id], addedComponentIds: added };
    }
    case "rollback": {
      const pkg = state.packages[change.packageId];
      if (!pkg) throw new CapabilityError("not-found", "That package is not in the library.");
      const previous = pkg.previousRevisions?.find(
        (entry) =>
          entry.revision === change.toRevision || entry.artifactDigest === change.toRevision,
      );
      if (!previous)
        throw new CapabilityError("not-found", "That revision is not kept for rollback.");
      const artifact = state.artifacts[previous.artifactDigest];
      if (!artifact)
        throw new CapabilityError(
          "conflict",
          "The previous revision's files are no longer cached.",
        );
      const restored = state.inspections[`rollback:${pkg.id}:${previous.artifactDigest}`];
      if (!restored) throw new CapabilityError("conflict", "Preview the rollback again.");
      for (const id of pkg.componentIds) delete state.components[id];
      for (const component of restored.components) state.components[component.id] = component;
      pkg.previousRevisions = [
        { revision: pkg.revision, artifactDigest: pkg.artifactDigest, replacedAt: now },
        ...(pkg.previousRevisions ?? []).filter(
          (entry) => entry.artifactDigest !== previous.artifactDigest,
        ),
      ].slice(0, 5);
      pkg.revision = previous.revision;
      pkg.artifactDigest = previous.artifactDigest;
      pkg.componentIds = restored.components.map((component) => component.id);
      pkg.updatedAt = now;
      // A rollback is deliberate: pin it, so the next update check does not undo it.
      pkg.pinned = true;
      delete state.inspections[`rollback:${pkg.id}:${previous.artifactDigest}`];
      return { packageIds: [pkg.id], addedComponentIds: [] };
    }
    case "reconcile":
      return { packageIds: [], addedComponentIds: [] };
    case "import": {
      const imported = state.imports[change.importId];
      if (!imported)
        throw new CapabilityError("conflict", "The import preview expired; preview it again.");
      return { packageIds: [], addedComponentIds: [] };
    }
  }
}

export function planDigestOf(
  change: CapabilityChange | undefined,
  targets: readonly CapabilityPlannedTarget[],
): string {
  return sha256(
    canonicalCapabilityJson({
      change: change ?? null,
      targets: targets.map((target) => [
        target.key,
        target.action,
        target.toDigest ?? "",
        target.status,
      ]),
    }),
  );
}

/** Approval reasons for what a change adds. */
export function approvalReasonsFor(
  state: CapabilityState,
  addedComponentIds: readonly string[],
): string[] {
  const components = addedComponentIds
    .map((id) => state.components[id])
    .filter((component) => component !== undefined);
  return capabilityInstallApproval(components).reasons;
}

/** Folds machine results into every live operation that planned the same keys. */
export function updateOperationTargets(
  state: CapabilityState,
  results: ReadonlyMap<string, { status: CapabilityTargetStatus; reason?: string }>,
): string[] {
  const touched: string[] = [];
  for (const operation of Object.values(state.operations)) {
    if (isTerminalCapabilityOperationState(operation.state)) continue;
    if (operation.state !== "applying" && operation.state !== "observing") continue;
    let changed = false;
    for (const target of operation.targets) {
      const result = results.get(target.key);
      if (!result) continue;
      target.status = result.status;
      if (result.reason) target.reason = result.reason;
      else delete target.reason;
      changed = true;
    }
    if (!changed) continue;
    operation.summary = summarizeCapabilityTargets(operation.targets);
    operation.updatedAt = nowIso();
    finalizeOperation(operation);
    touched.push(operation.id);
  }
  return touched;
}

const UNSETTLED: ReadonlySet<CapabilityTargetStatus> = new Set(["pending", "outcome-unknown"]);
const FAILED: ReadonlySet<CapabilityTargetStatus> = new Set([
  "failed",
  "drifted",
  "blocked-policy",
]);

/** Completes an operation once no target is still pending or unknown. */
export function finalizeOperation(operation: CapabilityOperationSnapshot): void {
  if (isTerminalCapabilityOperationState(operation.state)) return;
  const writes = operation.targets.filter(
    (target) => target.action !== "skip" && target.action !== "keep",
  );
  if (writes.some((target) => UNSETTLED.has(target.status))) return;
  const failed = writes.filter(
    (target) => FAILED.has(target.status) || target.status === "offline",
  );
  operation.state =
    failed.length === 0
      ? "completed"
      : failed.length === writes.length && writes.length > 0
        ? "failed"
        : "partially-completed";
  operation.updatedAt = nowIso();
}

/** Marks every older live operation superseded: the newest desired state is what gets delivered. */
export function supersedeOperations(state: CapabilityState, newestId: string): string[] {
  const ids: string[] = [];
  for (const operation of Object.values(state.operations)) {
    if (operation.id === newestId) continue;
    if (isTerminalCapabilityOperationState(operation.state)) continue;
    if (operation.state === "awaiting-approval" || operation.state === "planned") continue;
    operation.state = "superseded";
    operation.supersededBy = newestId;
    operation.updatedAt = nowIso();
    ids.push(operation.id);
  }
  return ids;
}

export function recordActivity(
  state: CapabilityState,
  entry: Omit<CapabilityActivityEntry, "id" | "at">,
): void {
  const id = `act_${randomBytes(8).toString("hex")}`;
  state.activity[id] = { id, at: nowIso(), ...entry };
}

/** The client view of an operation: the internal change record stripped. */
export function operationSnapshot(record: CapabilityOperationRecord): CapabilityOperationSnapshot {
  const { change: _change, basis: _basis, ...snapshot } = record;
  return {
    ...snapshot,
    targets: snapshot.targets.slice(0, CAPABILITY_LIMITS.maxTargetsPerOperation),
  };
}
