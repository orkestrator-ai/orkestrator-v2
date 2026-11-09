import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeCommandInvocations, runCommand } from "./command-capture.js";
import { withEnvironmentDraining } from "./container-readiness.js";
import {
  CONTAINER_ROOT_PATH,
  CONTAINER_TERMINAL_CLOSE_SCRIPT,
  CONTAINER_TERMINAL_PID_RECORD_COMMAND,
  CONTAINER_TERMINAL_PID_DIR_PREFIX,
} from "./container-scripts.js";
import {
  closeContainerTerminalShell,
  containerTerminalCloseArgs,
  newContainerTerminalToken,
} from "./container-terminal-shell.js";

// The close-script case starts real `sleep` and `sh` processes.
setDefaultTimeout(30_000);

const spawned: Bun.Subprocess[] = [];
const directories: string[] = [];
function scripts() {
  const root = mkdtempSync(join(tmpdir(), "terminal-record-test-"));
  directories.push(root);
  const prefix = join(root, "records-");
  const dir = `${prefix}${process.getuid!()}`;
  mkdirSync(dir, { mode: 0o700 });
  return {
    dir,
    close: CONTAINER_TERMINAL_CLOSE_SCRIPT.replaceAll(CONTAINER_TERMINAL_PID_DIR_PREFIX, prefix),
    record: CONTAINER_TERMINAL_PID_RECORD_COMMAND.replaceAll(
      CONTAINER_TERMINAL_PID_DIR_PREFIX,
      prefix,
    ),
  };
}
async function sessionId(pid: number) {
  const child = Bun.spawn(["ps", "-o", "sid=", "-p", String(pid)], { stdout: "pipe" });
  const sid = (await new Response(child.stdout).text()).trim();
  expect(await child.exited).toBe(0);
  return sid;
}
async function runScript(script: string, token: string) {
  const child = Bun.spawn(["sh", "-c", script, "terminal-test", token], {
    env: { ...process.env, ORKESTRATOR_TERMINAL_SESSION: token },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
}
function startSleep(token: string, detached = false) {
  const child = Bun.spawn(["sleep", "300"], {
    env: { ...process.env, ORKESTRATOR_TERMINAL_SESSION: token },
    stdio: ["ignore", "ignore", "ignore"],
    detached,
  });
  spawned.push(child);
  return child;
}

afterEach(async () => {
  // Only the processes this file started, through their own handles.
  for (const child of spawned.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("container terminal close", () => {
  test("runs the close script as the terminal's own user with the token as an argument", () => {
    const token = newContainerTerminalToken();
    expect(token).toMatch(/^[0-9a-f-]{36}--[0-9a-f-]{36}$/);
    expect(containerTerminalCloseArgs({ containerId: "container-1", user: "node", token })).toEqual(
      [
        "exec",
        "--user",
        "node",
        "container-1",
        "sh",
        "-c",
        CONTAINER_TERMINAL_CLOSE_SCRIPT,
        "orkestrator-terminal-close",
        token,
      ],
    );
    // A root terminal's close gets the fixed root PATH, as its launch does.
    expect(containerTerminalCloseArgs({ containerId: "c", user: "orkroot", token })).toEqual([
      "exec",
      "--env",
      `PATH=${CONTAINER_ROOT_PATH}`,
      "--user",
      "orkroot",
      "c",
      "sh",
      "-c",
      CONTAINER_TERMINAL_CLOSE_SCRIPT,
      "orkestrator-terminal-close",
      token,
    ]);
    // The image's default user when the tab names none.
    expect(containerTerminalCloseArgs({ containerId: "c", token }).slice(0, 3)).toEqual([
      "exec",
      "c",
      "sh",
    ]);
  });

  // The script reads /proc, so it runs only where there is one. It signals
  // nothing but processes carrying this test's random token.
  test.skipIf(!existsSync("/proc/self/environ"))(
    "HUPs token-bearing jobs in the recorded session and preserves detached sessions",
    async () => {
      const token = newContainerTerminalToken();
      const fixture = scripts();
      const job = startSleep(token);
      const detached = startSleep(token, true);
      const other = startSleep(newContainerTerminalToken());
      const sid = await sessionId(job.pid);
      expect(await sessionId(detached.pid)).not.toBe(sid);
      writeFileSync(join(fixture.dir, `${token}.pid`), `${job.pid} ${sid}\n`);
      await runScript(fixture.close, token);
      await job.exited;
      expect(job.signalCode).toBe("SIGHUP");
      expect(detached.exitCode).toBeNull();
      expect(other.exitCode).toBeNull();
      expect(existsSync(join(fixture.dir, `${token}.pid`))).toBe(false);
    },
  );

  test.skipIf(!existsSync("/proc/self/environ"))(
    "sweeps dead and mismatched records while preserving a valid live record",
    async () => {
      const fixture = scripts();
      const valid = newContainerTerminalToken();
      const live = startSleep(valid);
      const stale = newContainerTerminalToken();
      const mismatch = newContainerTerminalToken();
      writeFileSync(
        join(fixture.dir, `${valid}.pid`),
        `${live.pid} ${await sessionId(live.pid)}\n`,
      );
      // Beyond Linux pid_max: cannot refer to an unrelated host process.
      writeFileSync(join(fixture.dir, `${stale}.pid`), "999999999 999999999\n");
      writeFileSync(join(fixture.dir, `${mismatch}.pid`), `${live.pid}\n`);
      await runScript(fixture.record, newContainerTerminalToken());
      expect(existsSync(join(fixture.dir, `${valid}.pid`))).toBe(true);
      expect(existsSync(join(fixture.dir, `${stale}.pid`))).toBe(false);
      expect(existsSync(join(fixture.dir, `${mismatch}.pid`))).toBe(false);
      // A reused PID with another token must not authorize a group signal.
      writeFileSync(join(fixture.dir, `${mismatch}.pid`), `${live.pid}\n`);
      await runScript(fixture.close, mismatch);
      expect(live.exitCode).toBeNull();
      expect(existsSync(join(fixture.dir, `${mismatch}.pid`))).toBe(false);
    },
  );

  test.skipIf(!existsSync("/proc/self/environ"))(
    "uses the recorded session after the shell exits and skips an unknown session",
    async () => {
      const fixture = scripts();
      const token = newContainerTerminalToken();
      const job = startSleep(token);
      await runScript(fixture.close, token);
      expect(job.exitCode).toBeNull();
      writeFileSync(join(fixture.dir, `${token}.pid`), `999999999 ${await sessionId(job.pid)}\n`);
      await runScript(fixture.close, token);
      await job.exited;
      expect(job.signalCode).toBe("SIGHUP");
    },
  );

  test("tokens share a shell-safe process prefix but never a shell suffix", () => {
    const first = newContainerTerminalToken();
    const second = newContainerTerminalToken();
    expect(first.split("--")[0]).toBe(second.split("--")[0]);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]+$/);
    expect(CONTAINER_TERMINAL_PID_RECORD_COMMAND).not.toContain("'");
  });

  test.skipIf(!existsSync("/proc/self/environ"))(
    "a new backend closes old and legacy shells but preserves its own shells",
    async () => {
      const fixture = scripts();
      const currentToken = newContainerTerminalToken();
      const oldToken = `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa--${newContainerTerminalToken().split("--")[1]}`;
      const legacyToken = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const current = startSleep(currentToken);
      const old = startSleep(oldToken);
      const legacy = startSleep(legacyToken);
      for (const [token, child] of [
        [currentToken, current],
        [oldToken, old],
        [legacyToken, legacy],
      ] as const) {
        writeFileSync(
          join(fixture.dir, `${token}.pid`),
          `${child.pid} ${await sessionId(child.pid)}\n`,
        );
      }
      await runScript(fixture.record, newContainerTerminalToken());
      await Promise.all([old.exited, legacy.exited]);
      expect(old.signalCode).toBe("SIGHUP");
      expect(legacy.signalCode).toBe("SIGHUP");
      expect(current.exitCode).toBeNull();
      expect(existsSync(join(fixture.dir, `${oldToken}.pid`))).toBe(false);
      expect(existsSync(join(fixture.dir, `${currentToken}.pid`))).toBe(true);
    },
  );

  test("contains a failed docker exec and forwards its timeout and shutdown signal", async () => {
    const controller = new AbortController();
    let called = false;
    await closeContainerTerminalShell(
      { containerId: "failed-container", token: newContainerTerminalToken() },
      controller.signal,
      async (command, _args, options) => {
        called = true;
        expect(command).toBe("docker");
        expect(options?.timeoutMs).toBe(15_000);
        expect(options?.signal).toBe(controller.signal);
        return runCommand("sh", ["-c", "exit 7"], options);
      },
    );
    expect(called).toBe(true);
    let aborted = false;
    const pending = closeContainerTerminalShell(
      { containerId: "aborted-container", token: newContainerTerminalToken() },
      controller.signal,
      (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    controller.abort();
    await pending;
    expect(aborted).toBe(true);
  });

  test("leaves a container an explicit stop is draining to the drain", async () => {
    const dockerRuns: Array<readonly string[]> = [];
    const stopObserving = observeCommandInvocations("docker", (args) => dockerRuns.push(args));
    try {
      await withEnvironmentDraining(
        { beginDrain: () => () => undefined },
        "environment-draining",
        "container-draining",
        () =>
          closeContainerTerminalShell(
            { containerId: "container-draining", token: newContainerTerminalToken() },
            new AbortController().signal,
          ),
      );
    } finally {
      stopObserving();
    }
    expect(dockerRuns).toEqual([]);
  });
});
