// Verifies that claude-tmux-client wrappers forward the right Tauri command
// names and argument shapes. We re-mock `@/lib/native/backend` *for this file
// only* (tests/setup.ts installs a no-op mock; we replace it with one whose
// implementation captures calls). The replacement is restored in afterAll so
// the rest of the suite is unaffected.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const calls: Array<{ cmd: string; args: unknown }> = [];

mock.module("@/lib/native/backend", () => ({
  invoke: mock(async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    return undefined;
  }),
  Resource: class Resource {
    close() {
      return Promise.resolve();
    }
  },
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({
    invoke: mock(() => Promise.resolve()),
    Resource: class Resource {
      close() {
        return Promise.resolve();
      }
    },
  }));
});

beforeEach(() => {
  calls.length = 0;
});

import {
  answerPreToolUse,
  capturePane,
  createInteractiveTerminal,
  detachInteractiveTerminal,
  getPendingHooks,
  getStatus,
  getTranscript,
  interruptSession,
  listPreviousSessions,
  replyHook,
  resize,
  resizeInteractiveTerminal,
  sendKeys,
  sendText,
  startInteractiveTerminal,
  startSession,
  stopSession,
  submit,
  switchModel,
  writeInteractiveTerminal,
} from "./claude-tmux-client";

describe("claude-tmux-client invoke wrappers", () => {
  test("startSession forwards tabId, environmentId, prompt/model/plan, and resume", async () => {
    await startSession("tab-1", "env-1", {
      initialPrompt: "hi",
      model: "sonnet",
      planMode: true,
      resumeSessionId: "sess-resume",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("claude_tmux_start");
    expect(calls[0]!.args).toEqual({
      tabId: "tab-1",
      environmentId: "env-1",
      initialPrompt: "hi",
      model: "sonnet",
      planMode: true,
      resumeSessionId: "sess-resume",
    });
  });

  test("startSession passes undefined when options are omitted", async () => {
    await startSession("tab-1", "env-1");
    expect(calls[0]!.args).toEqual({
      tabId: "tab-1",
      environmentId: "env-1",
      initialPrompt: undefined,
      model: undefined,
      planMode: undefined,
      resumeSessionId: undefined,
    });
  });

  test("stopSession invokes the stop command with tabId and environmentId", async () => {
    await stopSession("tab-1", "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_stop");
    expect(calls[0]!.args).toEqual({ tabId: "tab-1", environmentId: "env-1" });
  });

  test("interruptSession invokes the interrupt command with tabId and environmentId", async () => {
    await interruptSession("tab-1", "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_interrupt");
    expect(calls[0]!.args).toEqual({ tabId: "tab-1", environmentId: "env-1" });
  });

  test("getStatus invokes the status command with tabId and environmentId", async () => {
    await getStatus("tab-1", "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_status");
    expect(calls[0]!.args).toEqual({ tabId: "tab-1", environmentId: "env-1" });
  });

  test("scoped commands always include environmentId", async () => {
    await getStatus("default", "env-2");
    await capturePane("default", "env-2");
    await submit("default", "go", "env-2");

    expect(calls.map((call) => call.args)).toEqual([
      { tabId: "default", environmentId: "env-2" },
      { tabId: "default", environmentId: "env-2" },
      { tabId: "default", environmentId: "env-2", text: "go" },
    ]);
  });

  test("getTranscript invokes the transcript command with tabId and environmentId", async () => {
    await getTranscript("tab-1", "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_transcript");
    expect(calls[0]!.args).toEqual({ tabId: "tab-1", environmentId: "env-1" });
  });

  test("getPendingHooks invokes the pending hooks command with tabId and environmentId", async () => {
    await getPendingHooks("tab-1", "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_pending_hooks");
    expect(calls[0]!.args).toEqual({ tabId: "tab-1", environmentId: "env-1" });
  });

  test("submit forwards text and environmentId", async () => {
    await submit("tab-1", "go", "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_submit");
    expect(calls[0]!.args).toEqual({ tabId: "tab-1", environmentId: "env-1", text: "go" });
  });

  test("switchModel forwards the model and environmentId", async () => {
    await switchModel("tab-1", "claude-opus-4-7", "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_switch_model");
    expect(calls[0]!.args).toEqual({
      tabId: "tab-1",
      environmentId: "env-1",
      model: "claude-opus-4-7",
    });
  });

  test("sendText forwards text and environmentId without auto-Enter", async () => {
    await sendText("tab-1", "raw", "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_send_text");
    expect(calls[0]!.args).toEqual({ tabId: "tab-1", environmentId: "env-1", text: "raw" });
  });

  test("sendKeys forwards the key list and environmentId", async () => {
    await sendKeys("tab-1", ["C-c", "Enter"], "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_send_keys");
    expect(calls[0]!.args).toEqual({
      tabId: "tab-1",
      environmentId: "env-1",
      keys: ["C-c", "Enter"],
    });
  });

  test("capturePane invokes the capture command with tabId and environmentId", async () => {
    await capturePane("tab-1", "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_capture_pane");
    expect(calls[0]!.args).toEqual({ tabId: "tab-1", environmentId: "env-1" });
  });

  test("resize forwards cols/rows as numbers and environmentId", async () => {
    await resize("tab-1", 200, 50, "env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_resize");
    expect(calls[0]!.args).toEqual({
      tabId: "tab-1",
      environmentId: "env-1",
      cols: 200,
      rows: 50,
    });
  });

  test("interactive terminal wrappers forward command names and arguments", async () => {
    await createInteractiveTerminal("tab-1", 120, 40, "env-1");
    await startInteractiveTerminal("pty-1");
    await writeInteractiveTerminal("pty-1", "abc");
    await resizeInteractiveTerminal("pty-1", 140, 45);
    await detachInteractiveTerminal("pty-1");

    expect(calls.map((call) => call.cmd)).toEqual([
      "claude_tmux_create_interactive_terminal",
      "claude_tmux_start_interactive_terminal",
      "claude_tmux_write_interactive_terminal",
      "claude_tmux_resize_interactive_terminal",
      "claude_tmux_detach_interactive_terminal",
    ]);
    expect(calls.map((call) => call.args)).toEqual([
      { tabId: "tab-1", environmentId: "env-1", cols: 120, rows: 40 },
      { terminalSessionId: "pty-1" },
      { terminalSessionId: "pty-1", data: "abc" },
      { terminalSessionId: "pty-1", cols: 140, rows: 45 },
      { terminalSessionId: "pty-1" },
    ]);
  });

  test("answerPreToolUse forwards decision and optional reason", async () => {
    await answerPreToolUse("tab-1", "evt", "approve");
    expect(calls[0]!.args).toEqual({
      tabId: "tab-1",
      environmentId: undefined,
      eventId: "evt",
      decision: "approve",
      reason: undefined,
    });
    await answerPreToolUse("tab-1", "evt", "block", "no", "env-1");
    expect(calls[1]!.args).toEqual({
      tabId: "tab-1",
      environmentId: "env-1",
      eventId: "evt",
      decision: "block",
      reason: "no",
    });
  });

  test("replyHook forwards arbitrary JSON response", async () => {
    await replyHook("tab-1", "PostToolUse", "evt", { ok: true });
    expect(calls[0]!.cmd).toBe("claude_tmux_reply_hook");
    expect(calls[0]!.args).toEqual({
      tabId: "tab-1",
      environmentId: undefined,
      eventKind: "PostToolUse",
      eventId: "evt",
      response: { ok: true },
    });
  });

  test("listPreviousSessions invokes the list command with environmentId", async () => {
    await listPreviousSessions("env-1");
    expect(calls[0]!.cmd).toBe("claude_tmux_list_previous_sessions");
    expect(calls[0]!.args).toEqual({ environmentId: "env-1" });
  });
});
