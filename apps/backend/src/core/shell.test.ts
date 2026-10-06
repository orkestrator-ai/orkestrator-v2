import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CommandFailedError,
  commandInvocationCount,
  runCommand,
  runCommandBuffer,
} from "./shell.js";

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
  let groupPidFile: string | undefined;

  afterEach(async () => {
    // Fixtures publish their own group ID, so a failed assertion still cleans
    // up only processes owned by this test.
    if (groupPidFile) {
      const pid = Number(await readFile(groupPidFile, "utf8").catch(() => ""));
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
      }
    }
    groupPidFile = undefined;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  posixOnly("reports a timeout and stops processes the child started", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-shell-test-"));
    const pidFile = path.join(tempDir, "grandchild.pid");

    groupPidFile = path.join(tempDir, "parent.pid");
    // `git fetch` over ssh has this shape: the child starts a long-lived
    // subprocess of its own and waits on it.
    const failure = await runCommand(
      "sh",
      ["-c", 'echo $$ > "$1"; sleep 30 & echo $! > "$2"; wait', "sh", groupPidFile, pidFile],
      {
        timeoutMs: 400,
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).timedOut).toBe(true);

    const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(await waitUntilGone(grandchildPid)).toBe(true);
  });

  for (const parentExits of [false, true]) {
    posixOnly(
      `settles and escalates when a descendant ignores SIGTERM (parent exits: ${parentExits})`,
      async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-shell-test-"));
        groupPidFile = path.join(tempDir, "parent.pid");
        const pidFile = path.join(tempDir, "grandchild.pid");
        const started = Date.now();
        const failure = await runCommand(
          "sh",
          [
            "-c",
            `echo $$ > "$1"; sh -c 'trap "" TERM; exec sleep 30' & echo $! > "$2"; ${parentExits ? "exit 0" : "wait"}`,
            "sh",
            groupPidFile,
            pidFile,
          ],
          { timeoutMs: 400 },
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(CommandFailedError);
        expect((failure as CommandFailedError).timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(await waitUntilGone(Number(await readFile(pidFile, "utf8")))).toBe(true);
      },
    );
  }

  for (const psBehavior of ["exit 1", "sleep 30"]) {
    posixOnly(`cleans up without process enumeration (${psBehavior})`, async () => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-shell-test-"));
      groupPidFile = path.join(tempDir, "parent.pid");
      const pidFile = path.join(tempDir, "grandchild.pid");
      const psCalled = path.join(tempDir, "ps-called");
      await writeFile(
        path.join(tempDir, "ps"),
        `#!/bin/sh\necho called > "${psCalled}"\n${psBehavior}\n`,
        { mode: 0o755 },
      );
      const started = Date.now();
      const failure = await runCommand(
        "sh",
        ["-c", 'echo $$ > "$1"; sleep 30 & echo $! > "$2"; wait', "sh", groupPidFile, pidFile],
        { timeoutMs: 400, env: { ...process.env, PATH: `${tempDir}:${process.env.PATH}` } },
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CommandFailedError);
      expect((failure as CommandFailedError).timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await waitUntilGone(Number(await readFile(pidFile, "utf8")))).toBe(true);
      expect(await readFile(psCalled, "utf8").catch(() => "")).toBe("");
    });
  }

  posixOnly("signals only the owned group while descendants rapidly exit and restart", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-shell-test-"));
    groupPidFile = path.join(tempDir, "parent.pid");
    const decoy = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const originalKill = process.kill.bind(process);
    const signals: number[] = [];
    const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      signals.push(pid);
      return originalKill(pid, signal);
    });
    try {
      const failure = await runCommand(
        "sh",
        ["-c", 'echo $$ > "$1"; while :; do sleep 0.01 & wait; done', "sh", groupPidFile],
        { timeoutMs: 400 },
      ).catch((error: unknown) => error);
      expect((failure as CommandFailedError).timedOut).toBe(true);
      const rootPid = Number(await readFile(groupPidFile, "utf8"));
      expect(signals).toEqual([-rootPid, -rootPid]);
      expect(isRunning(decoy.pid!)).toBe(true);
    } finally {
      kill.mockRestore();
      decoy.kill("SIGKILL");
      await new Promise<void>((resolve) => decoy.once("close", () => resolve()));
    }
  });

  posixOnly(
    "settles even if group signaling fails and a descendant keeps the pipes open",
    async () => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-shell-test-"));
      groupPidFile = path.join(tempDir, "parent.pid");
      const originalKill = process.kill.bind(process);
      const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid < 0) throw new Error("group signal unavailable");
        return originalKill(pid, signal);
      });
      try {
        const started = Date.now();
        const failure = await runCommand(
          "sh",
          ["-c", 'echo $$ > "$1"; sleep 30 & exit 0', "sh", groupPidFile],
          { timeoutMs: 400 },
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CommandFailedError);
        expect((failure as CommandFailedError).timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        kill.mockRestore();
      }
    },
  );

  posixOnly("uses the 60-second default when timeoutMs is omitted", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
      delay: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ) =>
      originalSetTimeout(callback, delay === 60_000 ? 100 : delay, ...args)) as typeof setTimeout);
    try {
      const failure = await runCommand("sh", ["-c", "sleep 30"]).catch((error: unknown) => error);
      expect((failure as CommandFailedError).timedOut).toBe(true);
      expect(timer.mock.calls.some((call) => call[1] === 60_000)).toBe(true);
    } finally {
      timer.mockRestore();
    }
  });

  test("rejects invalid timeout values before spawning", async () => {
    const before = commandInvocationCount("invalid-timeout-command");
    for (const timeoutMs of [-1, NaN, Infinity, -Infinity, 0.5, 2_147_483_648]) {
      await expect(runCommand("invalid-timeout-command", [], { timeoutMs })).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    expect(commandInvocationCount("invalid-timeout-command")).toBe(before);
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
  const printEnv = [
    "-c",
    "alias.printenv=!env | grep -E '^(GIT_TERMINAL_PROMPT|SSH_ASKPASS|SSH_ASKPASS_REQUIRE)='",
    "printenv",
  ];

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
    expect(stdout).toContain("SSH_ASKPASS_REQUIRE=force\n");
  });

  for (const require of ["never", "prefer", "force", ""]) {
    posixOnly(
      `keeps an explicit SSH_ASKPASS_REQUIRE (${require}) and supplies a refusing program`,
      async () => {
        const { stdout } = await runCommand("git", printEnv, {
          env: { PATH: process.env.PATH, SSH_ASKPASS_REQUIRE: require },
        });
        expect(stdout).toContain(`SSH_ASKPASS_REQUIRE=${require}\n`);
        expect(stdout).toContain("SSH_ASKPASS=/usr/bin/false\n");
      },
    );
  }

  for (const { askpass, require } of [
    { askpass: "/opt/inherited-askpass", require: undefined },
    { askpass: "/opt/inherited-askpass", require: "never" },
    { askpass: undefined, require: "never" },
    { askpass: undefined, require: undefined },
  ]) {
    posixOnly(
      `inherits askpass settings when options.env is omitted (askpass: ${askpass}, require: ${require})`,
      async () => {
        const originalAskpass = process.env.SSH_ASKPASS;
        const originalRequire = process.env.SSH_ASKPASS_REQUIRE;
        try {
          if (askpass === undefined) delete process.env.SSH_ASKPASS;
          else process.env.SSH_ASKPASS = askpass;
          if (require === undefined) delete process.env.SSH_ASKPASS_REQUIRE;
          else process.env.SSH_ASKPASS_REQUIRE = require;
          const { stdout } = await runCommand("git", printEnv);
          expect(stdout).toContain(`SSH_ASKPASS=${askpass ?? "/usr/bin/false"}\n`);
          expect(stdout).toContain(`SSH_ASKPASS_REQUIRE=${require ?? "force"}\n`);
          expect(process.env.SSH_ASKPASS).toBe(askpass);
          expect(process.env.SSH_ASKPASS_REQUIRE).toBe(require);
        } finally {
          if (originalAskpass === undefined) delete process.env.SSH_ASKPASS;
          else process.env.SSH_ASKPASS = originalAskpass;
          if (originalRequire === undefined) delete process.env.SSH_ASKPASS_REQUIRE;
          else process.env.SSH_ASKPASS_REQUIRE = originalRequire;
        }
      },
    );
  }

  posixOnly(
    "uses configured askpass in a Git SSH transport even with a controlling terminal",
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-git-askpass-test-"));
      try {
        const key = path.join(tempDir, "key");
        const askpass = path.join(tempDir, "askpass");
        const called = path.join(tempDir, "askpass-called");
        const transport = path.join(tempDir, "transport.py");
        await runCommand("ssh-keygen", ["-q", "-t", "ed25519", "-N", "test-passphrase", "-f", key]);
        await writeFile(askpass, `#!/bin/sh\necho called >> "${called}"\nexit 1\n`, {
          mode: 0o755,
        });
        // Git invokes a local SSH transport which exercises OpenSSH's passphrase
        // reader under a real controlling PTY, without a network or credentials.
        // The helper owns and reaps its PTY child even if a regression prompts.
        await writeFile(
          transport,
          `import errno, os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execlp("ssh-keygen", "ssh-keygen", "-y", "-f", sys.argv[1])
output = b""
deadline = time.monotonic() + 2
try:
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.05)[0]:
            continue
        try:
            data = os.read(fd, 4096)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        output += data
        if b"Enter passphrase" in output:
            break
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    os.close(fd)
sys.stderr.buffer.write(output)
sys.exit(1)
`,
        );
        const failure = await runCommand(
          "git",
          [
            "-c",
            `core.sshCommand=python3 "${transport}" "${key}"`,
            "ls-remote",
            "ssh://example.invalid/repository",
          ],
          {
            timeoutMs: 4_000,
            env: { PATH: process.env.PATH, SSH_ASKPASS: askpass, GIT_SSH_VARIANT: "ssh" },
          },
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CommandFailedError);
        expect((failure as CommandFailedError).timedOut).toBe(false);
        expect((failure as CommandFailedError).message).not.toContain("Enter passphrase");
        expect(await readFile(called, "utf8")).toContain("called");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

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

// These exercise the capture boundary that replaced execFile, including binary
// output, redaction and non-timeout failures used by backend callers.
describe("runCommand capture", () => {
  test("preserves binary output and stdin", async () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    const result = await runCommandBuffer(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { stdin: bytes },
    );
    expect(result.stdout).toEqual(bytes);
    expect(result.stderr).toEqual(Buffer.alloc(0));
  });

  test("redacts output and preserves a nonzero exit outcome", async () => {
    const failure = await runCommand(
      process.execPath,
      ["-e", 'console.error("secret-value"); process.exit(7)'],
      { redactValues: ["secret-value"] },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).message).toBe("[REDACTED]");
    expect((failure as CommandFailedError).exitCode).toBe(7);
    expect((failure as CommandFailedError).timedOut).toBe(false);
  });

  test("redacts arguments in the fallback error when a command writes no output", async () => {
    const failure = await runCommand(process.execPath, ["-e", "process.exit(7)", "secret-value"], {
      redactValues: ["secret-value"],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).message).toContain("[REDACTED]");
    expect((failure as CommandFailedError).message).not.toContain("secret-value");
    expect((failure as CommandFailedError).exitCode).toBe(7);
    expect((failure as CommandFailedError).timedOut).toBe(false);
  });

  for (const stream of ["stdout", "stderr"]) {
    test(`bounds ${stream} capture and stops a process that exceeds the limit`, async () => {
      const started = Date.now();
      const failure = await runCommand(
        process.execPath,
        [
          "-e",
          `process.${stream}.write(Buffer.alloc(50 * 1024 * 1024 + 1, 120)); setInterval(() => {}, 1000)`,
        ],
        { timeoutMs: 3_000 },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CommandFailedError);
      expect((failure as CommandFailedError).timedOut).toBe(false);
      expect((failure as CommandFailedError).message.length).toBeLessThanOrEqual(50 * 1024 * 1024);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  }

  test("preserves the missing executable outcome", async () => {
    const failure = await runCommand("orkestrator-nonexistent-shell-test-command").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).executableMissing).toBe(true);
    expect((failure as CommandFailedError).timedOut).toBe(false);
  });
});
