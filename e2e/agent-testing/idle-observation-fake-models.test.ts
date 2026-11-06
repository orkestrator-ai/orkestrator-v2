import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type ChildProcess, type spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type FakeModelHandle,
  startLocalFakeModel,
  startModel,
  withFakeModelCleanup,
} from "./idle-observation-fake-models";

function fakeChild(mode: "ready" | "silent" | "exit" | "error") {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    pid: mode === "error" ? undefined : 123,
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
