/**
 * Bounds on the Pi MCP client's connect and close lifecycle.
 *
 * Split from `mcp.test.ts`, which covers what the client registers; this file
 * pins how much work an attach or detach may do at once and how long it may
 * wait. Up to 64 servers can be configured, each potentially a child process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionState } from "./agent-session.js";
import {
  MAX_CONCURRENT_MCP_CONNECTS,
  closePiMcp,
  mapWithConcurrency,
  preparePiMcp,
  publicPiMcpServers,
  setPiMcpTimeoutsForTests,
  setPiMcpTransportForTests,
  type PiMcpConnection,
} from "./mcp.js";

const roots: string[] = [];

afterEach(async () => {
  setPiMcpTransportForTests();
  setPiMcpTimeoutsForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function agentDirWithServers(count: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-lifecycle-"));
  roots.push(root);
  const servers = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`server${index}`, { command: `cmd-${index}` }]),
  );
  await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: servers }));
  return root;
}

function connection(overrides: Partial<PiMcpConnection> = {}): PiMcpConnection {
  return {
    tools: [{ name: "search" }],
    async call() {
      return { content: [] };
    },
    async close() {},
    ...overrides,
  };
}

describe("mapWithConcurrency", () => {
  test("keeps input order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active -= 1;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  test("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 4, async (value: number) => value)).toEqual([]);
    expect(await mapWithConcurrency([1], 4, async (value) => value + 1)).toEqual([2]);
  });
});

describe("Pi MCP connect concurrency", () => {
  test("connects at most four servers at once and still connects them all", async () => {
    expect(MAX_CONCURRENT_MCP_CONNECTS).toBe(4);
    const agentDir = await agentDirWithServers(12);
    let active = 0;
    let peak = 0;
    setPiMcpTransportForTests({
      async connect() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return connection();
      },
    });
    const state = newSessionState();

    await preparePiMcp(state, { agentDir, cwd: agentDir, env: {} });

    expect(peak).toBe(4);
    const inventory = publicPiMcpServers(state);
    expect(inventory).toHaveLength(12);
    expect(inventory.every((server) => server.status === "connected")).toBe(true);
    // Input order survives the pool.
    expect(inventory.map((server) => server.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `server${index}`),
    );
    await closePiMcp(state);
  });

  test("a server whose listing is malformed fails alone", async () => {
    const agentDir = await agentDirWithServers(3);
    setPiMcpTransportForTests({
      async connect(server) {
        if (server.id === "server1") {
          return connection({ tools: [{ name: 42 as unknown as string }] });
        }
        return connection();
      },
    });
    const state = newSessionState();

    await preparePiMcp(state, { agentDir, cwd: agentDir, env: {} });

    expect(publicPiMcpServers(state).map((server) => [server.id, server.status])).toEqual([
      ["server0", "connected"],
      ["server1", "failed"],
      ["server2", "connected"],
    ]);
    await closePiMcp(state);
  });

  test("a detach during the attach never starts the servers still queued", async () => {
    const agentDir = await agentDirWithServers(8);
    const started: string[] = [];
    const releases: Array<() => void> = [];
    setPiMcpTransportForTests({
      async connect(server) {
        started.push(server.id);
        await new Promise<void>((resolve) => releases.push(resolve));
        return connection();
      },
    });
    const state = newSessionState();
    const preparing = preparePiMcp(state, { agentDir, cwd: agentDir, env: {} });
    while (started.length < MAX_CONCURRENT_MCP_CONNECTS) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await closePiMcp(state);
    for (const release of releases.splice(0)) release();
    await preparing;

    expect(started).toHaveLength(MAX_CONCURRENT_MCP_CONNECTS);
    expect(publicPiMcpServers(state)).toEqual([]);
  });

  test("a detach before the first connect starts spawns nothing", async () => {
    const agentDir = await agentDirWithServers(3);
    const started: string[] = [];
    setPiMcpTransportForTests({
      async connect(server) {
        started.push(server.id);
        return connection();
      },
    });
    const state = newSessionState();
    const preparing = preparePiMcp(state, { agentDir, cwd: agentDir, env: {} });
    await closePiMcp(state);
    await preparing;
    expect(started).toEqual([]);
  });
});

describe("Pi MCP close deadline", () => {
  test("a close that never settles does not hold the detach", async () => {
    setPiMcpTimeoutsForTests({ closeMs: 20 });
    const agentDir = await agentDirWithServers(2);
    let closedFast = 0;
    setPiMcpTransportForTests({
      async connect(server) {
        return connection({
          close:
            server.id === "server0"
              ? () => new Promise<void>(() => undefined)
              : async () => {
                  closedFast += 1;
                },
        });
      },
    });
    const state = newSessionState();
    await preparePiMcp(state, { agentDir, cwd: agentDir, env: {} });

    const started = Date.now();
    await closePiMcp(state);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(closedFast).toBe(1);
    expect(state.health.listNotices().map((notice) => notice.message)).toContain(
      "An MCP server did not close in time; the bridge moved on without waiting",
    );
  });

  test("a close that rejects, early or after the deadline, is handled", async () => {
    setPiMcpTimeoutsForTests({ closeMs: 10 });
    const agentDir = await agentDirWithServers(3);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      setPiMcpTransportForTests({
        async connect(server) {
          return connection({
            close:
              server.id === "server0"
                ? async () => {
                    throw new Error("close failed");
                  }
                : server.id === "server1"
                  ? () => {
                      throw new Error("close threw synchronously");
                    }
                  : () =>
                      new Promise<void>((_, reject) =>
                        setTimeout(() => reject(new Error("late close failure")), 30),
                      ),
          });
        },
      });
      const state = newSessionState();
      await preparePiMcp(state, { agentDir, cwd: agentDir, env: {} });

      await closePiMcp(state);
      // Outlive the late rejection so an unhandled one would have surfaced.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a rebuild is not held by the previous generation's stuck close", async () => {
    setPiMcpTimeoutsForTests({ closeMs: 20 });
    const agentDir = await agentDirWithServers(1);
    let generation = 0;
    setPiMcpTransportForTests({
      async connect() {
        generation += 1;
        return connection({
          close: generation === 1 ? () => new Promise<void>(() => undefined) : async () => {},
        });
      },
    });
    const state = newSessionState();
    await preparePiMcp(state, { agentDir, cwd: agentDir, env: {} });

    const started = Date.now();
    await preparePiMcp(state, { agentDir, cwd: agentDir, env: {} });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(generation).toBe(2);
    expect(publicPiMcpServers(state)).toMatchObject([{ id: "server0", status: "connected" }]);
    await closePiMcp(state);
  });
});
