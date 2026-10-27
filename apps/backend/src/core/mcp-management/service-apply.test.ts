import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { openCodeFake, openCodeProvider, waitUntil } from "../agent-provider-test-support.js";
import { createMcpRuntimeProbe } from "../commands-registry-mcp.js";
import type { CommandContext } from "../commands-context.js";
import { CONTAINER_DEFAULTS_REASON } from "./apply.js";
import {
  createFixture,
  entry,
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

  test("Grok reports a required restart; nothing is restarted", async () => {
    session("grok", "env-env-1:tab-g");
    expect((await saveAndApply("grok", "grok:user")).operation.apply.state).toBe(
      "restart-required",
    );
  });

  test("OpenCode rebuilds the worktree's instance once idle, and its listing proves the change", async () => {
    session("opencode", "env-env-1:tab-o1");
    session("opencode", "env-env-1:tab-o2");
    fixture.activity.set("env-1:opencode:env-env-1:tab-o2", "working");
    fixture.openCodeReload.value = { outcome: "reloaded", names: ["orkestrator", "fixture"] };
    const result = await saveAndApply("opencode", "opencode:project-opencode.json", "environment");
    expect(result.operation.apply.runtimes.map((runtime) => runtime.state)).toEqual([
      "queued",
      "queued",
    ]);
    // One busy session holds the whole directory: disposal would abort its work.
    await fixture.service.tick();
    expect(fixture.openCodeReloads).toEqual([]);
    fixture.activity.set("env-1:opencode:env-env-1:tab-o2", "idle");
    await fixture.service.tick();
    expect(fixture.openCodeReloads).toEqual(["env-1"]);
    const done = await fixture.service.getOperation({ operationId: result.operation.operationId });
    expect(done.apply.state).toBe("applied");
    expect(done.apply.runtimes[0]!.reason).toContain("rebuilt this worktree's instance");
    await fixture.service.tick();
    expect(fixture.openCodeReloads.length).toBe(1);
  });

  test("OpenCode says what a reload could not prove", async () => {
    session("opencode", "env-env-1:tab-o");
    const state = async (answer: Fixture["openCodeReload"]["value"]) => {
      fixture.openCodeReload.value = answer;
      const result = await saveAndApply(
        "opencode",
        "opencode:project-opencode.json",
        "environment",
      );
      await fixture.service.tick();
      const operation = await fixture.service.getOperation({
        operationId: result.operation.operationId,
      });
      // Each case adds the same name again; drop it for the next one.
      writeFileSync(path.join(fixture.worktree, "opencode.json"), JSON.stringify({ mcp: {} }));
      return operation.apply.runtimes[0]!;
    };
    // The rebuilt instance does not list the saved server.
    expect(await state({ outcome: "reloaded", names: ["orkestrator"] })).toMatchObject({
      state: "restart-required",
      reason: expect.stringContaining("does not list fixture"),
    });
    // Disposed, but the listing could not be read: loads at its next request.
    expect(await state({ outcome: "reloaded" })).toMatchObject({ state: "pending-next-turn" });
    // A server that predates in-place reload keeps the restart guidance.
    expect(await state({ outcome: "unsupported" })).toMatchObject({
      state: "restart-required",
      reason: expect.stringContaining("stop and start the environment"),
    });
    expect(await state({ outcome: "not-running" })).toMatchObject({
      state: "pending-next-turn",
      reason: expect.stringContaining("OpenCode is not running"),
    });
    // OpenCode itself saw work running: keep waiting, never force it.
    expect(await state({ outcome: "busy" })).toMatchObject({
      state: "queued",
      reason: expect.stringContaining("OpenCode to finish"),
    });
    expect(await state(new Error("refused"))).toMatchObject({ state: "failed" });
  });

  for (const cancel of [true, false]) {
    test(`busy OpenCode apply followed by ${cancel ? "cancellation" : "supersession"} leaves no idle disposal`, async () => {
      session("opencode", "env-env-1:tab-o");
      const fake = openCodeFake();
      const provider = openCodeProvider(fake);
      let restores = 0;
      const probe = createMcpRuntimeProbe({
        nativeAgents: {
          reloadMcpConfigurationIfRunning: () => provider.reloadMcpConfiguration!(),
          openCodeMcpServerNamesIfRunning: async () => ["fixture"],
        },
        runtime: {
          localServers: {
            openCodeAgentTools: {
              forget: () => {
                restores += 1;
              },
            },
            enqueueEnvironmentOperation: async () => ({ running: false, port: null, pid: null }),
          },
        },
      } as unknown as CommandContext);
      fixture.probe.reloadOpenCode = probe.reloadOpenCode;
      fixture.probe.openCodeMcpServerNames = probe.openCodeMcpServerNames;
      try {
        await provider.createSession("build", "test");
        await waitUntil(() => fake.subscriptions.length === 1);
        fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
        const first = await saveAndApply(
          "opencode",
          "opencode:project-opencode.json",
          "environment",
        );
        pauseScheduler(fixture);
        await fixture.service.tick();
        expect(first.operation.apply.state).toBe("queued");
        if (cancel) {
          const cancelled = await fixture.service.cancelApply({
            operationId: first.operation.operationId,
          });
          expect(cancelled.apply.state).toBe("cancelled");
        } else {
          const snapshot = await fixture.service.snapshot({ targetId: first.operation.targetId });
          await fixture.service.mutate(
            mutation(
              first.operation.targetId,
              {
                kind: "update",
                entryId: entry(snapshot, "opencode:project-opencode.json", "fixture").entryId,
                expectedRevision: revision(snapshot, "opencode:project-opencode.json")!,
                patch: { command: { kind: "set", value: "replacement" } },
              },
              "save-and-apply",
            ),
          );
        }
        pauseScheduler(fixture);
        fake.setStatusResponse({ data: { "owned-session": { type: "idle" } } });
        fake.subscriptions[0]!.push({
          type: "session.idle",
          properties: { sessionID: "owned-session" },
        });
        // Drain the provider's stream before the scheduler is allowed another attempt.
        await provider.status("owned-session");
        await Promise.resolve();
        expect(fake.instanceDisposeCalls).toHaveLength(0);
        expect(restores).toBe(0);
        await fixture.service.tick();
        expect(fake.instanceDisposeCalls).toHaveLength(cancel ? 0 : 1);
        expect(restores).toBe(cancel ? 0 : 1);
        await fixture.service.tick();
        expect(fake.instanceDisposeCalls).toHaveLength(cancel ? 0 : 1);
        expect(
          (await fixture.service.getOperation({ operationId: first.operation.operationId })).apply
            .state,
        ).toBe("cancelled");
      } finally {
        await provider.dispose?.();
      }
    });
  }

  test("an OpenCode listing timeout after disposal stays pending instead of reporting reload failure", async () => {
    session("opencode", "env-env-1:tab-o");
    fixture.openCodeReload.value = { outcome: "reloaded" };
    let expire!: () => void;
    let listingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      listingStarted = resolve;
    });
    let listing = false;
    fixture.probe.openCodeMcpServerNames = () => {
      listing = true;
      // withTimeout registers synchronously after this method returns.
      queueMicrotask(listingStarted);
      return new Promise(() => {});
    };
    const original = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      ms: number,
      ...args: unknown[]
    ) => {
      if (listing && ms === 30_000) expire = callback;
      return original(callback, ms, ...args);
    }) as typeof setTimeout);
    try {
      const result = await saveAndApply(
        "opencode",
        "opencode:project-opencode.json",
        "environment",
      );
      const ticking = fixture.service.tick();
      await started;
      expect(expire).toBeDefined();
      expire();
      await ticking;
      expect(fixture.openCodeReloads).toEqual(["env-1"]);
      expect(
        (await fixture.service.getOperation({ operationId: result.operation.operationId })).apply
          .state,
      ).toBe("pending-next-turn");
    } finally {
      timer.mockRestore();
    }
  });

  test("OpenCode user files keep the restart: the server caches them for its lifetime", async () => {
    session("opencode", "env-env-1:tab-o");
    fixture.openCodeReload.value = { outcome: "reloaded", names: ["fixture"] };
    const result = await saveAndApply("opencode", "opencode:user-opencode.json");
    expect(result.operation.apply.runtimes[0]).toMatchObject({
      state: "restart-required",
      reason: expect.stringContaining("keeps its user configuration until its server restarts"),
    });
    await fixture.service.tick();
    expect(fixture.openCodeReloads).toEqual([]);
  });

  test("an OpenCode container keeps the restart; its server is not reloaded", async () => {
    fixture.environment.environmentType = "containerized";
    session("opencode", "env-env-1:tab-o");
    const result = await saveAndApply("opencode", "opencode:user-opencode.json");
    expect(result.operation.apply.runtimes[0]!.state).toBe("restart-required");
    await fixture.service.tick();
    expect(fixture.openCodeReloads).toEqual([]);
  });

  test("a Codex thread is applied once it starts a turn after the reload", async () => {
    session("codex", "env-env-1:tab-1", { lastDispatchId: "req-1" });
    session("codex", "env-env-1:tab-2");
    const result = await saveAndApply("codex", "codex:user");
    const read = () => fixture.service.getOperation({ operationId: result.operation.operationId });
    // A dispatch that is open when the reload answers may have started its
    // turn before the reload landed, so it proves nothing.
    fixture.reloadControl.wait = async () => {
      fixture.sessions[1]!.pendingDispatch = true;
      fixture.sessions[1]!.pendingDispatchId = "req-open";
    };
    await fixture.service.tick();
    fixture.reloadControl.wait = undefined;
    expect((await read()).apply.runtimes.map((runtime) => runtime.state)).toEqual([
      "pending-next-turn",
      "pending-next-turn",
    ]);
    // Nothing new was dispatched: still waiting.
    await fixture.service.tick();
    expect((await read()).apply.state).toBe("pending-next-turn");

    // The open dispatch is accepted: still not proof.
    fixture.sessions[1]!.pendingDispatch = false;
    delete fixture.sessions[1]!.pendingDispatchId;
    fixture.sessions[1]!.lastDispatchId = "req-open";
    // Tab 1 starts a new turn: proof for tab 1 only.
    fixture.sessions[0]!.lastDispatchId = "req-2";
    await fixture.service.tick();
    let runtimes = (await read()).apply.runtimes;
    expect(runtimes.map((runtime) => runtime.state)).toEqual(["applied", "pending-next-turn"]);
    expect(runtimes[0]!.reason).toBe(
      "The thread started a turn after Codex loaded the saved configuration.",
    );

    fixture.sessions[1]!.lastDispatchId = "req-3";
    await fixture.service.tick();
    runtimes = (await read()).apply.runtimes;
    expect(runtimes.map((runtime) => runtime.state)).toEqual(["applied", "applied"]);
    expect((await read()).apply.state).toBe("applied");
  });

  for (const missing of ["failed", "absent"] as const) {
    test(`a ${missing} post-reload catalogue cannot prove a historical Codex dispatch`, async () => {
      session("codex", "env-env-1:tab-1", { lastDispatchId: "req-before-reload" });
      const result = await saveAndApply("codex", "codex:user");
      fixture.reloadControl.wait = async () => {
        fixture.sessionReadControl.read = () => {
          if (missing === "failed") throw new Error("catalogue unavailable");
          return [];
        };
      };
      await fixture.service.tick();
      const read = () =>
        fixture.service.getOperation({ operationId: result.operation.operationId });
      expect((await read()).apply.state).toBe("pending-next-turn");
      fixture.sessionReadControl.read = undefined;
      // Baseline recovery itself is not adoption, including after a backend restart.
      fixture.service.dispose();
      fixture.service = fixture.newService();
      await read();
      await fixture.service.tick();
      expect((await read()).apply.state).toBe("pending-next-turn");
      fixture.sessions[0]!.lastDispatchId = "req-after-recovery";
      await fixture.service.tick();
      expect((await read()).apply.state).toBe("applied");
    });
  }

  for (const preserve of [false, true]) {
    test(`a later Codex reload ${preserve ? "preserves surviving" : "retires overwritten"} changes`, async () => {
      session("codex", "env-env-1:tab-1", { lastDispatchId: "before" });
      const first = await saveAndApply("codex", "codex:user");
      await fixture.service.tick();
      const targetId = first.operation.targetId;
      const snapshot = await fixture.service.snapshot({ targetId });
      const second = await fixture.service.mutate(
        mutation(
          targetId,
          preserve
            ? {
                kind: "add",
                sourceId: "codex:user",
                expectedRevision: revision(snapshot, "codex:user"),
                definition: { name: "other", transport: "stdio", command: "other" },
              }
            : {
                kind: "update",
                entryId: entry(snapshot, "codex:user", "fixture").entryId,
                expectedRevision: revision(snapshot, "codex:user")!,
                patch: { command: { kind: "set", value: "replacement" } },
              },
          "save-and-apply",
        ),
      );
      await fixture.service.tick();
      fixture.sessions[0]!.lastDispatchId = "after-both-reloads";
      await fixture.service.tick();
      const older = await fixture.service.getOperation({
        operationId: first.operation.operationId,
      });
      const newer = await fixture.service.getOperation({
        operationId: second.operation.operationId,
      });
      expect(older.apply.state).toBe(preserve ? "applied" : "cancelled");
      if (!preserve) expect(older.apply.runtimes[0]!.cancelReason).toBe("superseded-local");
      expect(newer.apply.state).toBe("applied");
      expect(fixture.reloads).toEqual(["env-1", "env-1"]);
    });
  }

  test("a later reload cannot reuse a dispatch from an unverified configuration generation", async () => {
    session("codex", "env-env-1:tab-1", { lastDispatchId: "before" });
    const first = await saveAndApply("codex", "codex:user");
    pauseScheduler(fixture);
    await fixture.service.tick();
    const savedA = fixture.read("home/.codex/config.toml");
    const targetId = first.operation.targetId;
    const snapshot = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(
        targetId,
        {
          kind: "update",
          entryId: entry(snapshot, "codex:user", "fixture").entryId,
          expectedRevision: revision(snapshot, "codex:user")!,
          patch: { command: { kind: "set", value: "replacement" } },
        },
        "save-and-apply",
      ),
    );
    pauseScheduler(fixture);
    // The second reload succeeds, but its source cannot be established.
    fixture.reloadControl.wait = async () => {
      fixture.write("home/.codex/config.toml", "[invalid");
    };
    await fixture.service.tick();
    fixture.reloadControl.wait = undefined;
    fixture.sessions[0]!.lastDispatchId = "during-unverified-generation";
    fixture.write("home/.codex/config.toml", savedA);
    const restored = await fixture.service.snapshot({ targetId });
    await fixture.service.mutate(
      mutation(
        targetId,
        {
          kind: "add",
          sourceId: "codex:user",
          expectedRevision: revision(restored, "codex:user"),
          definition: { name: "third", transport: "stdio", command: "x" },
        },
        "save-and-apply",
      ),
    );
    pauseScheduler(fixture);
    await fixture.service.tick();
    const read = () => fixture.service.getOperation({ operationId: first.operation.operationId });
    expect((await read()).apply.state).toBe("pending-next-turn");
    fixture.sessions[0]!.lastDispatchId = "after-verified-generation";
    await fixture.service.tick();
    expect((await read()).apply.state).toBe("applied");
  });

  test("cancelling a later Codex reload in flight still invalidates the configuration it replaced", async () => {
    session("codex", "env-env-1:tab-1", { lastDispatchId: "before" });
    const first = await saveAndApply("codex", "codex:user");
    pauseScheduler(fixture);
    await fixture.service.tick();
    const snapshot = await fixture.service.snapshot({ targetId: first.operation.targetId });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fixture.reloadControl.wait = () => {
      entered();
      return gate;
    };
    const second = await fixture.service.mutate(
      mutation(
        first.operation.targetId,
        {
          kind: "update",
          entryId: entry(snapshot, "codex:user", "fixture").entryId,
          expectedRevision: revision(snapshot, "codex:user")!,
          patch: { command: { kind: "set", value: "replacement" } },
        },
        "save-and-apply",
      ),
    );
    pauseScheduler(fixture);
    const ticking = fixture.service.tick();
    try {
      await started;
      await fixture.service.cancelApply({ operationId: second.operation.operationId });
    } finally {
      release();
      await ticking;
    }
    fixture.sessions[0]!.lastDispatchId = "after";
    await fixture.service.tick();
    expect(
      (await fixture.service.getOperation({ operationId: first.operation.operationId })).apply
        .state,
    ).toBe("cancelled");
    expect(
      (await fixture.service.getOperation({ operationId: second.operation.operationId })).apply
        .state,
    ).toBe("cancelled");
  });

  test("a Codex thread with no running app-server is applied by its next turn too", async () => {
    session("codex", "env-env-1:tab-1", { lastDispatchId: "req-1" });
    fixture.reloadOutcome.value = "not-running";
    const result = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    fixture.sessions[0]!.lastDispatchId = "req-2";
    await fixture.service.tick();
    expect(
      (await fixture.service.getOperation({ operationId: result.operation.operationId })).apply
        .state,
    ).toBe("applied");
  });

  test("Codex turn evidence stops at the evidence window", async () => {
    session("codex", "env-env-1:tab-1");
    const result = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    fixture.now.value += 24 * 60 * 60_000 + 1;
    fixture.sessions[0]!.lastDispatchId = "req-late";
    await fixture.service.tick();
    expect(
      (await fixture.service.getOperation({ operationId: result.operation.operationId })).apply
        .state,
    ).toBe("pending-next-turn");
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
    session("claude", "env-env-1:tab-k");
    // Claude's user file is staged again before every container start.
    const container = await saveAndApply("claude", "claude:user");
    expect(container.operation.apply.runtimes[0]).toMatchObject({
      state: "restart-required",
      reason: expect.stringContaining("stop and start the environment"),
    });
    // Cursor's mcp.json is staged at creation (staged-inputs 2), like the others.
    const cursor = await saveAndApply("cursor", "cursor:user");
    expect(cursor.operation.apply.runtimes).toEqual([]);
    session("cursor", "env-env-1:tab-c");
    const second = await fixture.service.apply({ operationId: cursor.operation.operationId });
    expect(second.apply.runtimes[0]).toMatchObject({
      state: "restart-required",
      reason: CONTAINER_DEFAULTS_REASON,
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
    expect(fixture.reloads).toEqual(["env-1"]);
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
    expect(["queued", "pending-next-turn"]).toContain(newer.operation.apply.state);
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

  test("a Codex update with reordered native keys recovers as saved", async () => {
    const file = "home/.codex/config.toml";
    fixture.write(
      file,
      '[mcp_servers.docs]\ncommand = "bun"\nstartup_timeout_sec = 10\nargs = ["old"]\n',
    );
    const targetId = await targetIdFor(fixture, "codex", "backend");
    const before = await fixture.service.snapshot({ targetId });
    const source = before.sources.find((item) => item.sourceId === "codex:user")!;
    const definition = before.definitions.find((item) => item.name === "docs")!;
    const result = await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: definition.entryId,
        expectedRevision: source.revision!,
        patch: { args: [{ kind: "set", value: "new" }] },
      }),
    );
    fixture.service.dispose();
    markPending(result.operation.operationId);
    fixture.service = fixture.newService();
    expect(
      (await fixture.service.getOperation({ operationId: result.operation.operationId })).phase,
    ).toBe("saved");
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
