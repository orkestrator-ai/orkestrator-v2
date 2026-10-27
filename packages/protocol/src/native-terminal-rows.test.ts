import { describe, expect, test } from "bun:test";
import {
  NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX,
  isNativeTerminalMessageId,
  withNativeTerminalMessages,
} from "./native-terminal-rows";

const REFUSED =
  "unexpected status 401 Unauthorized: Incorrect API key provided: sk-fake***1234. You can find your API key at https://platform.openai.com/account/api-keys.";

type Row = Record<string, unknown>;

function terminal(kind: "error" | "stopped", content: string, hash = "0123456789abcdef"): Row {
  return {
    id: `native-terminal:${kind}:${hash}`,
    role: "system",
    content,
    parts: [{ type: "text", content }],
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

const user: Row = { id: "user-1", role: "user", content: "hello", parts: [] };

function assistantWithStatus(content: string): Row {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
    parts: [{ type: "status", severity: "error", content }],
  };
}

describe("native terminal rows", () => {
  test("recognises the backend's terminal ids only", () => {
    expect(isNativeTerminalMessageId("native-terminal:error:abc")).toBe(true);
    expect(isNativeTerminalMessageId("native-terminal:stopped:abc")).toBe(true);
    expect(isNativeTerminalMessageId("error-opencode-1")).toBe(false);
    expect(isNativeTerminalMessageId(undefined)).toBe(false);
    expect(NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX).toBe("native-terminal:error:");
  });

  test("appends a failure the transcript does not hold", () => {
    const row = terminal("error", REFUSED);
    expect(withNativeTerminalMessages([user], [row])).toEqual([user, row]);
  });

  test("returns the same array when there is nothing to add", () => {
    const messages = [user];
    expect(withNativeTerminalMessages(messages, undefined)).toBe(messages);
    expect(withNativeTerminalMessages(messages, [])).toBe(messages);
    const row = terminal("error", REFUSED);
    const held = [user, row];
    // A full projection already carries the row in its messages.
    expect(withNativeTerminalMessages(held, [row])).toBe(held);
  });

  test("skips a failure the last row already states as an error status line", () => {
    // Codex and Pi put the provider's reason on the turn's last row.
    const codex = [user, assistantWithStatus(REFUSED)];
    expect(withNativeTerminalMessages(codex, [terminal("error", REFUSED)])).toBe(codex);
    // Bounded with an ellipsis.
    const bounded = [user, assistantWithStatus(`${REFUSED.slice(0, 40)}…`)];
    expect(withNativeTerminalMessages(bounded, [terminal("error", REFUSED)])).toBe(bounded);
    // Reduced from a JSON body to its `error.message`.
    const body = JSON.stringify({ type: "error", error: { message: "Model not supported" } });
    const reduced = [user, assistantWithStatus("Model not supported")];
    expect(withNativeTerminalMessages(reduced, [terminal("error", body)])).toBe(reduced);
  });

  test.each([
    'Model "private" is unavailable',
    "First line\nSecond line",
    "Cannot access C:\\models\\private",
  ])("suppresses decoded JSON error %p", (message) => {
    for (const body of [{ error: { message } }, { message }]) {
      const rows = [user, assistantWithStatus(message)];
      expect(withNativeTerminalMessages(rows, [terminal("error", JSON.stringify(body))])).toBe(
        rows,
      );
      const bounded = [user, assistantWithStatus(`${message.slice(0, 12)}…`)];
      expect(withNativeTerminalMessages(bounded, [terminal("error", JSON.stringify(body))])).toBe(
        bounded,
      );
    }
  });

  test("suppresses Pi's matching bounded output with its truncation notice", () => {
    const message = "Provider failed: " + "reason ".repeat(50) + "\n\n[output truncated]";
    const rows = [user, assistantWithStatus(message)];
    expect(withNativeTerminalMessages(rows, [terminal("error", message)])).toBe(rows);
  });

  test("keeps a failure the last row does not state", () => {
    const messages = [user, assistantWithStatus("A different failure")];
    const row = terminal("error", REFUSED);
    expect(withNativeTerminalMessages(messages, [row])).toEqual([...messages, row]);
    // An informational status line is not a failure.
    const info: Row[] = [
      user,
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "status", severity: "info", content: REFUSED }],
      },
    ];
    expect(withNativeTerminalMessages(info, [row])).toEqual([...info, row]);
    // Only the last row speaks for the turn that just ended.
    const earlier = [assistantWithStatus(REFUSED), user];
    expect(withNativeTerminalMessages(earlier, [row])).toEqual([...earlier, row]);
  });

  test("skips a failure OpenCode's inline error row already renders", () => {
    const inline: Row = {
      id: "error-opencode-assistant-failed",
      role: "assistant",
      content: "Model request failed (HTTP 400): Bad Request",
      parts: [],
    };
    const messages = [user, inline];
    expect(withNativeTerminalMessages(messages, [terminal("error", "Bad Request")])).toBe(messages);
    const other = terminal("error", "Connection lost while receiving events", "fedcba9876543210");
    expect(withNativeTerminalMessages(messages, [other])).toEqual([...messages, other]);
  });

  test("never drops a stop row for a matching status line, nor a non-terminal row", () => {
    const messages = [user, assistantWithStatus("Query stopped by user.")];
    const stopped = terminal("stopped", "Query stopped by user.");
    expect(withNativeTerminalMessages(messages, [stopped])).toEqual([...messages, stopped]);
    const foreign: Row = { id: "assistant-9", role: "system", content: "x", parts: [] };
    expect(withNativeTerminalMessages(messages, [foreign])).toBe(messages);
  });
});
