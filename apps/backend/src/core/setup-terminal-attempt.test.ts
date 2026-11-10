import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fakePid } from "@orkestrator/protocol/testing/fake-pids";

import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { spawnSetupTerminal } from "./commands-environment.js";
import {
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  environmentLifecycleErrorMessage,
  setupScriptFailedError,
} from "./commands-error-text.js";
import {
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
  retireFinishedSetupTerminal,
} from "./setup-terminal-attempt.js";
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

/** A PTY that exits when terminated, delivering its exit event as a real one does. */
function fakeSetupPty(pid: number, options: { deliverExit?: boolean } = {}) {
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  let terminated = false;
  const pty = {
    pid,
    onExit: (callback: (event: PtyExitEvent) => void) => {
      exitListeners.add(callback);
      return { dispose: () => exitListeners.delete(callback) };
    },
    terminate: async () => {
      terminated = true;
      if (options.deliverExit !== false) {
        for (const listener of Array.from(exitListeners)) listener({ exitCode: 0 });
      }
      return true;
    },
  } as unknown as PtyProcess;
  return { pty, wasTerminated: () => terminated, listenerCount: () => exitListeners.size };
}

describe("retireFinishedSetupTerminal", () => {
  test("does nothing when no terminal is registered", async () => {
    const terminals = new TerminalRuntime();
    expect(await retireFinishedSetupTerminal("e1:setup", terminals)).toBe(false);
    terminals.shutdown();
  });

  test("terminates the previous run's terminal and unregisters it", async () => {
    const terminals = new TerminalRuntime();
    const stale = fakeSetupPty(fakePid(10));
    terminals.registerProcess("e1:setup", stale.pty);
    expect(await retireFinishedSetupTerminal("e1:setup", terminals)).toBe(true);
    expect(stale.wasTerminated()).toBe(true);
    expect(terminals.process("e1:setup")).toBeUndefined();
    expect(stale.listenerCount()).toBe(0);
    terminals.shutdown();
  });

  test("unregisters a terminal whose exit never arrives, after a bounded wait", async () => {
    const terminals = new TerminalRuntime();
    const stale = fakeSetupPty(fakePid(11), { deliverExit: false });
    terminals.registerProcess("e1:setup", stale.pty);
    expect(await retireFinishedSetupTerminal("e1:setup", terminals, { exitWaitMs: 10 })).toBe(true);
    expect(terminals.process("e1:setup")).toBeUndefined();
    expect(stale.listenerCount()).toBe(0);
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
