import { describe, expect, test } from "bun:test";
import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import {
  createSession,
  track,
  getPendingInteractions,
  respondToInteraction,
} from "./session-manager-test-harness.js";
import { pendingQuestions, pendingPlanApprovals } from "./session-manager-core.js";
import { cleanupPendingInteractions } from "./session-manager-lifecycle.js";
import { parkInteraction } from "./session-manager-parked-interactions.js";
import { canAdmitInteraction } from "./session-manager-interaction-budget.js";
import type { ClaudeInteractionRequest } from "../types/index.js";

function request(sessionId: string, id: string, message = "Input"): ClaudeInteractionRequest {
  return {
    id,
    sessionId,
    kind: "mcp-form",
    serverName: "test",
    message,
    schema: { type: "object" },
    requestedAt: Date.now(),
    expiresAt: Date.now() + 300000,
  };
}

describe("parked interaction ownership and admission", () => {
  test("redelivery settles the old waiter without deleting its replacement", async () => {
    const session = createSession("redelivery");
    track(session.id);
    const first = parkInteraction(request(session.id, "same"));
    const replacement = request(session.id, "same", "Replacement");
    const second = parkInteraction(replacement);
    expect(await first).toEqual({ action: "withdrawn" });
    expect(getPendingInteractions(session.id)).toEqual([replacement]);
    expect(respondToInteraction("same", { action: "accept", content: {} }, session.id)).toBe(true);
    expect(await second).toEqual({ action: "accept", content: {} });
  });

  test("provider ids reused across sessions have independent waiters", async () => {
    const a = createSession("reuse-a");
    const b = createSession("reuse-b");
    track(a.id);
    track(b.id);
    const first = parkInteraction(request(a.id, "same"));
    const second = parkInteraction(request(b.id, "same"));
    expect(respondToInteraction("same", { action: "decline" })).toBe(false);
    expect(respondToInteraction("same", { action: "decline" }, a.id)).toBe(true);
    expect(await first).toEqual({ action: "decline" });
    expect(getPendingInteractions(b.id)).toHaveLength(1);
    cleanupPendingInteractions(b.id);
    expect(await second).toEqual({ action: "withdrawn" });
  });

  test("count admission includes questions and plans and releases capacity", async () => {
    const session = createSession("count-bound");
    track(session.id);
    pendingQuestions.set("q", { id: "q", sessionId: session.id, questions: [], toolUseId: "q" });
    pendingPlanApprovals.set("p", { id: "p", sessionId: session.id, toolUseId: "p" });
    const waits = Array.from({ length: AGENT_INTERACTION_LIMITS.maxPendingRequests - 2 }, (_, i) =>
      parkInteraction(request(session.id, String(i))),
    );
    expect(await parkInteraction(request(session.id, "excess"))).toEqual({ action: "decline" });
    expect(getPendingInteractions(session.id)).toHaveLength(62);
    expect(respondToInteraction("0", { action: "decline" }, session.id)).toBe(true);
    await waits[0];
    const replacement = parkInteraction(request(session.id, "replacement"));
    expect(getPendingInteractions(session.id)).toHaveLength(62);
    cleanupPendingInteractions(session.id);
    expect(await replacement).toEqual({ action: "withdrawn" });
    await Promise.all(waits);
    expect(canAdmitInteraction(request(session.id, "new"), "interactions")).toBe(true);
  });

  test("UTF-8 byte admission preserves listable, answerable cards and exact envelope boundary", async () => {
    const session = createSession("byte-bound");
    track(session.id);
    const waits = [];
    for (let i = 0; i < 18; i++) {
      const candidate = request(session.id, String(i), "界".repeat(5025));
      if (!canAdmitInteraction(candidate, "interactions")) {
        expect(await parkInteraction(candidate)).toEqual({ action: "decline" });
      } else waits.push(parkInteraction(candidate));
    }
    const admitted = getPendingInteractions(session.id);
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.length).toBeLessThan(18);
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const used =
      bytes({ interactions: admitted }) + bytes({ questions: [] }) + bytes({ approvals: [] });
    expect(used).toBeLessThanOrEqual(AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes);
    for (const card of admitted)
      expect(respondToInteraction(card.id, { action: "accept", content: {} }, session.id)).toBe(
        true,
      );
    await Promise.all(waits);
    const candidate = request(session.id, "exact", "");
    let lower = 0;
    let upper = AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes;
    while (lower + 1 < upper) {
      const middle = Math.floor((lower + upper) / 2);
      candidate.message = "x".repeat(middle);
      if (canAdmitInteraction(candidate, "interactions")) lower = middle;
      else upper = middle;
    }
    candidate.message = "x".repeat(lower);
    expect(canAdmitInteraction(candidate, "interactions")).toBe(true);
    candidate.message += "x";
    expect(canAdmitInteraction(candidate, "interactions")).toBe(false);
  });
});
