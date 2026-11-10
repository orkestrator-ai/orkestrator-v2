import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runContainerTabBenchmark } from "../../scripts/container-tmux-tab-live";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(mode = "success") {
  const dir = mkdtempSync(path.join(tmpdir(), "container-orchestration-"));
  dirs.push(dir);
  const out = path.join(dir, "result.json");
  const calls: string[] = [];
  let stopped = false;
  let busy = false;
  let launched = false;
  let measurementSleeps = 0;
  const controller = new AbortController();
  const code = await runContainerTabBenchmark(
    { profile: "fixture", windowMs: 10, stoppedMs: 10, turns: 1, out },
    controller.signal,
    {
      profileStatus: () => ({ status: "ready" }),
      gatewayFor: (() => ({
        kinds: async () => {
          return {};
        },
        invoke: async (command: string) => {
          if (command === "get_projects") return [{ id: "project" }];
          if (command === "get_environments")
            return [
              {
                id: "env",
                environmentType: "containerized",
                containerId: "container",
                status: stopped ? "stopped" : "running",
              },
            ];
          if (command === "enqueue_prompt_queue_message") busy = true;
          if (command === "claude_tmux_status")
            return {
              running: true,
              busy,
              session_id: "session",
            };
          if (command === "claude_tmux_stop") {
            calls.push("tab-stop");
            if (mode === "tab-stop") throw new Error("stop");
          }
          return undefined;
        },
      })) as never,
      gatewayMetrics: async () => ({}),
      docker: (args) => {
        if (args[0] === "stop") {
          stopped = true;
          calls.push("stop");
        }
        if (args[0] === "start") {
          calls.push("restart");
          if (mode === "restart") throw new Error("restart");
        }
        return "";
      },
      installFakeModel: async () => {
        launched = true;
        return () => {
          calls.push("restore");
          if (mode === "restore") throw new Error("restore");
        };
      },
      transcriptExists: () => mode !== "missing-transcript",
      execCounter: () => ({ stop: async () => ({ total: 0, labels: {} }) }),
      delay: (async (ms: number) => {
        if (ms === 10 && ++measurementSleeps === 3 && mode === "end-busy") busy = true;
        if (mode === "abort" && launched) {
          controller.abort();
          throw new Error("aborted");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }) as never,
      waitFor: (async (label: string, _timeout: number, probe: () => Promise<unknown>) => {
        if (label === "the tab to go idle") {
          if (mode === "idle-timeout") throw new Error("timeout");
          busy = false;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return probe();
      }) as never,
    },
  );
  return { code, calls, result: JSON.parse(readFileSync(out, "utf8")) };
}

test("orchestration publishes a checked idle window and restores in order", async () => {
  const { code, result, calls } = await run();
  expect(code).toBe(0);
  expect(result.windows.map((w: { name: string }) => w.name)).toEqual([
    "no-tab",
    "idle-unbound",
    "turns",
    "idle-bound",
    "stopped",
  ]);
  expect(result.turnsIncludeDriverStatusProbes).toBe(true);
  expect(result.windows[2].note).toContain("not a polling-cost comparison");
  expect(calls).toEqual(["stop", "restart", "tab-stop", "restore"]);
});
for (const mode of ["idle-timeout", "missing-transcript", "end-busy"]) {
  test(`${mode} cannot publish a bound-idle rate but preserves stopped measurement`, async () => {
    const { code, result, calls } = await run(mode);
    expect(code).toBe(1);
    expect(result.idleBoundInvalid).toBeDefined();
    expect(result.windows.some((w: { name: string }) => w.name === "idle-bound")).toBe(false);
    expect(result.windows.at(-1).name).toBe("stopped");
    expect(calls).toEqual(["stop", "restart", "tab-stop", "restore"]);
  });
}
for (const mode of ["restart", "tab-stop", "restore"]) {
  test(`${mode} failure is recorded and later cleanup is attempted`, async () => {
    const { code, result, calls } = await run(mode);
    expect(code).toBe(1);
    expect(result.cleanupFailed).toBe(true);
    expect(result.cleanupFailures).toHaveLength(1);
    expect(calls).toEqual(["stop", "restart", "tab-stop", "restore"]);
  });
}
test("cancellation still restores the launched tab and fake model", async () => {
  const { code, calls } = await run("abort");
  expect(code).toBe(1);
  expect(calls).toEqual(["tab-stop", "restore"]);
});
