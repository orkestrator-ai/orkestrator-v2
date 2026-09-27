import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { terminalProcesses } from "./commands-runtime-state.js";
import {
  setupTerminalSessionId,
  terminateTerminalSessionsForEnvironment,
} from "./commands-terminal.js";
import { spawnPty } from "./pty.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  for (const id of Array.from(terminalProcesses.keys())) {
    terminalProcesses.get(id)?.kill();
    terminalProcesses.delete(id);
  }
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false,
  );
}

describe("terminal termination before worktree removal", () => {
  test(
    "no descendant of the setup terminal can write after termination resolves",
    async () => {
      if (process.platform === "win32") return;
      const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "ork-terminate-worktree-"));
      tempDirectories.push(worktree);
      const late = path.join(worktree, "bridges", "cursor-bridge", ".turbo", "turbo-build.log");
      const started = path.join(worktree, "started");
      // The shell and its build ignore SIGTERM and SIGHUP, as an interactive
      // shell and a detached job do, so only the SIGKILL escalation stops them.
      const script = [
        "trap '' TERM HUP",
        `(trap '' TERM HUP; touch '${started}'; sleep 3; mkdir -p '${path.dirname(late)}'; echo late > '${late}') &`,
        "wait",
      ].join("\n");
      const pty = spawnPty("/bin/sh", ["-c", script], { cwd: worktree, cols: 80, rows: 24 });
      terminalProcesses.set(setupTerminalSessionId("e1"), pty);
      const deadline = Date.now() + 5_000;
      while (!(await exists(started)) && Date.now() < deadline) await Bun.sleep(25);
      expect(await exists(started)).toBe(true);

      const survivors = await terminateTerminalSessionsForEnvironment("e1");
      expect(survivors).toEqual([]);
      expect(terminalProcesses.has(setupTerminalSessionId("e1"))).toBe(false);

      await Bun.sleep(3_500);
      expect(await exists(late)).toBe(false);
    },
    { timeout: 20_000 },
  );
});
