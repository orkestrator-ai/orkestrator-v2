import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  MCP_MANAGEMENT_LIMITS,
  mcpManagementErrorFromUnknown,
} from "@orkestrator/protocol/mcp-management";

import { COORDINATOR_BLOCKED, ENVIRONMENT_DELETED } from "./apply.js";
import { createFixture, mutation, revision, targetIdFor, type Fixture } from "./test-support.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
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

  test("fan-out beyond the page keeps one reload per environment", async () => {
    const limit = MCP_MANAGEMENT_LIMITS.runtimesPerOperation;
    for (let index = 0; index < limit + 2; index += 1) session("codex", `env-env-1:tab-${index}`);
    environment("env-2");
    session("codex", "env-env-2:tab-last", { environmentId: "env-2" });
    const result = await saveAndApply("codex", "codex:user");
    expect(result.operation.apply.runtimes).toHaveLength(limit);
    expect(result.operation.apply.omitted).toBe(3);
    expect(
      result.operation.apply.runtimes.some((runtime) => runtime.environmentId === "env-2"),
    ).toBe(true);
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
