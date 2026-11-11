import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { withOpenCode2HostDatabaseServer } from "./opencode2-host-database-server.js";
import { openCode2LegacyReconcileMarker } from "./opencode2/credential-upgrade.js";
import { FakeOpenCode2Server } from "./opencode2/fake-server.test-support.js";
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
let fakes: FakeOpenCode2Server[] = [];
let savedXdgDataHome: string | undefined;
let nextPid = 520_000;

// Fake values only; nothing here is a real credential.
const FILE_KEY = "sk-fake-file-key";
const STORE_KEY = "sk-fake-store-key";

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
  routes: (url: URL, request: Request) => Response | Promise<Response> | undefined = () =>
    undefined,
) {
  const port = Number(spawned.args[spawned.args.indexOf("--port") + 1]);
  servers.push(
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/info") return Response.json({ version: "2.2.6" });
        return routes(url, request) ?? new Response(null, { status: 404 });
      },
    }),
  );
}

let onSpawn: (spawned: { args: string[] }) => void = serveAs2x;

/** A spawned private server whose routes are a shared stateful fake's, counting credential writes. */
function forwardTo(fake: FakeOpenCode2Server, writes: { count: number }) {
  return (spawned: { args: string[] }) =>
    serveAs2x(spawned, async (url, request) => {
      if (url.pathname === "/api/credential" && request.method === "POST") writes.count += 1;
      const body = request.method === "GET" ? undefined : await request.text();
      return fetch(`${fake.baseUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(body ? { body } : {}),
      });
    });
}

function fakeServer(): FakeOpenCode2Server {
  const fake = new FakeOpenCode2Server();
  fakes.push(fake);
  return fake;
}

/** The host's `auth.json`, as an agent-test start locates it (`$XDG_DATA_HOME/opencode`). */
async function writeAuthFile(contents: unknown): Promise<void> {
  const file = path.join(process.env.XDG_DATA_HOME!, "opencode", "auth.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(contents));
}

function recordRunning(environmentId: string, port: number, coordinator?: unknown) {
  const child = createFakeChild();
  runtime.localServers.adoptProcess(openCode2ServerKey(environmentId), child);
  runtime.localServers.openCode2.record(environmentId, {
    child,
    port,
    password: "pw",
    directory: "/work",
    ...(coordinator ? { coordinator } : {}),
  } as never);
}

function context(): CommandContext {
  return {
    // The agent-test flavour reads `auth.json` from XDG_DATA_HOME, which each
    // test points at its own directory: never the developer's real logins.
    runtimeFlavor: "agent-test",
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
  savedXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(appRoot, "xdg-data");
  await fs.mkdir(path.join(appRoot, "bin"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "bin", "opencode2"), "");
  storage = new StorageService(path.join(appRoot, "data"));
  await storage.init();
  children = [];
  spawns = [];
  servers = [];
  fakes = [];
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
  for (const fake of fakes) fake.stop();
  runtime.shutdown();
  if (savedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdgDataHome;
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
    recordRunning("env-1", 4242);
    const shared = await withOpenCode2HostDatabaseServer(context(), async (client) => client);
    expect(shared.baseUrl).toBe("http://127.0.0.1:4242");
    // The probe location, never the environment's worktree.
    expect(shared.directory).toBe(path.join(storage.getDataDir(), "model-catalog-probe"));
    expect(spawns).toEqual([]);
    const separate = await withOpenCode2HostDatabaseServer(context(), async (client) => client, {
      private: true,
    });
    expect(separate.baseUrl).not.toBe("http://127.0.0.1:4242");
    expect(spawns).toHaveLength(1);
  });

  test("host discovery through a running environment's server never reads that project's location", async () => {
    // The environment's location (its worktree's opencode.json) adds a
    // project-only provider; any other location has only the global one.
    const directories: Array<string | null> = [];
    const environmentServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        const directory = request.headers.get("x-opencode-directory");
        if (url.pathname === "/api/credential") return Response.json({ data: [] });
        if (url.pathname !== "/api/model") return new Response(null, { status: 404 });
        directories.push(directory);
        const models = [{ id: "global-model", providerID: "global" }];
        if (directory === "/work") models.push({ id: "secret-model", providerID: "project-only" });
        return Response.json({ location: {}, data: models });
      },
    });
    servers.push(environmentServer);
    recordRunning("env-1", environmentServer.port!);
    const models = await withOpenCode2HostDatabaseServer(context(), (client) =>
      client.api<Array<{ providerID: string }>>("GET", "/api/model", "model list", {}),
    );
    expect(models.map((model) => model.providerID)).toEqual(["global"]);
    expect(directories).toEqual([path.join(storage.getDataDir(), "model-catalog-probe")]);
    expect(spawns).toEqual([]);
  });

  test("a coordinator's server is never used for host work", async () => {
    recordRunning("coordinator:ws:conv", 4343, {
      policy: { id: "coordinator-read-only" },
      research: { mode: "off", servers: [] },
      signature: "sig",
    });
    const client = await withOpenCode2HostDatabaseServer(context(), async (value) => value);
    expect(client.baseUrl).not.toBe("http://127.0.0.1:4343");
    expect(spawns).toHaveLength(1);
  });

  test("the first use reconciles a preview-era database with auth.json, through a private server", async () => {
    // Signed in through 1.x while the preview was off; the database still
    // holds a login since signed out.
    await writeAuthFile({ anthropic: { type: "api", key: FILE_KEY } });
    const fake = fakeServer();
    fake.credentials.push({
      id: "cred_old",
      integrationID: "openai",
      label: "x",
      active: true,
      value: { type: "key", key: STORE_KEY },
    });
    const writes = { count: 0 };
    onSpawn = forwardTo(fake, writes);
    const listed = await withOpenCode2HostDatabaseServer(context(), (client) =>
      client.api<Array<{ integrationID: string }>>("GET", "/api/credential", "list", {}),
    );
    // `use` already sees the reconciled logins: no local environment started.
    expect(listed.map((entry) => entry.integrationID)).toEqual(["anthropic"]);
    expect(fake.credentials.map((entry) => entry.value)).toEqual([{ type: "key", key: FILE_KEY }]);
    const marker = openCode2LegacyReconcileMarker(storage.getDataDir());
    expect(await fs.readFile(marker, "utf8")).not.toContain(FILE_KEY);
    expect(writes.count).toBe(1);

    // Marker-gated: a later use changes nothing the database now owns.
    fake.credentials.push({
      id: "cred_new",
      integrationID: "xai",
      label: "x",
      active: true,
      value: { type: "key", key: STORE_KEY },
    });
    await withOpenCode2HostDatabaseServer(context(), async () => undefined);
    expect(fake.credentials.map((entry) => entry.integrationID)).toEqual(["anthropic", "xai"]);
    expect(writes.count).toBe(1);
  });

  test("the first use reconciles through a running server too", async () => {
    await writeAuthFile({ anthropic: { type: "api", key: FILE_KEY } });
    const fake = fakeServer();
    recordRunning("env-1", Number(new URL(fake.baseUrl).port));
    await withOpenCode2HostDatabaseServer(context(), async () => undefined);
    expect(fake.credentials.map((entry) => entry.integrationID)).toEqual(["anthropic"]);
    expect(spawns).toEqual([]);
  });

  test("concurrent first users share one reconcile", async () => {
    await writeAuthFile({
      anthropic: { type: "api", key: FILE_KEY },
      openai: { type: "api", key: FILE_KEY },
    });
    const fake = fakeServer();
    const writes = { count: 0 };
    onSpawn = forwardTo(fake, writes);
    await Promise.all([
      withOpenCode2HostDatabaseServer(context(), async () => undefined),
      withOpenCode2HostDatabaseServer(context(), async () => undefined),
      withOpenCode2HostDatabaseServer(context(), async () => undefined),
    ]);
    expect(writes.count).toBe(2);
    expect(fake.credentials.map((entry) => entry.integrationID).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  test("refuses to start once shutdown has begun", async () => {
    runtime.localServers.closeAdmission();
    await expect(withOpenCode2HostDatabaseServer(context(), async () => undefined)).rejects.toThrow(
      "shutting down",
    );
    expect(spawns).toEqual([]);
  });
});
