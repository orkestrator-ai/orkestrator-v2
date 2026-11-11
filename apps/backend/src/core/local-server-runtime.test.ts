import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { BridgeRestartCounter } from "./bridge-restarts.js";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";
import { LOCAL_SERVER_HEALTHY_REUSE_MS, LocalServerRuntime } from "./local-server-runtime.js";

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

describe("bridge restart counts", () => {
  test("a start counts, and so does an exit nothing asked for, but not a requested one", async () => {
    const counter = new BridgeRestartCounter();
    const servers = new LocalServerRuntime({
      terminateProcessTree: async () => true,
      bridgeRestarts: counter,
    });
    const crashed = fakeChild(110);
    servers.reportBridgeStart(KEY, crashed);
    servers.reportBridgeExit(KEY, crashed, 1, null);
    const stopped = fakeChild(111);
    servers.reportBridgeStart(KEY, stopped);
    servers.adoptProcess(KEY, stopped);
    await servers.terminate(KEY, stopped, "stop requested");
    servers.reportBridgeExit(KEY, stopped, null, "SIGTERM");
    expect(counter.snapshot()).toEqual({
      codex: { localStarts: 2, localUnrequestedExits: 1, containerLaunches: 0 },
    });
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

describe("reapAfterUnrequestedExit", () => {
  const recordingRuntime = (result: "empty" | "stopped" | "survived") => {
    const reaped: Array<number | undefined> = [];
    const servers = new LocalServerRuntime({
      terminateProcessTree: async () => true,
      reapProcessGroup: async (pgid) => {
        reaped.push(pgid);
        return result;
      },
    });
    return { servers, reaped };
  };
  const reaps = () => logs.records().filter((record) => record.event === "bridge.orphans-reaped");

  test("a bridge that died on its own has its group reaped, and the reap is logged", async () => {
    const { servers, reaped } = recordingRuntime("stopped");
    await servers.reapAfterUnrequestedExit(KEY, fakeChild(201));
    expect(reaped).toEqual([201]);
    expect(reaps()).toMatchObject([
      { level: "warn", fields: { key: KEY, pid: 201, result: "stopped" } },
    ]);
  });

  test("an empty group is reaped quietly, and a survivor is an error", async () => {
    const quiet = recordingRuntime("empty");
    await quiet.servers.reapAfterUnrequestedExit(KEY, fakeChild(202));
    expect(quiet.reaped).toEqual([202]);
    expect(reaps()).toEqual([]);
    const stuck = recordingRuntime("survived");
    await stuck.servers.reapAfterUnrequestedExit(KEY, fakeChild(203));
    expect(reaps()).toMatchObject([{ level: "error", fields: { result: "survived" } }]);
  });

  test("a stop the backend asked for is left to terminate", async () => {
    const { servers, reaped } = recordingRuntime("stopped");
    const child = fakeChild(204);
    servers.adoptProcess(KEY, child);
    await servers.terminate(KEY, child, "stop requested");
    await servers.reapAfterUnrequestedExit(KEY, child);
    expect(reaped).toEqual([]);
  });

  test("a failing reaper never rejects", async () => {
    const servers = new LocalServerRuntime({
      reapProcessGroup: async () => {
        throw new Error("ps failed");
      },
    });
    await expect(servers.reapAfterUnrequestedExit(KEY, fakeChild(205))).resolves.toBeUndefined();
  });
});

describe("reused health answers", () => {
  const healthyChild = () => fakeChild(fakePid(1)) as ChildProcessWithoutNullStreams;

  test("stand for the same process, port and token inside the window only", () => {
    const servers = runtime();
    const child = healthyChild();
    servers.adoptProcess(KEY, child);
    servers.recordHealthy(KEY, { child, port: 4100, authToken: "token", at: 1_000 });

    expect(servers.recentlyHealthy(KEY, child, 4100, "token", 1_000)).toBe(true);
    expect(
      servers.recentlyHealthy(KEY, child, 4100, "token", 1_000 + LOCAL_SERVER_HEALTHY_REUSE_MS - 1),
    ).toBe(true);
    expect(servers.recentlyHealthy(KEY, child, 4101, "token", 1_001)).toBe(false);
    // A mismatch drops the answer, so the original coordinates probe again too.
    expect(servers.recentlyHealthy(KEY, child, 4100, "token", 1_001)).toBe(false);

    servers.recordHealthy(KEY, { child, port: 4100, authToken: "token", at: 1_000 });
    expect(servers.recentlyHealthy(KEY, child, 4100, "other", 1_001)).toBe(false);
    servers.recordHealthy(KEY, { child, port: 4100, authToken: "token", at: 1_000 });
    expect(
      servers.recentlyHealthy(KEY, child, 4100, "token", 1_000 + LOCAL_SERVER_HEALTHY_REUSE_MS),
    ).toBe(false);
  });

  test("are not recorded for a process that does not own the key", () => {
    const servers = runtime();
    const owner = healthyChild();
    const stranger = fakeChild(fakePid(2)) as ChildProcessWithoutNullStreams;
    servers.adoptProcess(KEY, owner);
    servers.recordHealthy(KEY, { child: stranger, port: 4100, authToken: "token", at: 1_000 });

    expect(servers.recentlyHealthy(KEY, stranger, 4100, "token", 1_000)).toBe(false);
  });

  test("end when the process is marked unresponsive or released", () => {
    const servers = runtime();
    const child = healthyChild();
    servers.adoptProcess(KEY, child);
    servers.recordHealthy(KEY, { child, port: 4100, authToken: "token", at: 1_000 });
    servers.markUnresponsive(KEY, { child, since: 1_000, lastFailureAt: 1_000 });
    expect(servers.recentlyHealthy(KEY, child, 4100, "token", 1_001)).toBe(false);

    servers.clearUnresponsive(KEY);
    servers.recordHealthy(KEY, { child, port: 4100, authToken: "token", at: 1_000 });
    servers.releaseOwnership(KEY, child);
    expect(servers.recentlyHealthy(KEY, child, 4100, "token", 1_001)).toBe(false);
  });
});
