import { afterEach, describe, expect, test } from "bun:test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import type { PublicAttentionPage } from "@orkestrator/protocol/public-api-resources";
import { decodeAttentionCursor, encodeAttentionCursor } from "./actions-attention.js";
import { withPublicAuthority } from "./dispatch.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";

/** `attention.list`: pending interactions, the caller's settled runs and finished setups. */

afterEach(cleanupSessionHarnesses);

function approval(providerSessionId: string): AgentInteractionRequest {
  return {
    version: 1,
    id: "approval-1",
    provider: "claude",
    kind: "command-approval",
    origin: "interactive-native",
    sessionId: providerSessionId,
    state: "pending",
    revision: 4,
    presentation: { title: "Run rm -rf dist", body: "secret body text", questions: [] },
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
  } as unknown as AgentInteractionRequest;
}

describe("attention.list", () => {
  test("lists waiting interactions without their body, then settled runs and setups", async () => {
    const { harness, service, stub } = await setup();
    const empty = await harness.call<PublicAttentionPage>("attention.list", {});
    if (!empty.ok) throw new Error(empty.error.message);
    expect(empty.result.items).toEqual([]);

    const started = await harness.call<{ sessionId: string; tabId: string; runId: string }>(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "work" },
      { requestId: "attention-run" },
    );
    if (!started.ok) throw new Error(started.error.message);
    const providerSessionId = stub.sends[0]!.sessionId;
    stub.pending.push(approval(providerSessionId));
    // Idle sessions are not read at all.
    setActivity(service, "claude", started.result.tabId, providerSessionId, "idle");
    const idle = await harness.call<PublicAttentionPage>("attention.list", {});
    expect(idle.ok && idle.result.counts.interactions).toBe(0);

    setActivity(service, "claude", started.result.tabId, providerSessionId, "waiting");
    const waiting = await harness.call<PublicAttentionPage>("attention.list", {});
    if (!waiting.ok) throw new Error(waiting.error.message);
    expect(waiting.result.items[0]).toEqual({
      kind: "interaction",
      at: expect.any(String),
      sessionId: started.result.sessionId,
      environmentId: "env-1",
      environmentName: "sessions",
      agent: "claude",
      interactionId: "approval-1",
      interactionKind: "command-approval",
      revision: 4,
      blocking: true,
      title: "Run rm -rf dist",
    });
    expect(JSON.stringify(waiting)).not.toContain("secret body text");

    // A finished setup and a settled run both appear after the cursor.
    const cursor = waiting.result.cursor;
    // Stopping settles the start run one way or another (the scripted
    // provider never confirms the turn ended, so it may stay unknown).
    await harness.call(
      "session.stop",
      { sessionId: started.result.sessionId },
      { requestId: "attention-stop" },
    );
    await harness.storage.updateEnvironment("env-1", {
      setupPhase: "failed",
      setupCompletedAt: new Date(Date.now() + 5).toISOString(),
    });
    const later = await harness.call<PublicAttentionPage>("attention.list", { cursor });
    if (!later.ok) throw new Error(later.error.message);
    expect(later.result.items.map((item) => item.kind)).toContain("setup");
    expect(later.result.items).toContainEqual(
      expect.objectContaining({ kind: "setup", environmentId: "env-1", phase: "failed" }),
    );
    expect(later.result.items.filter((item) => item.kind === "run").length).toBeGreaterThan(0);
    expect(decodeAttentionCursor(later.result.cursor)!).toBeGreaterThanOrEqual(
      decodeAttentionCursor(cursor)!,
    );

    const limited = await harness.call<PublicAttentionPage>("attention.list", { cursor, limit: 1 });
    expect(limited.ok && limited.result.items).toHaveLength(1);
    expect(limited.ok && limited.result.more).toBeGreaterThan(0);
  });

  test("never lists another authority's runs and refuses a foreign cursor", async () => {
    const { harness } = await setup();
    const started = await harness.call(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "work" },
      { requestId: "operator-run" },
    );
    expect(started.ok).toBe(true);
    await harness.call(
      "session.stop",
      { sessionId: (started as { result: { sessionId: string } }).result.sessionId },
      { requestId: "operator-stop" },
    );
    const asOperator = await harness.call<PublicAttentionPage>("attention.list", {});
    expect(asOperator.ok && asOperator.result.counts.runs).toBeGreaterThan(0);
    const asCredential = (await harness.commands.get("public_action")!(
      withPublicAuthority(
        { schemaVersion: 1, action: "attention.list", actionVersion: 1, input: {} },
        "control-mcp:voice",
      ),
      harness.context,
    )) as { ok: boolean; result: PublicAttentionPage };
    expect(asCredential.ok && asCredential.result.counts.runs).toBe(0);

    const bad = await harness.call("attention.list", { cursor: "not-a-cursor" });
    expect(!bad.ok && bad.error.code).toBe("invalid-input");
    expect(decodeAttentionCursor(encodeAttentionCursor(1_234_567))).toBe(1_234_567);
  });
});
