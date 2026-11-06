import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { observeCommandInvocations } from "./command-capture.js";
import { withEnvironmentDraining } from "./container-readiness.js";
import { CONTAINER_ROOT_PATH, CONTAINER_TERMINAL_CLOSE_SCRIPT } from "./container-scripts.js";
import {
  closeContainerTerminalShell,
  containerTerminalCloseArgs,
  newContainerTerminalToken,
} from "./container-terminal-shell.js";

// The close-script case starts real `sleep` and `sh` processes.
setDefaultTimeout(30_000);

const spawned: Bun.Subprocess[] = [];

afterEach(async () => {
  // Only the processes this file started, through their own handles.
  for (const child of spawned.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
});

describe("container terminal close", () => {
  test("runs the close script as the terminal's own user with the token as an argument", () => {
    const token = newContainerTerminalToken();
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
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
    "HUPs every process carrying the token, in any process group, and nothing else",
    async () => {
      const token = newContainerTerminalToken();
      const start = (env: Record<string, string>, detached: boolean) => {
        const child = Bun.spawn(["sleep", "300"], {
          env: { ...process.env, ...env },
          stdio: ["ignore", "ignore", "ignore"],
          ...(detached ? { detached: true } : {}),
        });
        spawned.push(child);
        return child;
      };
      const job = start({ ORKESTRATOR_TERMINAL_SESSION: token }, false);
      const ownGroup = start({ ORKESTRATOR_TERMINAL_SESSION: token }, true);
      const other = start({ ORKESTRATOR_TERMINAL_SESSION: newContainerTerminalToken() }, false);
      const unmarked = start({}, false);

      const close = Bun.spawn(
        ["sh", "-c", CONTAINER_TERMINAL_CLOSE_SCRIPT, "orkestrator-terminal-close", token],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(await close.exited).toBe(0);
      expect(await new Response(close.stdout).text()).toBe("");

      await Promise.all([job.exited, ownGroup.exited]);
      expect(job.signalCode).toBe("SIGHUP");
      expect(ownGroup.signalCode).toBe("SIGHUP");
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
      expect(unmarked.exitCode).toBeNull();
      expect(unmarked.signalCode).toBeNull();
    },
  );

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
