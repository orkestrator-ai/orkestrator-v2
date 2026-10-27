/**
 * Runtime generations: every apply outcome names the bridge process and
 * provider session it was observed against, a read that straddles a runtime
 * replacement is not attributed, and a re-apply never inherits an earlier
 * run's success.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { McpOperationSnapshot } from "@orkestrator/protocol/mcp-management";

import { EVIDENCE_RECHECK_MS, NEWER_RUN_REASON, appliedReason } from "./evidence.js";
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
  fixture.environment.claudeBridgePid = 101;
  fixture.environment.codexBridgePid = 301;
});

afterEach(async () => {
  await fixture.cleanup();
});

const KEY = "env-env-1:tab-a";

function session(agent: AgentPlatform, providerSessionId: string, key = KEY) {
  fixture.sessions.push({
    environmentId: "env-1",
    agent,
    logicalSessionKey: key,
    providerSessionId,
    pendingDispatch: false,
    coordinator: false,
  });
}

function claudeDigest(): string {
  return `sha256:${createHash("sha256")
    .update(readFileSync(path.join(fixture.root, "home/.claude.json")))
    .digest("base64url")}`;
}

function reportClaude(observedAt = fixture.now.value): void {
  fixture.evidence.set(`env-1:claude:${KEY}`, {
    state: "evidence",
    evidence: {
      sources: { user: claudeDigest() },
      observedAt: new Date(observedAt).toISOString(),
      scope: "session",
    },
  });
}

async function saveAndApply(provider: AgentPlatform, sourceId: string) {
  const targetId = await targetIdFor(fixture, provider, "backend");
  const snapshot = await fixture.service.snapshot({ targetId });
  const result = await fixture.service.mutate(
    mutation(
      targetId,
      {
        kind: "add",
        sourceId,
        expectedRevision: revision(snapshot, sourceId),
        definition: { name: "fixture", transport: "stdio", command: "x" },
      },
      "save-and-apply",
    ),
  );
  pauseScheduler(fixture);
  return result.operation;
}

async function runtimeOf(operation: McpOperationSnapshot) {
  return (await fixture.service.getOperation({ operationId: operation.operationId })).apply
    .runtimes[0]!;
}

describe("runtime generations", () => {
  test("a planned runtime names its generation without disclosing its ids", async () => {
    session("claude", "provider-session-1");
    session("claude", "provider-session-2", "env-env-1:tab-b");
    const operation = await saveAndApply("claude", "claude:user");
    const [first, second] = operation.apply.runtimes;
    expect(first!.generation).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // Another conversation in the same bridge is another generation.
    expect(second!.generation).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(second!.generation).not.toBe(first!.generation);
    const durable = readFileSync(path.join(fixture.dataDir, "mcp-management/operations.json"));
    expect(JSON.stringify(operation)).not.toContain("provider-session-1");
    expect(durable.toString()).not.toContain("provider-session-1");
  });

  test("evidence from the planned generation is applied against it", async () => {
    session("claude", "provider-session-1");
    const operation = await saveAndApply("claude", "claude:user");
    const planned = operation.apply.runtimes[0]!.generation;
    fixture.now.value += 1_000;
    reportClaude();
    await fixture.service.tick();
    expect(await runtimeOf(operation)).toMatchObject({
      state: "applied",
      reason: appliedReason("claude"),
      generation: planned,
    });
  });

  test.each([
    ["the bridge restarted", () => (fixture.environment.claudeBridgePid = 202)],
    [
      "the tab moved to a new conversation",
      () => (fixture.sessions[0]!.providerSessionId = "ps-2"),
    ],
  ])("when %s, the newer run that proved it is named", async (_case, replace) => {
    session("claude", "provider-session-1");
    const operation = await saveAndApply("claude", "claude:user");
    const planned = operation.apply.runtimes[0]!.generation;
    replace();
    fixture.now.value += 1_000;
    reportClaude();
    await fixture.service.tick();
    const runtime = await runtimeOf(operation);
    expect(runtime).toMatchObject({ state: "applied", reason: NEWER_RUN_REASON });
    expect(runtime.generation).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(runtime.generation).not.toBe(planned);
  });

  test("a read during which the runtime was replaced is not attributed, then re-read", async () => {
    session("claude", "provider-session-1");
    const operation = await saveAndApply("claude", "claude:user");
    fixture.now.value += 1_000;
    reportClaude();
    // The runtime is replaced while its bridge is being read: the answer may
    // describe either run, so neither gets it.
    fixture.evidenceHook.onRead = () => {
      fixture.sessions[0]!.providerSessionId = "provider-session-2";
      fixture.evidenceHook.onRead = undefined;
    };
    await fixture.service.tick();
    expect(await runtimeOf(operation)).toMatchObject({ state: "pending-next-turn" });
    expect(fixture.evidenceReads).toHaveLength(1);

    // Re-read at once, not after the recheck interval, against the new run.
    await fixture.service.tick();
    expect(fixture.evidenceReads).toHaveLength(2);
    expect(await runtimeOf(operation)).toMatchObject({
      state: "applied",
      reason: NEWER_RUN_REASON,
    });
  });

  test("a re-apply never inherits an earlier run's success", async () => {
    session("claude", "provider-session-1");
    const operation = await saveAndApply("claude", "claude:user");
    fixture.now.value += 1_000;
    reportClaude();
    await fixture.service.tick();
    const proven = await runtimeOf(operation);
    expect(proven.state).toBe("applied");

    // The bridge restarts; the new run has reported nothing yet.
    fixture.environment.claudeBridgePid = 202;
    fixture.evidence.clear();
    const replanned = await fixture.service.apply({ operationId: operation.operationId });
    pauseScheduler(fixture);
    expect(replanned.apply.runtimes[0]).toMatchObject({ state: "pending-next-turn" });
    expect(replanned.apply.runtimes[0]!.generation).not.toBe(proven.generation);
    fixture.now.value += EVIDENCE_RECHECK_MS;
    await fixture.service.tick();
    expect((await runtimeOf(operation)).state).toBe("pending-next-turn");

    // Only the new run's own report proves it, against the generation now planned.
    fixture.now.value += EVIDENCE_RECHECK_MS;
    reportClaude();
    await fixture.service.tick();
    expect(await runtimeOf(operation)).toMatchObject({
      state: "applied",
      reason: appliedReason("claude"),
      generation: replanned.apply.runtimes[0]!.generation,
    });
  });

  test("a Codex reload names the process it reached", async () => {
    session("codex", "thread-1");
    const operation = await saveAndApply("codex", "codex:user");
    const planned = operation.apply.runtimes[0]!.generation;
    expect(planned).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // The app-server restarted between planning and the reload.
    fixture.environment.codexBridgePid = 302;
    await fixture.service.tick();
    const runtime = await runtimeOf(operation);
    expect(runtime.state).toBe("pending-next-turn");
    expect(runtime.generation).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(runtime.generation).not.toBe(planned);
  });

  test("containers and coordinators have no generation to name", async () => {
    session("claude", "provider-session-1");
    fixture.sessions.push({
      environmentId: "env-1",
      agent: "claude",
      logicalSessionKey: "env-env-1:coord",
      providerSessionId: "provider-session-c",
      pendingDispatch: false,
      coordinator: true,
    });
    fixture.environment.environmentType = "containerized";
    const operation = await saveAndApply("claude", "claude:user");
    for (const runtime of operation.apply.runtimes) expect(runtime.generation).toBeUndefined();
  });
});
