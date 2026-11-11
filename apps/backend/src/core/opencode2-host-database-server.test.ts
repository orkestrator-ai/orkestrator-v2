import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { withOpenCode2HostDatabaseServer } from "./opencode2-host-database-server.js";
import { openCode2ServerKey } from "./opencode2/host-server-state.js";
import { openCode2HostPaths } from "./opencode2/server.js";
import { StorageService } from "./storage.js";

type FakeChild = ChildProcessWithoutNullStreams & { exited: boolean };

let appRoot = "";
let storage: StorageService;
let runtime: BackendRuntime;
let children: FakeChild[] = [];
let spawns: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }> = [];
let servers: Array<ReturnType<typeof Bun.serve>> = [];
let nextPid = 520_000;

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

/** A spawn that answers as a 2.x server on the `--port` it was given. */
function serveAs2x(
  spawned: { args: string[] },
  routes: (url: URL) => Response | undefined = () => undefined,
) {
  const port = Number(spawned.args[spawned.args.indexOf("--port") + 1]);
  servers.push(
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/info") return Response.json({ version: "2.2.6" });
        return routes(url) ?? new Response(null, { status: 404 });
      },
    }),
  );
}

let onSpawn: (spawned: { args: string[] }) => void = serveAs2x;

function context(): CommandContext {
  return {
    appRoot,
    resourceRoot: appRoot,
    toolchainBinDir: path.join(appRoot, "bin"),
    storage,
    emit: () => undefined,
    runtime,
  } as unknown as CommandContext;
}

beforeEach(async () => {
  appRoot = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-oc2-host-db-"));
  await fs.mkdir(path.join(appRoot, "bin"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "bin", "opencode2"), "");
  storage = new StorageService(path.join(appRoot, "data"));
  await storage.init();
  children = [];
  spawns = [];
  servers = [];
  onSpawn = serveAs2x;
  runtime = new BackendRuntime({
    emit: () => undefined,
    localServers: {
      spawn: ((
        command: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv; cwd?: string },
      ) => {
        spawns.push({ command, args, env: options.env ?? {}, cwd: options.cwd });
        const child = createFakeChild();
        children.push(child);
        onSpawn({ args });
        return child;
      }) as never,
      terminateProcessTree: mock(async (child: { pid?: number }) => {
        const target = children.find((candidate) => candidate.pid === child.pid);
        if (target) target.exited = true;
        return true;
      }) as never,
    },
  });
});

afterEach(async () => {
  for (const server of servers) server.stop(true);
  runtime.shutdown();
  await fs.rm(appRoot, { recursive: true, force: true });
});

describe("withOpenCode2HostDatabaseServer", () => {
  test("starts a private server on the host database, uses it and stops it", async () => {
    onSpawn = (spawned) =>
      serveAs2x(spawned, (url) =>
        url.pathname === "/api/provider" ? Response.json({ data: ["listed"] }) : undefined,
      );
    const answer = await withOpenCode2HostDatabaseServer(context(), (client) =>
      client.api("GET", "/api/provider", "provider list", {}),
    );
    expect(answer).toEqual(["listed"]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe(path.join(appRoot, "bin", "opencode2"));
    expect(spawns[0]!.args.slice(0, 3)).toEqual(["serve", "--hostname", "127.0.0.1"]);
    expect(spawns[0]!.env.OPENCODE_DB).toBe(openCode2HostPaths(storage.getDataDir()).database);
    expect(spawns[0]!.env.OPENCODE_PASSWORD).toBeTruthy();
    expect(spawns[0]!.cwd).toBe(path.join(storage.getDataDir(), "model-catalog-probe"));
    expect(children[0]!.exited).toBe(true);
    expect(runtime.localServers.processCount()).toBe(0);
  });

  test("stops the private server when its use fails", async () => {
    await expect(
      withOpenCode2HostDatabaseServer(context(), async () => {
        throw new Error("use failed");
      }),
    ).rejects.toThrow("use failed");
    expect(children[0]!.exited).toBe(true);
    expect(runtime.localServers.processCount()).toBe(0);
  });

  test("uses a running host server unless a private one is asked for", async () => {
    const child = createFakeChild();
    runtime.localServers.adoptProcess(openCode2ServerKey("env-1"), child);
    runtime.localServers.openCode2.record("env-1", {
      child,
      port: 4242,
      password: "pw",
      directory: "/work",
    });
    const shared = await withOpenCode2HostDatabaseServer(context(), async (client) => client);
    expect(shared.baseUrl).toBe("http://127.0.0.1:4242");
    expect(shared.directory).toBe("/work");
    expect(spawns).toEqual([]);
    const separate = await withOpenCode2HostDatabaseServer(context(), async (client) => client, {
      private: true,
    });
    expect(separate.baseUrl).not.toBe("http://127.0.0.1:4242");
    expect(spawns).toHaveLength(1);
  });

  test("refuses to start once shutdown has begun", async () => {
    runtime.localServers.closeAdmission();
    await expect(withOpenCode2HostDatabaseServer(context(), async () => undefined)).rejects.toThrow(
      "shutting down",
    );
    expect(spawns).toEqual([]);
  });
});
