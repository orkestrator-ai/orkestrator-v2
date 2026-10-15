import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import type {
  ClaudeInteractionRequest,
  PlanApprovalRequest,
  QuestionRequest,
} from "../types/index.js";
import {
  pendingInteractions,
  pendingPlanApprovals,
  pendingQuestions,
} from "./session-manager-core.js";

export function interactionKey(sessionId: string, requestId: string): string {
  return JSON.stringify([sessionId, requestId]);
}

/** Bound the combined snapshot, including all three HTTP response envelopes.
 * Never evict an unanswered request to make room for another one. */
export function canAdmitInteraction(
  candidate: ClaudeInteractionRequest | PlanApprovalRequest | QuestionRequest,
  family: "interactions" | "approvals" | "questions",
): boolean {
  const families = {
    interactions: Array.from(pendingInteractions.values()),
    approvals: Array.from(pendingPlanApprovals.values()),
    questions: Array.from(pendingQuestions.values()),
  };
  let count = 0;
  let bytes = 0;
  // The backend also validates its normalized snapshot. Allow for duplicated
  // option labels/provider values, JSON-encoded schemas and generated card
  // metadata. The fixed allowance covers identities, timing, origin and the
  // snapshot envelope; per-question/option allowances cover generated keys.
  let normalizedBytes = 128;
  for (const name of ["interactions", "approvals", "questions"] as const) {
    const entries = families[name].filter(
      (entry) =>
        entry.sessionId === candidate.sessionId && !(name === family && entry.id === candidate.id),
    );
    const payload = name === family ? [...entries, candidate] : entries;
    count += payload.length;
    for (const entry of payload) {
      const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
      normalizedBytes += 2 * entryBytes + 1024;
      if ("questions" in entry) {
        normalizedBytes += entry.questions.length * 256;
        for (const question of entry.questions)
          normalizedBytes += (question.options?.length ?? 0) * 128;
      }
    }
    bytes += new TextEncoder().encode(JSON.stringify({ [name]: payload })).byteLength;
  }
  return (
    count <= AGENT_INTERACTION_LIMITS.maxPendingRequests &&
    bytes <= AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes &&
    normalizedBytes <= AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
  );
}
