import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands.js";
import { getBridgePath, prepareBridgePath, startLocalServerUnlocked } from "./commands-servers.js";
import { stopLocalServerUnlocked } from "./commands-local-server-lifecycle.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

let root: string;
let context: CommandContext;
let storage: StorageService;
let runtime: BackendRuntime;
let starts: Promise<unknown>[];
let previousNodeEnv: string | undefined;
let servers: Array<{ id: string; kind: "pi" | "cursor" }>;

beforeEach(async () => {
  previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-runtime-wiring-")));
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  runtime = new BackendRuntime({ emit: () => undefined });
  context = {
    storage,
    runtime,
    runtimeFlavor: "agent-test",
    appRoot: path.join(root, "app"),
    resourceRoot: path.join(root, "resources"),
    emit: () => undefined,
    environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
  } as CommandContext;
  starts = [];
  servers = [];
  const bin = path.join(context.resourceRoot, "bin");
  await fs.mkdir(bin, { recursive: true });
  const installer = path.join(root, "install.ts");
  await fs.writeFile(
    installer,
    `
    await Bun.write(${JSON.stringify(path.join(root, "installing"))}, process.cwd());
    const deadline = Date.now() + 10000;
    while (!(await Bun.file(${JSON.stringify(path.join(root, "release"))}).exists())) {
      if (Date.now() > deadline) process.exit(1);
      await Bun.sleep(10);
    }
  `,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(
    path.join(bin, "bun"),
    `#!/bin/sh
if [ "$1" = install ]; then
  exec ${quote(process.execPath)} ${quote(installer)}
fi
exec ${quote(process.execPath)} "$@"
`,
    { mode: 0o700 },
  );
});

afterEach(async () => {
  await fs.writeFile(path.join(root, "release"), "release");
  runtime.localServers.cursorSdkLogin.cancel();
  await Promise.allSettled(starts);
  for (const server of servers) await stopLocalServerUnlocked(server.id, context, server.kind);
  runtime.shutdown();
  storage.close();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  await fs.rm(root, { recursive: true, force: true });
});

async function stage(bridge: "pi-bridge" | "cursor-bridge") {
  const source = path.join(context.resourceRoot, bridge);
  await fs.mkdir(path.join(source, "runtime"), { recursive: true });
  await fs.mkdir(path.join(source, "dist"));
  await fs.writeFile(
    path.join(source, "runtime/install.json"),
    JSON.stringify({ digest: "0123456789abcdef" }),
  );
  await fs.writeFile(path.join(source, "runtime/bun.lock"), "{}");
  await fs.writeFile(path.join(source, "runtime/package.json"), "{}");
  await fs.writeFile(
    path.join(source, "dist/index.js"),
    `
    await Bun.write(${JSON.stringify(path.join(root, "spawned"))}, process.cwd());
    if (process.argv.includes("--login")) {
      console.log(JSON.stringify({ loginUrl: "https://cursor.example/login" }));
      const timer = setInterval(() => {}, 1000);
      process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
      await new Promise(() => {});
    }
    const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT || 0),
      fetch() { return Response.json({ ok: true }); } });
    process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
  `,
  );
}

async function waitForInstall() {
  const deadline = Date.now() + 5_000;
  while (!(await Bun.file(path.join(root, "installing")).exists())) {
    if (Date.now() >= deadline) throw new Error("Installation never started");
    await Bun.sleep(10);
  }
}

function track<T>(promise: Promise<T>): Promise<T> {
  starts.push(promise);
  // Attach a rejection handler immediately: cancellation is expected in these tests.
  void promise.catch(() => undefined);
  return promise;
}

test("lookup names the future install; preparation waits and reuses it", async () => {
  await stage("pi-bridge");
  const destination = getBridgePath(context, "pi-bridge");
  expect(destination).toBe(path.join(root, "data/bridge-runtimes/pi-bridge/0123456789abcdef"));
  expect(await fs.stat(destination).catch(() => null)).toBeNull();
  let ready = false;
  const prepared = track(
    prepareBridgePath(context, "pi-bridge").then((value) => {
      ready = true;
      return value;
    }),
  );
  await waitForInstall();
  expect(ready).toBe(false);
  await fs.writeFile(path.join(root, "release"), "release");
  expect(await prepared).toBe(destination);
  expect(await prepareBridgePath(context, "pi-bridge")).toBe(destination);
});

test("development paths take precedence over on-demand descriptors", async () => {
  await stage("cursor-bridge");
  const development = path.join(context.appRoot, "bridges/cursor-bridge");
  await fs.mkdir(development, { recursive: true });
  expect(getBridgePath(context, "cursor-bridge")).toBe(development);
  expect(await prepareBridgePath(context, "cursor-bridge")).toBe(development);
  expect(await Bun.file(path.join(root, "installing")).exists()).toBe(false);
  process.env.NODE_ENV = "production";
  expect(getBridgePath(context, "cursor-bridge")).not.toBe(development);
  const installed = track(prepareBridgePath(context, "cursor-bridge"));
  await waitForInstall();
  await fs.writeFile(path.join(root, "release"), "release");
  expect(await installed).toBe(getBridgePath(context, "cursor-bridge"));
});

test("a complete packaged bridge needs no installation", async () => {
  const complete = path.join(context.resourceRoot, "claude-bridge");
  expect(getBridgePath(context, "claude-bridge")).toBe(complete);
  expect(await prepareBridgePath(context, "claude-bridge")).toBe(complete);
});

test.each(["cursor_sdk_login_cancel", "cursor_sdk_logout"])(
  "%s cancels login during installation",
  async (cancelCommand) => {
    await stage("cursor-bridge");
    const registry = createCommandRegistry();
    const invoke = (name: string) => Promise.resolve(registry.get(name)!({}, context));
    const starting = track(invoke("cursor_sdk_login_start"));
    await waitForInstall();
    expect(await invoke("cursor_sdk_login_status")).toMatchObject({ state: "pending" });
    await invoke(cancelCommand);
    expect(await invoke("cursor_sdk_login_status")).toMatchObject({ state: "idle" });
    await fs.writeFile(path.join(root, "release"), "release");
    await expect(starting).rejects.toThrow("cancelled");
    expect(await Bun.file(path.join(root, "spawned")).exists()).toBe(false);
    expect(await invoke("cursor_sdk_login_status")).toMatchObject({ state: "idle" });
  },
);

test("a replacement login survives the cancelled preparation finishing", async () => {
  await stage("cursor-bridge");
  const registry = createCommandRegistry();
  const invoke = (name: string) => Promise.resolve(registry.get(name)!({}, context));
  const cancelled = track(invoke("cursor_sdk_login_start"));
  await waitForInstall();
  await invoke("cursor_sdk_login_cancel");
  const replacement = track(invoke("cursor_sdk_login_start"));
  expect(await invoke("cursor_sdk_login_status")).toMatchObject({ state: "pending" });
  await fs.writeFile(path.join(root, "release"), "release");
  await expect(cancelled).rejects.toThrow("cancelled");
  expect(await replacement).toEqual({ loginUrl: "https://cursor.example/login" });
  expect(await invoke("cursor_sdk_login_status")).toMatchObject({ state: "pending" });
  await invoke("cursor_sdk_login_cancel");
  expect(await invoke("cursor_sdk_login_status")).toMatchObject({ state: "idle" });
});

test.each(["pi", "cursor"] as const)(
  "%s local startup waits for its on-demand runtime",
  async (kind) => {
    await stage(`${kind}-bridge`);
    const checkout = path.join(root, "checkout");
    await fs.mkdir(checkout);
    const project = await storage.addProject(createProject("fixture", checkout));
    const environment = createEnvironment(project.id, { name: "local", environmentType: "local" });
    environment.status = "running";
    environment.worktreePath = checkout;
    await storage.addEnvironment(environment);
    servers.push({ id: environment.id, kind });
    const starting = track(startLocalServerUnlocked(environment.id, context, kind));
    await waitForInstall();
    expect(runtime.localServers.process(`${kind}:${environment.id}`)).toBeUndefined();
    expect(await Bun.file(path.join(root, "spawned")).exists()).toBe(false);
    await fs.writeFile(path.join(root, "release"), "release");
    const result = await starting;
    expect(result.pid).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(root, "spawned"), "utf8")).toBe(
      getBridgePath(context, `${kind}-bridge`),
    );
  },
);
