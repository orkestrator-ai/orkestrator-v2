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

describe("Electron tmux MCP config and session start", () => {
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
          connection: (environmentId: string, projectId: string, target: "host" | "container") => {
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

      expect(connectionCalls).toEqual([
        {
          environmentId: environment.id,
          projectId: environment.projectId,
          target: "host",
        },
      ]);
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
      expect(await fs.readFile(log, "utf8")).toContain(`--mcp-config '${configPath}'`);

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

      await expect(
        invoke(
          handlers,
          "claude_tmux_start",
          { tabId: "tab-agent-config-write-failure", environmentId: environment.id },
          context,
        ),
      ).rejects.toThrow();

      expect((await fs.stat(configPath)).isDirectory()).toBe(true);
      expect(
        (await fs.readdir(runtimeRoot)).filter(
          (name) => name.startsWith("agent-mcp.json.") && name.endsWith(".tmp"),
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

      await expect(
        invoke(
          handlers,
          "claude_tmux_start",
          { tabId: "tab-agent-launch-failure", environmentId: environment.id },
          context,
        ),
      ).rejects.toThrow("tmux new-session failed");

      await expect(fs.stat(configPath)).rejects.toThrow();
      expect(
        (await fs.readdir(runtimeRoot)).filter(
          (name) => name.startsWith("agent-mcp.json.") && name.endsWith(".tmp"),
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
          connection: (environmentId: string, projectId: string, target: "host" | "container") => {
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

      expect(connectionCalls).toEqual([
        {
          environmentId: environment.id,
          projectId: environment.projectId,
          target: "container",
        },
      ]);
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
          await fs.readFile(path.join(worktree, ".claude", "settings.local.json"), "utf8"),
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
    await expect(invoke(handlers, "claude_tmux_interrupt", args)).rejects.toThrow(
      "tmux session not running",
    );
    await expect(invoke(handlers, "claude_tmux_pending_hooks", args)).rejects.toThrow(
      "tmux session not running",
    );
    await expect(invoke(handlers, "claude_tmux_tasks", args)).rejects.toThrow(
      "tmux session not running",
    );
    await expect(
      invoke(handlers, "claude_tmux_detach_interactive_terminal", { terminalSessionId: "missing" }),
    ).resolves.toBeUndefined();
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

      const first = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-1782973296000-1", environmentId: environment.id },
        context,
      )) as { tmux_session: string; running: boolean };
      const second = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-1782973296000-2", environmentId: environment.id },
        context,
      )) as { tmux_session: string; running: boolean };

      expect(first.running).toBe(true);
      expect(second.running).toBe(true);
      expect(first.tmux_session).not.toBe(second.tmux_session);

      const tmuxLog = await fs.readFile(log, "utf8");
      const newSessionLines = tmuxLog.split("\n").filter((line) => line.startsWith("new-session "));
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

      const first = (await invoke(handlers, "claude_tmux_start", args, context)) as {
        session_id: string;
      };
      const attached = (await invoke(handlers, "claude_tmux_start", args, context)) as {
        session_id: string;
      };

      expect(attached.session_id).toBe(first.session_id);
      await waitFor(() =>
        events.some(
          (event) => event.kind === "initial-prompt-sent" && event.session_id === first.session_id,
        ),
      );
      let tmuxLog = await fs.readFile(log, "utf8");
      expect(tmuxLog.split("\n").filter((line) => line.startsWith("new-session "))).toHaveLength(1);
      expect(tmuxLog.split("\n").filter((line) => line.startsWith("paste-buffer "))).toHaveLength(
        1,
      );
      expect(tmuxLog).not.toContain("kill-session");

      const replaced = (await invoke(
        handlers,
        "claude_tmux_start",
        { ...args, initialPrompt: undefined, replaceExisting: true },
        context,
      )) as { session_id: string };
      expect(replaced.session_id).not.toBe(first.session_id);
      tmuxLog = await fs.readFile(log, "utf8");
      expect(tmuxLog.split("\n").filter((line) => line.startsWith("new-session "))).toHaveLength(2);
      expect(tmuxLog).toContain("kill-session");

      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  });

  test("prepares initial-prompt naming in the backend before starting Claude", async () => {
    const prepared: Array<{ environmentId: string; prompt: string }> = [];
    const handlers = createHandlers({
      prepareEnvironmentFirstPrompt: async (environmentId, prompt) => {
        prepared.push({ environmentId, prompt });
      },
    });

    await withFakeTmuxRuntime(async ({ environment }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      await invoke(
        handlers,
        "claude_tmux_start",
        {
          tabId: "backend-naming",
          environmentId: environment.id,
          initialPrompt: "Inspect the workspace",
        },
        context,
      );

      expect(prepared).toEqual([
        { environmentId: environment.id, prompt: "Inspect the workspace" },
      ]);
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "backend-naming", environmentId: environment.id },
        context,
      );
    });
  });

  test("prepares naming from the first direct prompt exactly once", async () => {
    const prepared: Array<{ environmentId: string; prompt: string }> = [];
    const handlers = createHandlers({
      prepareEnvironmentFirstPrompt: async (environmentId, prompt) => {
        prepared.push({ environmentId, prompt });
      },
    });

    await withFakeTmuxRuntime(async ({ environment }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "direct-first-prompt", environmentId: environment.id };
      await invoke(handlers, "claude_tmux_start", args, context);

      await invoke(
        handlers,
        "claude_tmux_submit",
        { ...args, text: "Name this environment" },
        context,
      );
      await invoke(
        handlers,
        "claude_tmux_submit",
        { ...args, text: "This is the second prompt" },
        context,
      );

      expect(prepared).toEqual([
        { environmentId: environment.id, prompt: "Name this environment" },
      ]);
      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  });

  test("does not name a resumed tmux conversation from its first local submit", async () => {
    const prepared: string[] = [];
    const handlers = createHandlers({
      prepareEnvironmentFirstPrompt: async (_environmentId, prompt) => {
        prepared.push(prompt);
      },
    });

    await withFakeTmuxRuntime(async ({ environment }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const args = {
        tabId: "resumed-first-local-prompt",
        environmentId: environment.id,
        resumeSessionId: "provider-session-before-restart",
      };
      await invoke(handlers, "claude_tmux_start", args, context);
      await invoke(
        handlers,
        "claude_tmux_submit",
        { ...args, text: "Continue the existing conversation" },
        context,
      );

      expect(prepared).toEqual([]);
      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  });

  test("does not hold the tmux install lock while first-prompt naming is prepared", async () => {
    const namingGate = deferred<void>();
    let namingStarted = false;
    const handlers = createHandlers({
      prepareEnvironmentFirstPrompt: async () => {
        namingStarted = true;
        await namingGate.promise;
      },
    });

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
      const args = {
        tabId: "delete-during-naming",
        environmentId: environment.id,
        initialPrompt: "Inspect the workspace",
      };
      const start = invoke(handlers, "claude_tmux_start", args, context);
      await waitFor(() => namingStarted);

      environment.deletionRequestedAt = new Date().toISOString();
      await expect(
        cleanupEnvironmentTmux(environment.id, context as unknown as CommandContext),
      ).resolves.toBeUndefined();

      namingGate.resolve();
      await expect(start).rejects.toThrow(`environment ${environment.id} is being deleted`);
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
      const stop = invoke(handlers, "claude_tmux_stop", args, context).finally(() => {
        stopSettled = true;
      });
      await delay(75);
      const settledBeforeStartReleased = stopSettled;
      await fs.writeFile(`${barrier}.release`, "");

      const started = await start;
      await stop;

      expect(settledBeforeStartReleased).toBe(false);
      expect(existsSync(path.join(alive, started.tmux_session))).toBe(false);
      await expect(invoke(handlers, "claude_tmux_status", args, context)).resolves.toBeNull();
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

      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-runtime-root", environmentId: environment.id },
        context,
      )) as { session_id: string };

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
});
