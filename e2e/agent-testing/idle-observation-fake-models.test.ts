import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { expect, test, setDefaultTimeout } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type ChildProcess, type spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTAINER_OPENCODE_FAKE_BASE_URL,
  CONTAINER_OPENCODE_FAKE_SCRIPT,
  type ContainerExec,
  type FakeModelHandle,
  bundleOpenCodeFake,
  fakeModelSettingsFile,
  installContainerFakeOpenCode,
  pointProfileOpenCodeAtContainerFake,
  startLocalFakeModel,
  startModel,
  withFakeModelCleanup,
} from "./idle-observation-fake-models";

setDefaultTimeout(30_000);

function fakeChild(mode: "ready" | "silent" | "exit" | "error") {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    pid: mode === "error" ? undefined : fakePid(1),
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
    kill() {
      child.killed = true;
      child.signalCode = "SIGTERM";
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    },
  });
  const spawnModel = (() => {
    queueMicrotask(() => {
      if (mode === "ready") child.stdout.write("http://127.0.0.1:1234\n");
      if (mode === "exit") {
        child.exitCode = 1;
        child.emit("exit", 1);
      }
      if (mode === "error") child.emit("error", new Error("ENOENT"));
    });
    return child as unknown as ChildProcess;
  }) as typeof spawn;
  return { child, spawnModel };
}

for (const mode of ["silent", "exit", "error"] as const) {
  test(`startup ${mode} rejects and releases startup listeners`, async () => {
    const { child, spawnModel } = fakeChild(mode);
    await expect(startModel("fixture", { spawnModel, timeoutMs: 5 })).rejects.toThrow(
      mode === "silent" ? "never started" : mode === "exit" ? "exited" : "ENOENT",
    );
    expect(child.killed).toBe(mode === "silent");
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
  });
}

for (const stage of ["create_environment", "openClient"]) {
  test(`${stage} failure stops the acquired model and restores profile settings`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "idle-fake-cleanup-"));
    const home = path.join(directory, "agent-credentials", "claude");
    mkdirSync(home, { recursive: true });
    const file = path.join(home, "settings.json");
    const original = '{"env":{"EXISTING":"kept"}}\n';
    writeFileSync(file, original);
    const { child, spawnModel } = fakeChild("ready");
    try {
      await expect(
        (async function run() {
          // The same acquisition order as the live spec: register before either setup step.
          const handles: FakeModelHandle[] = [];
          return withFakeModelCleanup(handles, async () => {
            handles.push(await startLocalFakeModel("claude", directory, { spawnModel }));
            expect(readFileSync(file, "utf8")).toContain("ANTHROPIC_BASE_URL");
            throw new Error(stage);
          });
        })(),
      ).rejects.toThrow(stage);
      expect(child.killed).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(child.stdout.listenerCount("data")).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("Pi's fake is added to the profile's own models.json and removed again", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "idle-fake-pi-"));
  const file = fakeModelSettingsFile("pi", directory);
  // Under the backend's isolated HOME, never a real ~/.pi.
  expect(file).toBe(
    path.join(directory, "agent-credentials", "home", ".pi", "agent", "models.json"),
  );
  mkdirSync(path.dirname(file), { recursive: true });
  const original = '{"providers":{"kept":{"baseUrl":"http://kept"}}}\n';
  writeFileSync(file, original);
  const { child, spawnModel } = fakeChild("ready");
  try {
    const handle = await startLocalFakeModel("pi", directory, { spawnModel });
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      providers: Record<string, { baseUrl: string }>;
    };
    expect(Object.keys(written.providers).sort()).toEqual(["idleqa-fake", "kept"]);
    expect(written.providers["idleqa-fake"]!.baseUrl).toBe("http://127.0.0.1:1234");
    await handle.stop();
    expect(child.killed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("OpenCode's fake provider is merged into the profile's own opencode.json and removed again", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "idle-fake-opencode-"));
  const file = fakeModelSettingsFile("opencode", directory);
  // Under the backend's isolated XDG_CONFIG_HOME, never a real ~/.config/opencode.
  expect(file).toBe(
    path.join(directory, "agent-credentials", "xdg-config", "opencode", "opencode.json"),
  );
  mkdirSync(path.dirname(file), { recursive: true });
  const original = '{"mcp":{"kept":{"type":"local","command":["true"]}}}\n';
  writeFileSync(file, original);
  const { child, spawnModel } = fakeChild("ready");
  try {
    const handle = await startLocalFakeModel("opencode", directory, { spawnModel });
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      mcp: Record<string, unknown>;
      provider: Record<string, { npm: string; options: { baseURL: string } }>;
      model: string;
      small_model: string;
      enabled_providers: string[];
    };
    expect(Object.keys(written.mcp)).toEqual(["kept"]);
    expect(written.provider["idleqa-fake"]!.npm).toBe("@ai-sdk/openai-compatible");
    expect(written.provider["idleqa-fake"]!.options.baseURL).toBe("http://127.0.0.1:1234");
    // No turn or title request can fall through to a hosted OpenCode model.
    expect(written.model).toBe("idleqa-fake/idleqa-1");
    expect(written.small_model).toBe("idleqa-fake/idleqa-1");
    expect(written.enabled_providers).toEqual(["idleqa-fake"]);
    await handle.stop();
    expect(child.killed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a container run points the profile's opencode.json at the container's loopback, then restores it", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "idle-fake-opencode-container-"));
  const file = fakeModelSettingsFile("opencode", directory);
  mkdirSync(path.dirname(file), { recursive: true });
  const original = '{"mcp":{"kept":{"type":"local","command":["true"]}}}\n';
  writeFileSync(file, original);
  try {
    const handle = pointProfileOpenCodeAtContainerFake(directory);
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      mcp: Record<string, unknown>;
      provider: Record<string, { options: { baseURL: string } }>;
      enabled_providers: string[];
    };
    // The container's server reaches its own loopback, never the host's.
    expect(written.provider["idleqa-fake"]!.options.baseURL).toBe(CONTAINER_OPENCODE_FAKE_BASE_URL);
    expect(CONTAINER_OPENCODE_FAKE_BASE_URL).toBe("http://127.0.0.1:47124/v1");
    expect(written.enabled_providers).toEqual(["idleqa-fake"]);
    expect(Object.keys(written.mcp)).toEqual(["kept"]);
    await handle.stop();
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a profile with no opencode.json gets one for the run and none afterwards", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "idle-fake-opencode-container-"));
  const file = fakeModelSettingsFile("opencode", directory);
  try {
    const handle = pointProfileOpenCodeAtContainerFake(directory);
    expect(readFileSync(file, "utf8")).toContain(CONTAINER_OPENCODE_FAKE_BASE_URL);
    await handle.stop();
    expect(() => readFileSync(file, "utf8")).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

type Exec = { args: string[]; input?: string };

function fakeContainer(options: { pid?: string; readyAfter?: number; running?: boolean } = {}) {
  const calls: Exec[] = [];
  let curls = 0;
  const state = { running: options.running ?? true };
  const container: ContainerExec = {
    exec(args, input) {
      calls.push({ args, input });
      if (args[0] === "curl") {
        curls += 1;
        if (curls <= (options.readyAfter ?? 0)) throw new Error("docker exec failed");
        return "";
      }
      const command = args.at(-1) ?? "";
      if (command.includes("nohup")) return `${options.pid ?? "4321"}\n`;
      return "";
    },
    running: () => state.running,
  };
  return { calls, container, state };
}

test("the container fake is written and served as node, and stopped only by its recorded PID", async () => {
  const { calls, container } = fakeContainer({ readyAfter: 2 });
  const handle = await installContainerFakeOpenCode("c1", {
    container,
    source: "// bundled fake",
    readyTimeoutMs: 5_000,
  });
  expect(handle.origin).toBe("container loopback :47124");
  const [write, start] = calls;
  expect(write!.args.slice(0, 2)).toEqual(["--user", "node"]);
  expect(write!.args.at(-1)).toContain(`cat > ${CONTAINER_OPENCODE_FAKE_SCRIPT}`);
  expect(write!.input).toBe("// bundled fake");
  expect(start!.args.slice(0, 2)).toEqual(["--user", "node"]);
  expect(start!.args.at(-1)).toContain(`bun ${CONTAINER_OPENCODE_FAKE_SCRIPT} --port 47124`);
  // Readiness polls the fake's own models route until it answers.
  expect(calls.filter((call) => call.args[0] === "curl")).toHaveLength(3);
  await handle.stop();
  const stop = calls.at(-1)!.args.at(-1)!;
  expect(stop).toContain("/proc/4321/cmdline");
  expect(stop).toContain(`grep -qF ${CONTAINER_OPENCODE_FAKE_SCRIPT}`);
  expect(stop).toContain("kill 4321");
  expect(stop).not.toMatch(/pkill|killall/);
});

test("stopping the container fake does nothing once its container no longer runs", async () => {
  const { calls, container, state } = fakeContainer();
  const handle = await installContainerFakeOpenCode("c1", { container, source: "x" });
  const before = calls.length;
  state.running = false;
  await handle.stop();
  expect(calls.length).toBe(before);
});

test("a fake that never answers is stopped and the install fails", async () => {
  const { calls, container } = fakeContainer({ readyAfter: Number.POSITIVE_INFINITY });
  await expect(
    installContainerFakeOpenCode("c1", { container, source: "x", readyTimeoutMs: 1 }),
  ).rejects.toThrow("never answered");
  expect(calls.at(-1)!.args.at(-1)).toContain("kill 4321");
});

test("a start that reports no PID signals nothing and removes the script", async () => {
  const { calls, container } = fakeContainer({ pid: "oops" });
  await expect(installContainerFakeOpenCode("c1", { container, source: "x" })).rejects.toThrow(
    "no PID",
  );
  const last = calls.at(-1)!.args.at(-1)!;
  expect(last).toBe(`rm -f ${CONTAINER_OPENCODE_FAKE_SCRIPT}`);
});

test("the OpenCode fake bundles into one file the container can run alone", () => {
  const source = bundleOpenCodeFake();
  // Nothing left to resolve from this repository inside the container.
  expect(source).not.toMatch(/from\s+["']\.{1,2}\//);
  expect(source).toContain("chat/completions");
  expect(source).toContain("--port");
});
