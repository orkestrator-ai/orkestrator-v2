/**
 * A bridge older than the MCP configuration report cannot prove an apply.
 * The runtime says so, with what to do, instead of waiting silently; a
 * restarted bridge can still prove it afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { McpOperationSnapshot } from "@orkestrator/protocol/mcp-management";

import { EVIDENCE_RECHECK_MS, appliedReason, olderBridgeOutcome } from "./evidence.js";
import {
  createFixture,
  mutation,
  pauseScheduler,
  revision,
  targetIdFor,
  type Fixture,
} from "./test-support.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
});

const KEY = "env-env-1:tab-a";

const USER: Record<"claude" | "cursor" | "pi" | "grok", { file: string; sourceId: string }> = {
  claude: { file: "home/.claude.json", sourceId: "claude:user" },
  cursor: { file: "home/.cursor/mcp.json", sourceId: "cursor:user" },
  pi: { file: "home/.pi/agent/mcp.json", sourceId: "pi:user" },
  grok: { file: "home/.grok/config.toml", sourceId: "grok:user" },
};

function session(agent: AgentPlatform) {
  fixture.sessions.push({
    environmentId: "env-1",
    agent,
    logicalSessionKey: KEY,
    providerSessionId: "provider-session-1",
    pendingDispatch: false,
    coordinator: false,
  });
}

async function saveAndApply(provider: keyof typeof USER) {
  const targetId = await targetIdFor(fixture, provider, "backend");
  const snapshot = await fixture.service.snapshot({ targetId });
  const result = await fixture.service.mutate(
    mutation(
      targetId,
      {
        kind: "add",
        sourceId: USER[provider].sourceId,
        expectedRevision: revision(snapshot, USER[provider].sourceId),
        definition: { name: "fixture", transport: "stdio", command: "x" },
      },
      "save-and-apply",
    ),
  );
  pauseScheduler(fixture);
  return result.operation;
}

function answer(provider: AgentPlatform, value: Parameters<Fixture["evidence"]["set"]>[1]) {
  fixture.evidence.set(`env-1:${provider}:${KEY}`, value);
}

function prove(provider: keyof typeof USER): void {
  const digest = `sha256:${createHash("sha256")
    .update(readFileSync(path.join(fixture.root, USER[provider].file)))
    .digest("base64url")}`;
  answer(provider, {
    state: "evidence",
    evidence: {
      sources: { user: digest },
      observedAt: new Date(fixture.now.value).toISOString(),
      scope: provider === "grok" ? "process" : "session",
    },
  });
}

async function runtimeOf(operation: McpOperationSnapshot) {
  return (await fixture.service.getOperation({ operationId: operation.operationId })).apply
    .runtimes[0]!;
}

describe("bridges older than the MCP configuration report", () => {
  test.each(["cursor", "pi"] as const)(
    "%s: an older bridge needs a restart, and a restarted bridge proves it",
    async (provider) => {
      session(provider);
      const operation = await saveAndApply(provider);
      expect(operation.apply.runtimes[0]!.state).toBe("pending-next-turn");
      answer(provider, { state: "unsupported" });
      await fixture.service.tick();
      const older = await runtimeOf(operation);
      expect(older).toMatchObject(olderBridgeOutcome(provider));
      expect(older.state).toBe("restart-required");
      expect(older.reason).toContain("older than this backend");
      expect(older.reason).toContain("Stop and start the environment");

      // Still polled: the environment restarts with a current bridge.
      fixture.now.value += EVIDENCE_RECHECK_MS;
      prove(provider);
      await fixture.service.tick();
      expect(await runtimeOf(operation)).toMatchObject({
        state: "applied",
        reason: appliedReason(provider),
      });
    },
  );

  test("Claude: the change still loads, and the bridge's first report confirms it", async () => {
    session("claude");
    const operation = await saveAndApply("claude");
    answer("claude", { state: "unsupported" });
    await fixture.service.tick();
    const older = await runtimeOf(operation);
    expect(older.state).toBe("pending-next-turn");
    expect(older.reason).toBe(olderBridgeOutcome("claude").reason);
    expect(older.reason).toContain("confirmed once the bridge reports");
    expect(older.reason).not.toContain("until the environment restarts");

    // A bridge from #838 on reports its first query's files: no restart.
    fixture.now.value += EVIDENCE_RECHECK_MS;
    prove("claude");
    await fixture.service.tick();
    expect(await runtimeOf(operation)).toMatchObject({
      state: "applied",
      reason: appliedReason("claude"),
    });
  });

  test("Grok: a restart onto an older bridge says so rather than staying generic", async () => {
    fixture.environment.grokBridgePid = 11;
    session("grok");
    const operation = await saveAndApply("grok");
    expect(operation.apply.runtimes[0]!.state).toBe("restart-required");
    fixture.environment.grokBridgePid = 12;
    answer("grok", { state: "unsupported" });
    await fixture.service.tick();
    expect(await runtimeOf(operation)).toMatchObject(olderBridgeOutcome("grok"));
  });

  test("the outcome is published once, not on every poll", async () => {
    session("pi");
    const operation = await saveAndApply("pi");
    answer("pi", { state: "unsupported" });
    await fixture.service.tick();
    const events = fixture.events.length;
    fixture.now.value += EVIDENCE_RECHECK_MS;
    await fixture.service.tick();
    expect(fixture.evidenceReads).toHaveLength(2);
    expect(fixture.events.length).toBe(events);
    expect((await runtimeOf(operation)).state).toBe("restart-required");
  });

  test("a current bridge with nothing loaded yet is not mistaken for an older one", async () => {
    session("pi");
    const operation = await saveAndApply("pi");
    answer("pi", { state: "none" });
    await fixture.service.tick();
    expect(await runtimeOf(operation)).toMatchObject({
      state: "pending-next-turn",
      reason: "Reconnects MCP servers before the session's next message.",
    });
  });
});
