import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { mcpManagementErrorFromUnknown } from "@orkestrator/protocol/mcp-management";

import { createFixture, mutation, revision, targetIdFor, type Fixture } from "./test-support.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
});

function session(agent: AgentPlatform, key: string) {
  fixture.sessions.push({
    environmentId: "env-1",
    agent,
    logicalSessionKey: key,
    pendingDispatch: false,
    coordinator: false,
  });
}

async function add(provider: AgentPlatform, sourceId: string, name: string, intent = "save") {
  const targetId = await targetIdFor(fixture, provider, "backend");
  const snapshot = await fixture.service.snapshot({ targetId });
  return fixture.service.mutate(
    mutation(
      targetId,
      {
        kind: "add",
        sourceId,
        expectedRevision: revision(snapshot, sourceId),
        definition: { name, transport: "stdio", command: "x" },
      },
      intent as "save" | "save-and-apply",
    ),
  );
}

async function codeOf(promise: Promise<unknown>) {
  return mcpManagementErrorFromUnknown(await promise.catch((error: unknown) => error))?.code;
}

/** Every file under the fake home, with its bytes and mtime. */
function homeFiles(): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else result[full] = `${readFileSync(full, "utf8")}@${statSync(full).mtimeMs}`;
    }
  };
  walk(fixture.home);
  return result;
}

describe("rollout gate", () => {
  test("defaults to everything enabled", async () => {
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(snapshot.target.capabilities.management.supported).toBe(true);
    expect(snapshot.target.capabilities.rollout).toEqual({
      write: { supported: true },
      apply: { supported: true },
    });
    expect(fixture.service.rolloutSettings().enabled).toBe(true);
  });

  test("the kill switch refuses mutations, explains itself, and never touches saved files", async () => {
    await add("claude", "claude:user", "kept");
    const before = homeFiles();
    fixture.rollout.value = { enabled: false };
    await fixture.service.refreshRollout();
    expect(homeFiles()).toEqual(before);

    const targetId = await targetIdFor(fixture, "claude", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(snapshot.target.capabilities.management).toMatchObject({
      supported: false,
      reason: expect.stringContaining("turned off"),
    });
    expect(snapshot.target.capabilities.operations.add.supported).toBe(false);
    // Rows stay readable but read-only, with the reason.
    const row = snapshot.definitions.find((definition) => definition.name === "kept")!;
    expect(row.readOnlyReason).toContain("turned off");
    expect(row.actions.remove.supported).toBe(false);

    expect(await codeOf(add("claude", "claude:user", "refused"))).toBe("management-disabled");
    expect(
      await codeOf(
        fixture.service.validate(
          mutation(targetId, {
            kind: "add",
            sourceId: "claude:user",
            expectedRevision: revision(snapshot, "claude:user"),
            definition: { name: "refused", transport: "stdio", command: "x" },
          }),
        ),
      ),
    ).toBe("management-disabled");
    expect(homeFiles()).toEqual(before);
    expect(JSON.parse(fixture.read("home/.claude.json")).mcpServers.kept).toBeDefined();

    // Turning it back on restores writes.
    fixture.rollout.value = undefined;
    await fixture.service.refreshRollout();
    expect((await add("claude", "claude:user", "again")).operation.phase).toBe("saved");
  });

  test("a per-provider write gate only affects that provider", async () => {
    fixture.rollout.value = { writeProviders: ["claude"] };
    await fixture.service.refreshRollout();
    expect(await codeOf(add("pi", "pi:user", "no"))).toBe("management-disabled");
    expect((await add("claude", "claude:user", "yes")).operation.phase).toBe("saved");
  });

  test("disabling apply retires queued work as cancelled and pauses the scheduler", async () => {
    session("codex", "env-env-1:tab-1");
    fixture.activity.set("env-1:codex:env-env-1:tab-1", "working");
    const queued = await add("codex", "codex:user", "fixture", "save-and-apply");
    expect(queued.operation.apply.state).toBe("queued");
    const before = homeFiles();

    fixture.rollout.value = { applyProviders: ["claude"] };
    await fixture.service.refreshRollout();
    const retired = await fixture.service.getOperation({
      operationId: queued.operation.operationId,
    });
    expect(retired.phase).toBe("saved");
    expect(retired.apply.state).toBe("cancelled");
    expect(retired.apply.runtimes[0]!.reason).toContain("not enabled");
    expect(retired.apply.runtimes[0]!.reason).toContain("saved configuration is unchanged");

    fixture.activity.set("env-1:codex:env-env-1:tab-1", "idle");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual([]);
    expect(homeFiles()).toEqual(before);

    // Saving still works; applying is withheld with an explicit message.
    const saved = await add("codex", "codex:user", "second", "save-and-apply");
    expect(saved.operation.phase).toBe("saved");
    expect(saved.operation.apply.state).toBe("not-requested");
    expect(saved.operation.message).toContain("Saved.");
    expect(await codeOf(fixture.service.apply({ operationId: saved.operation.operationId }))).toBe(
      "management-disabled",
    );
    const targetId = await targetIdFor(fixture, "codex", "backend");
    const snapshot = await fixture.service.snapshot({ targetId });
    expect(snapshot.target.capabilities.rollout?.apply.supported).toBe(false);
    expect(snapshot.target.capabilities.rollout?.write.supported).toBe(true);
  });

  test("a backend that starts with the gate off retires queued work from before", async () => {
    session("codex", "env-env-1:tab-1");
    fixture.activity.set("env-1:codex:env-env-1:tab-1", "working");
    const queued = await add("codex", "codex:user", "fixture", "save-and-apply");
    fixture.service.dispose();
    fixture.rollout.value = { enabled: false };
    fixture.service = fixture.newService();
    const retired = await fixture.service.getOperation({
      operationId: queued.operation.operationId,
    });
    expect(retired.apply.state).toBe("cancelled");
    expect(retired.apply.runtimes[0]!.reason).toContain("turned off");
  });
});
