import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMailBenchmark, parseOptions, gatewayFor } from "../../scripts/tmux-mail-inject-live";
import { mailBenchmarkFixture } from "../fixtures/tmux-mail-benchmark-runtime";

const roots: string[] = [];
const temporary = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mail-benchmark-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const options = (root: string) =>
  parseOptions([
    "--profile",
    "fixture",
    "--deliveries",
    "1",
    "--out",
    path.join(root, "result.json"),
  ]);
const result = (root: string) => JSON.parse(readFileSync(path.join(root, "result.json"), "utf8"));
const restored = (directory: string) => {
  expect(readFileSync(path.join(directory, "settings.json"), "utf8")).toBe('{"original":true}\n');
  expect(existsSync(path.join(directory, ".claude.json"))).toBe(false);
};

test("valid measurements succeed and restore files, stop only the owned tab and close the server", async () => {
  const root = temporary();
  const h = mailBenchmarkFixture(root);
  expect(await runMailBenchmark(options(root), undefined, h.runtime)).toBe(0);
  expect(result(root)).toMatchObject({
    ok: true,
    idle: { mailInjectionReadsPerPass: 2 },
    deliveries: [{ mailInjectionReadsBeyondIdle: 0 }],
  });
  const launch = h.events.find((event) => event.startsWith("launch:"))!.slice(7);
  expect(h.events).toContain(`stop:${launch}:true`);
  expect(h.events.slice(-2)).toEqual(["restored", "server-stopped"]);
  restored(h.claudeDir);
  await expect(fetch(h.origin())).rejects.toThrow();
});

test("restores both files when they already existed", async () => {
  const root = temporary();
  const h = mailBenchmarkFixture(root);
  const statePath = path.join(h.claudeDir, ".claude.json");
  const saved = '{"projects":{},"originalState":true}\n';
  writeFileSync(statePath, saved);
  expect(await runMailBenchmark(options(root), undefined, h.runtime)).toBe(0);
  expect(readFileSync(statePath, "utf8")).toBe(saved);
});

test("cleanup requests have an independent deadline after cancellation", async () => {
  const root = temporary();
  const h = mailBenchmarkFixture(root);
  const controller = new AbortController();
  controller.abort();
  const cancelled: boolean[] = [];
  const gateway = gatewayFor(h.runtime.profileStatus(), controller.signal, async (_url, init) => {
    cancelled.push(init.signal!.aborted);
    return Response.json({ result: true });
  });
  await gateway.invoke("normal");
  await gateway.invoke("claude_tmux_stop", {}, true);
  expect(cancelled).toEqual([true, false]);
});

test.each([
  "http-error",
  "disabled",
  "missing",
  "invalid",
  "reset",
  "no-idle-pass",
  "delivery-reset",
  "delivery-stall",
])("%s fails with a measurement error artifact and cleanup", async (mode) => {
  const root = temporary();
  let reads = 0;
  const h = mailBenchmarkFixture(root, () => {
    reads += 1;
    if (mode === "http-error") return Response.json({ error: "unavailable" }, { status: 500 });
    if (mode === "disabled")
      return Response.json({ recurringWork: { metrics: { enabled: false } } });
    if (mode === "missing") return Response.json({ recurringWork: { metrics: { kinds: {} } } });
    const count =
      mode === "reset"
        ? 10 - reads
        : mode === "delivery-reset"
          ? reads >= 4
            ? 1
            : 10 + reads
          : mode === "delivery-stall"
            ? 10 + Math.min(reads, 3)
            : 10;
    return Response.json({
      recurringWork: {
        metrics: {
          kinds: {
            "mail-injection": {
              started: count,
              changed: 0,
              failed: 0,
              bytes: count,
              workUnits: { "storage-read": mode === "invalid" ? null : count },
            },
          },
        },
      },
    });
  });
  expect(await runMailBenchmark(options(root), undefined, h.runtime)).toBe(1);
  expect(result(root).ok).not.toBe(true);
  expect(result(root).error).toMatch(
    /Metrics request failed|counters unavailable|counters reset|no measured|No valid measured/i,
  );
  restored(h.claudeDir);
  expect(h.events.at(-1)).toBe("server-stopped");
});

test.each(["SIGINT", "SIGTERM"] as const)(
  "%s unwinds configured fixtures and awaits cleanup before exit",
  async (signal) => {
    const root = temporary();
    const script = path.join(root, "interrupt.ts");
    writeFileSync(
      script,
      `
    import { appendFileSync } from "node:fs";
    import { mailBenchmarkFixture } from ${JSON.stringify(path.resolve(import.meta.dir, "../fixtures/tmux-mail-benchmark-runtime.ts"))};
    import { runMailBenchmark, __testing } from ${JSON.stringify(path.resolve(import.meta.dir, "../../scripts/tmux-mail-inject-live.ts"))};
    import { withTerminationSignals } from ${JSON.stringify(path.resolve(import.meta.dir, "../../scripts/recurring-live-ab.ts"))};
    const h = mailBenchmarkFixture(${JSON.stringify(root)});
    h.runtime.sleep = async (ms, signal) => {
      appendFileSync(${JSON.stringify(path.join(root, "events"))}, "waiting\\n");
      await __testing.mailRuntime.sleep(ms, signal);
    };
    process.exitCode = await withTerminationSignals(signal => runMailBenchmark(${JSON.stringify(options(root))}, signal, h.runtime));
  `,
    );
    const child = spawn(process.execPath, [script], { stdio: "ignore" });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (
          existsSync(path.join(root, "events")) &&
          readFileSync(path.join(root, "events"), "utf8").includes("waiting")
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(readFileSync(path.join(root, "events"), "utf8")).toContain("waiting");
      child.kill(signal);
      expect(await done).toBe(signal === "SIGINT" ? 130 : 143);
      const events = readFileSync(path.join(root, "events"), "utf8").trim().split("\n");
      const tabId = events.find((event) => event.startsWith("launch:"))!.slice(7);
      expect(events.slice(-3)).toEqual([`stop:${tabId}:true`, "restored", "server-stopped"]);
      restored(path.join(root, "profiles/fixture/data/agent-credentials/claude"));
      expect(result(root).ok).not.toBe(true);
      expect(result(root).error).toMatch(/Benchmark interrupted|Benchmark terminated/);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await done;
    }
  },
  15_000,
);
