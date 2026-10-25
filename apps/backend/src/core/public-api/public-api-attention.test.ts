import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import type { PublicAttentionPage } from "@orkestrator/protocol/public-api-resources";
import { decodeAttentionCursor, encodeAttentionCursor } from "./actions-attention.js";
import { requestKey } from "./operation-ledger.js";
import type { PublicApiHarness } from "./test-support.js";
import { withPublicAuthority } from "./dispatch.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";

/** `attention.list`: pending interactions, the caller's settled runs and finished setups. */

afterEach(cleanupSessionHarnesses);

/** Advance only the read clock past the store's last completed millisecond. */
async function readAttention(harness: PublicApiHarness, input: Record<string, unknown>) {
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 10);
  try {
    return await harness.call<PublicAttentionPage>("attention.list", input);
  } finally {
    clock.mockRestore();
  }
}

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
    const empty = await readAttention(harness, {});
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
    const idle = await readAttention(harness, {});
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
      setupCompletedAt: new Date().toISOString(),
    });
    const later = await readAttention(harness, { cursor });
    if (!later.ok) throw new Error(later.error.message);
    expect(later.result.items.map((item) => item.kind)).toContain("setup");
    expect(later.result.items).toContainEqual(
      expect.objectContaining({ kind: "setup", environmentId: "env-1", phase: "failed" }),
    );
    expect(later.result.items.filter((item) => item.kind === "run").length).toBeGreaterThan(0);
    expect(decodeAttentionCursor(later.result.cursor)!).toBeGreaterThanOrEqual(
      decodeAttentionCursor(cursor)!,
    );

    const limited = await readAttention(harness, { cursor, limit: 1 });
    expect(limited.ok && limited.result.items).toHaveLength(1);
    expect(limited.ok && limited.result.more).toBeGreaterThan(0);
  });

  test("continuations deliver equal-time events despite a persistent blocking interaction", async () => {
    const { harness, service, stub } = await setup();
    const started = await harness.call<{ sessionId: string; tabId: string }>(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "work" },
      { requestId: "paged-run" },
    );
    if (!started.ok) throw new Error(started.error.message);
    const providerSessionId = stub.sends[0]!.sessionId;
    stub.pending.push(approval(providerSessionId));
    setActivity(service, "claude", started.result.tabId, providerSessionId, "waiting");
    const template = (await harness.storage.loadEnvironments())[0]!;
    const at = new Date(Date.now() - 100).toISOString();
    for (let index = 0; index < 4; index += 1) {
      await harness.storage.addEnvironment({
        ...template,
        id: `setup-${index}`,
        name: `setup ${index}`,
        status: "stopped",
        setupPhase: "ready",
        setupCompletedAt: at,
      });
    }
    let cursor = encodeAttentionCursor(Date.parse(at) - 1);
    const delivered: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await readAttention(harness, {
        cursor,
        limit: 1,
      });
      if (!response.ok) throw new Error(response.error.message);
      for (const item of response.result.items)
        delivered.push(item.kind === "setup" ? item.environmentId : item.kind);
      cursor = response.result.cursor;
      expect(cursor.length).toBeLessThanOrEqual(64);
      if (!response.result.more) break;
    }
    expect(delivered[0]).toBe("interaction");
    expect(delivered.filter((id) => id === "interaction")).toHaveLength(1);
    expect(delivered.filter((id) => id.startsWith("setup-")).sort()).toEqual([
      "setup-0",
      "setup-1",
      "setup-2",
      "setup-3",
    ]);
    const next = await readAttention(harness, { cursor, limit: 1 });
    expect(next.ok && next.result.items[0]?.kind).toBe("interaction");
  });

  test("continues beyond the operation query limit without dropping settled runs", async () => {
    const { harness } = await setup();
    const operations: string[] = [];
    for (let index = 0; index < 55; index += 1) {
      const requestId = `settled-${index}`;
      const { record } = await harness.storage.admitPublicOperation({
        authority: "operator",
        action: "ticket.create",
        scope: "project:test",
        requestId,
        requestKey: requestKey("operator", "ticket.create", "project:test", requestId),
        fingerprint: "0".repeat(64),
        generation: "test",
      });
      await harness.storage.updatePublicOperation(record.operationId, (current) => ({
        ...current,
        state: "succeeded",
        stage: "completed",
      }));
      operations.push(record.operationId);
    }
    const delivered: string[] = [];
    let cursor = encodeAttentionCursor(Date.now() - 60_000);
    for (let index = 0; index < 60; index += 1) {
      const page = await readAttention(harness, {
        cursor,
        limit: 1,
      });
      if (!page.ok) throw new Error(page.error.message);
      delivered.push(
        ...page.result.items.flatMap((item) => (item.kind === "run" ? [item.operationId] : [])),
      );
      cursor = page.result.cursor;
      if (!page.result.more) break;
    }
    expect(delivered.sort()).toEqual(operations.sort());
    expect(new Set(delivered).size).toBe(55);
  });

  test("checks the newest environment after more than 200 older environments", async () => {
    const { harness, service, stub } = await setup();
    const template = (await harness.storage.loadEnvironments())[0]!;
    for (let index = 2; index <= 201; index += 1) {
      await harness.storage.addEnvironment({
        ...template,
        id: `env-${index}`,
        name: `environment ${index}`,
        order: index,
        status: index === 201 ? "running" : "stopped",
      });
    }
    const started = await harness.call<{ tabId: string }>(
      "session.start",
      { environmentId: "env-201", agent: "claude", prompt: "work" },
      { requestId: "newest-env" },
    );
    if (!started.ok) throw new Error(started.error.message);
    const providerSessionId = stub.sends[0]!.sessionId;
    stub.pending.push(approval(providerSessionId));
    setActivity(service, "claude", started.result.tabId, providerSessionId, "waiting", "env-201");
    const response = await readAttention(harness, {});
    expect(response.ok && response.result.items).toContainEqual(
      expect.objectContaining({ kind: "interaction", environmentId: "env-201" }),
    );
  });

  test("settled runs are selected before newer active operations fill the storage limit", async () => {
    const { harness } = await setup();
    const settled = await harness.call(
      "ticket.create",
      { projectId: (await harness.storage.loadEnvironments())[0]!.projectId, title: "Settled" },
      { requestId: "settled-run" },
    );
    expect(settled.ok).toBe(true);
    for (let index = 0; index < 51; index += 1) {
      await harness.storage.admitPublicOperation({
        authority: "operator",
        action: "session.start",
        scope: "environment:env-1",
        requestId: `active-${index}`,
        requestKey: requestKey("operator", "session.start", "environment:env-1", `active-${index}`),
        fingerprint: "0".repeat(64),
        generation: "test",
      });
    }
    const page = await readAttention(harness, {});
    expect(page.ok && page.result.items).toContainEqual(
      expect.objectContaining({ kind: "run", operationId: settled.receipt!.operationId }),
    );
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
    const asOperator = await readAttention(harness, {});
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
