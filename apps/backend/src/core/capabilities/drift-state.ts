/**
 * The state side of adopting local changes (`drift.ts`), applied inside the
 * same transaction as the change that publishes them (`applyChangeToState`):
 * the drift entries it settles, the package's relation to where the bytes came
 * from, and, for a local variant, the setups it replaces the original in.
 */
import {
  CAPABILITY_LIMITS,
  parseCapabilityComponentId,
  type CapabilityPackage,
  type CapabilityPackageSelection,
} from "@orkestrator/protocol/capability-resources";

import { CapabilityError } from "./security.js";
import type { CapabilityState, SourceInspectionRecord } from "./types.js";

/** Re-keys `<packageId>#<kind>:<key>` from one package to another. */
function remapComponentId(componentId: string, from: string, to: string): string {
  const parsed = parseCapabilityComponentId(componentId);
  return parsed?.packageId === from ? `${to}#${parsed.kind}:${parsed.key}` : componentId;
}

/**
 * Settles the drift entries an adoption covers and records where the new
 * revision came from. `before` is the adopted package as it was before the
 * change. Throws `conflict` when a covered local change moved since the
 * preview.
 */
export function settleAdoption(
  state: CapabilityState,
  inspection: SourceInspectionRecord,
  before: CapabilityPackage | undefined,
  options: { now: string; setupId: string; actor?: string },
): void {
  const adoption = inspection.adoption;
  if (!adoption) return;
  const fromPackageId = adoption.fromPackageId ?? inspection.packageId;
  const driftIds = adoption.driftIds?.length ? adoption.driftIds : [adoption.driftId];
  for (const driftId of driftIds) {
    const drift = state.drift[driftId];
    const item = adoption.items?.find(
      (entry) =>
        drift && entry.locationId === drift.locationId && entry.componentId === drift.componentId,
    );
    const expected = driftId === adoption.driftId ? adoption.digest || undefined : item?.digest;
    if (
      !drift ||
      drift.state !== "open" ||
      drift.packageId !== fromPackageId ||
      (drift.observedDigest ?? undefined) !== expected
    ) {
      throw new CapabilityError(
        "conflict",
        "The local change no longer matches the adoption preview.",
      );
    }
    drift.state = "adopted";
  }

  const pkg = state.packages[inspection.packageId];
  if (!pkg) return;
  pkg.provenance = "managed";
  if (adoption.mode === "variant") {
    const original = state.packages[fromPackageId];
    if (original) {
      pkg.derivedFrom = {
        packageId: original.id,
        source: original.source,
        revision: original.revision,
        artifactDigest: original.artifactDigest,
        at: options.now,
      };
    }
    replaceInSetups(state, fromPackageId, pkg.id, options);
    return;
  }
  // The package's next revision: a package with an outside source now diverges from it.
  if (pkg.source.kind !== "managed" && before) {
    pkg.diverged = {
      upstreamRevision: before.diverged?.upstreamRevision ?? before.revision,
      upstreamDigest: before.diverged?.upstreamDigest ?? before.artifactDigest,
      reason: adoption.merged ? "merged-local" : "adopted-local",
      at: options.now,
    };
    // A proposal made against the replaced revision is stale; the next check
    // proposes the upstream head again, marked as diverged.
    for (const update of Object.values(state.updates)) {
      if (update.packageId !== pkg.id || update.state !== "pending") continue;
      delete state.updates[update.id];
      delete state.inspections[`update:${update.id}`];
    }
  }
}

/** A local variant replaces its original wherever a setup selects it, keeping the choices made. */
function replaceInSetups(
  state: CapabilityState,
  from: string,
  to: string,
  options: { now: string; setupId: string; actor?: string },
): void {
  for (const setup of Object.values(state.setups)) {
    const original = setup.packageSelections.find((entry) => entry.packageId === from);
    if (!original) continue;
    const added = setup.packageSelections.find((entry) => entry.packageId === to);
    const replacement: CapabilityPackageSelection = {
      packageId: to,
      version: "latest",
      ...(original.components
        ? { components: original.components.map((id) => remapComponentId(id, from, to)) }
        : {}),
      ...(original.required || added?.required ? { required: true } : {}),
    };
    setup.packageSelections = setup.packageSelections
      .filter((entry) => entry.packageId !== to)
      .map((entry) => (entry.packageId === from ? replacement : entry))
      .slice(0, CAPABILITY_LIMITS.maxSelectionsPerSetup);
    setup.exclusions = setup.exclusions.map((exclusion) => {
      const bar = exclusion.lastIndexOf("|");
      if (bar < 0) return exclusion;
      const id = exclusion.slice(bar + 1);
      const mapped = id === from ? to : remapComponentId(id, from, to);
      return `${exclusion.slice(0, bar)}|${mapped}`;
    });
    if (setup.id !== options.setupId) {
      setup.revision += 1;
      setup.updatedAt = options.now;
      if (options.actor) setup.updatedBy = options.actor;
    }
  }
}
