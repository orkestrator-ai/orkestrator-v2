import { describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import type { CommandContext } from "../../../apps/backend/src/core/commands";
import type { Environment } from "../../../apps/backend/src/core/models";
import {
  cleanupEnvironmentTmux,
  RUNTIME_ROOT_PREFIX,
  tmuxSessionName,
} from "../../../apps/backend/src/core/tmux";
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import {
  createHandlers,
  createTempDir,
  deferred,
  encodeCwd,
  invoke,
  waitFor,
  withFakeContainerTmuxRuntime,
  withFakeTmuxRuntime,
} from "./tmux-test-harness.js";

describe("Electron tmux environment teardown", () => {
  test("environment teardown kills live sessions, restores settings and removes the runtime root", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, worktree, alive, log, runtimeRoot }) => {
      const settingsPath = path.join(worktree, ".claude", "settings.local.json");
      const original = JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, original);

      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      const started = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-teardown", environmentId: environment.id },
        context,
      )) as { tmux_session: string; running: boolean };

      expect(started.running).toBe(true);
      // tmux mode has taken the settings file over by now.
      expect(await fs.readFile(settingsPath, "utf8")).not.toBe(original);

      // Deleting the environment goes through this, not `claude_tmux_stop`.
      await cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext);

      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
      await expect(fs.stat(runtimeRoot)).rejects.toThrow();
      // The fake tmux drops the alive marker on kill-session.
      expect(existsSync(path.join(alive, started.tmux_session))).toBe(false);
      expect(await fs.readFile(log, "utf8")).toContain(`kill-session -t ${started.tmux_session}`);

      // The session is forgotten too, so a later command cannot drive a dead tab.
      await expect(
        invoke(
          handlers,
          "claude_tmux_status",
          {
            tabId: "tab-teardown",
            environmentId: environment.id,
          },
          context,
        ),
      ).resolves.toBeNull();
    });
  });

  test("environment teardown survives a backend it cannot reach", async () => {
    await withFakeTmuxRuntime(async ({ environment }) => {
      // A container environment whose container id is already gone: there is
      // nothing to exec into, and deletion must not be blocked by that.
      const unreachable = {
        ...environment,
        environmentType: "container" as const,
        containerId: null,
      };
      const context = {
        storage: {
          getEnvironment: async () => unreachable,
          loadEnvironments: async () => [unreachable],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await expect(
        cleanupEnvironmentTmux(unreachable.id, context as unknown as CommandContext),
      ).resolves.toBeUndefined();
    });
  });

  test("environment teardown fails closed when a surviving environment contests the tmux prefix", async () => {
    await withFakeTmuxRuntime(async ({ environment, alive, log }) => {
      const orphanName = tmuxSessionName(environment.id, "orphan-contested");
      await fs.mkdir(alive, { recursive: true });
      await fs.writeFile(path.join(alive, orphanName), "");
      const collidingEnvironment = {
        ...environment,
        id: `${environment.id.slice(0, 16)}-survivor`,
      };
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment, collidingEnvironment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext);

      expect(existsSync(path.join(alive, orphanName))).toBe(true);
      expect(await fs.readFile(log, "utf8")).not.toContain(`kill-session -t ${orphanName}`);
      await fs.rm(path.join(alive, orphanName), { force: true });
    });
  });

  test("environment teardown accepts a session disappearing after list-sessions", async () => {
    await withFakeTmuxRuntime(async ({ environment, alive, runtimeRoot }) => {
      const orphanName = tmuxSessionName(environment.id, "orphan-race");
      await fs.mkdir(alive, { recursive: true });
      await fs.mkdir(runtimeRoot, { recursive: true });
      await fs.writeFile(path.join(alive, orphanName), "");
      process.env.FAKE_TMUX_MISSING_ON_KILL = orphanName;
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await expect(
        cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext),
      ).resolves.toBeUndefined();
      expect(existsSync(path.join(alive, orphanName))).toBe(false);
      await expect(fs.stat(runtimeRoot)).rejects.toThrow();
    });
  });

  test("orphan reconciliation retains failed managed stops and cleans hooks when tmux has no server", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, worktree, runtimeRoot }) => {
      const settingsPath = path.join(worktree, ".claude", "settings.local.json");
      const backupPath = path.join(runtimeRoot, "settings.local.json.orkestrator-v2-backup");
      const hookPath = path.join(runtimeRoot, "hook.sh");
      const originalSettings = JSON.stringify(
        { permissions: { allow: ["Bash(git status)"] } },
        null,
        2,
      );
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, originalSettings);
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
          loadPaneLayoutsForReconciliation: async () => ({ available: true, layouts: {} }),
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-orphan-stop-failure";
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        {
          tabId,
          environmentId: environment.id,
        },
        context,
      )) as { session_id: string };
      const installedSettings = await fs.readFile(settingsPath, "utf8");
      const installedHook = await fs.readFile(hookPath, "utf8");
      const installedBackup = await fs.readFile(backupPath, "utf8");
      const sessionDir = path.join(runtimeRoot, "sessions", status.session_id);
      const nowSpy = spyOn(Date, "now");
      const originalFailKill = process.env.FAKE_TMUX_FAIL_KILL;
      let now = Date.now() + 1_000_000_000;
      nowSpy.mockImplementation(() => now);
      try {
        await invoke(handlers, "claude_tmux_reconcile_orphans", {}, context);
        process.env.FAKE_TMUX_FAIL_KILL = "1";
        now += 60 * 60 * 1_000 + 60_001;
        await expect(
          invoke(handlers, "claude_tmux_reconcile_orphans", {}, context),
        ).resolves.toEqual({ reaped: 0, skipped: false });
        await expect(
          invoke(
            handlers,
            "claude_tmux_status",
            {
              tabId,
              environmentId: environment.id,
            },
            context,
          ),
        ).resolves.not.toBeNull();
        expect(existsSync(sessionDir)).toBe(true);

        delete process.env.FAKE_TMUX_FAIL_KILL;
        now += 60_001;
        await expect(
          invoke(handlers, "claude_tmux_reconcile_orphans", {}, context),
        ).resolves.toEqual({ reaped: 1, skipped: false });
        await expect(
          invoke(
            handlers,
            "claude_tmux_status",
            {
              tabId,
              environmentId: environment.id,
            },
            context,
          ),
        ).resolves.toBeNull();

        // Recreate only the persisted managed hook state. With no tmux server
        // and no in-memory sessions, reconciliation must still restore it.
        await fs.mkdir(runtimeRoot, { recursive: true });
        await fs.writeFile(hookPath, installedHook);
        await fs.writeFile(backupPath, installedBackup);
        await fs.writeFile(settingsPath, installedSettings);
        now += 60_001;
        await expect(
          invoke(handlers, "claude_tmux_reconcile_orphans", {}, context),
        ).resolves.toEqual({ reaped: 0, skipped: false });
        await expect(fs.readFile(settingsPath, "utf8")).resolves.toBe(originalSettings);
        await expect(fs.stat(runtimeRoot)).rejects.toThrow();
      } finally {
        nowSpy.mockRestore();
        if (originalFailKill === undefined) delete process.env.FAKE_TMUX_FAIL_KILL;
        else process.env.FAKE_TMUX_FAIL_KILL = originalFailKill;
      }
    });
  }, 20_000);

  test("a start queued behind environment teardown rejects the deletion tombstone", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      let storedEnvironment: Environment = environment;
      const loadGate = deferred<Environment[]>();
      let loadStarted = false;
      const context = {
        storage: {
          getEnvironment: async () => storedEnvironment,
          loadEnvironments: async () => {
            loadStarted = true;
            return loadGate.promise;
          },
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-delete-race", environmentId: environment.id },
        context,
      );

      const cleanup = cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext);
      await waitFor(() => loadStarted);

      storedEnvironment = {
        ...environment,
        deletionRequestedAt: new Date().toISOString(),
      };
      const queuedStart = invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-after-delete", environmentId: environment.id },
        context,
      );
      const queuedStartOutcome = queuedStart.then(
        () => ({ error: null as Error | null }),
        (error: unknown) => ({
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
      loadGate.resolve([storedEnvironment]);

      await expect(cleanup).resolves.toBeUndefined();
      expect((await queuedStartOutcome).error?.message).toContain("is being deleted");
      expect(await fs.readFile(log, "utf8")).not.toContain(
        tmuxSessionName(environment.id, "tab-after-delete"),
      );
    });
  });

  test("a queued prompt submit rejects a deletion tombstone before typing", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      let storedEnvironment: Environment = environment;
      const context = {
        storage: {
          getEnvironment: async () => storedEnvironment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-delete-submit", environmentId: environment.id },
        context,
      );

      storedEnvironment = {
        ...environment,
        deletionRequestedAt: new Date().toISOString(),
      };
      await expect(
        invoke(
          handlers,
          "claude_tmux_submit_queued",
          {
            tabId: "tab-delete-submit",
            environmentId: environment.id,
            text: "must not be typed",
          },
          context,
        ),
      ).rejects.toThrow("is being deleted");
      expect(await fs.readFile(log, "utf8")).not.toContain("must not be typed");
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-delete-submit", environmentId: environment.id },
        context,
      );
    });
  });

  test("environment teardown detaches active interactive terminal polling", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-interactive-cleanup", environmentId: environment.id },
        context,
      );
      const terminalSessionId = (await invoke(
        handlers,
        "claude_tmux_create_interactive_terminal",
        {
          tabId: "tab-interactive-cleanup",
          environmentId: environment.id,
          cols: 120,
          rows: 40,
        },
        context,
      )) as string;
      await invoke(
        handlers,
        "claude_tmux_start_interactive_terminal",
        { terminalSessionId },
        context,
      );

      await cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext);

      await expect(
        invoke(
          handlers,
          "claude_tmux_write_interactive_terminal",
          { terminalSessionId, data: "after-delete" },
          context,
        ),
      ).rejects.toThrow("interactive terminal session not found");
    });
  });

  test("environment teardown preserves its runtime root when tmux killing fails", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-kill-retry", environmentId: environment.id },
        context,
      );

      const originalFailKill = process.env.FAKE_TMUX_FAIL_KILL;
      process.env.FAKE_TMUX_FAIL_KILL = "1";
      try {
        await expect(
          cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext),
        ).rejects.toThrow("cleanup incomplete");
        expect((await fs.stat(runtimeRoot)).isDirectory()).toBe(true);
      } finally {
        if (originalFailKill === undefined) delete process.env.FAKE_TMUX_FAIL_KILL;
        else process.env.FAKE_TMUX_FAIL_KILL = originalFailKill;
      }
    });
  });

  test("environment teardown preserves retry state when environment loading fails", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => {
            throw new Error("environment store unavailable");
          },
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-load-failure", environmentId: environment.id },
        context,
      );

      await expect(
        cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext),
      ).rejects.toThrow("cleanup incomplete");
      expect((await fs.stat(runtimeRoot)).isDirectory()).toBe(true);
    });
  });

  test("environment teardown retains the backup when restoring Claude settings fails", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, worktree }) => {
      const settingsPath = path.join(worktree, ".claude", "settings.local.json");
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ original: true }));
      const context = {
        storage: {
          getEnvironment: async () => environment,
          loadEnvironments: async () => [environment],
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-settings-failure", environmentId: environment.id },
        context,
      );

      await fs.rm(settingsPath);
      await fs.mkdir(settingsPath);

      await expect(
        cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext),
      ).rejects.toThrow("cleanup incomplete");
      expect(
        await fs.readFile(
          path.join(runtimeRoot, "settings.local.json.orkestrator-v2-backup"),
          "utf8",
        ),
      ).toContain("original");
    });
  });

});
