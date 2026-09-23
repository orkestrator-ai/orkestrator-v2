import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import {
  createFixture,
  entry,
  mutation,
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

async function saveAndApply(
  provider: AgentPlatform,
  sourceId: string,
  kind: "backend" | "environment" = "backend",
) {
  const targetId = await targetIdFor(fixture, provider, kind);
  const snapshot = await fixture.service.snapshot({ targetId });
  return fixture.service.mutate(
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
}

const operationsFile = () => path.join(fixture.dataDir, "mcp-management", "operations.json");

describe("runtime application", () => {
  test("save-only never plans runtimes", async () => {
    session("claude", "env-env-1:tab-a");
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const result = await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: null,
        definition: { name: "a", transport: "stdio", command: "x" },
      }),
    );
    expect(result.operation.apply).toEqual({ state: "not-requested", runtimes: [], omitted: 0 });
  });

  test("Claude sessions load on their next message; coordinators and excluded projects are blocked", async () => {
    session("claude", "env-env-1:tab-a");
    session("claude", "env-env-1:coord", { coordinator: true });
    session("claude", "env-env-1:tab-b", { projectResources: false });
    const user = await saveAndApply("claude", "claude:user");
    expect(user.operation.apply.runtimes.map((runtime) => runtime.state)).toEqual([
      "pending-next-turn",
      "blocked-policy",
      "pending-next-turn",
    ]);
    const project = await saveAndApply("claude", "claude:project", "environment");
    expect(project.operation.apply.runtimes.map((runtime) => runtime.state)).toEqual([
      "pending-next-turn",
      "blocked-policy",
      "blocked-policy",
    ]);
    expect(project.operation.apply.terminalGuidance).toContain("restart the terminal");
  });

  test("OpenCode and Grok report a required restart; nothing is restarted", async () => {
    session("opencode", "env-env-1:tab-o");
    session("grok", "env-env-1:tab-g");
    expect(
      (await saveAndApply("opencode", "opencode:user-opencode.json")).operation.apply.state,
    ).toBe("restart-required");
    expect((await saveAndApply("grok", "grok:user")).operation.apply.state).toBe(
      "restart-required",
    );
  });

  test("stopped environments and containers say when they will pick the change up", async () => {
    session("pi", "env-env-1:tab-p");
    fixture.environment.status = "stopped";
    const stopped = await saveAndApply("pi", "pi:user");
    expect(stopped.operation.apply.runtimes[0]).toMatchObject({
      state: "pending-next-turn",
      reason: expect.stringContaining("next starts"),
    });
    fixture.environment.status = "running";
    fixture.environment.environmentType = "containerized";
    const container = await saveAndApply("cursor", "cursor:user");
    expect(container.operation.apply.runtimes).toEqual([]);
    session("cursor", "env-env-1:tab-c");
    const second = await fixture.service.apply({ operationId: container.operation.operationId });
    expect(second.apply.runtimes[0]).toMatchObject({
      state: "restart-required",
      reason: expect.stringContaining("recreate"),
    });
  });

  test("Codex reload waits for every session in the process to be idle, then runs once", async () => {
    session("codex", "env-env-1:tab-1");
    session("codex", "env-env-1:tab-2");
    fixture.activity.set("env-1:codex:env-env-1:tab-2", "working");
    const result = await saveAndApply("codex", "codex:user");
    expect(result.operation.apply.state).toBe("queued");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual([]);
    expect(
      (await fixture.service.getOperation({ operationId: result.operation.operationId })).apply
        .state,
    ).toBe("queued");

    fixture.activity.set("env-1:codex:env-env-1:tab-2", "idle");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual(["env-1:env-env-1:tab-1"]);
    const done = await fixture.service.getOperation({ operationId: result.operation.operationId });
    expect(done.apply.runtimes.map((runtime) => runtime.state)).toEqual([
      "pending-next-turn",
      "pending-next-turn",
    ]);
    await fixture.service.tick();
    expect(fixture.reloads.length).toBe(1);
  });

  test("unknown activity and pending dispatches count as busy", async () => {
    session("codex", "env-env-1:tab-1", { pendingDispatch: true });
    const result = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual([]);
    fixture.sessions[0]!.pendingDispatch = false;
    fixture.activity.set("env-1:codex:env-env-1:tab-1", "unknown");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual([]);
    // Bounded: after the wait budget the runtime fails instead of waiting forever.
    fixture.now.value += 31 * 60_000;
    await fixture.service.tick();
    expect(
      (await fixture.service.getOperation({ operationId: result.operation.operationId })).apply
        .state,
    ).toBe("failed");
  });

  test("a failed reload leaves the save intact and can be retried without rewriting", async () => {
    session("codex", "env-env-1:tab-1");
    fixture.reloadFailure.value = new Error("bridge said no");
    const result = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    const failed = await fixture.service.getOperation({
      operationId: result.operation.operationId,
    });
    expect(failed.phase).toBe("saved");
    expect(failed.apply.state).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain("bridge said no");
    const before = fixture.read("home/.codex/config.toml");
    fixture.reloadFailure.value = null;
    await fixture.service.apply({ operationId: result.operation.operationId });
    await fixture.service.tick();
    expect(fixture.reloads.length).toBe(1);
    expect(fixture.read("home/.codex/config.toml")).toBe(before);
    expect(
      (await fixture.service.getOperation({ operationId: result.operation.operationId })).apply
        .state,
    ).toBe("pending-next-turn");
  });

  test("a newer apply supersedes queued work and cancel leaves the save intact", async () => {
    session("codex", "env-env-1:tab-1");
    fixture.activity.set("env-1:codex:env-env-1:tab-1", "working");
    const first = await saveAndApply("codex", "codex:user");
    const targetId = first.operation.targetId;
    const snapshot = await fixture.service.snapshot({ targetId });
    const second = await fixture.service.mutate(
      mutation(
        targetId,
        {
          kind: "remove",
          entryId: entry(snapshot, "codex:user", "fixture").entryId,
          expectedRevision: revision(snapshot, "codex:user")!,
        },
        "save-and-apply",
      ),
    );
    expect(
      (await fixture.service.getOperation({ operationId: first.operation.operationId })).apply
        .state,
    ).toBe("cancelled");
    const cancelled = await fixture.service.cancelApply({
      operationId: second.operation.operationId,
    });
    expect(cancelled.apply.state).toBe("cancelled");
    expect(cancelled.phase).toBe("saved");
  });

  test("a project apply keeps a different environment's user apply queued", async () => {
    fixture.extraEnvironments.push({
      ...fixture.environment,
      id: "env-2",
      name: "env-two",
      worktreePath: path.join(fixture.root, "worktree-two"),
    });
    session("codex", "env-env-1:tab-1");
    session("codex", "env-env-2:tab-2", { environmentId: "env-2" });
    fixture.activity.set("env-1:codex:env-env-1:tab-1", "working");
    fixture.activity.set("env-2:codex:env-env-2:tab-2", "working");
    const targetId = await targetIdFor(fixture, "codex", "environment");
    const firstSnapshot = await fixture.service.snapshot({ targetId });
    const user = await fixture.service.mutate(
      mutation(
        targetId,
        {
          kind: "add",
          sourceId: "codex:user",
          expectedRevision: revision(firstSnapshot, "codex:user"),
          definition: { name: "user", transport: "stdio", command: "x" },
        },
        "save-and-apply",
      ),
    );
    const projectSnapshot = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(
        targetId,
        {
          kind: "add",
          sourceId: "codex:project",
          expectedRevision: revision(projectSnapshot, "codex:project"),
          definition: { name: "project", transport: "stdio", command: "x" },
        },
        "save-and-apply",
      ),
    );
    const first = await fixture.service.getOperation({ operationId: user.operation.operationId });
    expect(first.apply.runtimes.find((runtime) => runtime.environmentId === "env-2")?.state).toBe(
      "queued",
    );
  });

  test("cancelling during a reload is retained after the tick completes", async () => {
    session("codex", "env-env-1:tab-1");
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.reloadControl.wait = () => {
      started();
      return gate;
    };
    const result = await saveAndApply("codex", "codex:user");
    const ticking = fixture.service.tick();
    await entered;
    await fixture.service.cancelApply({ operationId: result.operation.operationId });
    release();
    await ticking;
    const final = await fixture.service.getOperation({ operationId: result.operation.operationId });
    expect(final.apply.state).toBe("cancelled");
    expect(final.apply.runtimes[0]?.state).toBe("cancelled");
  });

  test("a newer apply during reload keeps the older operation superseded", async () => {
    session("codex", "env-env-1:tab-1");
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.reloadControl.wait = () => {
      started();
      return gate;
    };
    const first = await saveAndApply("codex", "codex:user");
    const ticking = fixture.service.tick();
    await entered;
    const snapshot = await fixture.service.snapshot({ targetId: first.operation.targetId });
    const newer = await fixture.service.mutate(
      mutation(
        first.operation.targetId,
        {
          kind: "remove",
          entryId: entry(snapshot, "codex:user", "fixture").entryId,
          expectedRevision: revision(snapshot, "codex:user")!,
        },
        "save-and-apply",
      ),
    );
    release();
    await ticking;
    const older = await fixture.service.getOperation({ operationId: first.operation.operationId });
    expect(older.apply.state).toBe("cancelled");
    expect(newer.operation.apply.state).toBe("queued");
  });

  test("operations survive a backend restart and queued work resumes", async () => {
    session("codex", "env-env-1:tab-1");
    fixture.activity.set("env-1:codex:env-env-1:tab-1", "working");
    const result = await saveAndApply("codex", "codex:user");
    fixture.service.dispose();
    fixture.service = fixture.newService();
    fixture.activity.set("env-1:codex:env-env-1:tab-1", "idle");
    expect(
      (await fixture.service.getOperation({ operationId: result.operation.operationId })).apply
        .state,
    ).toBe("queued");
    await fixture.service.tick();
    expect(fixture.reloads.length).toBe(1);
  });
});

describe("crash recovery", () => {
  function markPending(operationId: string, mutate: (record: any) => void = () => undefined) {
    const store = JSON.parse(readFileSync(operationsFile(), "utf8"));
    const record = store.operations.find(
      (candidate: any) => candidate.snapshot.operationId === operationId,
    );
    record.snapshot.phase = "pending";
    delete record.snapshot.savedRevision;
    mutate(record);
    writeFileSync(operationsFile(), JSON.stringify(store));
  }

  test("a write that landed before the crash is recognised, not repeated", async () => {
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const result = await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: null,
        definition: { name: "a", transport: "stdio", command: "x" },
      }),
    );
    fixture.service.dispose();
    markPending(result.operation.operationId);
    const before = fixture.read("home/.claude.json");
    fixture.service = fixture.newService();
    const recovered = await fixture.service.getOperation({
      operationId: result.operation.operationId,
    });
    expect(recovered.phase).toBe("saved");
    expect(recovered.message).toContain("Recovered");
    expect(fixture.read("home/.claude.json")).toBe(before);
  });

  test("a crash before the write is reported as not saved", async () => {
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const result = await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: null,
        definition: { name: "a", transport: "stdio", command: "x" },
      }),
    );
    const current = (await fixture.service.snapshot({ targetId })).sources[0]!.revision;
    fixture.service.dispose();
    markPending(result.operation.operationId, (record) => {
      record.recovery.expectedRevision = current;
    });
    fixture.service = fixture.newService();
    const recovered = await fixture.service.getOperation({
      operationId: result.operation.operationId,
    });
    expect(recovered.phase).toBe("failed");
    expect(recovered.message).toContain("not changed");
  });

  test("an external change after an interrupted write becomes a conflict", async () => {
    const targetId = await targetIdFor(fixture, "claude", "backend");
    const result = await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: null,
        definition: { name: "a", transport: "stdio", command: "x" },
      }),
    );
    fixture.service.dispose();
    markPending(result.operation.operationId);
    fixture.write(
      "home/.claude.json",
      JSON.stringify({ mcpServers: { a: { command: "edited elsewhere" } } }),
    );
    fixture.service = fixture.newService();
    expect(
      (await fixture.service.getOperation({ operationId: result.operation.operationId })).phase,
    ).toBe("conflict");
  });
});
