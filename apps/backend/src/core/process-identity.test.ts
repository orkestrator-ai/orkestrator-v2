import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isProcessAlive,
  isRecordedProcessAlive,
  processStartIdentity,
  readLiveCommandLines,
  readPsCommandLines,
} from "./process-identity.js";

describe("production process identity", () => {
  test.skipIf(process.platform === "win32")("reads a stable native start identity", () => {
    const identity = processStartIdentity(process.pid);
    expect(identity).not.toBeNull();
    expect(processStartIdentity(process.pid)).toBe(identity);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      expect(identity).toBe(`${boot}:${fields[19]}`);
      expect(identity).toMatch(/^[0-9a-f-]{36}:\d+$/);
    } else {
      const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      });
      expect(ps.status).toBe(0);
      expect(identity).toBe(ps.stdout.trim());
    }
  });

  test.skipIf(process.platform === "win32")(
    "finds a real live command line and observes its exit",
    async () => {
      const marker = `ork-process-identity-${process.pid}-${Date.now()}`;
      const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)", marker], {
        stdio: "ignore",
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const pid = child.pid!;
      try {
        expect(isProcessAlive(pid)).toBe(true);
        const identity = processStartIdentity(pid);
        expect(identity).not.toBeNull();
        expect(isRecordedProcessAlive(pid, identity)).toBe(true);
        expect(isRecordedProcessAlive(pid, "a different start")).toBe(false);
        const lines = await readLiveCommandLines();
        expect(lines).not.toBeNull();
        expect(lines).toContain(marker);
        expect(lines).not.toContain("\0");
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      expect(isProcessAlive(pid)).toBe(false);
      expect(processStartIdentity(pid)).toBeNull();
      expect(isRecordedProcessAlive(pid, null)).toBe(false);
      expect(await readLiveCommandLines()).not.toContain(marker);
    },
  );
});

describe("readPsCommandLines", () => {
  const originalPath = process.env.PATH;

  async function withPs<T>(body: string, run: () => Promise<T>): Promise<T> {
    const directory = mkdtempSync(path.join(tmpdir(), "ork-process-identity-ps-"));
    const script = path.join(directory, "ps");
    writeFileSync(script, `#!/bin/sh\n${body}\n`);
    chmodSync(script, 0o755);
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    try {
      return await run();
    } finally {
      process.env.PATH = originalPath;
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test("returns ps's whole output, asked for in the C locale", async () => {
    const stdout = await withPs(`printf '%s|%s\\n' "$LC_ALL" "$*"`, () => readPsCommandLines());
    expect(stdout).toBe("C|-axww -o args=\n");
  });

  test("a failing ps is unknown, whatever it printed", async () => {
    expect(await withPs("echo partial; exit 1", () => readPsCommandLines())).toBeNull();
  });

  test("a ps past its timeout is unknown, whatever it printed", async () => {
    const lines = await withPs("echo partial; exec sleep 30", () =>
      readPsCommandLines({ timeoutMs: 100 }),
    );
    expect(lines).toBeNull();
  });

  test("a ps past its output limit is unknown rather than a shorter list", async () => {
    const lines = await withPs("printf 123456", () => readPsCommandLines({ maxOutputBytes: 5 }));
    expect(lines).toBeNull();
  });
});
