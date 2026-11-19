/**
 * Runtime evidence and what it allows a badge to say
 * (docs/architecture/agent-capabilities-management.md, "Verification").
 *
 * Levels only rise with evidence: a receipt proves `present` (or `enabled`
 * for a provider flag); a provider's live inventory that lists the component
 * for a session proves `advertised`; a component the session actually ran
 * proves `observed-in-use`. A provider with no live inventory stays
 * "installed; not runtime-verified" until a use is seen. Nothing here
 * infers readiness from a file copy.
 */
import {
  verificationRank,
  type CapabilityTarget,
  type CapabilityTargetStatus,
  type CapabilityVerificationLevel,
} from "@orkestrator/protocol/capability-resources";

import type { CapabilityState, InstallationReceipt, RuntimeObservation } from "./types.js";

export function observationId(target: CapabilityTarget, componentId: string): string {
  return `${target.nodeId}|${target.provider}|${target.sessionId ?? ""}|${componentId}`;
}

/**
 * Records evidence from a session's command catalogue: names the provider
 * itself listed. Only a `ready` catalogue counts; a stale or partial one is
 * not evidence that the current generation loaded anything.
 */
export function recordCatalogueEvidence(
  state: CapabilityState,
  input: {
    target: CapabilityTarget;
    catalogueState: string;
    names: readonly string[];
    generation?: string;
    now: string;
  },
): number {
  if (input.catalogueState !== "ready") return 0;
  const names = new Set(
    input.names.map((name) =>
      name
        .replace(/^\/+/, "")
        .replace(/^skill:/, "")
        .toLowerCase(),
    ),
  );
  let recorded = 0;
  for (const component of Object.values(state.components)) {
    if (component.kind !== "skill" && component.kind !== "command" && component.kind !== "prompt")
      continue;
    const candidates = [
      component.name,
      component.pathOrKey.split("/").pop()?.replace(/\.md$/, "") ?? "",
    ]
      .map((name) => name.toLowerCase())
      .filter(Boolean);
    if (
      !candidates.some(
        (name) => names.has(name) || [...names].some((listed) => listed.endsWith(`:${name}`)),
      )
    )
      continue;
    const id = observationId(input.target, component.id);
    const previous = state.observations[id];
    if (
      previous &&
      verificationRank(previous.level) >= verificationRank("advertised") &&
      previous.generation === input.generation
    ) {
      continue;
    }
    const observation: RuntimeObservation = {
      id,
      target: input.target,
      componentId: component.id,
      level:
        previous && verificationRank(previous.level) > verificationRank("advertised")
          ? previous.level
          : "advertised",
      source: "bridge-inventory",
      ...(input.generation ? { generation: input.generation } : {}),
      observedAt: input.now,
    };
    state.observations[id] = observation;
    recorded += 1;
  }
  return recorded;
}

/** The strongest evidence for a component on a target. */
export function evidenceFor(
  state: CapabilityState,
  target: Pick<CapabilityTarget, "nodeId" | "provider">,
  componentId: string,
): RuntimeObservation | undefined {
  let best: RuntimeObservation | undefined;
  for (const observation of Object.values(state.observations)) {
    if (
      observation.componentId !== componentId ||
      observation.target.nodeId !== target.nodeId ||
      observation.target.provider !== target.provider
    ) {
      continue;
    }
    if (!best || verificationRank(observation.level) > verificationRank(best.level))
      best = observation;
  }
  return best;
}

/**
 * A receipt's status. Catalogue names alone cannot attest which bytes were loaded.
 */
export function effectiveReceiptStatus(
  _state: CapabilityState,
  receipt: InstallationReceipt,
  _provider: CapabilityTarget["provider"],
): {
  status: CapabilityTargetStatus;
  verification: CapabilityVerificationLevel | "unverified";
  lastVerifiedAt?: string;
} {
  // Stored catalogue names from previous versions did not prove package identity.
  return {
    status: receipt.status,
    verification: receipt.verification,
    ...(receipt.verifiedAt ? { lastVerifiedAt: receipt.verifiedAt } : {}),
  };
}
