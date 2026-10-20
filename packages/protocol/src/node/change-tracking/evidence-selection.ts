/**
 * MeasurementSelectionPolicyV1: choose which retained evidence a tool's
 * payload and provider-reported effect resources measure.
 *
 * Evidence is first partitioned by claim — a proposal and a provider-reported
 * result never compete as if they measured the same thing — and only then
 * ranked by kind. Ties break on the evidence key and revision, never on
 * receipt time. A numeric report that disagrees with the selected patch is
 * kept as a discrepancy instead of being shown above an incompatible body.
 */

import type { ExecutionOccurrence, ProviderEvidence, ToolPhase } from "../../change-evidence.js";
import { MEASUREMENT_SELECTION_POLICY_ID } from "./count-policy.js";
import type { EvidenceMeasurement } from "./evidence-measure.js";

export { MEASUREMENT_SELECTION_POLICY_ID };

export interface EvidenceCandidate {
  evidenceId: string;
  evidenceRevision: number;
  evidenceKey: string;
  evidence: ProviderEvidence;
}

export interface EvidenceSelection {
  role: "payload" | "effect";
  kind: ProviderEvidence["kind"];
  candidates: EvidenceCandidate[];
}

export interface EvidenceDiscrepancy {
  kind: "reported-counts-disagree";
  reported: { additions: number | null; deletions: number | null };
  selectedEvidenceIds: string[];
}

export interface SelectionResult {
  policyId: typeof MEASUREMENT_SELECTION_POLICY_ID;
  payload: EvidenceSelection | null;
  effect: EvidenceSelection | null;
  discrepancies: EvidenceDiscrepancy[];
}

function rank(evidence: ProviderEvidence): number {
  switch (evidence.kind) {
    case "patch":
      return evidence.format === "git_unified" && evidence.body.state === "available" ? 0 : 5;
    case "replacement":
      // Result-side replacements outrank input fragments within one claim.
      if (evidence.before.state === "unknown" && evidence.after.state === "unknown") return 6;
      return evidence.origin === "result" ? 1 : 2;
    case "reported-counts":
      return evidence.additions === null && evidence.deletions === null ? 4 : 3;
    case "path-operation":
      return 4;
  }
}

function compareCandidates(left: EvidenceCandidate, right: EvidenceCandidate): number {
  if (left.evidenceKey !== right.evidenceKey) return left.evidenceKey < right.evidenceKey ? -1 : 1;
  return left.evidenceRevision - right.evidenceRevision;
}

function select(
  role: "payload" | "effect",
  candidates: readonly EvidenceCandidate[],
): EvidenceSelection | null {
  if (candidates.length === 0) return null;
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) best = Math.min(best, rank(candidate.evidence));
  const chosen = candidates
    .filter((candidate) => rank(candidate.evidence) === best)
    .sort(compareCandidates);
  return { role, kind: chosen[0]!.evidence.kind, candidates: chosen };
}

/**
 * Select payload and effect evidence for one canonical attempt. `candidates`
 * must already hold one selected revision per evidence key.
 */
export function selectToolEvidence(
  candidates: readonly EvidenceCandidate[],
  lifecycle: { phase: ToolPhase; executionOccurrence: ExecutionOccurrence },
): SelectionResult {
  const reported = candidates.filter((c) => c.evidence.effectClaim === "provider-reported");
  const proposals = candidates.filter((c) => c.evidence.effectClaim !== "provider-reported");
  const ran =
    lifecycle.phase !== "denied" &&
    lifecycle.executionOccurrence !== "did-not-run" &&
    lifecycle.executionOccurrence !== "not-started";
  // A provider-reported result without execution is retained but not shown
  // as an applied effect; it falls back to the payload role.
  const payloadPool = ran ? proposals : candidates;
  return {
    policyId: MEASUREMENT_SELECTION_POLICY_ID,
    payload: select("payload", payloadPool),
    effect: ran ? select("effect", reported) : null,
    discrepancies: [],
  };
}

/**
 * Compare declared tool-level counts against the measured selection. A
 * disagreement is retained for diagnostics; the selection is unchanged.
 */
export function findCountDiscrepancies(
  selection: EvidenceSelection,
  measured: EvidenceMeasurement,
  candidates: readonly EvidenceCandidate[],
): EvidenceDiscrepancy[] {
  if (selection.kind === "reported-counts") return [];
  const discrepancies: EvidenceDiscrepancy[] = [];
  for (const candidate of candidates) {
    const evidence = candidate.evidence;
    if (evidence.kind !== "reported-counts" || evidence.scope === "turn") continue;
    const additionsDiffer =
      evidence.additions !== null &&
      measured.additions.value !== null &&
      evidence.additions !== measured.additions.value;
    const deletionsDiffer =
      evidence.deletions !== null &&
      measured.deletions.value !== null &&
      evidence.deletions !== measured.deletions.value;
    if (additionsDiffer || deletionsDiffer) {
      discrepancies.push({
        kind: "reported-counts-disagree",
        reported: { additions: evidence.additions, deletions: evidence.deletions },
        selectedEvidenceIds: selection.candidates.map((c) => c.evidenceId),
      });
    }
  }
  return discrepancies;
}
