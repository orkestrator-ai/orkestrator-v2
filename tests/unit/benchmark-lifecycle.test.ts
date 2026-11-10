import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectWindow, execCounter } from "../../scripts/container-tmux-tab-live";
import { runItemCounts } from "../../scripts/busy-item-counts-live";
import { gatewayFor } from "../../scripts/tmux-mail-inject-live";
import { cliFailure } from "../../scripts/recurring-live-ab-busy";

setDefaultTimeout(30_000);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function collector() {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    stdout: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kills: [] as string[],
    kill(signal: string) {
      this.kills.push(signal);
      this.signalCode = signal;
      this.stdout.end();
      events.emit("exit", null, signal);
      events.emit("close", null, signal);
      return true;
    },
  });
  const counter = execCounter("fixture", (() => child) as unknown as typeof spawn, async () => {});
  return { child, counter };
}

test("collector drains events and reaps its child on normal stop", async () => {
  const { child, counter } = collector();
  child.stdout.write(JSON.stringify("exec_start: tmux list-sessions") + "\n");
  expect(await counter.stop()).toEqual({ total: 1, labels: { "tmux list-sessions": 1 } });
  expect(child.kills).toEqual(["SIGTERM"]);
});

for (const failure of ["error", "exit"] as const) {
  test(`collector rejects ${failure} instead of returning a partial count`, async () => {
    const { child, counter } = collector();
    if (failure === "error") child.emit("error", new Error("spawn failed"));
    else {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }
    child.stdout.end();
    child.emit("close", child.exitCode, null);
    await expect(counter.stop()).rejects.toThrow("measurement invalid");
  });
}

for (const failure of ["opening", "final", "body", "collector"] as const) {
  test(`window rejects ${failure} failure and always stops the collector`, async () => {
    let reads = 0;
    let stops = 0;
    let bodyRan = false;
    await expect(
      collectWindow(
        () => ({
          stop: async () => {
            stops++;
            if (failure === "collector") throw new Error("collector");
            return { total: 0, labels: {} };
          },
        }),
        async () => {
          reads++;
          if ((failure === "opening" && reads === 1) || (failure === "final" && reads === 2))
            throw new Error(failure);
          return {};
        },
        async () => {
          bodyRan = true;
          if (failure === "body") throw new Error("body");
          return 7;
        },
      ),
    ).rejects.toThrow(failure);
    expect(stops).toBe(1);
    expect(bodyRan).toBe(failure !== "opening");
  });
}

test("a complete window returns both snapshots and its result", async () => {
  let reads = 0;
  const result = await collectWindow(
    () => ({ stop: async () => ({ total: 2, labels: { tmux: 2 } }) }),
    async () => {
      reads++;
      return {};
    },
    async () => 42,
  );
  expect(reads).toBe(2);
  expect(result.value).toBe(42);
  expect(result.counted.total).toBe(2);
});

for (const mode of [
  "success",
  "cancel",
  "refuse-stop",
  "refuse-start",
  "read-error",
  "no-busy",
] as const) {
  test(`busy lifecycle: ${mode}`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "benchmark-lifecycle-"));
    dirs.push(dir);
    const controller = new AbortController();
    const calls: Array<{ action: string; cleanup: boolean }> = [];
    let stopped = false;
    let time = 0;
    const gateway = {
      async invoke<T>(
        command: string,
        args: Record<string, unknown> = {},
        cleanup = false,
      ): Promise<T> {
        if (controller.signal.aborted && !cleanup) throw new Error("aborted");
        if (command === "get_projects") return [{ id: "fixture" }] as T;
        if (command === "get_environments")
          return [
            {
              id: "busy",
              name: mode === "no-busy" ? "fixture" : "busy-one",
              environmentType: "local",
              status: stopped ? "stopped" : "running",
            },
          ] as T;
        const action = String(args.action);
        calls.push({ action, cleanup });
        if (action === "environment.stop") {
          if (mode === "refuse-stop") return { ok: false, error: { code: "denied" } } as T;
          stopped = true;
        }
        if (action === "environment.start" && mode === "refuse-start")
          throw new Error("start failed");
        return { ok: true } as T;
      },
      async kinds() {
        if (mode === "read-error") throw new Error("metrics failed");
        return {};
      },
    };
    const out = path.join(dir, "result.json");
    const code = await runItemCounts({ profile: "fixture", windowMs: 1, out }, controller.signal, {
      gateway,
      now: () => ++time,
      sleep: async () => {
        if (mode === "cancel" && stopped) {
          controller.abort();
          throw new Error("cancelled");
        }
      },
    });
    expect(code).toBe(mode === "success" ? 0 : 1);
    const artifact = JSON.parse(readFileSync(out, "utf8"));
    expect(artifact.windows.length).toBe(
      mode === "success" || mode === "refuse-start"
        ? 2
        : mode === "cancel" || mode === "refuse-stop"
          ? 1
          : 0,
    );
    expect(calls.filter((call) => call.action === "environment.start")).toEqual(
      stopped ? [{ action: "environment.start", cleanup: true }] : [],
    );
    if (mode === "refuse-start") expect(artifact.cleanupFailed).toBe(true);
  });
}

test("cleanup gateway requests use an independent live signal after cancellation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "benchmark-auth-"));
  dirs.push(dir);
  const { writeFileSync } = await import("node:fs");
  const authFile = path.join(dir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ token: "fixture-only" }));
  const controller = new AbortController();
  controller.abort();
  const signals: boolean[] = [];
  const gateway = gatewayFor(
    { browserUrl: "http://127.0.0.1", authFile },
    controller.signal,
    async (_url, init) => {
      signals.push(init.signal!.aborted);
      return Response.json({ result: { ok: true } });
    },
  );
  await gateway.invoke("public_action", {}, true);
  await gateway.invoke("public_action");
  expect(signals).toEqual([false, true]);
});

test("CLI failure summaries cover codes, counts, malformed JSON and signal exit without output", () => {
  expect(cliFailure({ status: 1, stdout: '{"error":{"code":"denied"}}' })).toBe("exit 1, denied");
  expect(cliFailure({ status: 0, stdout: '{"result":{"items":[{},{}]}}' })).toBe(
    "exit 0, 2 listed",
  );
  expect(cliFailure({ status: 1, stdout: "{}" })).toBe("exit 1, no error code");
  expect(cliFailure({ status: null, stdout: "private non-JSON output" })).toBe(
    "exit signal, no JSON",
  );
});
