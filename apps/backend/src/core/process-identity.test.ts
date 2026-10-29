import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  isProcessAlive,
  isRecordedProcessAlive,
  processStartIdentity,
  readLiveCommandLines,
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
