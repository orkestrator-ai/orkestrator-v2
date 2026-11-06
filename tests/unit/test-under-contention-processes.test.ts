/**
 * The contention runner stops every burner it started, through its own
 * handles, whatever happens to the command or the runner. These tests spawn
 * real processes, so the file is in the slow tier. They signal nothing but
 * their own children; a burner's liveness is read from /proc on Linux (no
 * signal at all), and only falls back to signal 0 elsewhere.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ANNOUNCE_ENV,
  burnerSource,
  detectPlatform,
  runUnderContention,
} from "../../scripts/test-under-contention";

const runner = path.resolve(import.meta.dir, "../../scripts/test-under-contention.ts");
const quiet = () => undefined;

/** True while `pid` is still one of our burners (not gone, not a zombie, not reused). */
function burnerAlive(pid: number): boolean {
  if (process.platform === "linux") {
    const stat = `/proc/${pid}/stat`;
    if (!existsSync(stat)) return false;
    try {
      const state = readFileSync(stat, "utf8").split(") ")[1]?.[0];
      if (state === "Z" || state === "X") return false;
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("process.ppid");
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectGone(pids: number[]) {
  expect(pids.length).toBeGreaterThan(0);
  // Burners are reaped before the runner returns, so this holds immediately.
  expect(pids.filter(burnerAlive)).toEqual([]);
}

describe("test-under-contention burner cleanup", () => {
  test("exits before spinning when startup already has a different parent", async () => {
    // The shell/runner could have died before evaluation. Supply a deliberately
    // different expected parent while executing the actual burner source.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        burnerSource(60, process.pid + 1).replace(
          "for (;;) {",
          'throw new Error("entered busy loop"); for (;;) {',
        ),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      expect(await child.exited).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("propagates a passing command's status and stops its burners", async () => {
    const lines: string[] = [];
    const result = await runUnderContention(
      { burners: 2, command: [process.execPath, "-e", "process.exit(0)"] },
      { log: (line) => lines.push(line) },
    );
    expect(result.exitCode).toBe(0);
    expect(result.burnerPids).toHaveLength(2);
    await expectGone(result.burnerPids);
    const summary = lines.at(-1)!;
    expect(summary).toMatch(/^contention: core=\S+ burners=2 elapsed=\d+\.\ds exit=0$/);
    if (detectPlatform().taskset) expect(result.pinned).toBe(true);
  });

  test("propagates a failing command's status and still stops its burners", async () => {
    const result = await runUnderContention(
      { burners: 2, command: [process.execPath, "-e", "process.exit(3)"] },
      { log: quiet },
    );
    expect(result.exitCode).toBe(3);
    await expectGone(result.burnerPids);
  });

  test("runs unpinned and says so without taskset", async () => {
    const lines: string[] = [];
    const result = await runUnderContention(
      { burners: 1, command: [process.execPath, "-e", "process.exit(0)"] },
      { platform: { taskset: undefined, cores: 4 }, log: (line) => lines.push(line) },
    );
    expect(result.pinned).toBe(false);
    expect(lines[0]).toContain("weaker condition");
    expect(lines.at(-1)).toContain("core=unpinned");
    await expectGone(result.burnerPids);
  });

  test("stops its burners when the runner throws", async () => {
    let pids: number[] = [];
    await expect(
      runUnderContention(
        { burners: 2, command: ["true"] },
        {
          log: quiet,
          onBurnersStarted: (started) => {
            pids = started;
            throw new Error("injected failure");
          },
        },
      ),
    ).rejects.toThrow("injected failure");
    await expectGone(pids);
  });

  test("answers 127 and stops its burners when the command cannot start", async () => {
    const result = await runUnderContention(
      { burners: 1, command: ["no-such-command"] },
      {
        log: quiet,
        spawnCommand: () => {
          throw new Error("spawn failed");
        },
      },
    );
    expect(result.exitCode).toBe(127);
    await expectGone(result.burnerPids);
  });

  test("on SIGTERM it stops the command and its burners and exits 143", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        runner,
        "--burners",
        "2",
        "--",
        process.execPath,
        "-e",
        "console.log(process.pid); await Bun.sleep(30000)",
      ],
      env: { ...process.env, [ANNOUNCE_ENV]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const decoder = new TextDecoder();
      const readUntil = async (stream: ReadableStream<Uint8Array>, pattern: RegExp) => {
        const reader = stream.getReader();
        let text = "";
        while (!pattern.test(text)) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value);
        }
        reader.releaseLock();
        return text;
      };
      const announced = await readUntil(child.stderr, /contention-burners \S+\n/);
      // Wait for the command to be running too, so the signal has something to stop.
      const commandPid = Number((await readUntil(child.stdout, /^\d+\n/)).trim());
      const pids = announced
        .match(/contention-burners (\S+)/)![1]!
        .split(",")
        .map(Number);
      expect(pids.filter(burnerAlive)).toHaveLength(2);

      child.kill("SIGTERM");
      expect(await child.exited).toBe(143);
      await expectGone(pids);
      // The command was reaped before the runner exited.
      if (process.platform === "linux") expect(existsSync(`/proc/${commandPid}`)).toBe(false);
    } finally {
      // Only our own child; its burners exit by themselves once it is gone.
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
