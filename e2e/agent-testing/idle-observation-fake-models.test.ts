import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { expect, test, setDefaultTimeout } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type ChildProcess, type spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type FakeModelHandle,
  fakeModelSettingsFile,
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
