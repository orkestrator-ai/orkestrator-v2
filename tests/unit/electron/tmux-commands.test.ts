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

describe("Electron tmux hooks and transcripts", () => {
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

      const status = (await invoke(
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
      )) as { session_id: string; running: boolean; fast_mode: boolean };
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

      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_plan_mode",
          { tabId: "tab-1", environmentId: environment.id, planMode: true },
          context,
        ),
      ).resolves.toBe("plan");
      await expect(
        invoke(
          handlers,
          "claude_tmux_status",
          { tabId: "tab-1", environmentId: environment.id },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ permission_mode: "plan" }));
      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_plan_mode",
          { tabId: "tab-1", environmentId: environment.id, planMode: false },
          context,
        ),
      ).resolves.toBe("bypassPermissions");
      await expect(
        invoke(
          handlers,
          "claude_tmux_status",
          { tabId: "tab-1", environmentId: environment.id },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ permission_mode: "bypassPermissions" }));

      const switchedLog = await fs.readFile(log, "utf8");
      expect(switchedLog).toContain("send-keys -t");
      expect(switchedLog).toContain("-- BTab");

      const sessionRoot = path.join(runtimeRoot, "sessions", status.session_id);
      const pendingDir = path.join(sessionRoot, "pending");
      const responseDir = path.join(sessionRoot, "response");
      const timingDir = path.join(sessionRoot, "timing");
      await fs.mkdir(pendingDir, { recursive: true });
      const hookEventId = "1700000000-event-1";
      await fs.writeFile(
        path.join(pendingDir, `PreToolUse-${hookEventId}.json`),
        JSON.stringify({ tool_name: "Edit" }),
      );
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
      await Promise.all(
        invalidTimingEventIds.map((eventId) =>
          fs.writeFile(
            path.join(pendingDir, `PermissionRequest-${eventId}.json`),
            JSON.stringify({ tool_name: "Edit" }),
          ),
        ),
      );

      const pendingHooks = (await invoke(handlers, "claude_tmux_pending_hooks", {
        tabId: "tab-1",
        environmentId: environment.id,
      })) as Array<Record<string, unknown>>;
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

      await invoke(handlers, "claude_tmux_reply_hook", {
        tabId: "tab-1",
        environmentId: environment.id,
        eventKind: "PreToolUse",
        eventId: hookEventId,
        response: { ok: true },
      });
      await expect(
        fs.readFile(path.join(responseDir, `PreToolUse-${hookEventId}.json`), "utf8"),
      ).resolves.toBe(JSON.stringify({ ok: true }));
      await expect(
        fs.stat(path.join(pendingDir, `PreToolUse-${hookEventId}.json`)),
      ).rejects.toThrow();
      await expect(
        fs.stat(path.join(timingDir, `PreToolUse-${hookEventId}.json`)),
      ).rejects.toThrow();
      await expect(
        invoke(handlers, "claude_tmux_reply_hook", {
          tabId: "tab-1",
          environmentId: environment.id,
          eventKind: "PreToolUse",
          eventId: "../bad",
          response: {},
        }),
      ).rejects.toThrow("invalid hook event id");

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(transcriptDir, `${status.session_id}.jsonl`),
        `${JSON.stringify({ type: "user", message: { role: "user", content: "Hello" } })}\nnot-json\n${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Hi" } })}\n`,
      );
      await expect(
        invoke(handlers, "claude_tmux_transcript", {
          tabId: "tab-1",
          environmentId: environment.id,
        }),
      ).resolves.toEqual([
        { type: "user", message: { role: "user", content: "Hello" } },
        { type: "assistant", message: { role: "assistant", content: "Hi" } },
      ]);
      await expect(
        invoke(
          handlers,
          "claude_tmux_list_previous_sessions",
          { environmentId: environment.id },
          context,
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          session_id: status.session_id,
          title: "Hello",
          message_count: 3,
        }),
      ]);

      const terminalSessionId = (await invoke(
        handlers,
        "claude_tmux_create_interactive_terminal",
        { tabId: "tab-1", environmentId: environment.id, cols: 120, rows: 40 },
        context,
      )) as string;
      await invoke(
        handlers,
        "claude_tmux_start_interactive_terminal",
        { terminalSessionId },
        context,
      );
      await invoke(handlers, "claude_tmux_write_interactive_terminal", {
        terminalSessionId,
        data: "abc\r\n\u001b[A\u007f",
      });
      await invoke(handlers, "claude_tmux_resize_interactive_terminal", {
        terminalSessionId,
        cols: 100,
        rows: 30,
      });
      await invoke(handlers, "claude_tmux_detach_interactive_terminal", { terminalSessionId });
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-1", environmentId: environment.id },
        context,
      );

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
      const terminalOutput = emitted.find(
        (item) => item.event === `terminal-output-${terminalSessionId}`,
      );
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
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-hook-timeout", environmentId: environment.id },
        context,
      )) as { session_id: string };

      const installedScript = await fs.readFile(path.join(runtimeRoot, "hook.sh"), "utf8");
      const timeout = installedScript.match(/^TIMEOUT_SECS=(\d+)$/m);
      expect(timeout?.[1]).toBe("300");
      expect(installedScript).toContain('REQUESTED_AT_MS="$(epoch_millis)"');
      expect(installedScript).toContain("EXPIRES_AT_MS=$((REQUESTED_AT_MS + TIMEOUT_SECS * 1000))");
      expect(installedScript).toContain('sleep "$TIMEOUT_SECS" &');
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
        await expect(
          invoke(
            handlers,
            "claude_tmux_switch_plan_mode",
            { tabId: "tab-plan-validation", environmentId: environment.id, planMode },
            context,
          ),
        ).rejects.toThrow("Expected planMode to be a boolean");
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
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-modes", environmentId: environment.id },
        context,
      )) as { tmux_session: string };
      const modePath = path.join(alive, `${status.tmux_session}.mode`);
      await fs.writeFile(path.join(alive, `${status.tmux_session}.auto-prompt-on-btab`), "");

      for (const sourceMode of ["bypassPermissions", "default", "acceptEdits", "auto", "dontAsk"]) {
        await fs.writeFile(modePath, sourceMode);
        await expect(
          invoke(
            handlers,
            "claude_tmux_switch_plan_mode",
            { tabId: "tab-plan-modes", environmentId: environment.id, planMode: true },
            context,
          ),
        ).resolves.toBe("plan");
        await expect(fs.readFile(modePath, "utf8")).resolves.toBe("plan");
      }

      const beforeBuild = await fs.readFile(log, "utf8");
      expect(beforeBuild).not.toContain("-- BTab");

      await expect(
        invoke(
          handlers,
          "claude_tmux_switch_plan_mode",
          { tabId: "tab-plan-modes", environmentId: environment.id, planMode: false },
          context,
        ),
      ).resolves.toBe("bypassPermissions");
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
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-errors", environmentId: environment.id },
        context,
      )) as { tmux_session: string };
      const prefix = path.join(alive, status.tmux_session);
      const modePath = `${prefix}.mode`;
      const switchToPlan = () =>
        invoke(
          handlers,
          "claude_tmux_switch_plan_mode",
          { tabId: "tab-plan-errors", environmentId: environment.id, planMode: true },
          context,
        );

      await fs.writeFile(modePath, "selection");
      await expect(switchToPlan()).rejects.toThrow("Finish the active Claude prompt");

      await fs.writeFile(modePath, "exited");
      await expect(switchToPlan()).rejects.toThrow(
        "Claude exited before its mode could be changed",
      );

      await fs.writeFile(modePath, "bypassPermissions");
      await fs.writeFile(`${prefix}.fail-capture`, "");
      await expect(switchToPlan()).rejects.toThrow("capture failed");
      await fs.rm(`${prefix}.fail-capture`);

      await fs.writeFile(`${prefix}.fail-send`, "");
      await expect(switchToPlan()).rejects.toThrow("send failed");
      await fs.rm(`${prefix}.fail-send`);
      await fs.rm(`${prefix}.input`, { force: true });

      await fs.writeFile(`${prefix}.ignore-plan`, "");
      await expect(switchToPlan()).rejects.toThrow(
        "Claude did not enter plan; observed bypassPermissions",
      );
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
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-plan-lock", environmentId: environment.id },
        context,
      )) as { tmux_session: string };
      await fs.writeFile(path.join(alive, `${status.tmux_session}.delay-plan`), "");
      const terminalSessionId = (await invoke(
        handlers,
        "claude_tmux_create_interactive_terminal",
        { tabId: "tab-plan-lock", environmentId: environment.id, cols: 100, rows: 30 },
        context,
      )) as string;

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
        const status = (await invoke(
          handlers,
          "claude_tmux_status",
          { tabId: "tab-initial", environmentId: environment.id },
          context,
        )) as { busy: boolean } | null;
        return status?.busy === true;
      }, 3_000);

      try {
        expect(await fs.readFile(log, "utf8")).not.toContain(" --settings ");
        const beforeSwitch = await fs.readFile(log, "utf8");
        await expect(
          invoke(
            handlers,
            "claude_tmux_switch_plan_mode",
            { tabId: "tab-initial", environmentId: environment.id, planMode: true },
            context,
          ),
        ).rejects.toThrow("Cannot switch Claude mode while a turn is running");
        expect(await fs.readFile(log, "utf8")).toBe(beforeSwitch);
        await expect(
          invoke(
            handlers,
            "claude_tmux_switch_fast_mode",
            { tabId: "tab-initial", environmentId: environment.id, fastMode: true },
            context,
          ),
        ).rejects.toThrow("Cannot switch Claude fast mode while a turn is running");
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

      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-fallback", environmentId: environment.id },
        context,
      )) as { session_id: string; running: boolean };
      expect(status.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });

      const oldPath = path.join(transcriptDir, "old-session.jsonl");
      await fs.writeFile(
        oldPath,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Old" } })}\n`,
      );
      await fs.utimes(oldPath, new Date(0), new Date(0));

      const fallbackPath = path.join(transcriptDir, "claude-owned-session.jsonl");
      await fs.writeFile(
        fallbackPath,
        `${JSON.stringify({ sessionId: status.session_id, type: "assistant", message: { role: "assistant", content: "Visible" } })}\n`,
      );

      await expect(
        invoke(handlers, "claude_tmux_transcript", {
          tabId: "tab-fallback",
          environmentId: environment.id,
        }),
      ).resolves.toEqual([
        {
          sessionId: status.session_id,
          type: "assistant",
          message: { role: "assistant", content: "Visible" },
        },
      ]);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-fallback", environmentId: environment.id },
        context,
      );
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

      const reviewStatus = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "review-tab", environmentId: environment.id, initialPrompt: "Review this" },
        context,
      )) as { session_id: string; running: boolean };
      expect(reviewStatus.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(
        path.join(transcriptDir, "review-owned-session.jsonl"),
        `${JSON.stringify({ sessionId: reviewStatus.session_id, type: "assistant", message: { role: "assistant", content: "Review transcript" } })}\n`,
      );

      const freshStatus = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "fresh-tab", environmentId: environment.id },
        context,
      )) as { session_id: string; running: boolean };
      expect(freshStatus.running).toBe(true);
      expect(freshStatus.session_id).not.toBe(reviewStatus.session_id);

      await expect(
        invoke(handlers, "claude_tmux_transcript", {
          tabId: "fresh-tab",
          environmentId: environment.id,
        }),
      ).resolves.toEqual([]);

      await fs.writeFile(
        path.join(transcriptDir, "fresh-owned-session.jsonl"),
        `${JSON.stringify({ sessionId: freshStatus.session_id, type: "assistant", message: { role: "assistant", content: "Fresh transcript" } })}\n`,
      );

      await expect(
        invoke(handlers, "claude_tmux_transcript", {
          tabId: "fresh-tab",
          environmentId: environment.id,
        }),
      ).resolves.toEqual([
        {
          sessionId: freshStatus.session_id,
          type: "assistant",
          message: { role: "assistant", content: "Fresh transcript" },
        },
      ]);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "review-tab", environmentId: environment.id },
        context,
      );
      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "fresh-tab", environmentId: environment.id },
        context,
      );
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

      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-ambiguous", environmentId: environment.id },
        context,
      )) as { running: boolean };
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

      await expect(
        invoke(handlers, "claude_tmux_transcript", {
          tabId: "tab-ambiguous",
          environmentId: environment.id,
        }),
      ).resolves.toEqual([]);

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-ambiguous", environmentId: environment.id },
        context,
      );
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

      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-tail", environmentId: environment.id },
        context,
      )) as { session_id: string; running: boolean };
      expect(status.running).toBe(true);

      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      const transcriptPath = path.join(transcriptDir, `${status.session_id}.jsonl`);
      await fs.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Hello £" } })}\n`,
      );

      await waitFor(() =>
        emitted.some(
          (item) =>
            item.event === "claude-tmux:event" &&
            (item.payload as { kind?: string; line?: { message?: { content?: string } } }).kind ===
              "transcript-line" &&
            (item.payload as { line?: { message?: { content?: string } } }).line?.message
              ?.content === "Hello £",
        ),
      );

      await fs.appendFile(
        transcriptPath,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Second message" } })}\n`,
      );

      await waitFor(() =>
        emitted.some(
          (item) =>
            item.event === "claude-tmux:event" &&
            (item.payload as { kind?: string; line?: { message?: { content?: string } } }).kind ===
              "transcript-line" &&
            (item.payload as { line?: { message?: { content?: string } } }).line?.message
              ?.content === "Second message",
        ),
      );

      await fs.appendFile(
        transcriptPath,
        `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`,
      );
      await waitFor(() =>
        emitted.some(
          (item) =>
            item.event === "claude-tmux:event" &&
            (item.payload as { kind?: string; permission_mode?: string }).kind ===
              "permission-mode-changed" &&
            (item.payload as { permission_mode?: string }).permission_mode === "plan",
        ),
      );
      await expect(
        invoke(
          handlers,
          "claude_tmux_status",
          { tabId: "tab-tail", environmentId: environment.id },
          context,
        ),
      ).resolves.toEqual(expect.objectContaining({ permission_mode: "plan" }));

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-tail", environmentId: environment.id },
        context,
      );
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

      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId: "tab-tasks", environmentId: environment.id },
        context,
      )) as { session_id: string; running: boolean };
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
      const lines = (await invoke(handlers, "claude_tmux_transcript", {
        tabId: "tab-tasks",
        environmentId: environment.id,
      })) as Array<{ taskSnapshots?: Record<string, unknown> }>;

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
      await expect(
        invoke(handlers, "claude_tmux_tasks", {
          tabId: "tab-tasks",
          environmentId: environment.id,
        }),
      ).resolves.toEqual({
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

      await waitFor(() =>
        emitted.some(
          (item) =>
            item.event === "claude-tmux:event" &&
            (item.payload as { kind?: string }).kind === "transcript-line" &&
            (item.payload as { line?: { taskSnapshots?: Record<string, unknown> } }).line
              ?.taskSnapshots?.["tu-task-2"] !== undefined,
        ),
      );

      const tailed = emitted
        .map(
          (item) =>
            item.payload as {
              line?: {
                taskSnapshots?: Record<string, { items?: unknown; changedTaskId?: string }>;
              };
            },
        )
        .filter((payload) => payload.line?.taskSnapshots)
        .at(-1);
      expect(tailed?.line?.taskSnapshots?.["tu-task-2"]).toEqual({
        items: [{ id: "1", subject: "Derived in the backend", status: "completed" }],
        complete: true,
        changedTaskId: "1",
      });

      await invoke(
        handlers,
        "claude_tmux_stop",
        { tabId: "tab-tasks", environmentId: environment.id },
        context,
      );
    });
  });
});
