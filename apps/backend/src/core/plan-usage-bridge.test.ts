import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { __testing as commandTesting } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { setLocalServerShutdownRequested } from "./commands-runtime-state.js";
import { createPlanUsageReader } from "./plan-usage.js";
import { StorageService } from "./storage.js";

type FakeChild = ChildProcessWithoutNullStreams & { exited: boolean };

let appRoot = "";
let storage: StorageService;
let servers: Server[] = [];
let children: FakeChild[] = [];
let nextPid = 710_000;

function createFakeChild(): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild;
  const stream = () => Object.assign(new EventEmitter(), { resume: () => undefined });
  Object.assign(emitter, {
    pid: nextPid++,
    exitCode: null,
    signalCode: null,
    killed: false,
    exited: false,
    stdout: stream(),
    stderr: stream(),
    kill: () => true,
  });
  return emitter;
}

/** Answer `/global/health` like every bridge and route `/global/usage` to `respond`. */
function stubBridgeSpawn(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
): void {
  commandTesting.setSpawnLocalServerCommand(((
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean } = {},
  ) => {
    const spawned = {
      command,
      args,
      cwd: options.cwd,
      env: options.env ?? {},
      detached: options.detached,
    };
    const child = createFakeChild();
    children.push(child);
    const server = createServer((request, response) => {
      if (request.url === "/global/health") {
        response.writeHead(200).end();
        return;
      }
      respond(request, response);
    });
    const port = Number(spawned.env.PORT);
    void new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    servers.push(server);
    return child;
  }) as never);
}

function jsonAccount(body: unknown): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
}

function context(): CommandContext {
  return {
    appRoot,
    resourceRoot: appRoot,
    toolchainBinDir: path.join(appRoot, "bin"),
    storage,
    emit: () => undefined,
  } as unknown as CommandContext;
}

beforeEach(async () => {
  appRoot = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-plan-usage-"));
  for (const bridge of ["claude-bridge", "codex-bridge", "cursor-bridge"]) {
    const directory = path.join(appRoot, "bridges", bridge, "dist");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "index.js"), "");
  }
  await fs.mkdir(path.join(appRoot, "bin"), { recursive: true });
  storage = new StorageService(path.join(appRoot, "data"));
  await storage.init();
  servers = [];
  children = [];
  commandTesting.setTerminateProcessTree(
    mock(async (child: { pid?: number }) => {
      const target = children.find((candidate) => candidate.pid === child.pid);
      if (target) target.exited = true;
      return true;
    }) as never,
  );
});

afterEach(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  commandTesting.resetLocalServerLifecycle();
  setLocalServerShutdownRequested(false);
  await fs.rm(appRoot, { recursive: true, force: true });
});

describe("createPlanUsageReader bridge reads", () => {
  test("reports an explicit null Cursor account as unavailable, not unmetered", async () => {
    stubBridgeSpawn(jsonAccount({ account: null }));
    const snapshot = await createPlanUsageReader()(context(), "cursor");
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.message).toMatch(/Cursor/);
  });

  test("keeps an authoritative empty Claude account as ok with no windows", async () => {
    stubBridgeSpawn(jsonAccount({ account: [] }));
    const snapshot = await createPlanUsageReader()(context(), "claude");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.windows).toEqual([]);
  });

  test("keeps reported windows and their period length", async () => {
    stubBridgeSpawn(
      jsonAccount({
        account: [
          {
            window: "billing_cycle",
            label: "Cursor quota",
            usedPercent: 50,
            windowMinutes: 43_200,
          },
        ],
      }),
    );
    const snapshot = await createPlanUsageReader()(context(), "cursor");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.windows).toEqual([
      { window: "billing_cycle", label: "Cursor quota", usedPercent: 50, windowMinutes: 43_200 },
    ]);
  });

  test("maps a non-ok bridge response to an error snapshot", async () => {
    stubBridgeSpawn((request, response) => {
      request.resume();
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "boom" }));
    });
    const snapshot = await createPlanUsageReader()(context(), "codex");
    expect(snapshot.status).toBe("error");
    expect(snapshot.windows).toEqual([]);
  });
});
