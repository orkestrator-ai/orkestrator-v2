import { describe, expect, test } from "bun:test";
import { registerTmuxBackendCommands } from "../../../electron/backend/tmux";

function createHandlers() {
  const handlers = new Map<string, (args: Record<string, unknown>, context: unknown) => unknown>();
  registerTmuxBackendCommands((name, handler) => {
    handlers.set(name, handler as (args: Record<string, unknown>, context: unknown) => unknown);
  });
  return handlers;
}

async function invoke(
  handlers: Map<string, (args: Record<string, unknown>, context: unknown) => unknown>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`missing handler: ${name}`);
  return await handler(args, {
    storage: {},
    emit: () => undefined,
    appRoot: "",
    resourceRoot: "",
  });
}

describe("Electron tmux backend command registration", () => {
  test("registers the tmux command surface", () => {
    const handlers = createHandlers();

    for (const name of [
      "claude_tmux_start",
      "claude_tmux_stop",
      "claude_tmux_interrupt",
      "claude_tmux_status",
      "claude_tmux_transcript",
      "claude_tmux_pending_hooks",
      "claude_tmux_create_interactive_terminal",
      "claude_tmux_start_interactive_terminal",
      "claude_tmux_write_interactive_terminal",
      "claude_tmux_resize_interactive_terminal",
      "claude_tmux_detach_interactive_terminal",
      "claude_tmux_send_text",
      "claude_tmux_send_keys",
      "claude_tmux_submit",
      "claude_tmux_switch_model",
      "claude_tmux_switch_effort",
      "claude_tmux_capture_pane",
      "claude_tmux_resize",
      "claude_tmux_answer_pre_tool_use",
      "claude_tmux_reply_hook",
      "claude_tmux_list_previous_sessions",
      "start_claude_state_polling",
      "stop_claude_state_polling",
    ]) {
      expect(handlers.has(name)).toBe(true);
    }
  });

  test("keeps missing-session behavior compatible with the Tauri tmux commands", async () => {
    const handlers = createHandlers();
    const args = { tabId: "tab-missing", environmentId: "env-missing" };

    await expect(invoke(handlers, "claude_tmux_status", args)).resolves.toBeNull();
    await expect(invoke(handlers, "claude_tmux_stop", args)).resolves.toBeUndefined();
    await expect(invoke(handlers, "claude_tmux_interrupt", args)).rejects.toThrow("tmux session not running");
    await expect(invoke(handlers, "claude_tmux_pending_hooks", args)).rejects.toThrow("tmux session not running");
    await expect(invoke(handlers, "claude_tmux_detach_interactive_terminal", { terminalSessionId: "missing" })).resolves.toBeUndefined();
  });
});
