import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import {
  LOW_PRIORITY_SHELL_PREFIX,
  lowPriorityCommand,
  WORKLOAD_NICE,
} from "./process-priority.js";
import { LocalServerRuntime } from "./local-server-runtime.js";

const posix = process.platform !== "win32";
const REPORT_NICE = "ps -o ni= -p $$";
/** A run from inside a lowered agent starts lower already; nice never goes back up. */
const expectedNice = () => Math.max(os.getPriority(), WORKLOAD_NICE);

function collect(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.once("error", reject);
    child.once("close", () => resolve(stdout.trim()));
  });
}

describe("lowPriorityCommand", () => {
  test("prefixes the system's nice and keeps every argument intact", () => {
    expect(
      lowPriorityCommand("/bin/sh", ["-c", "echo 'a b'"], {
        platform: "linux",
        exists: (candidate) => candidate === "/usr/bin/nice",
      }),
    ).toEqual({
      command: "/usr/bin/nice",
      args: ["-n", String(WORKLOAD_NICE), "/bin/sh", "-c", "echo 'a b'"],
    });
    expect(
      lowPriorityCommand("/bin/sh", [], {
        platform: "darwin",
        exists: (candidate) => candidate === "/bin/nice",
      }).command,
    ).toBe("/bin/nice");
  });

  test("is inert on Windows and where there is no nice", () => {
    const unchanged = { command: "bun", args: ["index.js"] };
    expect(
      lowPriorityCommand("bun", ["index.js"], { platform: "win32", exists: () => true }),
    ).toEqual(unchanged);
    expect(
      lowPriorityCommand("bun", ["index.js"], { platform: "linux", exists: () => false }),
    ).toEqual(unchanged);
  });

  test.if(posix)("keeps the spawned PID and lowers the process", async () => {
    const lowered = lowPriorityCommand("/bin/sh", ["-c", `echo $$; ${REPORT_NICE}`]);
    const child = spawn(lowered.command, lowered.args);
    const [pid, nice] = (await collect(child)).split(/\s+/);
    expect(Number(pid)).toBe(child.pid!);
    expect(Number(nice)).toBeGreaterThanOrEqual(expectedNice());
  });

  test.if(process.platform === "linux")("reaches every thread of a Bun process", () => {
    // Bun starts its worker threads lazily; this makes it start some first.
    const lowered = lowPriorityCommand(process.execPath, [
      "-e",
      'const fs = require("node:fs");' +
        'await fs.promises.readFile("/proc/self/stat"); Bun.gc(true); await Bun.sleep(50);' +
        'console.log(fs.readdirSync("/proc/self/task").map((id) =>' +
        'fs.readFileSync(`/proc/self/task/${id}/stat`, "utf8").split(") ")[1].split(" ")[16]).join(" "))',
    ]);
    const { stdout } = spawnSync(lowered.command, lowered.args, {
      encoding: "utf8",
      timeout: 20_000,
    });
    const threads = stdout.trim().split(" ").map(Number);
    expect(threads.length).toBeGreaterThan(1);
    for (const nice of threads) expect(nice).toBeGreaterThanOrEqual(expectedNice());
  });

  test.if(posix)("a missing command fails with 127 rather than a spawn error", async () => {
    const lowered = lowPriorityCommand("/nonexistent/orkestrator-command");
    const child = spawn(lowered.command, lowered.args, { stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(127);
  });
});

describe("LOW_PRIORITY_SHELL_PREFIX", () => {
  test.if(posix)("lowers the shell and what it runs", () => {
    const { stdout } = spawnSync("/bin/sh", ["-c", `${LOW_PRIORITY_SHELL_PREFIX}${REPORT_NICE}`], {
      encoding: "utf8",
    });
    expect(Number(stdout.trim())).toBeGreaterThanOrEqual(expectedNice());
  });

  test.if(posix)("still runs the command when renice is unavailable", () => {
    const { status, stdout, stderr } = spawnSync(
      "/bin/sh",
      ["-c", `${LOW_PRIORITY_SHELL_PREFIX}echo ran`],
      { encoding: "utf8", env: { PATH: "/nonexistent" } },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("ran");
    expect(stderr).toBe("");
  });
});

describe("LocalServerRuntime", () => {
  test.if(posix)("starts bridges at the workload priority by default", async () => {
    const runtime = new LocalServerRuntime();
    const child = runtime.spawn("/bin/sh", ["-c", REPORT_NICE]);
    expect(Number(await collect(child))).toBeGreaterThanOrEqual(expectedNice());
  });

  test("an injected spawn still sees the command as given", () => {
    const seen: unknown[] = [];
    const runtime = new LocalServerRuntime({
      spawn: ((command: string, args: string[]) => {
        seen.push(command, args);
        return {} as never;
      }) as never,
    });
    runtime.spawn("bun", ["index.js"]);
    expect(seen).toEqual(["bun", ["index.js"]]);
  });
});
