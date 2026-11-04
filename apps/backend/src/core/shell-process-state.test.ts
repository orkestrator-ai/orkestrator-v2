import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeWaitStatus, groupHasLiveMember, readZombieExit } from "./shell-process-state.js";

const posixOnly = process.platform === "win32" ? test.skip : test;
const darwinOnly = process.platform === "darwin" ? test : test.skip;

/**
 * Leaves `script`'s shell dead and unreaped: its parent execs into a `sleep` that
 * never waits. The PID comes through a file, so no pipe reader is involved. With
 * `ownGroup` only the zombie is left in the zombie's group.
 */
async function withZombie(
  script: string,
  use: (zombiePid: number, parentPid: number) => void,
  { ownGroup = false } = {},
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-process-state-"));
  const pidFile = path.join(directory, "pid");
  const parent = spawn(
    "sh",
    [
      "-c",
      // The delay lets the parent exec first: a shell reaps its children, `sleep` does not.
      `${ownGroup ? "set -m; " : ""}sh -c 'sleep 0.1; ${script}' & echo $! > "$1"; exec sleep 30`,
      "sh",
      pidFile,
    ],
    { detached: true, stdio: "ignore" },
  );
  try {
    const deadline = Date.now() + 3_000;
    let zombiePid = 0;
    while (Date.now() < deadline) {
      zombiePid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      const stat = zombiePid
        ? Bun.spawnSync(["ps", "-o", "stat=", "-p", String(zombiePid)]).stdout.toString()
        : "";
      if (stat.trim().startsWith("Z")) break;
      await Bun.sleep(10);
    }
    use(zombiePid, parent.pid!);
  } finally {
    parent.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

describe("decodeWaitStatus", () => {
  test("separates an exit code from a fatal signal", () => {
    expect(decodeWaitStatus(0)).toEqual({ code: 0, signal: null });
    expect(decodeWaitStatus(0x300)).toEqual({ code: 3, signal: null });
    expect(decodeWaitStatus(9)).toEqual({ code: null, signal: "SIGKILL" });
    expect(decodeWaitStatus(15)).toEqual({ code: null, signal: "SIGTERM" });
  });
});

describe("readZombieExit", () => {
  for (const [script, expected] of [
    ["exit 0", { code: 0, signal: null }],
    ["exit 3", { code: 3, signal: null }],
    ["kill -KILL $$", { code: null, signal: "SIGKILL" }],
  ] as const) {
    darwinOnly(`reports the true outcome of a zombie (${script})`, async () => {
      await withZombie(script, (zombiePid) => {
        expect(readZombieExit(zombiePid)).toEqual(expected);
      });
    });
  }

  darwinOnly("reports nothing for a process that is still running", async () => {
    await withZombie("exit 0", (_zombiePid, parentPid) => {
      expect(readZombieExit(parentPid)).toBeUndefined();
    });
  });

  darwinOnly("reports nothing for a process that is gone", () => {
    // A PID above any configured maximum never names a process.
    expect(readZombieExit(2 ** 22 + 1)).toBeUndefined();
  });
});

describe("groupHasLiveMember", () => {
  posixOnly("sees a running member and ignores an empty group", async () => {
    await withZombie("exit 0", (_zombiePid, parentPid) => {
      expect(groupHasLiveMember(parentPid)).toBe(true);
    });
    expect(groupHasLiveMember(2 ** 22 + 1)).toBe(false);
  });

  posixOnly("does not count a zombie as a live member", async () => {
    await withZombie(
      "exit 0",
      (zombiePid) => {
        expect(groupHasLiveMember(zombiePid)).toBe(false);
      },
      { ownGroup: true },
    );
  });
});
