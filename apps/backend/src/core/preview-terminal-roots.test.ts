import { describe, expect, test } from "bun:test";

import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { spawnSetupTerminal } from "./commands-environment.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { PtyProcess } from "./pty.js";
import { createPreviewHarness } from "./preview-test-support.js";
import { TerminalRuntime } from "./terminal-runtime.js";

const fakePty = (pid: number) => ({ pid }) as PtyProcess;

describe("preview terminal process roots", () => {
  test("only live local PTYs count, including after a stable session exits", () => {
    const terminals = new TerminalRuntime();
    const local = { kind: "local" as const, environmentId: "a", cols: 80, rows: 24 };
    terminals.rememberStableSession("local", local, "local\0a\0tab");
    terminals.rememberSession("container", {
      kind: "container",
      environmentId: "b",
      containerId: "c",
      cols: 80,
      rows: 24,
    });
    terminals.rememberSession("invalid", local);
    terminals.registerProcess("local", fakePty(100));
    terminals.registerProcess("container", fakePty(200));
    terminals.registerProcess("invalid", fakePty(1));
    terminals.registerProcess("unknown", fakePty(300));
    expect(terminals.localProcessRoots()).toEqual([{ environmentId: "a", pid: 100 }]);
    terminals.cleanupSession("local");
    expect(terminals.localProcessRoots()).toEqual([]);
    expect(terminals.sessionConfig("local")?.kind).toBe("local");
    terminals.rememberSession("local", local);
    terminals.registerProcess("local", fakePty(400));
    expect(terminals.localProcessRoots()).toEqual([{ environmentId: "a", pid: 400 }]);
    terminals.cleanupSession("local", { explicit: true });
    expect(terminals.localProcessRoots()).toEqual([]);
    for (const id of terminals.processIds()) terminals.cleanupSession(id);
    terminals.shutdown();
  });

  test.skipIf(process.platform === "win32")(
    "the spawned local setup terminal is a managed root until it exits",
    async () => {
      const harness = await createPreviewHarness();
      const runtime = new BackendRuntime({ emit: () => undefined });
      const originalShell = process.env.SHELL;
      // This tests managed process roots, not the host user's interactive shell setup.
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
        const setup = await spawnSetupTerminal(environment, ["true"], context);
        await setup.completion;
        const pty = runtime.terminals.process(setup.sessionId)!;
        expect(pty.pid).toBeGreaterThan(1);
        expect(runtime.terminals.localProcessRoots()).toContainEqual({
          environmentId: "a",
          pid: pty.pid,
        });
        await pty.terminate();
        expect(runtime.terminals.localProcessRoots()).toEqual([]);
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
