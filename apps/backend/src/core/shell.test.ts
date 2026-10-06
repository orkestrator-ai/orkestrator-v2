import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CommandFailedError, runCommand } from "./shell.js";

const posixOnly = process.platform === "win32" ? test.skip : test;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isRunning(pid);
}

describe("runCommand timeout", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  posixOnly("reports a timeout and stops processes the child started", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-shell-test-"));
    const pidFile = path.join(tempDir, "grandchild.pid");

    // `git fetch` over ssh has this shape: the child starts a long-lived
    // subprocess of its own and waits on it.
    const failure = await runCommand("sh", ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`], {
      timeoutMs: 400,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).timedOut).toBe(true);

    const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(await waitUntilGone(grandchildPid)).toBe(true);
  });

  posixOnly("does not interfere with a command that finishes in time", async () => {
    const result = await runCommand("sh", ["-c", "echo done"], { timeoutMs: 5_000 });
    expect(result.stdout.trim()).toBe("done");
  });

  posixOnly("applies no timeout when timeoutMs is 0", async () => {
    const result = await runCommand("sh", ["-c", "sleep 0.2; echo done"], { timeoutMs: 0 });
    expect(result.stdout.trim()).toBe("done");
  });
});

describe("runCommand git environment", () => {
  const printEnv = ["-c", "alias.printenv=!env", "printenv"];

  posixOnly("refuses terminal and ssh prompts so a missing key fails fast", async () => {
    const { stdout } = await runCommand("git", printEnv, {
      env: { PATH: process.env.PATH },
    });
    expect(stdout).toContain("GIT_TERMINAL_PROMPT=0\n");
    expect(stdout).toContain("SSH_ASKPASS=/usr/bin/false\n");
    expect(stdout).toContain("SSH_ASKPASS_REQUIRE=force\n");
  });

  posixOnly("keeps an askpass the caller or user configured", async () => {
    const { stdout } = await runCommand("git", printEnv, {
      env: { PATH: process.env.PATH, SSH_ASKPASS: "/opt/custom-askpass" },
    });
    expect(stdout).toContain("SSH_ASKPASS=/opt/custom-askpass\n");
    expect(stdout).not.toContain("SSH_ASKPASS_REQUIRE=");
  });

  posixOnly("keeps an explicit GIT_TERMINAL_PROMPT", async () => {
    const { stdout } = await runCommand("git", printEnv, {
      env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "1" },
    });
    expect(stdout).toContain("GIT_TERMINAL_PROMPT=1\n");
  });

  posixOnly("does not change the environment of other programs", async () => {
    const { stdout } = await runCommand("env", [], { env: { PATH: process.env.PATH } });
    expect(stdout).not.toContain("SSH_ASKPASS");
    expect(stdout).not.toContain("GIT_TERMINAL_PROMPT");
  });
});
