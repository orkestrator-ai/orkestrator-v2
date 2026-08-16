import { describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import type { CommandContext } from "../../../apps/backend/src/core/commands";
import type { Environment } from "../../../apps/backend/src/core/models";
import { cleanupEnvironmentTmux, RUNTIME_ROOT_PREFIX, tmuxSessionName } from "../../../apps/backend/src/core/tmux";
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


describe("Electron tmux backend command registration", () => {
  test("registers the tmux command surface", () => {
    const handlers = createHandlers();

    for (const name of [
      "claude_tmux_start",
      "claude_tmux_stop",
      "claude_tmux_interrupt",
      "claude_tmux_status",
      "claude_tmux_transcript",
      "claude_tmux_tasks",
      "claude_tmux_pending_hooks",
      "claude_tmux_create_interactive_terminal",
      "claude_tmux_start_interactive_terminal",
      "claude_tmux_write_interactive_terminal",
      "claude_tmux_resize_interactive_terminal",
      "claude_tmux_detach_interactive_terminal",
      "claude_tmux_send_text",
      "claude_tmux_send_keys",
      "claude_tmux_answer_selection_prompt",
      "claude_tmux_submit",
      "claude_tmux_submit_queued",
      "claude_tmux_switch_model",
      "claude_tmux_switch_effort",
      "claude_tmux_switch_plan_mode",
      "claude_tmux_resize",
      "claude_tmux_answer_pre_tool_use",
      "claude_tmux_reply_hook",
      "claude_tmux_list_previous_sessions",
    ]) {
      expect(handlers.has(name)).toBe(true);
    }
  });

  test("writes an owner-only agent MCP config and includes it in a local Claude launch", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, log }) => {
      const connectionCalls: Array<{
        environmentId: string;
        projectId: string;
        target: "host" | "container";
      }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: (
            environmentId: string,
            projectId: string,
            target: "host" | "container",
          ) => {
            connectionCalls.push({ environmentId, projectId, target });
            return {
              url: "http://127.0.0.1:4567/mcp",
              token: "scoped-project-token",
            };
          },
          revokeEnvironment: () => undefined,
        },
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-agent-mcp", environmentId: environment.id },
        context,
      );

      expect(connectionCalls).toEqual([{
        environmentId: environment.id,
        projectId: environment.projectId,
        target: "host",
      }]);
      const configPath = path.join(runtimeRoot, "agent-mcp.json");
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        mcpServers: {
          orkestrator: {
            type: "http",
            url: "http://127.0.0.1:4567/mcp",
            headers: { Authorization: "Bearer scoped-project-token" },
          },
        },
      });
      expect(await fs.readFile(log, "utf8")).toContain(
        `--mcp-config '${configPath}'`,
      );

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-agent-mcp", environmentId: environment.id },
        context,
      );
      await expect(fs.stat(configPath)).rejects.toThrow();
    });
  });

  test("does not create an agent MCP config when Claude lacks the launch flag", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, log }) => {
      process.env.FAKE_CLAUDE_NO_MCP_CONFIG = "1";
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: () => {
            throw new Error("connection must not be requested");
          },
          revokeEnvironment: () => undefined,
        },
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-no-mcp-flag", environmentId: environment.id },
        context,
      );

      await expect(fs.stat(path.join(runtimeRoot, "agent-mcp.json"))).rejects.toThrow();
      expect(await fs.readFile(log, "utf8")).not.toContain("--mcp-config");
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-no-mcp-flag", environmentId: environment.id },
        context,
      );
    });
  });

  test("skips agent MCP injection if the environment disappears during launch", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, log }) => {
      let environmentReads = 0;
      const context = {
        storage: {
          getEnvironment: async () => {
            environmentReads += 1;
            return environmentReads < 3 ? environment : undefined;
          },
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: () => {
            throw new Error("connection must not be requested");
          },
          revokeEnvironment: () => undefined,
        },
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-vanished-agent-env", environmentId: environment.id },
        context,
      );

      await expect(fs.stat(path.join(runtimeRoot, "agent-mcp.json"))).rejects.toThrow();
      expect(await fs.readFile(log, "utf8")).not.toContain("--mcp-config");
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-vanished-agent-env", environmentId: environment.id },
        context,
      );
    });
  });

  test("cleans the private temporary file and fails closed when config replacement fails", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot, log }) => {
      const configPath = path.join(runtimeRoot, "agent-mcp.json");
      await fs.mkdir(configPath, { recursive: true });
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: () => ({
            url: "http://127.0.0.1:4567/mcp",
            token: "scoped-project-token",
          }),
          revokeEnvironment: () => undefined,
        },
      };

      await expect(invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-agent-config-write-failure", environmentId: environment.id },
        context,
      )).rejects.toThrow();

      expect((await fs.stat(configPath)).isDirectory()).toBe(true);
      expect(
        (await fs.readdir(runtimeRoot)).filter((name) =>
          name.startsWith("agent-mcp.json.") && name.endsWith(".tmp")
        ),
      ).toEqual([]);
      expect(await fs.readFile(log, "utf8")).not.toContain("new-session ");
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-agent-config-write-failure", environmentId: environment.id },
        context,
      );
    });
  });

  test("removes the bearer config when tmux rejects the Claude launch", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      process.env.FAKE_TMUX_FAIL_NEW = "1";
      const configPath = path.join(runtimeRoot, "agent-mcp.json");
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: () => ({
            url: "http://127.0.0.1:4567/mcp",
            token: "scoped-project-token",
          }),
          revokeEnvironment: () => undefined,
        },
      };

      await expect(invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-agent-launch-failure", environmentId: environment.id },
        context,
      )).rejects.toThrow("tmux new-session failed");

      await expect(fs.stat(configPath)).rejects.toThrow();
      expect(
        (await fs.readdir(runtimeRoot)).filter((name) =>
          name.startsWith("agent-mcp.json.") && name.endsWith(".tmp")
        ),
      ).toEqual([]);
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-agent-launch-failure", environmentId: environment.id },
        context,
      );
    });
  });

  test("writes the agent MCP config securely for container-backed Claude sessions", async () => {
    const handlers = createHandlers();

    await withFakeContainerTmuxRuntime(async ({ environment, runtimeRoot, log, worktree }) => {
      const connectionCalls: Array<{
        environmentId: string;
        projectId: string;
        target: "host" | "container";
      }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        agentTools: {
          connection: (
            environmentId: string,
            projectId: string,
            target: "host" | "container",
          ) => {
            connectionCalls.push({ environmentId, projectId, target });
            return {
              url: "http://host.docker.internal:4567/mcp",
              token: "container-project-token",
            };
          },
          revokeEnvironment: () => undefined,
        },
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-container-agent-mcp", environmentId: environment.id },
        context,
      );

      expect(connectionCalls).toEqual([{
        environmentId: environment.id,
        projectId: environment.projectId,
        target: "container",
      }]);
      const configPath = path.join(runtimeRoot, "agent-mcp.json");
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        mcpServers: {
          orkestrator: {
            type: "http",
            url: "http://host.docker.internal:4567/mcp",
            headers: { Authorization: "Bearer container-project-token" },
          },
        },
      });
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(worktree, ".claude", "settings.local.json"),
            "utf8",
          ),
        ),
      ).toHaveProperty("hooks");

      const dockerLog = await fs.readFile(log, "utf8");
      expect(dockerLog).toContain('stat -c %a "$tmp"');
      expect(dockerLog).toContain(`--mcp-config '${configPath}'`);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-container-agent-mcp", environmentId: environment.id },
        context,
      );
      await expect(fs.stat(configPath)).rejects.toThrow();
    });
  });

  test("keeps missing-session behavior compatible with the backend tmux commands", async () => {
    const handlers = createHandlers();
    const args = { tabId: "tab-missing", environmentId: "env-missing" };

    await expect(invoke(handlers, "claude_tmux_status", args)).resolves.toBeNull();
    await expect(invoke(handlers, "claude_tmux_stop", args)).resolves.toBeUndefined();
    await expect(invoke(handlers, "claude_tmux_interrupt", args)).rejects.toThrow("tmux session not running");
    await expect(invoke(handlers, "claude_tmux_pending_hooks", args)).rejects.toThrow("tmux session not running");
    await expect(invoke(handlers, "claude_tmux_tasks", args)).rejects.toThrow("tmux session not running");
    await expect(invoke(handlers, "claude_tmux_detach_interactive_terminal", { terminalSessionId: "missing" })).resolves.toBeUndefined();
  });

  test("names generated tab ids without tmux session collisions", () => {
    const first = tmuxSessionName("env-local", "tab-1782973296000-1");
    const second = tmuxSessionName("env-local", "tab-1782973296000-2");

    expect(first).not.toBe(second);
    expect(first.startsWith("orkestrator-env-local-tab-178297329600-")).toBe(true);
    expect(second.startsWith("orkestrator-env-local-tab-178297329600-")).toBe(true);
  });

  test("starts separate tmux sessions for generated tab ids with the same old prefix", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      const first = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-1782973296000-1", environmentId: environment.id },
        context,
      ) as { tmux_session: string; running: boolean };
      const second = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-1782973296000-2", environmentId: environment.id },
        context,
      ) as { tmux_session: string; running: boolean };

      expect(first.running).toBe(true);
      expect(second.running).toBe(true);
      expect(first.tmux_session).not.toBe(second.tmux_session);

      const tmuxLog = await fs.readFile(log, "utf8");
      const newSessionLines = tmuxLog
        .split("\n")
        .filter((line) => line.startsWith("new-session "));
      expect(newSessionLines).toHaveLength(2);
      expect(newSessionLines[0]).toContain(first.tmux_session);
      expect(newSessionLines[1]).toContain(second.tmux_session);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-1782973296000-1", environmentId: environment.id },
        context,
      );
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-1782973296000-2", environmentId: environment.id },
        context,
      );
    });
  });

  test("attaches duplicate client starts to one tmux session unless replacement is explicit", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const events: Array<Record<string, unknown>> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (_event: string, payload: unknown) => {
          if (payload && typeof payload === "object") {
            events.push(payload as Record<string, unknown>);
          }
        },
        appRoot: "",
        resourceRoot: "",
      };
      const args = {
        tabId: "startup-agent",
        environmentId: environment.id,
        initialPrompt: "Inspect the workspace",
      };

      const first = await invoke(
        handlers,
        "claude_tmux_start",
        args,
        context,
      ) as { session_id: string };
      const attached = await invoke(
        handlers,
        "claude_tmux_start",
        args,
        context,
      ) as { session_id: string };

      expect(attached.session_id).toBe(first.session_id);
      await waitFor(() =>
        events.some((event) =>
          event.kind === "initial-prompt-sent"
          && event.session_id === first.session_id
        ),
      );
      let tmuxLog = await fs.readFile(log, "utf8");
      expect(
        tmuxLog.split("\n").filter((line) => line.startsWith("new-session ")),
      ).toHaveLength(1);
      expect(
        tmuxLog.split("\n").filter((line) => line.startsWith("paste-buffer ")),
      ).toHaveLength(1);
      expect(tmuxLog).not.toContain("kill-session");

      const replaced = await invoke(
        handlers,
        "claude_tmux_start",
        { ...args, initialPrompt: undefined, replaceExisting: true },
        context,
      ) as { session_id: string };
      expect(replaced.session_id).not.toBe(first.session_id);
      tmuxLog = await fs.readFile(log, "utf8");
      expect(
        tmuxLog.split("\n").filter((line) => line.startsWith("new-session ")),
      ).toHaveLength(2);
      expect(tmuxLog).toContain("kill-session");

      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  });

  test("serializes stop behind an in-flight start so no tmux session is orphaned", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log, alive }) => {
      const barrier = `${log}.new-session`;
      process.env.FAKE_TMUX_NEW_SESSION_BARRIER = barrier;
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const args = {
        tabId: "concurrent-start-stop",
        environmentId: environment.id,
      };

      const start = invoke(handlers, "claude_tmux_start", args, context) as Promise<{
        tmux_session: string;
      }>;
      await waitFor(() => existsSync(`${barrier}.started`));

      let stopSettled = false;
      const stop = invoke(handlers, "claude_tmux_stop", args, context)
        .finally(() => {
          stopSettled = true;
        });
      await delay(75);
      const settledBeforeStartReleased = stopSettled;
      await fs.writeFile(`${barrier}.release`, "");

      const started = await start;
      await stop;

      expect(settledBeforeStartReleased).toBe(false);
      expect(existsSync(path.join(alive, started.tmux_session))).toBe(false);
      await expect(
        invoke(handlers, "claude_tmux_status", args, context),
      ).resolves.toBeNull();
    });
  });

  // Pins the runtime root against production. The cleanup in withFakeTmuxRuntime
  // uses `force: true`, so it silently succeeds against a wrong path — without
  // this test a change to RUNTIME_ROOT_PREFIX would leave every run leaking hook
  // state into /tmp with nothing failing.
  test("keeps per-environment hook state under the shared runtime root and removes it on stop", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      expect(runtimeRoot).toBe(path.join(RUNTIME_ROOT_PREFIX, environment.id));
      await expect(fs.stat(runtimeRoot)).rejects.toThrow();

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-runtime-root", environmentId: environment.id },
        context,
      ) as { session_id: string };

      expect((await fs.stat(runtimeRoot)).isDirectory()).toBe(true);
      expect(
        (await fs.stat(path.join(runtimeRoot, "sessions", status.session_id))).isDirectory(),
      ).toBe(true);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-runtime-root", environmentId: environment.id },
        context,
      );

      // Stopping the last session tears the whole root down. That is exactly why
      // two concurrent runs must not share an environment id.
      await expect(fs.stat(runtimeRoot)).rejects.toThrow();
    });
  });

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

      const started = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-teardown", environmentId: environment.id },
        context,
      ) as { tmux_session: string; running: boolean };

      expect(started.running).toBe(true);
      // tmux mode has taken the settings file over by now.
      expect(await fs.readFile(settingsPath, "utf8")).not.toBe(original);

      // Deleting the environment goes through this, not `claude_tmux_stop`.
      await cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext);

      expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
      await expect(fs.stat(runtimeRoot)).rejects.toThrow();
      // The fake tmux drops the alive marker on kill-session.
      expect(existsSync(path.join(alive, started.tmux_session))).toBe(false);
      expect(await fs.readFile(log, "utf8")).toContain(
        `kill-session -t ${started.tmux_session}`,
      );

      // The session is forgotten too, so a later command cannot drive a dead tab.
      await expect(
        invoke(handlers, "claude_tmux_status", {
          tabId: "tab-teardown",
          environmentId: environment.id,
        }, context),
      ).resolves.toBeNull();
    });
  });

  test("environment teardown survives a backend it cannot reach", async () => {
    await withFakeTmuxRuntime(async ({ environment }) => {
      // A container environment whose container id is already gone: there is
      // nothing to exec into, and deletion must not be blocked by that.
      const unreachable = { ...environment, environmentType: "container" as const, containerId: null };
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

      await cleanupEnvironmentTmux(
        environment.id,
        context as unknown as CommandContext,
      );

      expect(existsSync(path.join(alive, orphanName))).toBe(true);
      expect(await fs.readFile(log, "utf8")).not.toContain(
        `kill-session -t ${orphanName}`,
      );
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

      await expect(cleanupEnvironmentTmux(
        environment.id,
        context as unknown as CommandContext,
      )).resolves.toBeUndefined();
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
      const originalSettings = JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }, null, 2);
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
      const status = await invoke(handlers, "claude_tmux_start", {
        tabId,
        environmentId: environment.id,
      }, context) as { session_id: string };
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
        await expect(invoke(handlers, "claude_tmux_reconcile_orphans", {}, context))
          .resolves.toEqual({ reaped: 0, skipped: false });
        await expect(invoke(handlers, "claude_tmux_status", {
          tabId,
          environmentId: environment.id,
        }, context)).resolves.not.toBeNull();
        expect(existsSync(sessionDir)).toBe(true);

        delete process.env.FAKE_TMUX_FAIL_KILL;
        now += 60_001;
        await expect(invoke(handlers, "claude_tmux_reconcile_orphans", {}, context))
          .resolves.toEqual({ reaped: 1, skipped: false });
        await expect(invoke(handlers, "claude_tmux_status", {
          tabId,
          environmentId: environment.id,
        }, context)).resolves.toBeNull();

        // Recreate only the persisted managed hook state. With no tmux server
        // and no in-memory sessions, reconciliation must still restore it.
        await fs.mkdir(runtimeRoot, { recursive: true });
        await fs.writeFile(hookPath, installedHook);
        await fs.writeFile(backupPath, installedBackup);
        await fs.writeFile(settingsPath, installedSettings);
        now += 60_001;
        await expect(invoke(handlers, "claude_tmux_reconcile_orphans", {}, context))
          .resolves.toEqual({ reaped: 0, skipped: false });
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

      const cleanup = cleanupEnvironmentTmux(
        environment.id,
        context as unknown as CommandContext,
      );
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
      expect((await queuedStartOutcome).error?.message).toContain(
        "is being deleted",
      );
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
      await expect(invoke(
        handlers,
        "claude_tmux_submit_queued",
        {
          tabId: "tab-delete-submit",
          environmentId: environment.id,
          text: "must not be typed",
        },
        context,
      )).rejects.toThrow("is being deleted");
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
      const terminalSessionId = await invoke(
        handlers,
        "claude_tmux_create_interactive_terminal",
        {
          tabId: "tab-interactive-cleanup",
          environmentId: environment.id,
          cols: 120,
          rows: 40,
        },
        context,
      ) as string;
      await invoke(
        handlers,
        "claude_tmux_start_interactive_terminal",
        { terminalSessionId },
        context,
      );

      await cleanupEnvironmentTmux(
        environment.id,
        context as unknown as CommandContext,
      );

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
          cleanupEnvironmentTmux(
            environment.id,
            context as unknown as CommandContext,
          ),
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
        cleanupEnvironmentTmux(
          environment.id,
          context as unknown as CommandContext,
        ),
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
        cleanupEnvironmentTmux(
          environment.id,
          context as unknown as CommandContext,
        ),
      ).rejects.toThrow("cleanup incomplete");
      expect(
        await fs.readFile(
          path.join(runtimeRoot, "settings.local.json.orkestrator-v2-backup"),
          "utf8",
        ),
      ).toContain("original");
    });
  });

  test("starts local Claude sessions with the managed toolchain binary", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const toolchainBinDir = await createTempDir("ork-tmux-toolchain-");
      const managedClaude = path.join(toolchainBinDir, "claude");
      await fs.writeFile(managedClaude, `#!/bin/sh
case "$1" in
  --version) printf '2.1.2\n' ;;
  --help) printf '%s\n' '--session-id <uuid>' ;;
esac
exit 0
`);
      await fs.chmod(managedClaude, 0o500);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        toolchainBinDir,
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-managed", environmentId: environment.id },
        context,
      );

      expect(await fs.readFile(log, "utf8")).toContain(managedClaude);
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-managed", environmentId: environment.id },
        context,
      );
    });
  });

  test("omits the thinking and effort flags when an older CLI ignores what it does not know", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const toolchainBinDir = await createTempDir("ork-tmux-old-cli-");
      const oldClaude = path.join(toolchainBinDir, "claude");
      // An older CLI ignores the unknown option on the `--version` path and
      // exits 0, which is exactly what the probe treats as "unsupported". Its
      // `--help` also omits `--effort`, so that flag must be dropped too.
      await fs.writeFile(oldClaude, `#!/bin/sh
case "$1" in
  --help) printf '%s\\n' '--session-id <uuid>' ;;
  *) printf '2.1.2\\n' ;;
esac
exit 0
`);
      await fs.chmod(oldClaude, 0o500);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        toolchainBinDir,
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        {
          tabId: "tab-old-cli",
          environmentId: environment.id,
          model: "sonnet",
          effort: "high",
          fastMode: true,
        },
        context,
      ) as { fast_mode: boolean };

      const launchLog = await fs.readFile(log, "utf8");
      expect(launchLog).toContain(" --dangerously-skip-permissions");
      expect(launchLog).toContain(" --model 'sonnet'");
      expect(launchLog).not.toContain("--effort");
      expect(launchLog).not.toContain("--thinking-display");
      expect(launchLog).not.toContain("--thinking adaptive");
      expect(launchLog).not.toContain("--settings");
      expect(status.fast_mode).toBe(false);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-old-cli", environmentId: environment.id },
        context,
      );
    });
  });

  test("omits the thinking flags when the CLI knows --thinking-display but not --thinking", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const toolchainBinDir = await createTempDir("ork-tmux-split-cli-");
      const splitClaude = path.join(toolchainBinDir, "claude");
      // The flags must be probed as a pair. A CLI that accepts one and rejects
      // the other would otherwise be launched with an option it cannot parse,
      // and Claude would exit before the tmux session ever showed a prompt.
      await fs.writeFile(splitClaude, `#!/bin/sh
case "$1" in
  --help) printf '%s\\n' '--session-id <uuid>' ;;
  --thinking)
    printf '%s\\n' "error: unknown option '--thinking'" >&2
    exit 1
    ;;
  --thinking-display)
    case "$2" in
      summarized|omitted) ;;
      *)
        printf '%s\\n' "error: option '--thinking-display <display>' argument '$2' is invalid. Allowed choices are summarized, omitted." >&2
        exit 1
        ;;
    esac
    printf '2.1.2\\n'
    ;;
  *) printf '2.1.2\\n' ;;
esac
exit 0
`);
      await fs.chmod(splitClaude, 0o500);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        toolchainBinDir,
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-split-cli", environmentId: environment.id },
        context,
      );

      const launchLog = await fs.readFile(log, "utf8");
      expect(launchLog).toContain(" --dangerously-skip-permissions");
      expect(launchLog).not.toContain("--thinking");

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-split-cli", environmentId: environment.id },
        context,
      );
    });
  });

  test("resumes an existing session id and still requests the thinking flags", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const resumeSessionId = "11111111-2222-3333-4444-555555555555";

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-resume", environmentId: environment.id, model: "opus", effort: "medium", resumeSessionId },
        context,
      ) as { session_id: string; resumed: boolean };

      expect(status.session_id).toBe(resumeSessionId);
      expect(status.resumed).toBe(true);

      const launchLog = await fs.readFile(log, "utf8");
      expect(launchLog).toContain(` --resume ${resumeSessionId}`);
      expect(launchLog).not.toContain("--session-id");
      expect(launchLog).toContain(" --model 'opus'");
      expect(launchLog).toContain(" --effort 'medium'");
      // The probe runs on the resume path too — a resumed session is still a
      // fresh CLI process and needs the same thinking display.
      expect(launchLog).toContain(" --thinking adaptive --thinking-display summarized");

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-resume", environmentId: environment.id },
        context,
      );
    });
  });

  test("assigns a new observation generation when replacing the same resumed session", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const args = {
        tabId: "tab-generation",
        environmentId: environment.id,
        resumeSessionId: "11111111-2222-3333-4444-555555555555",
      };
      const first = await invoke(
        handlers,
        "claude_tmux_start",
        args,
        context,
      ) as { session_id: string; observation: { generation?: string; revision: number } };
      const second = await invoke(
        handlers,
        "claude_tmux_start",
        { ...args, replaceExisting: true },
        context,
      ) as { session_id: string; observation: { generation?: string; revision: number } };

      expect(second.session_id).toBe(first.session_id);
      expect(first.observation.generation).toBeTruthy();
      expect(second.observation.generation).toBeTruthy();
      expect(second.observation.generation).not.toBe(first.observation.generation);
      expect(second.observation.revision).toBe(0);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: args.tabId, environmentId: environment.id },
        context,
      );
    });
  });

  test("sends text and keys, resizes, rejects blank switches, and answers PreToolUse", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log, alive, runtimeRoot }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-commands";
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      ) as { session_id: string };
      const session = tmuxSessionName(environment.id, tabId);
      const inputBuffer = path.join(alive, `buffer-claude-tmux-input-${session}`);

      // sendText pastes through a tmux buffer rather than send-keys, so the
      // pasted payload has to survive verbatim.
      await invoke(handlers, "claude_tmux_send_text", { tabId, environmentId: environment.id, text: "hello 👋" });
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("hello 👋");
      await expect(fs.readFile(path.join(alive, `${session}.input`), "utf8")).resolves.toBe("hello 👋");

      await invoke(handlers, "claude_tmux_send_keys", { tabId, environmentId: environment.id, keys: ["Escape", "Enter"] });
      expect(await fs.readFile(log, "utf8")).toContain("-- Escape Enter");

      await invoke(handlers, "claude_tmux_resize", { tabId, environmentId: environment.id, cols: 120, rows: 40 });
      expect(await fs.readFile(log, "utf8")).toContain(`resize-window -t ${session} -x 120 -y 40`);
      await expect(invoke(
        handlers,
        "claude_tmux_resize",
        { tabId, environmentId: environment.id, cols: 0, rows: 40 },
      )).rejects.toThrow("cols");

      // A blank model or effort must be rejected before anything reaches tmux.
      const beforeRejected = await fs.readFile(log, "utf8");
      await expect(invoke(
        handlers,
        "claude_tmux_switch_model",
        { tabId, environmentId: environment.id, model: "   " },
      )).rejects.toThrow("model id cannot be empty");
      await expect(invoke(
        handlers,
        "claude_tmux_switch_effort",
        { tabId, environmentId: environment.id, effort: "" },
      )).rejects.toThrow("effort level cannot be empty");
      expect(await fs.readFile(log, "utf8")).toBe(beforeRejected);

      const sessionRoot = path.join(runtimeRoot, "sessions", status.session_id);
      await fs.mkdir(path.join(sessionRoot, "pending"), { recursive: true });
      await fs.writeFile(
        path.join(sessionRoot, "pending", "PreToolUse-event-9.json"),
        JSON.stringify({ tool_name: "Bash" }),
      );
      await invoke(handlers, "claude_tmux_answer_pre_tool_use", {
        tabId,
        environmentId: environment.id,
        eventId: "event-9",
        decision: "block",
        reason: "not this time",
      });
      await expect(
        fs.readFile(path.join(sessionRoot, "response", "PreToolUse-event-9.json"), "utf8").then(JSON.parse),
      ).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "not this time",
        },
      });
      await expect(fs.stat(path.join(sessionRoot, "pending", "PreToolUse-event-9.json"))).rejects.toThrow();

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  // Model, effort, and fast-mode switches are typed as slash commands into the running TUI
  // — the CLI flags only apply at launch — and each one then waits out the
  // no-hook settle window, so this needs more than the default per-test budget.
  test("switches model, effort, and fast mode as slash commands in the live TUI", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-switches";
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);
      const session = tmuxSessionName(environment.id, tabId);
      const inputBuffer = path.join(alive, `buffer-claude-tmux-input-${session}`);

      await invoke(handlers, "claude_tmux_switch_model", { tabId, environmentId: environment.id, model: "opus" });
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("/model opus");

      await invoke(handlers, "claude_tmux_switch_effort", { tabId, environmentId: environment.id, effort: "high" });
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("/effort high");

      await invoke(handlers, "claude_tmux_switch_fast_mode", { tabId, environmentId: environment.id, fastMode: true }, context);
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("/fast on");
      await expect(
        invoke(handlers, "claude_tmux_status", { tabId, environmentId: environment.id }, context),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await expect(fs.readFile(path.join(alive, `${session}.fast-option`), "utf8"))
        .resolves.toBe("1");
      expect(emitted).toContainEqual(expect.objectContaining({
        payload: expect.objectContaining({ kind: "fast-mode-changed", fast_mode: true }),
      }));

      await invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: false,
      }, context);
      await expect(
        invoke(handlers, "claude_tmux_status", { tabId, environmentId: environment.id }, context),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: false }));
      await expect(fs.readFile(path.join(alive, `${session}.fast-option`), "utf8"))
        .resolves.toBe("0");
      const beforeNoOp = await fs.readFile(path.join(alive, `${session}.fast-option`), "utf8");
      const eventCountBeforeNoOp = emitted.length;
      await invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: false,
      }, context);
      expect(await fs.readFile(path.join(alive, `${session}.fast-option`), "utf8"))
        .toBe(beforeNoOp);
      expect(emitted).toHaveLength(eventCountBeforeNoOp);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 20_000);

  test("rehydrates fast mode from tmux metadata without trusting the new start request", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const tabId = "tab-fast-reattach";
      const session = tmuxSessionName(environment.id, tabId);
      await fs.mkdir(alive, { recursive: true });
      await fs.writeFile(path.join(alive, session), "");
      await fs.writeFile(path.join(alive, `${session}.mode`), "bypassPermissions");
      await fs.writeFile(path.join(alive, `${session}.fast-option`), "1");

      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await expect(invoke(handlers, "claude_tmux_start", {
        tabId,
        environmentId: environment.id,
        fastMode: false,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: true }));

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  test("reports unknown fast mode when a reattached tmux session has no recoverable metadata", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const tabId = "tab-fast-unknown";
      const session = tmuxSessionName(environment.id, tabId);
      await fs.mkdir(alive, { recursive: true });
      await fs.writeFile(path.join(alive, session), "");
      await fs.writeFile(path.join(alive, `${session}.mode`), "bypassPermissions");
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await expect(invoke(handlers, "claude_tmux_start", {
        tabId,
        environmentId: environment.id,
        fastMode: true,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: null }));

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  test("rehydrates and repairs fast mode from a pane acknowledgement when metadata is missing", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const tabId = "tab-fast-pane-reattach";
      const session = tmuxSessionName(environment.id, tabId);
      await fs.mkdir(alive, { recursive: true });
      await fs.writeFile(path.join(alive, session), "");
      await fs.writeFile(path.join(alive, `${session}.mode`), "bypassPermissions");
      await fs.writeFile(path.join(alive, `${session}.fast-pane`), "fAsT MoDe oN");
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await expect(invoke(handlers, "claude_tmux_start", {
        tabId,
        environmentId: environment.id,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await expect(fs.readFile(path.join(alive, `${session}.fast-option`), "utf8"))
        .resolves.toBe("1");

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  test("reads false metadata and rejects garbage metadata as unknown", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const falseTabId = "tab-fast-option-zero";
      const falseSession = tmuxSessionName(environment.id, falseTabId);
      await fs.mkdir(alive, { recursive: true });
      await fs.writeFile(path.join(alive, falseSession), "");
      await fs.writeFile(path.join(alive, `${falseSession}.mode`), "bypassPermissions");
      await fs.writeFile(path.join(alive, `${falseSession}.fast-option`), "0");
      await expect(invoke(handlers, "claude_tmux_start", {
        tabId: falseTabId,
        environmentId: environment.id,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: false }));

      const garbageTabId = "tab-fast-option-garbage";
      const garbageSession = tmuxSessionName(environment.id, garbageTabId);
      await fs.writeFile(path.join(alive, garbageSession), "");
      await fs.writeFile(path.join(alive, `${garbageSession}.mode`), "bypassPermissions");
      await fs.writeFile(path.join(alive, `${garbageSession}.fast-option`), "sometimes");
      await expect(invoke(handlers, "claude_tmux_start", {
        tabId: garbageTabId,
        environmentId: environment.id,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: null }));

      await invoke(handlers, "claude_tmux_stop", { tabId: falseTabId, environmentId: environment.id }, context);
      await invoke(handlers, "claude_tmux_stop", { tabId: garbageTabId, environmentId: environment.id }, context);
    });
  });

  test("adopts a pane mode without submitting when backend state is unknown", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const tabId = "tab-fast-adopt";
      const session = tmuxSessionName(environment.id, tabId);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await fs.mkdir(alive, { recursive: true });
      await fs.writeFile(path.join(alive, session), "");
      await fs.writeFile(path.join(alive, `${session}.mode`), "bypassPermissions");
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);
      await fs.writeFile(path.join(alive, `${session}.fast-pane`), "Fast mode ON");

      await invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: true,
      }, context);
      expect(existsSync(path.join(alive, `${session}.input`))).toBe(false);
      await expect(fs.readFile(path.join(alive, `${session}.fast-option`), "utf8"))
        .resolves.toBe("1");

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  test("ignores stale pane acknowledgements and rejection text before the submitted command", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const tabId = "tab-fast-stale-pane";
      const session = tmuxSessionName(environment.id, tabId);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);
      await fs.writeFile(
        path.join(alive, `${session}.fast-pane`),
        "Fast mode OFF\nFast mode requires an eligible plan",
      );

      await expect(invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: true,
      }, context)).resolves.toBeUndefined();
      await expect(invoke(handlers, "claude_tmux_status", {
        tabId,
        environmentId: environment.id,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: true }));

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  test("resyncs stale in-memory fast mode before deciding whether to submit", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const tabId = "tab-fast-resync";
      const session = tmuxSessionName(environment.id, tabId);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(handlers, "claude_tmux_start", {
        tabId,
        environmentId: environment.id,
        fastMode: true,
      }, context);
      await fs.writeFile(path.join(alive, `${session}.fast-pane`), "Fast mode OFF");

      await invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: true,
      }, context);
      await expect(fs.readFile(path.join(alive, `buffer-claude-tmux-input-${session}`), "utf8"))
        .resolves.toBe("/fast on");
      await expect(invoke(handlers, "claude_tmux_status", {
        tabId,
        environmentId: environment.id,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: true }));

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  test("fails fast-mode changes when Claude exits before or during confirmation", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const beforeTab = "tab-fast-exited-before";
      const beforeSession = tmuxSessionName(environment.id, beforeTab);
      await invoke(handlers, "claude_tmux_start", { tabId: beforeTab, environmentId: environment.id }, context);
      await fs.writeFile(path.join(alive, `${beforeSession}.mode`), "exited");
      await expect(invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId: beforeTab,
        environmentId: environment.id,
        fastMode: true,
      }, context)).rejects.toThrow("Claude exited before fast mode could be changed");

      const duringTab = "tab-fast-exited-during";
      const duringSession = tmuxSessionName(environment.id, duringTab);
      await invoke(handlers, "claude_tmux_start", { tabId: duringTab, environmentId: environment.id }, context);
      await fs.writeFile(path.join(alive, `${duringSession}.exit-fast`), "");
      await expect(invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId: duringTab,
        environmentId: environment.id,
        fastMode: true,
      }, context)).rejects.toThrow("Claude exited before fast mode could be changed");

      await invoke(handlers, "claude_tmux_stop", { tabId: beforeTab, environmentId: environment.id }, context);
      await invoke(handlers, "claude_tmux_stop", { tabId: duringTab, environmentId: environment.id }, context);
    });
  });

  test("does not commit fast mode when Claude rejects the slash command", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const tabId = "tab-fast-rejected";
      const session = tmuxSessionName(environment.id, tabId);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);
      await fs.writeFile(path.join(alive, `${session}.reject-fast`), "");

      await expect(invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: true,
      }, context)).rejects.toThrow("Fast mode is unavailable for this model");
      await expect(invoke(
        handlers,
        "claude_tmux_status",
        { tabId, environmentId: environment.id },
        context,
      )).resolves.toEqual(expect.objectContaining({ fast_mode: false }));
      expect(emitted.filter(({ payload }) =>
        (payload as { kind?: string }).kind === "fast-mode-changed"
      )).toHaveLength(0);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  test("validates fast-mode requests and times out without inventing confirmation", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive, log }) => {
      const tabId = "tab-fast-timeout";
      const session = tmuxSessionName(environment.id, tabId);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);
      const beforeMalformed = await fs.readFile(log, "utf8");
      await expect(invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: "yes",
      }, context)).rejects.toThrow("Expected fastMode to be a boolean");
      expect(await fs.readFile(log, "utf8")).toBe(beforeMalformed);

      await fs.writeFile(path.join(alive, `${session}.mode`), "selection");
      await expect(invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: true,
      }, context)).rejects.toThrow("Finish the active Claude prompt");
      await fs.writeFile(path.join(alive, `${session}.mode`), "bypassPermissions");

      await fs.writeFile(path.join(alive, `${session}.ignore-fast`), "");
      await expect(invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: true,
      }, context)).rejects.toThrow("Claude did not confirm fast mode on");
      await expect(invoke(
        handlers,
        "claude_tmux_status",
        { tabId, environmentId: environment.id },
        context,
      )).resolves.toEqual(expect.objectContaining({ fast_mode: false }));

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 10_000);

  test("keeps the confirmed mode and emits it when only tmux metadata persistence fails", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const tabId = "tab-fast-persist-failure";
      const session = tmuxSessionName(environment.id, tabId);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);
      await fs.writeFile(path.join(alive, `${session}.fail-fast-option`), "");

      await expect(invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: true,
      }, context)).rejects.toThrow("Fast mode changed but its restart metadata could not be saved");
      await expect(invoke(
        handlers,
        "claude_tmux_status",
        { tabId, environmentId: environment.id },
        context,
      )).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      expect(emitted).toContainEqual(expect.objectContaining({
        payload: expect.objectContaining({ kind: "fast-mode-changed", fast_mode: true }),
      }));

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  test("retries launch metadata persistence and repairs a later missing option", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const retryTab = "tab-fast-launch-retry";
      const retrySession = tmuxSessionName(environment.id, retryTab);
      await fs.mkdir(alive, { recursive: true });
      await fs.writeFile(path.join(alive, `${retrySession}.fail-fast-option-once`), "");
      await expect(invoke(handlers, "claude_tmux_start", {
        tabId: retryTab,
        environmentId: environment.id,
        fastMode: true,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await expect(fs.readFile(path.join(alive, `${retrySession}.fast-option`), "utf8"))
        .resolves.toBe("1");

      const repairTab = "tab-fast-launch-repair";
      const repairSession = tmuxSessionName(environment.id, repairTab);
      await fs.writeFile(path.join(alive, `${repairSession}.fail-fast-option`), "");
      await expect(invoke(handlers, "claude_tmux_start", {
        tabId: repairTab,
        environmentId: environment.id,
        fastMode: true,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await fs.rm(path.join(alive, `${repairSession}.fail-fast-option`));
      await expect(invoke(handlers, "claude_tmux_start", {
        tabId: repairTab,
        environmentId: environment.id,
        fastMode: false,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await expect(fs.readFile(path.join(alive, `${repairSession}.fast-option`), "utf8"))
        .resolves.toBe("1");

      await invoke(handlers, "claude_tmux_stop", { tabId: retryTab, environmentId: environment.id }, context);
      await invoke(handlers, "claude_tmux_stop", { tabId: repairTab, environmentId: environment.id }, context);
    });
  });

  test("serializes reattach hydration behind an in-flight fast-mode switch", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const tabId = "tab-fast-reattach-race";
      const session = tmuxSessionName(environment.id, tabId);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(handlers, "claude_tmux_start", { tabId, environmentId: environment.id }, context);
      await fs.writeFile(path.join(alive, `${session}.delay-fast`), "");

      const switching = invoke(handlers, "claude_tmux_switch_fast_mode", {
        tabId,
        environmentId: environment.id,
        fastMode: true,
      }, context);
      await waitFor(() => existsSync(path.join(alive, `${session}.input`)));
      const reattaching = invoke(handlers, "claude_tmux_start", {
        tabId,
        environmentId: environment.id,
        fastMode: false,
      }, context);

      await expect(switching).resolves.toBeUndefined();
      await expect(reattaching).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await expect(invoke(handlers, "claude_tmux_status", {
        tabId,
        environmentId: environment.id,
      }, context)).resolves.toEqual(expect.objectContaining({ fast_mode: true }));

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

  test("starts with installed hooks, reads transcripts, replies to hooks, and maps interactive input", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, log, environment, runtimeRoot }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        {
          tabId: "tab-1",
          environmentId: environment.id,
          model: "sonnet",
          effort: "medium",
          fastMode: true,
          // Legacy callers may still send this launch-time field. It must not
          // override the invariant that Claude starts in bypass mode.
          planMode: true,
        },
        context,
      ) as { session_id: string; running: boolean; fast_mode: boolean };
      expect(status.running).toBe(true);
      expect(status.session_id).toBeTruthy();
      expect(status.fast_mode).toBe(true);

      const launchLog = await fs.readFile(log, "utf8");
      expect(launchLog).toContain(" --dangerously-skip-permissions");
      expect(launchLog).not.toContain("--permission-mode plan");
      // Without this the CLI defaults thinking display to "omitted" on recent
      // models, and every thinking block reaches the transcript with empty text.
      expect(launchLog).toContain(" --thinking adaptive --thinking-display summarized");
      expect(launchLog).toContain(" --settings '{\"fastMode\":true}'");

      await expect(invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-1", environmentId: environment.id, planMode: true },
        context,
      )).resolves.toBe("plan");
      await expect(invoke(
        handlers,
        "claude_tmux_status",
        { tabId: "tab-1", environmentId: environment.id },
        context,
      )).resolves.toEqual(expect.objectContaining({ permission_mode: "plan" }));
      await expect(invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-1", environmentId: environment.id, planMode: false },
        context,
      )).resolves.toBe("bypassPermissions");
      await expect(invoke(
        handlers,
        "claude_tmux_status",
        { tabId: "tab-1", environmentId: environment.id },
        context,
      )).resolves.toEqual(expect.objectContaining({ permission_mode: "bypassPermissions" }));

      const switchedLog = await fs.readFile(log, "utf8");
      expect(switchedLog).toContain("send-keys -t");
      expect(switchedLog).toContain("-- BTab");

      const sessionRoot = path.join(runtimeRoot, "sessions", status.session_id);
      const pendingDir = path.join(sessionRoot, "pending");
      const responseDir = path.join(sessionRoot, "response");
      const timingDir = path.join(sessionRoot, "timing");
      await fs.mkdir(pendingDir, { recursive: true });
      const hookEventId = "1700000000-event-1";
      await fs.writeFile(path.join(pendingDir, `PreToolUse-${hookEventId}.json`), JSON.stringify({ tool_name: "Edit" }));
      await fs.writeFile(
        path.join(timingDir, `PreToolUse-${hookEventId}.json`),
        JSON.stringify({ requestedAt: 1_700_000_000_123, expiresAt: 1_700_000_300_123 }),
      );
      const invalidTimingEventIds = [
        "event-legacy",
        "1700000000oops-malformed",
        "0-zero",
        "-1-negative",
        "9007199254740992-unsafe-seconds",
        "9007199254740-unsafe-milliseconds",
      ];
      await Promise.all(invalidTimingEventIds.map((eventId) =>
        fs.writeFile(
          path.join(pendingDir, `PermissionRequest-${eventId}.json`),
          JSON.stringify({ tool_name: "Edit" }),
        )
      ));

      const pendingHooks = await invoke(
        handlers,
        "claude_tmux_pending_hooks",
        { tabId: "tab-1", environmentId: environment.id },
      ) as Array<Record<string, unknown>>;
      expect(pendingHooks).toContainEqual({
        id: hookEventId,
        kind: "PreToolUse",
        payload: { tool_name: "Edit" },
        requestedAt: 1_700_000_000_123,
        expiresAt: 1_700_000_300_123,
      });
      for (const eventId of invalidTimingEventIds) {
        expect(pendingHooks).toContainEqual({
          id: eventId,
          kind: "PermissionRequest",
          payload: { tool_name: "Edit" },
        });
        const pending = pendingHooks.find((hook) => hook.id === eventId);
        expect(pending).not.toHaveProperty("requestedAt");
        expect(pending).not.toHaveProperty("expiresAt");
      }

      await invoke(
        handlers,
        "claude_tmux_reply_hook",
        { tabId: "tab-1", environmentId: environment.id, eventKind: "PreToolUse", eventId: hookEventId, response: { ok: true } },
      );
      await expect(fs.readFile(path.join(responseDir, `PreToolUse-${hookEventId}.json`), "utf8")).resolves.toBe(JSON.stringify({ ok: true }));
      await expect(fs.stat(path.join(pendingDir, `PreToolUse-${hookEventId}.json`))).rejects.toThrow();
      await expect(fs.stat(path.join(timingDir, `PreToolUse-${hookEventId}.json`))).rejects.toThrow();
      await expect(invoke(
        handlers,
        "claude_tmux_reply_hook",
        { tabId: "tab-1", environmentId: environment.id, eventKind: "PreToolUse", eventId: "../bad", response: {} },
      )).rejects.toThrow("invalid hook event id");

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(transcriptDir, `${status.session_id}.jsonl`),
        `${JSON.stringify({ type: "user", message: { role: "user", content: "Hello" } })}\nnot-json\n${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Hi" } })}\n`,
      );
      await expect(invoke(handlers, "claude_tmux_transcript", { tabId: "tab-1", environmentId: environment.id })).resolves.toEqual([
        { type: "user", message: { role: "user", content: "Hello" } },
        { type: "assistant", message: { role: "assistant", content: "Hi" } },
      ]);
      await expect(invoke(handlers, "claude_tmux_list_previous_sessions", { environmentId: environment.id }, context)).resolves.toEqual([
        expect.objectContaining({
          session_id: status.session_id,
          title: "Hello",
          message_count: 3,
        }),
      ]);

      const terminalSessionId = await invoke(
        handlers,
        "claude_tmux_create_interactive_terminal",
        { tabId: "tab-1", environmentId: environment.id, cols: 120, rows: 40 },
        context,
      ) as string;
      await invoke(handlers, "claude_tmux_start_interactive_terminal", { terminalSessionId }, context);
      await invoke(handlers, "claude_tmux_write_interactive_terminal", { terminalSessionId, data: "abc\r\n\u001b[A\u007f" });
      await invoke(handlers, "claude_tmux_resize_interactive_terminal", { terminalSessionId, cols: 100, rows: 30 });
      await invoke(handlers, "claude_tmux_detach_interactive_terminal", { terminalSessionId });
      await invoke(handlers, "claude_tmux_stop", { tabId: "tab-1", environmentId: environment.id }, context);

      const tmuxLog = await fs.readFile(log, "utf8");
      expect(tmuxLog).toContain("resize-window");
      expect(tmuxLog).toContain("capture-pane");
      expect(tmuxLog).toContain("send-keys -t");
      expect(tmuxLog).toContain("-l abc");
      expect(tmuxLog).toContain("-- Enter");
      expect(tmuxLog).toContain("-- C-j");
      expect(tmuxLog).toContain("-- Up");
      expect(tmuxLog).toContain("-- BSpace");
      expect(emitted.some((item) => item.event === "claude-tmux:event")).toBe(true);
      const terminalOutput = emitted.find((item) => item.event === `terminal-output-${terminalSessionId}`);
      expect(terminalOutput).toBeDefined();
      // Pins the current plain UTF-8 shape and exact-repaint marker.
      const terminalPayload = terminalOutput!.payload as Record<string, unknown>;
      expect(Object.keys(terminalPayload)).toEqual(["text", "full"]);
      expect(terminalPayload.full).toBe(true);
      expect(terminalPayload.text).toBe("\u001b[H\u001b[2Jbypass permissions on");
    });
  });

  test("generated blocking hooks use an integer timeout and fail closed on expiry", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-hook-timeout", environmentId: environment.id },
        context,
      ) as { session_id: string };

      const installedScript = await fs.readFile(path.join(runtimeRoot, "hook.sh"), "utf8");
      const timeout = installedScript.match(/^TIMEOUT_SECS=(\d+)$/m);
      expect(timeout?.[1]).toBe("300");
      expect(installedScript).toContain("REQUESTED_AT_MS=\"$(epoch_millis)\"");
      expect(installedScript).toContain("EXPIRES_AT_MS=$((REQUESTED_AT_MS + TIMEOUT_SECS * 1000))");
      expect(installedScript).toContain("sleep \"$TIMEOUT_SECS\" &");
      expect(installedScript).not.toContain("TIMEOUT_SECS * 4");

      // Exercise the real generated shell branches without waiting five
      // minutes. Only this disposable test copy receives a zero timeout.
      const immediateScript = installedScript.replace(/^TIMEOUT_SECS=\d+$/m, "TIMEOUT_SECS=0");
      const immediateScriptPath = path.join(runtimeRoot, "hook-immediate-timeout.sh");
      await fs.writeFile(immediateScriptPath, immediateScript);

      const runHook = (kind: "PreToolUse" | "PermissionRequest" | "Elicitation") => {
        const result = spawnSync("bash", [immediateScriptPath, kind], {
          encoding: "utf8",
          input: JSON.stringify({ session_id: status.session_id }),
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        return JSON.parse(result.stdout) as unknown;
      };

      expect(runHook("PreToolUse")).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Approval timed out without a user response.",
        },
      });
      expect(runHook("PermissionRequest")).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "Permission request timed out without a user response.",
          },
        },
      });
      expect(runHook("Elicitation")).toEqual({
        hookSpecificOutput: {
          hookEventName: "Elicitation",
          action: "cancel",
        },
      });

      const sessionRoot = path.join(runtimeRoot, "sessions", status.session_id);
      expect(await fs.readdir(path.join(sessionRoot, "pending"))).toEqual([]);
      expect(await fs.readdir(path.join(sessionRoot, "timing"))).toEqual([]);
      expect(await fs.readdir(path.join(sessionRoot, "timeout"))).toHaveLength(3);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-hook-timeout", environmentId: environment.id },
        context,
      );
    });
  });

  test("validates planMode strictly without sending input for malformed requests", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-validation", environmentId: environment.id },
        context,
      );
      const before = await fs.readFile(log, "utf8");

      for (const planMode of [undefined, null, "true", 0]) {
        await expect(invoke(
          handlers,
          "claude_tmux_switch_plan_mode",
          { tabId: "tab-plan-validation", environmentId: environment.id, planMode },
          context,
        )).rejects.toThrow("Expected planMode to be a boolean");
      }

      expect(await fs.readFile(log, "utf8")).toBe(before);
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-plan-validation", environmentId: environment.id },
        context,
      );
    });
  });

  test("enters plan directly from every supported pane mode without triggering Auto opt-in", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log, alive }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-modes", environmentId: environment.id },
        context,
      ) as { tmux_session: string };
      const modePath = path.join(alive, `${status.tmux_session}.mode`);
      await fs.writeFile(path.join(alive, `${status.tmux_session}.auto-prompt-on-btab`), "");

      for (const sourceMode of ["bypassPermissions", "default", "acceptEdits", "auto", "dontAsk"]) {
        await fs.writeFile(modePath, sourceMode);
        await expect(invoke(
          handlers,
          "claude_tmux_switch_plan_mode",
          { tabId: "tab-plan-modes", environmentId: environment.id, planMode: true },
          context,
        )).resolves.toBe("plan");
        await expect(fs.readFile(modePath, "utf8")).resolves.toBe("plan");
      }

      const beforeBuild = await fs.readFile(log, "utf8");
      expect(beforeBuild).not.toContain("-- BTab");

      await expect(invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-plan-modes", environmentId: environment.id, planMode: false },
        context,
      )).resolves.toBe("bypassPermissions");
      await expect(fs.readFile(modePath, "utf8")).resolves.toBe("bypassPermissions");
      expect(await fs.readFile(log, "utf8")).toContain("-- BTab");

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-plan-modes", environmentId: environment.id },
        context,
      );
    });
  });

  test("reports prompt, exit, capture, send, and transition failures", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-errors", environmentId: environment.id },
        context,
      ) as { tmux_session: string };
      const prefix = path.join(alive, status.tmux_session);
      const modePath = `${prefix}.mode`;
      const switchToPlan = () => invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-plan-errors", environmentId: environment.id, planMode: true },
        context,
      );

      await fs.writeFile(modePath, "selection");
      await expect(switchToPlan()).rejects.toThrow("Finish the active Claude prompt");

      await fs.writeFile(modePath, "exited");
      await expect(switchToPlan()).rejects.toThrow("Claude exited before its mode could be changed");

      await fs.writeFile(modePath, "bypassPermissions");
      await fs.writeFile(`${prefix}.fail-capture`, "");
      await expect(switchToPlan()).rejects.toThrow("capture failed");
      await fs.rm(`${prefix}.fail-capture`);

      await fs.writeFile(`${prefix}.fail-send`, "");
      await expect(switchToPlan()).rejects.toThrow("send failed");
      await fs.rm(`${prefix}.fail-send`);
      await fs.rm(`${prefix}.input`, { force: true });

      await fs.writeFile(`${prefix}.ignore-plan`, "");
      await expect(switchToPlan()).rejects.toThrow("Claude did not enter plan; observed bypassPermissions");
      await fs.rm(`${prefix}.ignore-plan`);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-plan-errors", environmentId: environment.id },
        context,
      );
    });
  });

  test("serializes interactive input and interrupts behind a mode transition", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive, log }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-lock", environmentId: environment.id },
        context,
      ) as { tmux_session: string };
      await fs.writeFile(path.join(alive, `${status.tmux_session}.delay-plan`), "");
      const terminalSessionId = await invoke(
        handlers,
        "claude_tmux_create_interactive_terminal",
        { tabId: "tab-plan-lock", environmentId: environment.id, cols: 100, rows: 30 },
        context,
      ) as string;

      const switching = invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-plan-lock", environmentId: environment.id, planMode: true },
        context,
      );
      await waitFor(async () => (await fs.readFile(log, "utf8")).includes("-- Enter"));

      const writing = invoke(
        handlers,
        "claude_tmux_write_interactive_terminal",
        { terminalSessionId, data: "serialized-input" },
        context,
      );
      const interrupting = invoke(
        handlers,
        "claude_tmux_interrupt",
        { tabId: "tab-plan-lock", environmentId: environment.id },
        context,
      );

      await delay(50);
      const whileSwitching = await fs.readFile(log, "utf8");
      expect(whileSwitching).not.toContain("-l serialized-input");
      expect(whileSwitching).not.toContain("-- Escape");

      await expect(switching).resolves.toBe("plan");
      await expect(writing).resolves.toBeUndefined();
      await expect(interrupting).resolves.toBeUndefined();
      const after = await fs.readFile(log, "utf8");
      expect(after.indexOf("-l serialized-input")).toBeGreaterThan(after.indexOf("-- Enter"));
      expect(after.indexOf("-- Escape")).toBeGreaterThan(after.indexOf("-l serialized-input"));

      const submitting = invoke(
        handlers,
        "claude_tmux_submit",
        { tabId: "tab-plan-lock", environmentId: environment.id, text: "Run the checks" },
        context,
      );
      const switchingDuringSubmit = invoke(
        handlers,
        "claude_tmux_switch_plan_mode",
        { tabId: "tab-plan-lock", environmentId: environment.id, planMode: false },
        context,
      );
      const switchingExpectation = expect(switchingDuringSubmit).rejects.toThrow(
        "Cannot switch Claude mode while a turn is running",
      );
      await expect(submitting).resolves.toBeUndefined();
      await switchingExpectation;
      await invoke(
        handlers,
        "claude_tmux_interrupt",
        { tabId: "tab-plan-lock", environmentId: environment.id },
        context,
      );

      await invoke(
        handlers,
        "claude_tmux_detach_interactive_terminal",
        { terminalSessionId },
        context,
      );
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-plan-lock", environmentId: environment.id },
        context,
      );
    });
  });

  test("marks a session busy after the backend submits an initial prompt", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      await invoke(
        handlers,
        "claude_tmux_start",
        {
          tabId: "tab-initial",
          environmentId: environment.id,
          initialPrompt: "Run the audit",
        },
        context,
      );

      await waitFor(async () => {
        const status = await invoke(
          handlers,
          "claude_tmux_status",
          { tabId: "tab-initial", environmentId: environment.id },
          context,
        ) as { busy: boolean } | null;
        return status?.busy === true;
      }, 3_000);

      try {
        expect(await fs.readFile(log, "utf8")).not.toContain(" --settings ");
        const beforeSwitch = await fs.readFile(log, "utf8");
        await expect(invoke(
          handlers,
          "claude_tmux_switch_plan_mode",
          { tabId: "tab-initial", environmentId: environment.id, planMode: true },
          context,
        )).rejects.toThrow("Cannot switch Claude mode while a turn is running");
        expect(await fs.readFile(log, "utf8")).toBe(beforeSwitch);
        await expect(invoke(
          handlers,
          "claude_tmux_switch_fast_mode",
          { tabId: "tab-initial", environmentId: environment.id, fastMode: true },
          context,
        )).rejects.toThrow("Cannot switch Claude fast mode while a turn is running");
        expect(await fs.readFile(log, "utf8")).toBe(beforeSwitch);

        await invoke(
          handlers,
          "claude_tmux_stop",
          { tabId: "tab-initial", environmentId: environment.id },
          context,
        );
      } finally {
        // After stop the session is removed from the manager; status returns null.
        const after = await invoke(
          handlers,
          "claude_tmux_status",
          { tabId: "tab-initial", environmentId: environment.id },
          context,
        );
        expect(after).toBeNull();
      }
    });
  });

  test("falls back to the newest current-session transcript when Claude writes a different JSONL filename", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-fallback", environmentId: environment.id },
        context,
      ) as { session_id: string; running: boolean };
      expect(status.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });

      const oldPath = path.join(transcriptDir, "old-session.jsonl");
      await fs.writeFile(oldPath, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Old" } })}\n`);
      await fs.utimes(oldPath, new Date(0), new Date(0));

      const fallbackPath = path.join(transcriptDir, "claude-owned-session.jsonl");
      await fs.writeFile(
        fallbackPath,
        `${JSON.stringify({ sessionId: status.session_id, type: "assistant", message: { role: "assistant", content: "Visible" } })}\n`,
      );

      await expect(invoke(
        handlers,
        "claude_tmux_transcript",
        { tabId: "tab-fallback", environmentId: environment.id },
      )).resolves.toEqual([
        { sessionId: status.session_id, type: "assistant", message: { role: "assistant", content: "Visible" } },
      ]);

      await invoke(handlers, "claude_tmux_stop", { tabId: "tab-fallback", environmentId: environment.id }, context);
    });
  });

  test("does not bind a fresh tab to another active tab's transcript fallback", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      const reviewStatus = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "review-tab", environmentId: environment.id, initialPrompt: "Review this" },
        context,
      ) as { session_id: string; running: boolean };
      expect(reviewStatus.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(transcriptDir, "review-owned-session.jsonl"),
        `${JSON.stringify({ sessionId: reviewStatus.session_id, type: "assistant", message: { role: "assistant", content: "Review transcript" } })}\n`,
      );

      const freshStatus = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "fresh-tab", environmentId: environment.id },
        context,
      ) as { session_id: string; running: boolean };
      expect(freshStatus.running).toBe(true);
      expect(freshStatus.session_id).not.toBe(reviewStatus.session_id);

      await expect(invoke(
        handlers,
        "claude_tmux_transcript",
        { tabId: "fresh-tab", environmentId: environment.id },
      )).resolves.toEqual([]);

      await fs.writeFile(
        path.join(transcriptDir, "fresh-owned-session.jsonl"),
        `${JSON.stringify({ sessionId: freshStatus.session_id, type: "assistant", message: { role: "assistant", content: "Fresh transcript" } })}\n`,
      );

      await expect(invoke(
        handlers,
        "claude_tmux_transcript",
        { tabId: "fresh-tab", environmentId: environment.id },
      )).resolves.toEqual([
        { sessionId: freshStatus.session_id, type: "assistant", message: { role: "assistant", content: "Fresh transcript" } },
      ]);

      await invoke(handlers, "claude_tmux_stop", { tabId: "review-tab", environmentId: environment.id }, context);
      await invoke(handlers, "claude_tmux_stop", { tabId: "fresh-tab", environmentId: environment.id }, context);
    });
  });

  test("does not use transcript fallback when fresh candidates are ambiguous", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-ambiguous", environmentId: environment.id },
        context,
      ) as { running: boolean };
      expect(status.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(transcriptDir, "first-fresh.jsonl"),
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "First" } })}\n`,
      );
      await fs.writeFile(
        path.join(transcriptDir, "second-fresh.jsonl"),
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Second" } })}\n`,
      );

      await expect(invoke(
        handlers,
        "claude_tmux_transcript",
        { tabId: "tab-ambiguous", environmentId: environment.id },
      )).resolves.toEqual([]);

      await invoke(handlers, "claude_tmux_stop", { tabId: "tab-ambiguous", environmentId: environment.id }, context);
    });
  });

  test("continues tailing live transcript lines after non-ASCII content", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-tail", environmentId: environment.id },
        context,
      ) as { session_id: string; running: boolean };
      expect(status.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      const transcriptPath = path.join(transcriptDir, `${status.session_id}.jsonl`);
      await fs.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Hello £" } })}\n`,
      );

      await waitFor(() => emitted.some((item) =>
        item.event === "claude-tmux:event" &&
        (item.payload as { kind?: string; line?: { message?: { content?: string } } }).kind === "transcript-line" &&
        (item.payload as { line?: { message?: { content?: string } } }).line?.message?.content === "Hello £"
      ));

      await fs.appendFile(
        transcriptPath,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Second message" } })}\n`,
      );

      await waitFor(() => emitted.some((item) =>
        item.event === "claude-tmux:event" &&
        (item.payload as { kind?: string; line?: { message?: { content?: string } } }).kind === "transcript-line" &&
        (item.payload as { line?: { message?: { content?: string } } }).line?.message?.content === "Second message"
      ));

      await fs.appendFile(
        transcriptPath,
        `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`,
      );
      await waitFor(() => emitted.some((item) =>
        item.event === "claude-tmux:event" &&
        (item.payload as { kind?: string; permission_mode?: string }).kind === "permission-mode-changed" &&
        (item.payload as { permission_mode?: string }).permission_mode === "plan"
      ));
      await expect(invoke(
        handlers,
        "claude_tmux_status",
        { tabId: "tab-tail", environmentId: environment.id },
        context,
      )).resolves.toEqual(expect.objectContaining({ permission_mode: "plan" }));

      await invoke(handlers, "claude_tmux_stop", { tabId: "tab-tail", environmentId: environment.id }, context);
    });
  });

  test("stamps the derived task list onto transcript lines and serves it on demand", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: {
          getEnvironment: async () => environment,
        },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };

      const status = await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-tasks", environmentId: environment.id },
        context,
      ) as { session_id: string; running: boolean };
      expect(status.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      const transcriptPath = path.join(transcriptDir, `${status.session_id}.jsonl`);
      const jsonl = (line: unknown) => `${JSON.stringify(line)}\n`;

      // A complete task tool call spans two lines: the use carries the args,
      // the result carries the assigned id.
      await fs.writeFile(
        transcriptPath,
        jsonl({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu-task-1",
                name: "TaskCreate",
                input: { subject: "Derived in the backend" },
              },
            ],
          },
        }) +
          jsonl({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-task-1",
                  content: "Task #1 created successfully: Derived in the backend",
                },
              ],
            },
          }),
      );

      // A full read stamps each line with the list as it stood at that line.
      const lines = await invoke(
        handlers,
        "claude_tmux_transcript",
        { tabId: "tab-tasks", environmentId: environment.id },
      ) as Array<{ taskSnapshots?: Record<string, unknown> }>;

      expect(lines).toHaveLength(2);
      // The tool_use line changed nothing; the result line carries the list,
      // keyed by the tool call it belongs to.
      expect(lines[0]?.taskSnapshots).toBeUndefined();
      expect(lines[1]?.taskSnapshots).toEqual({
        "tu-task-1": {
          items: [{ id: "1", subject: "Derived in the backend", status: "pending" }],
          complete: true,
          changedTaskId: "1",
        },
      });

      // ...and the same state is available without replaying the transcript,
      // which is how a tab that was unmounted catches up.
      await expect(invoke(
        handlers,
        "claude_tmux_tasks",
        { tabId: "tab-tasks", environmentId: environment.id },
      )).resolves.toEqual({
        items: [{ id: "1", subject: "Derived in the backend", status: "pending" }],
        complete: true,
      });

      // Live tail lines are stamped the same way.
      await fs.appendFile(
        transcriptPath,
        jsonl({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu-task-2",
                name: "TaskUpdate",
                input: { taskId: "1", status: "completed" },
              },
            ],
          },
        }) +
          jsonl({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-task-2",
                  content: "Updated task #1 status",
                },
              ],
            },
          }),
      );

      await waitFor(() => emitted.some((item) =>
        item.event === "claude-tmux:event" &&
        (item.payload as { kind?: string }).kind === "transcript-line" &&
        (item.payload as { line?: { taskSnapshots?: Record<string, unknown> } })
          .line?.taskSnapshots?.["tu-task-2"] !== undefined
      ));

      const tailed = emitted
        .map((item) => item.payload as {
          line?: { taskSnapshots?: Record<string, { items?: unknown; changedTaskId?: string }> };
        })
        .filter((payload) => payload.line?.taskSnapshots)
        .at(-1);
      expect(tailed?.line?.taskSnapshots?.["tu-task-2"]).toEqual({
        items: [{ id: "1", subject: "Derived in the backend", status: "completed" }],
        complete: true,
        changedTaskId: "1",
      });

      await invoke(handlers, "claude_tmux_stop", { tabId: "tab-tasks", environmentId: environment.id }, context);
    });
  });
});
