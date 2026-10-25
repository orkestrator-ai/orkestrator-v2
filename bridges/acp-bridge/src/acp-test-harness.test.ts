import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BRIDGE_TEST_TIMEOUT_MS,
  children,
  cleanupTrackedResources,
  temporaryDirectory,
  spawnBridge,
  stopChild,
  unusedPort,
  nativeFetch,
  here,
  waitForExit,
} from "./acp-test-harness";

describe("ACP test harness child tracking", () => {
  test(
    "awaits and deregisters live and already-exited children before deleting fixtures",
    async () => {
      const liveDirectory = await temporaryDirectory();
      const readyPath = resolve(liveDirectory, "ready");
      const exitPath = resolve(liveDirectory, "exited");
      const live = spawn(
        process.execPath,
        [
          "-e",
          // The handler is installed before "ready" is announced: the other
          // order let cleanup's SIGTERM arrive first and kill the child by
          // default, leaving `exitCode` null (flake 0179).
          `process.on("SIGTERM", async () => {
  try {
    await Bun.write(process.env.HARNESS_EXIT_PATH, "exited");
    process.exit(0);
  } catch {
    process.exit(1);
  }
});
await Bun.write(process.env.HARNESS_READY_PATH, "ready");
setInterval(() => {}, 1_000);`,
        ],
        {
          env: {
            ...process.env,
            HARNESS_EXIT_PATH: exitPath,
            HARNESS_READY_PATH: readyPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.add(live);
      while (
        !(await access(readyPath).then(
          () => true,
          () => false,
        ))
      ) {
        await Bun.sleep(5);
      }

      await cleanupTrackedResources();
      expect(live.exitCode).toBe(0);
      expect(children.has(live)).toBe(false);
      await expect(access(liveDirectory)).rejects.toThrow();

      const settledDirectory = await temporaryDirectory();
      const settled = spawn(process.execPath, ["-e", ""], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(settled);
      await waitForExit(settled);
      expect(children.has(settled)).toBe(true);

      await cleanupTrackedResources();
      expect(children.has(settled)).toBe(false);
      await expect(access(settledDirectory)).rejects.toThrow();
    },
    BRIDGE_TEST_TIMEOUT_MS,
  );
});

// Bind after unusedPort releases its reservation, just as a competing worker
// can. These listeners accept the harness's shared default credential.
const occupants: Server[] = [];
afterEach(async () => {
  await Promise.all(
    occupants.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

async function occupyReleasedPort(): Promise<number> {
  const port = await unusedPort();
  const server = createServer((request, response) => {
    response.writeHead(
      request.headers.authorization === "Bearer integration-test-token" ? 200 : 401,
    );
    response.end("{}");
  });
  occupants.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return port;
}

function delayedBridge(launched: ChildProcessWithoutNullStreams[]) {
  return (env: NodeJS.ProcessEnv) => {
    // The child remains alive long enough for the stranger to answer readiness
    // before the real bind fails. Without child-specific readiness this returns
    // the occupant as a healthy bridge.
    const child = spawn(
      process.execPath,
      [
        "--eval",
        `
      await Bun.sleep(250);
      await import(${JSON.stringify(pathToFileURL(resolve(here, "index.ts")).href)});
    `,
      ],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    launched.push(child);
    return child;
  };
}

function expectStopped(childrenToCheck: ChildProcessWithoutNullStreams[]) {
  for (const child of childrenToCheck) {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(children.has(child)).toBe(false);
  }
}

describe("ACP bridge startup ownership and retries", () => {
  test("rejects a same-token occupant on a fixed port without retrying", async () => {
    const port = await occupyReleasedPort();
    const response = await nativeFetch(`http://127.0.0.1:${port}/global/auth-check`, {
      headers: { authorization: "Bearer integration-test-token" },
    });
    expect(response.ok).toBe(true);
    const launched: ChildProcessWithoutNullStreams[] = [];
    let reservations = 0;
    await expect(
      spawnBridge(
        { port },
        {
          spawnChild: delayedBridge(launched),
          reservePort: async () => {
            reservations++;
            return unusedPort();
          },
        },
      ),
    ).rejects.toThrow(`ACP bridge exited while starting on port ${port} (attempt 1)`);
    expect(reservations).toBe(0);
    expect(launched).toHaveLength(1);
    expectStopped(launched);
  });

  test("retries exited bind failures on fresh ports through the third attempt", async () => {
    const ports: number[] = [];
    const launched: ChildProcessWithoutNullStreams[] = [];
    const bridge = await spawnBridge(
      {},
      {
        spawnChild: delayedBridge(launched),
        reservePort: async () => {
          const port = ports.length < 2 ? await occupyReleasedPort() : await unusedPort();
          ports.push(port);
          return port;
        },
      },
    );
    try {
      expect(launched).toHaveLength(3);
      expect(new Set(ports).size).toBe(3);
      expect(bridge.child).toBe(launched[2]!);
      expect(bridge.base).toBe(`http://127.0.0.1:${ports[2]}`);
      expectStopped(launched.slice(0, 2));
      expect(
        (await nativeFetch(`${bridge.base}/global/auth-check`, { headers: bridge.headers })).ok,
      ).toBe(true);
    } finally {
      await stopChild(bridge.child);
    }
    expectStopped(launched);
  });

  test("stops after three fresh-port bind failures and deregisters every child", async () => {
    const ports: number[] = [];
    const launched: ChildProcessWithoutNullStreams[] = [];
    await expect(
      spawnBridge(
        {},
        {
          spawnChild: delayedBridge(launched),
          reservePort: async () => {
            const port = await occupyReleasedPort();
            ports.push(port);
            return port;
          },
        },
      ),
    ).rejects.toThrow(/ACP bridge exited while starting on port .* \(attempt 3\)/);
    expect(launched).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    expectStopped(launched);
  });

  test("does not accept a same-token listener while its own child stays alive without binding", async () => {
    const port = await occupyReleasedPort();
    const launched: ChildProcessWithoutNullStreams[] = [];
    await expect(
      spawnBridge(
        { port },
        {
          timeoutMs: 200,
          spawnChild: (env) => {
            const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });
            launched.push(child);
            return child;
          },
        },
      ),
    ).rejects.toThrow("Timed out waiting for ACP state");
    expectStopped(launched);
  });
});
