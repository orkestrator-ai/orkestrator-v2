import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { LocalServerRuntime } from "./local-server-runtime.js";

const KEY = "codex:env-1";
const fakeChild = (pid: number) => ({ pid }) as unknown as ChildProcessWithoutNullStreams;
const runtime = () => new LocalServerRuntime({ terminateProcessTree: async () => true });

let logs: LogCapture;
const exits = () => logs.records().filter((record) => record.event === "bridge.exited");

beforeEach(() => {
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
});

describe("reportBridgeStart", () => {
  test("names the bridge and its process, and nothing else", () => {
    runtime().reportBridgeStart(KEY, fakeChild(100));
    const started = logs.records().filter((record) => record.event === "bridge.started");
    expect(started).toHaveLength(1);
    expect(started[0]?.level).toBe("info");
    expect(started[0]?.fields).toEqual({ key: KEY, pid: 100 });
  });
});

describe("reportBridgeExit", () => {
  test("a bridge that crashes on its own warns with its code and signal", () => {
    const child = fakeChild(101);
    runtime().reportBridgeExit(KEY, child, 1, null);
    expect(exits()).toMatchObject([
      {
        level: "warn",
        area: "local-server",
        fields: { key: KEY, pid: 101, code: 1, signal: null, requested: false },
      },
    ]);
  });

  test("a signal nobody here sent warns too", () => {
    runtime().reportBridgeExit(KEY, fakeChild(102), null, "SIGKILL");
    expect(exits()).toMatchObject([
      { level: "warn", fields: { code: null, signal: "SIGKILL", requested: false } },
    ]);
  });

  test("a clean exit 0 nothing asked for still warns", () => {
    runtime().reportBridgeExit(KEY, fakeChild(103), 0, null);
    expect(exits()).toMatchObject([
      { level: "warn", fields: { code: 0, signal: null, requested: false } },
    ]);
  });

  test("an exit the backend asked for is info, read alongside server.stopping", async () => {
    const servers = runtime();
    const child = fakeChild(104);
    servers.adoptProcess(KEY, child);
    await servers.terminate(KEY, child, "stop requested");
    servers.reportBridgeExit(KEY, child, null, "SIGTERM");
    expect(exits()).toMatchObject([
      { level: "info", fields: { signal: "SIGTERM", requested: true } },
    ]);
    expect(logs.records().map((record) => record.event)).toEqual([
      "server.stopping",
      "bridge.exited",
    ]);
  });

  test("the stop intent belongs to the child, not to its key", async () => {
    const servers = runtime();
    const replaced = fakeChild(105);
    const replacement = fakeChild(106);
    servers.adoptProcess(KEY, replaced);
    await servers.terminate(KEY, replaced, "replacing bridge: test");
    servers.adoptProcess(KEY, replacement);
    // The replaced child no longer owns the key, and its exit is still reported.
    servers.reportBridgeExit(KEY, replaced, 0, null);
    servers.reportBridgeExit(KEY, replacement, 0, null);
    expect(exits()).toMatchObject([
      { level: "info", fields: { pid: 105, requested: true } },
      { level: "warn", fields: { pid: 106, requested: false } },
    ]);
  });
});
