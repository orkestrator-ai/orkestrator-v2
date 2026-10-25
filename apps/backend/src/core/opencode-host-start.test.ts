import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { stopLocalServerUnlocked } from "./commands-local-server-lifecycle.js";
import { withShortLivedBridge } from "./host-model-catalog-refresh.js";
import { startLocalServerUnlocked } from "./commands-servers.js";
import { isOpenCodeDatabaseLockedError, OpenCodeHostStartGate } from "./opencode-host-start.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

/**
 * Every local OpenCode server opens the user's one `opencode.db`. On
 * 2026-10-21 two environments started theirs in the same second and one
 * exited with "database is locked", which refused its turn. These start a
 * real (fake) `opencode serve` that fails the same way on demand.
 */
describe("local OpenCode server starts on one host", () => {
  let root: string;
  let storage: StorageService;
  let context: CommandContext;
  const started: string[] = [];

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-opencode-host-start-")));
    await fs.mkdir(path.join(root, "managed-bin"));
    // `locked-runs` is how many launches still lose the database; `events`
    // records each launch and each server becoming healthy, in order.
    await fs.writeFile(path.join(root, "locked-runs"), "0");
    await fs.writeFile(
      path.join(root, "managed-bin", "opencode"),
      `#!${process.execPath}
const fs = require("node:fs");
const root = ${JSON.stringify(root)};
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const lockedRuns = Number(fs.readFileSync(root + "/locked-runs", "utf8"));
fs.appendFileSync(root + "/events", "launch " + port + "\\n");
if (lockedRuns !== 0) {
  if (lockedRuns > 0) fs.writeFileSync(root + "/locked-runs", String(lockedRuns - 1));
  process.stderr.write("Error: Unexpected error, check log file at ~/.local/share/opencode/log for more details\\n\\ndatabase is locked\\n");
  process.exit(1);
}
if (fs.existsSync(root + "/crash")) {
  process.stderr.write("Error: something else\\n");
  process.exit(1);
}
await new Promise((resolve) => setTimeout(resolve, 250));
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch() {
    return Response.json({ healthy: true });
  },
});
fs.appendFileSync(root + "/events", "healthy " + port + "\\n");
process.on("SIGTERM", () => process.exit(0));
`,
      { mode: 0o755 },
    );
    storage = new StorageService(path.join(root, "data"));
    await storage.init();
    context = {
      storage,
      appRoot: root,
      resourceRoot: root,
      toolchainBinDir: path.join(root, "managed-bin"),
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime: new BackendRuntime({
        emit: () => undefined,
        localServers: { openCodeLockedStartRetryDelaysMs: [20, 20] },
      }),
    } as unknown as CommandContext;
  });

  afterEach(async () => {
    for (const environmentId of started.splice(0)) {
      await stopLocalServerUnlocked(environmentId, context, "opencode").catch(() => undefined);
    }
    expect(context.runtime.localServers.hasEnvironmentOperations()).toBe(false);
    context.runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function localEnvironment(name: string): Promise<string> {
    const checkout = path.join(root, "checkouts", name);
    await fs.mkdir(checkout, { recursive: true });
    const project = await storage.addProject(createProject(`remote-${name}`, checkout));
    const environment = createEnvironment(project.id, { name, environmentType: "local" });
    environment.status = "running";
    environment.worktreePath = checkout;
    await storage.addEnvironment(environment);
    started.push(environment.id);
    return environment.id;
  }

  async function events(): Promise<string[]> {
    const text = await fs.readFile(path.join(root, "events"), "utf8").catch(() => "");
    return text.split("\n").filter(Boolean);
  }

  test("a start that loses the database is retried and comes up", async () => {
    const environmentId = await localEnvironment("retry");
    await fs.writeFile(path.join(root, "locked-runs"), "1");

    const server = await startLocalServerUnlocked(environmentId, context, "opencode");

    expect(server.wasRunning).toBe(false);
    const launches = (await events()).filter((event) => event.startsWith("launch"));
    expect(launches).toHaveLength(2);
    expect((await storage.getEnvironment(environmentId))?.localOpencodePort).toBe(server.port);
  });

  test("a database that stays locked fails with a reason the user can act on", async () => {
    const environmentId = await localEnvironment("locked");
    await fs.writeFile(path.join(root, "locked-runs"), "-1");

    const failure = await startLocalServerUnlocked(environmentId, context, "opencode").catch(
      (error: unknown) => error,
    );

    expect(isOpenCodeDatabaseLockedError(failure)).toBe(true);
    expect((failure as Error).message).toContain("database is locked");
    // The first attempt and both retries, then no more.
    expect((await events()).filter((event) => event.startsWith("launch"))).toHaveLength(3);
    expect((await storage.getEnvironment(environmentId))?.localOpencodePort ?? null).toBeNull();
  });

  test("any other early exit is not retried", async () => {
    const environmentId = await localEnvironment("crash");
    await fs.writeFile(path.join(root, "crash"), "");

    const failure = await startLocalServerUnlocked(environmentId, context, "opencode").catch(
      (error: unknown) => error,
    );

    expect(isOpenCodeDatabaseLockedError(failure)).toBe(false);
    expect((failure as Error).message).toContain("exited before becoming healthy");
    expect((await events()).filter((event) => event.startsWith("launch"))).toHaveLength(1);
  });

  test.each(["catalog-refresh", "provider-sign-in"] as const)(
    "%s probes serialize with environment starts through readiness",
    async (purpose) => {
      const environmentId = await localEnvironment(purpose);
      const probe = () =>
        withShortLivedBridge(
          context.runtime.localServers,
          {
            kind: "opencode",
            purpose,
            command: path.join(root, "managed-bin", "opencode"),
            args: (port) => ["serve", "--port", String(port)],
            cwd: root,
            env: {},
            token: "fixture-token",
            headers: {},
          },
          async () => "read",
        );
      const [server, result] = await Promise.all([
        startLocalServerUnlocked(environmentId, context, "opencode"),
        probe(),
      ]);
      expect(server.wasRunning).toBe(false);
      expect(result).toBe("read");
      expect((await events()).map((event) => event.split(" ")[0])).toEqual([
        "launch",
        "healthy",
        "launch",
        "healthy",
      ]);
      expect(context.runtime.localServers.processCount()).toBe(1);
    },
  );

  test("a queued environment start rechecks shutdown after acquiring the host turn", async () => {
    const environmentId = await localEnvironment("queued-shutdown");
    const release = await context.runtime.localServers.openCodeHostStart.acquire();
    const starting = startLocalServerUnlocked(environmentId, context, "opencode");
    const outcome = starting.catch((error: unknown) => error);
    try {
      // Tokens are allocated immediately before joining the host-start queue.
      for (
        let attempt = 0;
        !context.runtime.localServers.bridgeToken("opencode", environmentId);
        attempt += 1
      ) {
        if (attempt === 100) throw new Error("Start did not reach the host queue");
        await Bun.sleep(5);
      }
      context.runtime.localServers.closeAdmission();
    } finally {
      release();
    }
    expect(((await outcome) as Error).message).toContain("shutting down");
    expect(await events()).toEqual([]);
    expect(context.runtime.localServers.bridgeToken("opencode", environmentId)).toBeUndefined();
    const releaseNext = await context.runtime.localServers.openCodeHostStart.acquire();
    releaseNext();
  });

  test("shutdown between database-lock attempts prevents a retry spawn", async () => {
    const environmentId = await localEnvironment("retry-shutdown");
    await fs.writeFile(path.join(root, "locked-runs"), "-1");
    const warn = spyOn(console, "warn").mockImplementation((message) => {
      if (String(message).includes("retrying in")) {
        // Runs after the retry delay has started, before its next attempt.
        queueMicrotask(() => context.runtime.localServers.closeAdmission());
      }
    });
    try {
      await expect(startLocalServerUnlocked(environmentId, context, "opencode")).rejects.toThrow(
        "shutting down",
      );
      expect(warn).toHaveBeenCalled();
      expect((await events()).filter((event) => event.startsWith("launch"))).toHaveLength(1);
      expect(context.runtime.localServers.processCount()).toBe(0);
      expect(context.runtime.localServers.bridgeToken("opencode", environmentId)).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test("two environments starting together launch one server at a time", async () => {
    const first = await localEnvironment("first");
    const second = await localEnvironment("second");

    const [a, b] = await Promise.all([
      startLocalServerUnlocked(first, context, "opencode"),
      startLocalServerUnlocked(second, context, "opencode"),
    ]);

    expect(a.port).not.toBe(b.port);
    // Each launch waits until the previous server is healthy.
    const order = (await events()).map((event) => event.split(" ")[0]);
    expect(order).toEqual(["launch", "healthy", "launch", "healthy"]);
  });
});

describe("OpenCodeHostStartGate", () => {
  test("grants turns in order and tolerates a double release", async () => {
    const gate = new OpenCodeHostStartGate();
    const order: string[] = [];
    const releaseFirst = await gate.acquire();
    const second = gate.acquire().then((release) => {
      order.push("second");
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    releaseFirst();
    releaseFirst();
    const releaseSecond = await second;
    expect(order).toEqual(["second"]);
    releaseSecond();
    const releaseThird = await gate.acquire();
    releaseThird();
  });
});
