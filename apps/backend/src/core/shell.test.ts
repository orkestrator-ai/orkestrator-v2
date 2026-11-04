import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import * as captureFs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CommandFailedError,
  commandInvocationCount,
  observeCommandInvocations,
  runCommand,
  runCommandBuffer,
} from "./shell.js";

const posixOnly = process.platform === "win32" ? test.skip : test;
const darwinOnly = process.platform === "darwin" ? test : test.skip;

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
          { timeoutMs: 400, waitForDescendants: true },
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
        { timeoutMs: 400, waitForDescendants: true },
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
          { timeoutMs: 400, waitForDescendants: true },
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

  posixOnly("reports each invocation's arguments to an observer until it stops", async () => {
    const seen: string[][] = [];
    const stop = observeCommandInvocations("sh", (args) => seen.push([...args]));
    await runCommand("sh", ["-c", "true"], { timeoutMs: 5_000 });
    stop();
    await runCommand("sh", ["-c", "exit 0"], { timeoutMs: 5_000 });
    expect(seen).toEqual([["-c", "true"]]);
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
      ["-e", 'console.log("secret-value"); console.error("secret-value"); process.exit(7)'],
      { redactValues: ["secret-value"] },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).message).toBe("[REDACTED]");
    expect((failure as CommandFailedError).stdout).toBe("[REDACTED]\n");
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

  // Bun's pipe readers can miss EOF, through Bun.spawn and child_process alike, so a
  // child that already exited looked unfinished until its timeout (flake case 1537).
  test("captures output through files, so completion needs no pipe reader", async () => {
    const launch = spyOn(Bun, "spawn");
    try {
      expect((await runCommand(process.execPath, ["-e", "console.log('ok')"])).stdout).toBe("ok\n");
      const [, options] = launch.mock.calls[0] as unknown as [string[], Record<string, unknown>];
      expect(options.stdout).toBeTypeOf("number");
      expect(options.stderr).toBeTypeOf("number");
    } finally {
      launch.mockRestore();
    }
  });

  posixOnly("keeps no capture file on disk and no descriptor open", async () => {
    const original = process.env.TMPDIR;
    const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-shell-test-"));
    process.env.TMPDIR = directory;
    try {
      const before = readdirSync("/dev/fd").length;
      const listed = await runCommand("sh", ["-c", 'ls -A "$1"; echo done', "sh", directory]);
      expect(listed.stdout).toBe("done\n");
      for (let index = 0; index < 8; index += 1) {
        await runCommand("sh", ["-c", "exit 3"]).catch(() => undefined);
        await runCommand("orkestrator-nonexistent-shell-test-command").catch(() => undefined);
        await runCommand("sh", ["-c", "sleep 5"], { timeoutMs: 20 }).catch(() => undefined);
      }
      expect(readdirSync("/dev/fd").length).toBe(before);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
      await rm(directory, { recursive: true, force: true });
    }
  });

  posixOnly("does not report an unusable temporary directory as a missing executable", async () => {
    const original = process.env.TMPDIR;
    process.env.TMPDIR = path.join(os.tmpdir(), "orkestrator-shell-test-missing-directory");
    try {
      const failure = await runCommand("sh", ["-c", "true"]).catch((error: unknown) => error);
      expect((failure as Error).message).toContain("temporary directory: ENOENT");
      expect((failure as CommandFailedError).executableMissing).toBeFalsy();
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
    }
  });

  posixOnly("keeps each concurrent command's streams apart", async () => {
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        runCommand("sh", ["-c", 'echo "out $1"; echo "err $1" >&2', "sh", String(index)]),
      ),
    );
    results.forEach((result, index) => {
      expect(result).toEqual({ stdout: `out ${index}\n`, stderr: `err ${index}\n` });
    });
  });

  // Bun can lose a macOS child's exit and leave it a zombie (flake case 1537). This
  // keeps `exited` pending and answers `ps` as that zombie would. The timer is scaled.
  for (const [status, expectedCode] of [
    ["0", 0],
    ["300", 3],
  ] as const) {
    darwinOnly(`settles a lost exit from the zombie's status (${status})`, async () => {
      let nativeChild: ReturnType<typeof Bun.spawn>;
      const realSpawn = Bun.spawn;
      const realSpawnSync = Bun.spawnSync;
      const realSetTimeout = globalThis.setTimeout;
      const spawned = spyOn(Bun, "spawn").mockImplementation(
        ((...launch: [string[], object]) =>
          new Proxy((nativeChild = realSpawn(...launch)), {
            get(target, key) {
              if (key === "exited") return new Promise(() => undefined);
              const value = Reflect.get(target, key) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          })) as unknown as typeof Bun.spawn,
      );
      const spawnedSync = spyOn(Bun, "spawnSync").mockImplementation(((
        command: string[],
        ...rest: []
      ) =>
        command.includes("stat=,xstat=")
          ? {
              stdout: Buffer.from(nativeChild.exitCode === null ? "" : `Z ${status}\n`),
              success: true,
            }
          : realSpawnSync(command, ...rest)) as unknown as typeof Bun.spawnSync);
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: Parameters<typeof setTimeout>[0],
        delay: Parameters<typeof setTimeout>[1],
        ...args: unknown[]
      ) => realSetTimeout(callback, delay === 1_000 ? 1 : delay, ...args)) as typeof setTimeout);
      try {
        const outcome = await runCommand("sh", ["-c", "echo captured"]).catch(
          (error: unknown) => error,
        );
        if (expectedCode === 0) {
          expect(outcome).toEqual({ stdout: "captured\n", stderr: "" });
        } else {
          expect(outcome).toBeInstanceOf(CommandFailedError);
          expect((outcome as CommandFailedError).exitCode).toBe(expectedCode);
          expect((outcome as CommandFailedError).timedOut).toBe(false);
          expect((outcome as CommandFailedError).stdout).toBe("captured\n");
        }
      } finally {
        timer.mockRestore();
        spawnedSync.mockRestore();
        spawned.mockRestore();
      }
    });
  }

  posixOnly("gives a command with no payload a closed pipe, not /dev/null", async () => {
    const { stdout } = await runCommand("sh", [
      "-c",
      "if [ -p /dev/stdin ] || [ -S /dev/stdin ]; then echo pipe; fi; cat; echo eof",
    ]);
    expect(stdout).toBe("pipe\neof\n");
  });

  posixOnly("waits for a descendant holding the pipes and keeps its output", async () => {
    const { stdout } = await runCommand("sh", ["-c", "(sleep 0.2; echo late) & echo early"], {
      waitForDescendants: true,
    });
    expect(stdout).toBe("early\nlate\n");
  });

  posixOnly("reports a fatal signal without an exit code", async () => {
    const failure = await runCommand("sh", ["-c", "kill -KILL $$"]).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).exitCode).toBeNull();
    expect((failure as CommandFailedError).signal).toBe("SIGKILL");
    expect((failure as CommandFailedError).timedOut).toBe(false);
  });

  test("leaves an undefined environment value unset and refuses a NUL argument", async () => {
    const { stdout } = await runCommand("sh", ["-c", 'echo "[${SHELL_TEST_VALUE-unset}]"'], {
      env: { PATH: process.env.PATH, SHELL_TEST_VALUE: undefined },
    });
    expect(stdout).toBe("[unset]\n");
    await expect(runCommand("sh", ["-c", "true", "a\0b"])).rejects.toThrow("null bytes");
  });

  test("reports a missing working directory as a failure to start", async () => {
    const failure = await runCommand("sh", ["-c", "true"], {
      cwd: path.join(os.tmpdir(), "orkestrator-shell-test-missing-directory"),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).executableMissing).toBe(true);
  });
});

posixOnly("AbortSignal cancels a command without waiting for its independent timeout", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = runCommandBuffer("sh", ["-c", "sleep 30"], {
    signal: controller.signal,
    timeoutMs: 30_000,
  });
  const timer = setTimeout(() => controller.abort(), 40);
  try {
    const result = await running.catch((error) => error);
    expect(result).toBeInstanceOf(CommandFailedError);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
});

posixOnly("applies the overall deadline to a surviving git descendant", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-shell-test-"));
  try {
    const pidFile = path.join(tempDir, "descendant.pid");
    const started = Date.now();
    const failure = await runCommand(
      "git",
      ["-c", `alias.hold=!sleep 30 & echo $! > '${pidFile}'`, "hold"],
      { timeoutMs: 300, waitForDescendants: true },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await waitUntilGone(Number((await readFile(pidFile, "utf8")).trim()))).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

posixOnly("captures late git descendant output when explicitly requested", async () => {
  const { stdout } = await runCommand(
    "git",
    ["-c", "alias.late=!(sleep 0.2; echo late) & exit 0", "late"],
    {
      waitForDescendants: true,
    },
  );
  expect(stdout).toBe("late\n");
});

posixOnly("captures late non-git output when explicitly requested", async () => {
  const { stdout } = await runCommand("sh", ["-c", "(sleep 0.3; echo late) & exit 0"], {
    waitForDescendants: true,
  });
  expect(stdout).toBe("late\n");
});

describe("capture filesystem failures", () => {
  for (const stage of [
    "second open",
    "unlink",
    "read",
    "read on failure",
    "read on timeout",
    "stat",
    "stat while running",
  ] as const) {
    test(`rejects and closes all descriptors after ${stage} failure`, async () => {
      const opened: number[] = [];
      const paths: string[] = [];
      const closed: number[] = [];
      const originalOpen = captureFs.openSync;
      const originalClose = captureFs.closeSync;
      const open = spyOn(captureFs, "openSync").mockImplementation((...args) => {
        if (stage === "second open" && opened.length === 1) throw new Error("injected EMFILE");
        const fd = originalOpen(...args);
        opened.push(fd);
        paths.push(String(args[0]));
        return fd;
      });
      const close = spyOn(captureFs, "closeSync").mockImplementation((fd) => {
        closed.push(fd);
        originalClose(fd);
      });
      const fault =
        stage === "unlink"
          ? spyOn(captureFs, "unlinkSync").mockImplementation(() => {
              throw new Error("injected unlink");
            })
          : stage.startsWith("read")
            ? spyOn(captureFs, "readSync").mockImplementation(() => {
                throw new Error("injected EIO");
              })
            : stage.startsWith("stat")
              ? spyOn(captureFs, "fstatSync").mockImplementation(() => {
                  throw new Error("injected EIO");
                })
              : undefined;
      try {
        const script =
          stage.endsWith("timeout") || stage.endsWith("running")
            ? "echo output; exec sleep 30"
            : stage.endsWith("failure")
              ? "echo output; exit 1"
              : "echo output";
        await expect(runCommand("sh", ["-c", script], { timeoutMs: 500 })).rejects.toThrow();
        expect(opened.length).toBeGreaterThan(0);
        expect(closed.sort()).toEqual(opened.sort());
      } finally {
        fault?.mockRestore();
        close.mockRestore();
        open.mockRestore();
        for (const file of paths) await rm(file, { force: true });
      }
    });
  }
});

posixOnly("returns at leader exit and leaves a redirected same-group helper alive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ork-helper-"));
  const pidFile = path.join(directory, "pid");
  let pid = 0;
  try {
    await runCommand("sh", ["-c", 'sleep 30 >/dev/null 2>&1 & echo $! > "$1"', "sh", pidFile], {
      timeoutMs: 500,
    });
    pid = Number(await readFile(pidFile, "utf8"));
    expect(isRunning(pid)).toBe(true);
  } finally {
    if (pid) process.kill(pid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

darwinOnly(
  "unknown group inspection retains explicit waiting until the command deadline",
  async () => {
    const original = Bun.spawnSync;
    const inspection = spyOn(Bun, "spawnSync").mockImplementation(((
      args: string[],
      options: object,
    ) => {
      if (args[0] === "/bin/ps" && args.includes("-A"))
        return { success: false, stdout: Buffer.alloc(0) };
      return original(args, options);
    }) as typeof Bun.spawnSync);
    const realKill = process.kill;
    const kill = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => (signal === 0 ? true : realKill(pid, signal))) as typeof process.kill);
    try {
      const failure = await runCommand("sh", ["-c", "exit 0"], {
        waitForDescendants: true,
        timeoutMs: 50,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CommandFailedError);
      expect((failure as CommandFailedError).timedOut).toBe(true);
    } finally {
      kill.mockRestore();
      inspection.mockRestore();
    }
  },
);

posixOnly(
  "worktree add captures a background post-checkout writer when explicitly requested",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-shell-hook-"));
    try {
      const repo = path.join(root, "repo");
      await runCommand("git", ["init", "-b", "main", repo]);
      await runCommand("git", [
        "-C",
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ]);
      await writeFile(
        path.join(repo, ".git", "hooks", "post-checkout"),
        "#!/bin/sh\n(sleep 0.2; echo hook-finished) &\nexit 0\n",
        { mode: 0o755 },
      );
      const result = await runCommand(
        "git",
        ["-C", repo, "worktree", "add", "-b", "feature", path.join(root, "tree")],
        { waitForDescendants: true, timeoutMs: 5000 },
      );
      expect(result.stderr).toContain("hook-finished");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
