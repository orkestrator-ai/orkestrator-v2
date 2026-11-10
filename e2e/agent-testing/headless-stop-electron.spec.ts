import { expect, test } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { processTree } from "./process-tree";
import { electronSpecEnvironment } from "./electron-spec-environment";

const root = path.resolve(import.meta.dirname, "../..");
type Status = {
  status: string;
  logDir: string;
  pids: { electron?: number; backend?: number; launcher?: number };
  live: Record<string, boolean>;
};
const cores = () => readdirSync(root).filter((name) => /^core(?:\.\d+)?$/.test(name));
function alive(pid: number): boolean {
  try {
    // A zombie cannot do work and only waits for its reaper.
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

for (const fallback of [false, true]) {
  test(`headless profile stop leaves no crash or descendants (${fallback ? "launcher absent" : "graceful"})`, async () => {
    test.skip(process.platform !== "linux", "Linux process-tree and core regression");
    test.setTimeout(300_000);
    const profile = `headless-stop-${process.pid}-${fallback ? "fallback" : "normal"}`;
    const command = async (script: string, extra: string[] = []) => {
      try {
        const result = await promisify(execFile)(
          "bun",
          [`apps/desktop/scripts/${script}.ts`, "--profile", profile, ...extra],
          { cwd: root, encoding: "utf8", timeout: 30_000 },
        );
        return { status: 0, stdout: result.stdout };
      } catch {
        return { status: 1, stdout: "" };
      }
    };
    const before = cores();
    // No agent turns are needed: this tests the launcher and backend lifecycle.
    // The profile has no credentials and never contacts a model provider.
    const launcher = spawn(
      "bun",
      [
        "apps/desktop/scripts/dev-test.ts",
        "--profile",
        profile,
        "--fixture",
        "--headless",
        "--no-agent-credentials",
        "--agent-platforms",
        "pi",
      ],
      {
        cwd: root,
        env: electronSpecEnvironment(process.env, { ORKESTRATOR_AGENT_TEST_CORE_DUMPS: "1" }),
        stdio: "ignore",
      },
    );
    let owned: number[] = [];
    try {
      let status: Status | undefined;
      await expect
        .poll(
          async () => {
            const result = await command("dev-status", ["--json"]);
            try {
              status = JSON.parse(result.stdout) as Status;
            } catch {
              return false;
            }
            return status.status === "ready" && status.live.electron && status.live.backend;
          },
          { timeout: 240_000, intervals: [500, 1000] },
        )
        .toBe(true);
      expect(status!.pids.launcher).toBe(launcher.pid);
      owned = processTree(launcher.pid!);
      expect(owned).toContain(status!.pids.backend);
      if (fallback) {
        // Only signal the exact child spawned by this test.
        launcher.kill("SIGKILL");
        await expect.poll(() => alive(launcher.pid!), { timeout: 10_000 }).toBe(false);
      }
      expect((await command("dev-stop")).status).toBe(0);
      await expect.poll(() => owned.filter(alive), { timeout: 15_000 }).toEqual([]);
      const log = readFileSync(path.join(status!.logDir, "electron.log"), "utf8");
      expect(/SIGTRAP|FATAL|GPU process isn't usable/.test(log)).toBe(false);
      if (!fallback) expect(log).toMatch(/shutdown\.finished.*code=0/);
      expect(cores().filter((name) => !before.includes(name))).toEqual([]);
    } finally {
      // The profile commands validate process start times and exact ownership.
      const stopped = await command("dev-stop");
      expect(stopped.status).toBe(0);
      expect((await command("dev-reset")).status).toBe(0);
    }
  });
}
