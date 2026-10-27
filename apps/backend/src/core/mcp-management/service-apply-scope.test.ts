import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  MCP_MANAGEMENT_LIMITS,
  mcpManagementErrorFromUnknown,
  type McpRuntimeApplyEntry,
} from "@orkestrator/protocol/mcp-management";

import { COORDINATOR_BLOCKED, ENVIRONMENT_DELETED, publicApply } from "./apply.js";
import { EVIDENCE_READS_PER_TICK } from "./evidence.js";
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

afterEach(async () => {
  await fixture.cleanup();
});

function session(
  agent: AgentPlatform,
  key: string,
  extra: Partial<Fixture["sessions"][number]> = {},
) {
  fixture.sessions.push({
    environmentId: "env-1",
    agent,
    logicalSessionKey: key,
    pendingDispatch: false,
    coordinator: false,
    ...extra,
  });
}

function environment(id: string) {
  const worktree = path.join(fixture.root, `worktree-${id}`);
  mkdirSync(worktree, { recursive: true });
  fixture.extraEnvironments.push({ ...fixture.environment, id, name: id, worktreePath: worktree });
}

async function saveAndApply(provider: AgentPlatform, sourceId: string, targetId?: string) {
  const target = targetId ?? (await targetIdFor(fixture, provider, "backend"));
  const snapshot = await fixture.service.snapshot({ targetId: target });
  return fixture.service.mutate(
    mutation(
      target,
      {
        kind: "add",
        sourceId,
        expectedRevision: revision(snapshot, sourceId),
        definition: { name: "fixture", transport: "stdio", command: "x" },
      },
      "save-and-apply",
    ),
  );
}

describe("host project files under a project-resources policy", () => {
  // Live-confirmed for Cursor 1.0.37 on 2026-10-18: with the environment's
  // policy on, the host bridge loaded and called a server from the worktree's
  // `.cursor/mcp.json` while this catalogue still said "excluded".
  for (const [provider, file] of [
    ["cursor", ".cursor/mcp.json"],
    ["pi", ".pi/mcp.json"],
  ] as const) {
    test(`${provider}: the project file is loaded and applied when the environment turns project resources on`, async () => {
      fixture.write(
        `worktree/${file}`,
        JSON.stringify({ mcpServers: { proj: { command: "proj-server" } } }),
      );
      const target = await targetIdFor(fixture, provider, "environment");
      let snapshot = await fixture.service.snapshot({ targetId: target });
      const sourceId = `${provider}:project`;
      expect(snapshot.sources.find((source) => source.sourceId === sourceId)?.trust).toBe(
        "excluded",
      );

      fixture.environment.agentSettings = { executionPolicy: { projectResources: true } };
      snapshot = await fixture.service.snapshot({ targetId: target });
      expect(snapshot.sources.find((source) => source.sourceId === sourceId)?.trust).toBe(
        "allowed",
      );
      expect(
        snapshot.definitions.find(
          (definition) => definition.sourceId === sourceId && definition.name === "proj",
        )?.status,
      ).toBe("effective");

      session(provider, "env-env-1:tab-a", { projectResources: true });
      const result = await saveAndApply(provider, sourceId, target);
      expect(result.operation.apply.runtimes.map((runtime) => runtime.state)).toEqual([
        "pending-next-turn",
      ]);
    });
  }

  test("a session whose own policy excludes project resources stays blocked", async () => {
    fixture.environment.agentSettings = { executionPolicy: { projectResources: true } };
    session("cursor", "env-env-1:tab-a", { projectResources: false });
    const target = await targetIdFor(fixture, "cursor", "environment");
    const result = await saveAndApply("cursor", "cursor:project", target);
    expect(result.operation.apply.runtimes.map((runtime) => runtime.state)).toEqual([
      "blocked-policy",
    ]);
  });
});

describe("apply scope", () => {
  test("coordinator sessions under a runtime id are reported, not dropped", async () => {
    const coordinator = coordinatorRuntimeId("coord-1", "conv-1");
    // The id shape alone identifies it, even without the policy flag.
    session("claude", `${coordinator}:tab-c`, { environmentId: coordinator });
    session("claude", "env-env-1:tab-a");
    const result = await saveAndApply("claude", "claude:user");
    const runtimes = result.operation.apply.runtimes;
    expect(runtimes).toHaveLength(2);
    const blocked = runtimes.find((runtime) => runtime.environmentId === coordinator)!;
    expect(blocked.state).toBe("blocked-policy");
    expect(blocked.reason).toBe(COORDINATOR_BLOCKED);
    expect(blocked.label.startsWith("Coordinator")).toBe(true);
  });

  test("queued work for a deleted environment is retired as cancelled", async () => {
    environment("env-2");
    session("codex", "env-env-2:tab-1", { environmentId: "env-2" });
    fixture.activity.set("env-2:codex:env-env-2:tab-1", "working");
    const result = await saveAndApply("codex", "codex:user");
    expect(result.operation.apply.state).toBe("queued");
    fixture.extraEnvironments.splice(0);
    await fixture.service.tick();
    const retired = await fixture.service.getOperation({
      operationId: result.operation.operationId,
    });
    expect(retired.apply.runtimes[0]).toMatchObject({
      state: "cancelled",
      reason: ENVIRONMENT_DELETED,
    });
    expect(fixture.reloads).toEqual([]);
  });

  test("fan-out beyond the page lists every environment and counts the rest by state", async () => {
    const limit = MCP_MANAGEMENT_LIMITS.runtimesPerOperation;
    for (let index = 0; index < limit + 2; index += 1) session("codex", `env-env-1:tab-${index}`);
    environment("env-2");
    session("codex", "env-env-2:tab-last", { environmentId: "env-2" });
    const result = await saveAndApply("codex", "codex:user");
    expect(result.operation.apply.runtimes).toHaveLength(limit);
    expect(result.operation.apply.omitted).toBe(3);
    expect(result.operation.apply.omittedStates).toEqual({ queued: 3 });
    expect(
      result.operation.apply.runtimes.some((runtime) => runtime.environmentId === "env-2"),
    ).toBe(true);
    await fixture.service.tick();
    expect(fixture.reloads.sort()).toEqual(["env-1", "env-2"]);
    // The unlisted runtimes were advanced too, not dropped.
    const done = await fixture.service.getOperation({ operationId: result.operation.operationId });
    expect(done.apply.omittedStates).toEqual({ "pending-next-turn": 3 });
    expect(done.apply.state).toBe("pending-next-turn");
    // The catalog snapshot pages its operations the same way.
    const listed = (await fixture.service.snapshot({ targetId: result.operation.targetId }))
      .operations[0]!;
    expect(listed.apply.runtimes).toHaveLength(limit);
    expect(listed.apply.omitted).toBe(3);
  });

  test("more Codex environments than the page are all reloaded", async () => {
    const count = MCP_MANAGEMENT_LIMITS.runtimesPerOperation + 6;
    for (let index = 2; index <= count; index += 1) {
      environment(`env-${index}`);
      session("codex", `env-env-${index}:tab`, { environmentId: `env-${index}` });
    }
    session("codex", "env-env-1:tab");
    const result = await saveAndApply("codex", "codex:user");
    expect(result.operation.apply.runtimes).toHaveLength(
      MCP_MANAGEMENT_LIMITS.runtimesPerOperation,
    );
    expect(result.operation.apply.omitted).toBe(6);
    await fixture.service.tick();
    expect(new Set(fixture.reloads).size).toBe(count);
  });

  test("an unlisted runtime is still proven by its bridge", async () => {
    const limit = MCP_MANAGEMENT_LIMITS.runtimesPerOperation;
    for (let index = 0; index <= limit; index += 1) session("claude", `env-env-1:tab-${index}`);
    const result = await saveAndApply("claude", "claude:user");
    const listed = new Set(result.operation.apply.runtimes.map((runtime) => runtime.runtimeId));
    const hidden = `env-env-1:tab-${limit}`;
    expect(listed.has(`env-1\u0000${hidden}`)).toBe(false);
    pauseScheduler(fixture);
    fixture.now.value += 1_000;
    fixture.evidence.set(`env-1:claude:${hidden}`, {
      state: "evidence",
      evidence: {
        sources: {
          user: `sha256:${createHash("sha256")
            .update(readFileSync(path.join(fixture.home, ".claude.json")))
            .digest("base64url")}`,
        },
        observedAt: new Date(fixture.now.value).toISOString(),
        scope: "session",
      },
    });
    // Reads are paced, so cover every runtime once.
    const passes = Math.ceil((limit + 1) / EVIDENCE_READS_PER_TICK);
    for (let pass = 0; pass < passes; pass += 1) await fixture.service.tick();
    const proven = await fixture.service.getOperation({
      operationId: result.operation.operationId,
    });
    expect(proven.apply.omittedStates).toEqual({ applied: 1 });
  });

  test("a superseded runtime past the page is listed, so clients withhold Retry", () => {
    const limit = MCP_MANAGEMENT_LIMITS.runtimesPerOperation;
    const last = limit + 1;
    const runtimes = Array.from({ length: limit + 2 }, (_, index): McpRuntimeApplyEntry => ({
      runtimeId: `r-${index}`,
      environmentId: "env-1",
      label: `r-${index}`,
      updatedAt: "2026-09-23T12:00:00Z",
      ...(index === last
        ? { state: "cancelled", cancelReason: "superseded-external" }
        : { state: "failed" }),
    }));
    const paged = publicApply({ state: "failed", runtimes, omitted: 0 });
    expect(paged.runtimes).toHaveLength(limit);
    expect(paged.runtimes.at(-1)).toMatchObject({ runtimeId: `r-${last}` });
    expect(paged.omitted).toBe(2);
    expect(paged.omittedStates).toEqual({ failed: 2 });
  });

  test("past what one apply tracks, the rest are counted as not scheduled", async () => {
    const tracked = MCP_MANAGEMENT_LIMITS.runtimesTrackedPerOperation;
    const page = MCP_MANAGEMENT_LIMITS.runtimesPerOperation;
    for (let index = 0; index < tracked + 5; index += 1) session("codex", `env-env-1:tab-${index}`);
    environment("env-2");
    session("codex", "env-env-2:tab-last", { environmentId: "env-2" });
    const result = await saveAndApply("codex", "codex:user");
    const apply = result.operation.apply;
    expect(apply.runtimes).toHaveLength(page);
    expect(apply.omitted).toBe(tracked + 6 - page);
    // Tracked but unlisted, by state; the remainder was never scheduled.
    expect(apply.omittedStates).toEqual({ queued: tracked - page });
    // The environment past the cap still keeps its reload.
    await fixture.service.tick();
    expect(fixture.reloads.sort()).toEqual(["env-1", "env-2"]);
  });

  test("a queue at its target bound refuses a new target with busy", async () => {
    const bound = MCP_MANAGEMENT_LIMITS.queuedApplyTargets;
    const ids = ["env-1"];
    for (let index = 2; index <= bound + 1; index += 1) {
      environment(`env-${index}`);
      ids.push(`env-${index}`);
    }
    for (const id of ids) {
      session("codex", `env-${id}:tab`, { environmentId: id });
      fixture.activity.set(`${id}:codex:env-${id}:tab`, "working");
    }
    const targetFor = async (id: string) =>
      (await fixture.service.listTargets({ environmentId: id })).targets.find(
        (target) => target.provider === "codex" && target.context.kind === "environment",
      )!.targetId;
    for (const id of ids.slice(0, bound)) {
      const queued = await saveAndApply("codex", "codex:project", await targetFor(id));
      expect(queued.operation.apply.state).toBe("queued");
    }
    const overflow = await saveAndApply("codex", "codex:project", await targetFor(ids[bound]!));
    // The save itself succeeded; only scheduling was refused, and it says so.
    expect(overflow.operation.phase).toBe("saved");
    expect(overflow.operation.apply.state).toBe("failed");
    expect(overflow.operation.message).toContain("capacity");
    // Retrying while the queue is still full is refused again, retryably.
    const again = await fixture.service
      .apply({ operationId: overflow.operation.operationId })
      .catch((error: unknown) => error);
    expect(mcpManagementErrorFromUnknown(again)?.code).toBe("busy");
  });

  test("a bridge with nothing running, or one that predates reload, is reported truthfully", async () => {
    session("codex", "env-env-1:tab-1");
    fixture.reloadOutcome.value = "not-running";
    const idle = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    expect(
      (await fixture.service.getOperation({ operationId: idle.operation.operationId })).apply
        .runtimes[0],
    ).toMatchObject({ state: "pending-next-turn", reason: expect.stringContaining("not running") });

    fixture.reloadOutcome.value = "unsupported";
    await fixture.service.apply({ operationId: idle.operation.operationId });
    await fixture.service.tick();
    expect(
      (await fixture.service.getOperation({ operationId: idle.operation.operationId })).apply
        .runtimes[0],
    ).toMatchObject({ state: "restart-required", reason: expect.stringContaining("predates") });
    expect(fixture.reloads).toEqual(["env-1", "env-1"]);
  });
});
