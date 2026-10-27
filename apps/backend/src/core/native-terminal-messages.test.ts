import { expect, test } from "bun:test";
import { nativeTerminalMessages } from "./native-terminal-messages.js";

test("terminal rows use a stable real turn time, falling back to the epoch when unavailable", () => {
  const turnStartedAt = Date.parse("2026-10-27T12:00:00.000Z");
  const input = { error: "Authentication failed", turnStartedAt };
  const rows = nativeTerminalMessages(input);
  expect(rows[0]?.createdAt).toBe("2026-10-27T12:00:00.000Z");
  expect(nativeTerminalMessages(input)).toEqual(rows);
  const fallback = nativeTerminalMessages({ error: input.error });
  expect(fallback[0]?.createdAt).toBe("1970-01-01T00:00:00.000Z");
  expect(fallback[0]?.id).toBe(rows[0]?.id);
});
