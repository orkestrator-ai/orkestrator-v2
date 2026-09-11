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

describe("Electron tmux launch flags and interactive controls", () => {
  test("starts local Claude sessions with the managed toolchain binary", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const toolchainBinDir = await createTempDir("ork-tmux-toolchain-");
      const managedClaude = path.join(toolchainBinDir, "claude");
      await fs.writeFile(
        managedClaude,
        `#!/bin/sh
case "$1" in
  --version) printf '2.1.2\n' ;;
  --help) printf '%s\n' '--session-id <uuid>' ;;
esac
exit 0
`,
      );
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
      await fs.writeFile(
        oldClaude,
        `#!/bin/sh
case "$1" in
  --help) printf '%s\\n' '--session-id <uuid>' ;;
  *) printf '2.1.2\\n' ;;
esac
exit 0
`,
      );
      await fs.chmod(oldClaude, 0o500);
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
        toolchainBinDir,
      };

      const status = (await invoke(
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
      )) as { fast_mode: boolean };

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
      await fs.writeFile(
        splitClaude,
        `#!/bin/sh
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
`,
      );
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

      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        {
          tabId: "tab-resume",
          environmentId: environment.id,
          model: "opus",
          effort: "medium",
          resumeSessionId,
        },
        context,
      )) as { session_id: string; resumed: boolean; fast_mode: boolean | null };

      expect(status.session_id).toBe(resumeSessionId);
      expect(status.resumed).toBe(true);
      expect(status.fast_mode).toBeNull();

      const launchLog = await fs.readFile(log, "utf8");
      expect(launchLog).toContain(` --resume ${resumeSessionId}`);
      expect(launchLog).not.toContain("--session-id");
      expect(launchLog).toContain(" --model 'opus'");
      expect(launchLog).toContain(" --effort 'medium'");
      expect(launchLog).not.toContain(" --settings ");
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
      const first = (await invoke(handlers, "claude_tmux_start", args, context)) as {
        session_id: string;
        observation: { generation?: string; revision: number };
      };
      const second = (await invoke(
        handlers,
        "claude_tmux_start",
        { ...args, replaceExisting: true },
        context,
      )) as { session_id: string; observation: { generation?: string; revision: number } };

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
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      )) as { session_id: string };
      const session = tmuxSessionName(environment.id, tabId);
      const inputBuffer = path.join(alive, `buffer-claude-tmux-input-${session}`);

      // sendText pastes through a tmux buffer rather than send-keys, so the
      // pasted payload has to survive verbatim.
      await invoke(handlers, "claude_tmux_send_text", {
        tabId,
        environmentId: environment.id,
        text: "hello 👋",
      });
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("hello 👋");
      await expect(fs.readFile(path.join(alive, `${session}.input`), "utf8")).resolves.toBe(
        "hello 👋",
      );

      await invoke(handlers, "claude_tmux_send_keys", {
        tabId,
        environmentId: environment.id,
        keys: ["Escape", "Enter"],
      });
      expect(await fs.readFile(log, "utf8")).toContain("-- Escape Enter");

      await invoke(handlers, "claude_tmux_resize", {
        tabId,
        environmentId: environment.id,
        cols: 120,
        rows: 40,
      });
      expect(await fs.readFile(log, "utf8")).toContain(`resize-window -t ${session} -x 120 -y 40`);
      await expect(
        invoke(handlers, "claude_tmux_resize", {
          tabId,
          environmentId: environment.id,
          cols: 0,
          rows: 40,
        }),
      ).rejects.toThrow("cols");

      // A blank model or effort must be rejected before anything reaches tmux.
      const beforeRejected = await fs.readFile(log, "utf8");
      await expect(
        invoke(handlers, "claude_tmux_switch_model", {
          tabId,
          environmentId: environment.id,
          model: "   ",
        }),
      ).rejects.toThrow("model id cannot be empty");
      await expect(
        invoke(handlers, "claude_tmux_switch_effort", {
          tabId,
          environmentId: environment.id,
          effort: "",
        }),
      ).rejects.toThrow("effort level cannot be empty");
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
        fs
          .readFile(path.join(sessionRoot, "response", "PreToolUse-event-9.json"), "utf8")
          .then(JSON.parse),
      ).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "not this time",
        },
      });
      await expect(
        fs.stat(path.join(sessionRoot, "pending", "PreToolUse-event-9.json")),
      ).rejects.toThrow();

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
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      );
      const session = tmuxSessionName(environment.id, tabId);
      const inputBuffer = path.join(alive, `buffer-claude-tmux-input-${session}`);

      await invoke(handlers, "claude_tmux_switch_model", {
        tabId,
        environmentId: environment.id,
        model: "opus",
      });
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("/model opus");

      await invoke(handlers, "claude_tmux_switch_effort", {
        tabId,
        environmentId: environment.id,
        effort: "high",
      });
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("/effort high");

      await invoke(
        handlers,
        "claude_tmux_switch_fast_mode",
        { tabId, environmentId: environment.id, fastMode: true },
        context,
      );
      await expect(fs.readFile(inputBuffer, "utf8")).resolves.toBe("/fast on");
      await expect(
        invoke(handlers, "claude_tmux_status", { tabId, environmentId: environment.id }, context),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await expect(fs.readFile(path.join(alive, `${session}.fast-option`), "utf8")).resolves.toBe(
        "1",
      );
      expect(emitted).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ kind: "fast-mode-changed", fast_mode: true }),
        }),
      );

      await invoke(
        handlers,
        "claude_tmux_switch_fast_mode",
        {
          tabId,
          environmentId: environment.id,
          fastMode: false,
        },
        context,
      );
      await expect(
        invoke(handlers, "claude_tmux_status", { tabId, environmentId: environment.id }, context),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: false }));
      await expect(fs.readFile(path.join(alive, `${session}.fast-option`), "utf8")).resolves.toBe(
        "0",
      );
      const beforeNoOp = await fs.readFile(path.join(alive, `${session}.fast-option`), "utf8");
      const eventCountBeforeNoOp = emitted.length;
      await invoke(
        handlers,
        "claude_tmux_switch_fast_mode",
        {
          tabId,
          environmentId: environment.id,
          fastMode: false,
        },
        context,
      );
      expect(await fs.readFile(path.join(alive, `${session}.fast-option`), "utf8")).toBe(
        beforeNoOp,
      );
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
      await expect(
        invoke(
          handlers,
          "claude_tmux_start",
          {
            tabId,
            environmentId: environment.id,
            fastMode: false,
          },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));

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

      await expect(
        invoke(
          handlers,
          "claude_tmux_start",
          {
            tabId,
            environmentId: environment.id,
            fastMode: true,
          },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: null }));

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

      await expect(
        invoke(
          handlers,
          "claude_tmux_start",
          {
            tabId,
            environmentId: environment.id,
          },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await expect(fs.readFile(path.join(alive, `${session}.fast-option`), "utf8")).resolves.toBe(
        "1",
      );

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
      await expect(
        invoke(
          handlers,
          "claude_tmux_start",
          {
            tabId: falseTabId,
            environmentId: environment.id,
          },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: false }));

      const garbageTabId = "tab-fast-option-garbage";
      const garbageSession = tmuxSessionName(environment.id, garbageTabId);
      await fs.writeFile(path.join(alive, garbageSession), "");
      await fs.writeFile(path.join(alive, `${garbageSession}.mode`), "bypassPermissions");
      await fs.writeFile(path.join(alive, `${garbageSession}.fast-option`), "sometimes");
      await expect(
        invoke(
          handlers,
          "claude_tmux_start",
          {
            tabId: garbageTabId,
            environmentId: environment.id,
          },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: null }));

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: falseTabId, environmentId: environment.id },
        context,
      );
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: garbageTabId, environmentId: environment.id },
        context,
      );
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
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      );
      await fs.writeFile(path.join(alive, `${session}.fast-pane`), "Fast mode ON");

      await invoke(
        handlers,
        "claude_tmux_switch_fast_mode",
        {
          tabId,
          environmentId: environment.id,
          fastMode: true,
        },
        context,
      );
      expect(existsSync(path.join(alive, `${session}.input`))).toBe(false);
      await expect(fs.readFile(path.join(alive, `${session}.fast-option`), "utf8")).resolves.toBe(
        "1",
      );

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
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      );
      await fs.writeFile(
        path.join(alive, `${session}.fast-pane`),
        "Fast mode OFF\nFast mode requires an eligible plan",
      );

      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_fast_mode",
          {
            tabId,
            environmentId: environment.id,
            fastMode: true,
          },
          context,
        ),
      ).resolves.toBeUndefined();
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
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));

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
      await invoke(
        handlers,
        "claude_tmux_start",
        {
          tabId,
          environmentId: environment.id,
          fastMode: true,
        },
        context,
      );
      await fs.writeFile(path.join(alive, `${session}.fast-pane`), "Fast mode OFF");

      await invoke(
        handlers,
        "claude_tmux_switch_fast_mode",
        {
          tabId,
          environmentId: environment.id,
          fastMode: true,
        },
        context,
      );
      await expect(
        fs.readFile(path.join(alive, `buffer-claude-tmux-input-${session}`), "utf8"),
      ).resolves.toBe("/fast on");
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
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));

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
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: beforeTab, environmentId: environment.id },
        context,
      );
      await fs.writeFile(path.join(alive, `${beforeSession}.mode`), "exited");
      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_fast_mode",
          {
            tabId: beforeTab,
            environmentId: environment.id,
            fastMode: true,
          },
          context,
        ),
      ).rejects.toThrow("Claude exited before fast mode could be changed");

      const duringTab = "tab-fast-exited-during";
      const duringSession = tmuxSessionName(environment.id, duringTab);
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: duringTab, environmentId: environment.id },
        context,
      );
      await fs.writeFile(path.join(alive, `${duringSession}.exit-fast`), "");
      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_fast_mode",
          {
            tabId: duringTab,
            environmentId: environment.id,
            fastMode: true,
          },
          context,
        ),
      ).rejects.toThrow("Claude exited before fast mode could be changed");

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: beforeTab, environmentId: environment.id },
        context,
      );
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: duringTab, environmentId: environment.id },
        context,
      );
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
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      );
      await fs.writeFile(path.join(alive, `${session}.reject-fast`), "");

      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_fast_mode",
          {
            tabId,
            environmentId: environment.id,
            fastMode: true,
          },
          context,
        ),
      ).rejects.toThrow("Fast mode is unavailable for this model");
      await expect(
        invoke(handlers, "claude_tmux_status", { tabId, environmentId: environment.id }, context),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: false }));
      expect(
        emitted.filter(
          ({ payload }) => (payload as { kind?: string }).kind === "fast-mode-changed",
        ),
      ).toHaveLength(0);

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
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      );
      const beforeMalformed = await fs.readFile(log, "utf8");
      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_fast_mode",
          {
            tabId,
            environmentId: environment.id,
            fastMode: "yes",
          },
          context,
        ),
      ).rejects.toThrow("Expected fastMode to be a boolean");
      expect(await fs.readFile(log, "utf8")).toBe(beforeMalformed);

      await fs.writeFile(path.join(alive, `${session}.mode`), "selection");
      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_fast_mode",
          {
            tabId,
            environmentId: environment.id,
            fastMode: true,
          },
          context,
        ),
      ).rejects.toThrow("Finish the active Claude prompt");
      await fs.writeFile(path.join(alive, `${session}.mode`), "bypassPermissions");

      await fs.writeFile(path.join(alive, `${session}.ignore-fast`), "");
      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_fast_mode",
          {
            tabId,
            environmentId: environment.id,
            fastMode: true,
          },
          context,
        ),
      ).rejects.toThrow("Claude did not confirm fast mode on");
      await expect(
        invoke(handlers, "claude_tmux_status", { tabId, environmentId: environment.id }, context),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: false }));

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
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      );
      await fs.writeFile(path.join(alive, `${session}.fail-fast-option`), "");

      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_fast_mode",
          {
            tabId,
            environmentId: environment.id,
            fastMode: true,
          },
          context,
        ),
      ).rejects.toThrow("Fast mode changed but its restart metadata could not be saved");
      await expect(
        invoke(handlers, "claude_tmux_status", { tabId, environmentId: environment.id }, context),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      expect(emitted).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ kind: "fast-mode-changed", fast_mode: true }),
        }),
      );

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
      await expect(
        invoke(
          handlers,
          "claude_tmux_start",
          {
            tabId: retryTab,
            environmentId: environment.id,
            fastMode: true,
          },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await expect(
        fs.readFile(path.join(alive, `${retrySession}.fast-option`), "utf8"),
      ).resolves.toBe("1");

      const repairTab = "tab-fast-launch-repair";
      const repairSession = tmuxSessionName(environment.id, repairTab);
      await fs.writeFile(path.join(alive, `${repairSession}.fail-fast-option`), "");
      await expect(
        invoke(
          handlers,
          "claude_tmux_start",
          {
            tabId: repairTab,
            environmentId: environment.id,
            fastMode: true,
          },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await fs.rm(path.join(alive, `${repairSession}.fail-fast-option`));
      await expect(
        invoke(
          handlers,
          "claude_tmux_start",
          {
            tabId: repairTab,
            environmentId: environment.id,
            fastMode: false,
          },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
      await expect(
        fs.readFile(path.join(alive, `${repairSession}.fast-option`), "utf8"),
      ).resolves.toBe("1");

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: retryTab, environmentId: environment.id },
        context,
      );
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: repairTab, environmentId: environment.id },
        context,
      );
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
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      );
      await fs.writeFile(path.join(alive, `${session}.delay-fast`), "");

      const switching = invoke(
        handlers,
        "claude_tmux_switch_fast_mode",
        {
          tabId,
          environmentId: environment.id,
          fastMode: true,
        },
        context,
      );
      await waitFor(() => existsSync(path.join(alive, `${session}.input`)));
      const reattaching = invoke(
        handlers,
        "claude_tmux_start",
        {
          tabId,
          environmentId: environment.id,
          fastMode: false,
        },
        context,
      );

      await expect(switching).resolves.toBeUndefined();
      await expect(reattaching).resolves.toEqual(expect.objectContaining({ fast_mode: true }));
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
      ).resolves.toEqual(expect.objectContaining({ fast_mode: true }));

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  });

});
