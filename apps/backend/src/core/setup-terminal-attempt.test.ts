import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";

import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import {
  containerSetupShellCommand,
  settleTerminalProcessExit,
  spawnSetupTerminal,
} from "./commands-environment.js";
import {
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  environmentLifecycleErrorMessage,
  setupScriptFailedError,
} from "./commands-error-text.js";
import {
  CONTAINER_TERMINAL_PID_RECORD_COMMAND,
  SETUP_DONE_OSC_SEQUENCE,
  SETUP_FAILED_OSC_SEQUENCE,
  SETUP_FAILURE_REASONS,
  setupFailureReasonOscSequence,
} from "./container-scripts.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { PtyExitEvent, PtyProcess } from "./pty.js";
import { createPreviewHarness } from "./preview-test-support.js";
import {
  createSetupCompletionTracker,
  isRetiredSetupTerminal,
  retireFinishedSetupTerminal,
  SetupTerminalStillRunningError,
} from "./setup-terminal-attempt.js";
import type { ContainerTerminalShell } from "./container-terminal-shell.js";
import { TerminalRuntime } from "./terminal-runtime.js";

const ROOT_REASON = setupFailureReasonOscSequence("root-steps-need-full-network");

describe("setup completion tracker", () => {
  test("a failure with no reason marker has no reason", async () => {
    const tracker = createSetupCompletionTracker();
    tracker.onData(`output${SETUP_FAILED_OSC_SEQUENCE}`);
    expect(await tracker.completion).toBe(false);
    expect(tracker.failureReason()).toBeUndefined();
  });

  test("records the reason the script printed before it failed, in one chunk", async () => {
    const tracker = createSetupCompletionTracker();
    tracker.onData(`Root setup steps cannot run${ROOT_REASON}${SETUP_FAILED_OSC_SEQUENCE}`);
    expect(await tracker.completion).toBe(false);
    expect(tracker.failureReason()).toBe("root-steps-need-full-network");
  });

  test("records a reason marker split across two reads", async () => {
    const tracker = createSetupCompletionTracker();
    const split = Math.floor(ROOT_REASON.length / 2);
    tracker.onData(`before${ROOT_REASON.slice(0, split)}`);
    tracker.onData(`${ROOT_REASON.slice(split)}after`);
    tracker.onData(SETUP_FAILED_OSC_SEQUENCE);
    expect(await tracker.completion).toBe(false);
    expect(tracker.failureReason()).toBe("root-steps-need-full-network");
  });

  test("ignores a reason marker printed after the run settled", async () => {
    const tracker = createSetupCompletionTracker();
    tracker.onData(SETUP_DONE_OSC_SEQUENCE);
    tracker.onData(ROOT_REASON);
    expect(await tracker.completion).toBe(true);
    expect(tracker.failureReason()).toBeUndefined();
  });
});

describe("setup failure messages", () => {
  test("a named reason gets its own message; an unnamed one the generic message", () => {
    expect(environmentLifecycleErrorMessage(setupScriptFailedError())).toBe(
      ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript,
    );
    const root = environmentLifecycleErrorMessage(
      setupScriptFailedError("root-steps-need-full-network"),
    );
    expect(root).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.rootSetupNeedsFullNetwork);
    expect(root).toContain("full network access");
    expect(root).toContain('"root"');
  });

  test("each declared-package reason gets its own message (to-do 7770)", () => {
    const messages = {
      "apt-packages-refused": ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.aptPackagesRefused,
      "apt-packages-unsupported-runtime":
        ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.aptPackagesUnsupportedRuntime,
      "apt-packages-archive-unreachable":
        ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.aptPackagesArchiveUnreachable,
      "apt-packages-install-failed": ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.aptPackagesInstallFailed,
    } as const;
    for (const [reason, message] of Object.entries(messages)) {
      expect(
        environmentLifecycleErrorMessage(setupScriptFailedError(reason as keyof typeof messages)),
      ).toBe(message);
      expect(message).toContain("aptPackages");
    }
    expect(messages["apt-packages-archive-unreachable"]).toContain("deb.debian.org");
  });

  test("an unknown reason value falls back to the generic message", () => {
    const forged = Object.assign(new Error("Setup script failed"), {
      setupFailureReason: "anything-else",
    });
    expect(environmentLifecycleErrorMessage(forged)).toBe(
      ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript,
    );
  });

  test("workspace-setup.sh prints exactly the marker the backend reads, for every reason", () => {
    const script = readFileSync(
      path.join(import.meta.dir, "..", "..", "..", "..", "docker", "workspace-setup.sh"),
      "utf8",
    );
    for (const reason of SETUP_FAILURE_REASONS) {
      expect(script).toContain(`printf '\\033]9999;setup_failure_reason=${reason}\\007'`);
    }
  });
});

type FakeTermination = "exits" | "exits-silently" | "survives" | "rejects";

/**
 * A setup PTY. By default it exits when terminated and delivers its exit
 * event as a real one does; `exits-silently` withholds the event (delivered
 * later with `deliverExit`), `survives` reports that descendants outlived
 * termination, and `rejects` fails the termination outright.
 */
function fakeSetupPty(pid: number, termination: FakeTermination = "exits") {
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  let terminated = false;
  const deliverExit = () => {
    for (const listener of Array.from(exitListeners)) listener({ exitCode: 0 });
  };
  const pty = {
    pid,
    onExit: (callback: (event: PtyExitEvent) => void) => {
      exitListeners.add(callback);
      return { dispose: () => exitListeners.delete(callback) };
    },
    terminate: async () => {
      terminated = true;
      if (termination === "rejects") throw new Error("terminate failed");
      if (termination === "exits") deliverExit();
      return termination !== "survives";
    },
    kill: () => undefined,
  } as unknown as PtyProcess;
  return { pty, wasTerminated: () => terminated, deliverExit };
}

/** A terminal runtime whose container-shell closes are recorded, not run. */
function recordingTerminals() {
  const closes: ContainerTerminalShell[] = [];
  const terminals = new TerminalRuntime({
    closeContainerShell: async (shell) => {
      closes.push(shell);
    },
  });
  return { terminals, closes };
}

const SHELL: ContainerTerminalShell = { containerId: "c1", token: "aa--bb" };

describe("retireFinishedSetupTerminal", () => {
  test("does nothing when no terminal is registered", async () => {
    const terminals = new TerminalRuntime();
    expect(await retireFinishedSetupTerminal("e1:setup", terminals)).toBe(false);
    terminals.shutdown();
  });

  test("terminates the previous run's terminal, unregisters it and completes its history", async () => {
    const { terminals, closes } = recordingTerminals();
    const complete = spyOn(terminals.history, "complete");
    const stale = fakeSetupPty(fakePid(10));
    terminals.registerProcess("e1:setup", stale.pty);
    expect(await retireFinishedSetupTerminal("e1:setup", terminals)).toBe(true);
    expect(stale.wasTerminated()).toBe(true);
    expect(isRetiredSetupTerminal(stale.pty)).toBe(true);
    expect(terminals.process("e1:setup")).toBeUndefined();
    expect(complete).toHaveBeenCalledWith("e1:setup");
    expect(closes).toEqual([]);
    terminals.shutdown();
  });

  test("ends the container shell the previous run started, and waits for it", async () => {
    let finishClose!: () => void;
    let closeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const closes: ContainerTerminalShell[] = [];
    const terminals = new TerminalRuntime({
      closeContainerShell: (shell) => {
        closes.push(shell);
        closeStarted();
        return new Promise<void>((resolve) => {
          finishClose = resolve;
        });
      },
    });
    const stale = fakeSetupPty(fakePid(12));
    terminals.registerProcess("e1:setup", stale.pty);
    terminals.recordContainerShell("e1:setup", SHELL);
    let retired = false;
    const retirement = retireFinishedSetupTerminal("e1:setup", terminals).then((result) => {
      retired = result;
    });
    await started;
    // Cleaning up the session did not close it a second time, and the
    // retirement has not admitted a new run while the close is in flight.
    expect(closes).toEqual([SHELL]);
    expect(retired).toBe(false);
    finishClose();
    await retirement;
    expect(retired).toBe(true);
    expect(terminals.containerShell("e1:setup")).toBeUndefined();
    terminals.shutdown();
  });

  test("unregisters a terminal whose exit event never arrives once its tree is gone", async () => {
    const { terminals } = recordingTerminals();
    const stale = fakeSetupPty(fakePid(11), "exits-silently");
    terminals.registerProcess("e1:setup", stale.pty);
    expect(await retireFinishedSetupTerminal("e1:setup", terminals)).toBe(true);
    expect(terminals.process("e1:setup")).toBeUndefined();
    terminals.shutdown();
  });

  for (const termination of ["survives", "rejects"] as const) {
    test(`keeps the old terminal and refuses the retry when termination ${termination}`, async () => {
      const { terminals, closes } = recordingTerminals();
      const complete = spyOn(terminals.history, "complete");
      const stale = fakeSetupPty(fakePid(13), termination);
      terminals.registerProcess("e1:setup", stale.pty);
      terminals.recordContainerShell("e1:setup", SHELL);
      const error = await retireFinishedSetupTerminal("e1:setup", terminals).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SetupTerminalStillRunningError);
      expect(environmentLifecycleErrorMessage(error)).toBe(
        ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupStillRunning,
      );
      expect(terminals.process("e1:setup")).toBe(stale.pty);
      expect(terminals.containerShell("e1:setup")).toEqual(SHELL);
      expect(isRetiredSetupTerminal(stale.pty)).toBe(false);
      expect(complete).not.toHaveBeenCalled();
      expect(closes).toEqual([]);
      terminals.shutdown();
    });
  }

  test("a retry whose old tree survives spawns no replacement", async () => {
    const harness = await createPreviewHarness();
    const runtime = new BackendRuntime({ emit: () => undefined });
    try {
      await harness.addLocalEnvironment("a");
      await harness.storage.updateEnvironment("a", { worktreePath: harness.dir });
      const environment = (await harness.storage.getEnvironment("a"))!;
      const context = {
        storage: harness.storage,
        runtime,
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        toolchainBinDir: "",
        environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
      } as CommandContext;
      const stale = fakeSetupPty(fakePid(14), "survives");
      runtime.terminals.registerProcess("a:setup", stale.pty);
      await expect(spawnSetupTerminal(environment, ["true"], context)).rejects.toBeInstanceOf(
        SetupTerminalStillRunningError,
      );
      expect(runtime.terminals.process("a:setup")).toBe(stale.pty);
    } finally {
      runtime.terminals.cleanupSession("a:setup");
      runtime.shutdown();
      await harness.cleanup();
    }
  });
});

describe("a setup terminal's exit", () => {
  function exitRuntime() {
    const { terminals } = recordingTerminals();
    return {
      terminals,
      complete: spyOn(terminals.history, "complete"),
      cleanup: spyOn(terminals, "cleanupSession"),
    };
  }

  test("completes the history and unregisters the session it still owns", () => {
    const { terminals, complete, cleanup } = exitRuntime();
    const own = fakeSetupPty(fakePid(20));
    terminals.registerProcess("e1:setup", own.pty);
    let hooked = 0;
    settleTerminalProcessExit("e1:setup", own.pty, { exitCode: 0 }, terminals, {
      onExit: () => hooked++,
    });
    expect(hooked).toBe(1);
    expect(complete).toHaveBeenCalledWith("e1:setup");
    expect(cleanup).toHaveBeenCalledWith("e1:setup");
    expect(terminals.process("e1:setup")).toBeUndefined();
    terminals.shutdown();
  });

  test("leaves a replacement registered under the same id alone", () => {
    const { terminals, complete, cleanup } = exitRuntime();
    const old = fakeSetupPty(fakePid(21));
    const replacement = fakeSetupPty(fakePid(22));
    terminals.registerProcess("e1:setup", replacement.pty);
    let hooked = 0;
    settleTerminalProcessExit("e1:setup", old.pty, { exitCode: 0 }, terminals, {
      onExit: () => hooked++,
    });
    expect(hooked).toBe(1);
    expect(complete).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(terminals.process("e1:setup")).toBe(replacement.pty);
    terminals.shutdown();
  });

  test("a retired terminal's late exit during the replacement's preflight touches nothing", async () => {
    const { terminals, complete, cleanup } = exitRuntime();
    const old = fakeSetupPty(fakePid(23), "exits-silently");
    terminals.registerProcess("e1:setup", old.pty);
    expect(await retireFinishedSetupTerminal("e1:setup", terminals)).toBe(true);
    complete.mockClear();
    cleanup.mockClear();
    // The replacement has configured its history but registered no PTY yet.
    expect(terminals.process("e1:setup")).toBeUndefined();
    let hooked = 0;
    settleTerminalProcessExit("e1:setup", old.pty, { exitCode: 0 }, terminals, {
      onExit: () => hooked++,
    });
    expect(hooked).toBe(1);
    expect(complete).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    // And once the replacement registers, a still later exit leaves it too.
    const replacement = fakeSetupPty(fakePid(24));
    terminals.registerProcess("e1:setup", replacement.pty);
    old.deliverExit();
    settleTerminalProcessExit("e1:setup", old.pty, { exitCode: 0 }, terminals);
    expect(terminals.process("e1:setup")).toBe(replacement.pty);
    expect(complete).not.toHaveBeenCalled();
    terminals.shutdown();
  });
});

describe("setup retry", () => {
  test.skipIf(process.platform === "win32")(
    "a retry after a failed run runs its commands in a new terminal and settles",
    async () => {
      const harness = await createPreviewHarness();
      const runtime = new BackendRuntime({ emit: () => undefined });
      const originalShell = process.env.SHELL;
      // The setup command ends in `exec <shell> -l`; a plain sh keeps the host
      // user's interactive configuration out of the test.
      process.env.SHELL = "/bin/sh";
      try {
        await harness.addLocalEnvironment("a");
        await harness.storage.updateEnvironment("a", { worktreePath: harness.dir });
        const environment = (await harness.storage.getEnvironment("a"))!;
        const context = {
          storage: harness.storage,
          runtime,
          emit: () => undefined,
          appRoot: "",
          resourceRoot: "",
          toolchainBinDir: "",
          environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
        } as CommandContext;

        const failed = await spawnSetupTerminal(environment, ["false"], context);
        expect(await failed.completion).toBe(false);
        // The failed run's terminal stays open at the shell prompt.
        const stale = runtime.terminals.process(failed.sessionId)!;
        expect(stale).toBeDefined();

        const retried = await spawnSetupTerminal(environment, ["true"], context);
        expect(retried.sessionId).toBe(failed.sessionId);
        expect(await retried.completion).toBe(true);
        const fresh = runtime.terminals.process(retried.sessionId)!;
        expect(fresh).toBeDefined();
        expect(fresh).not.toBe(stale);
        expect(fresh.pid).not.toBe(stale.pid);
      } finally {
        if (originalShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = originalShell;
        await runtime.terminals.terminateSessionsForEnvironment("a");
        runtime.shutdown();
        await harness.cleanup();
      }
    },
    20_000,
  );
});

describe("container setup shell", () => {
  test("records the shell under its token, then execs a login zsh running the setup in place", () => {
    const command = containerSetupShellCommand("(echo 'it''s') && printf done; exec zsh -l");
    const lines = command.split("\n");
    expect(command.startsWith(CONTAINER_TERMINAL_PID_RECORD_COMMAND)).toBe(true);
    expect(lines.at(-1)).toMatch(/^exec zsh -lc '/);
  });

  test.skipIf(process.platform === "win32")(
    "runs the setup command unchanged in the exec'd shell, in the recorded process",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "ork-setup-shell-"));
      try {
        // A stand-in `zsh` that runs the `-lc` script with sh and prints its PID.
        writeFileSync(
          path.join(dir, "zsh"),
          '#!/bin/sh\n[ "$1" = "-lc" ] || exit 64\necho "pid=$$"\nexec /bin/sh -c "$2"\n',
          { mode: 0o755 },
        );
        const script = `echo "bash=$$"\n${containerSetupShellCommand('echo "it\'s set up"')}`;
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
        // No token: the record step is skipped, so nothing is written to /tmp.
        delete env.ORKESTRATOR_TERMINAL_SESSION;
        const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("it's set up");
        const bashPid = /bash=(\d+)/.exec(result.stdout)?.[1];
        expect(bashPid).toBeDefined();
        expect(result.stdout).toContain(`pid=${bashPid}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
