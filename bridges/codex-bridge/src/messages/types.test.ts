import { describe, expect, test } from "bun:test";
import { APP_SERVER_CAPABILITIES, EngineProcessExitError, EngineUnsupportedError } from "../engine/types.js";
import { createMessageId, createSessionId } from "./types.js";

describe("normalized and engine factories", () => {
  test("message and session ids are prefixed, UUID-shaped, and unique", () => {
    const messages = new Set(Array.from({ length: 20 }, () => createMessageId()));
    const sessions = new Set(Array.from({ length: 20 }, () => createSessionId()));
    expect(messages.size).toBe(20);
    expect(sessions.size).toBe(20);
    for (const id of messages) expect(id).toMatch(/^msg-[0-9a-f-]{36}$/);
    for (const id of sessions) expect(id).toMatch(/^session-[0-9a-f-]{36}$/);
  });

  test("engine process-exit errors preserve generation and default nullable fields", () => {
    expect(new EngineProcessExitError("gone", { generation: 4 })).toMatchObject({
      name: "EngineProcessExitError",
      generation: 4,
      code: null,
      signal: null,
    });
    expect(
      new EngineProcessExitError("gone", {
        generation: 5,
        code: 12,
        signal: "SIGTERM",
      }),
    ).toMatchObject({ generation: 5, code: 12, signal: "SIGTERM" });
  });

  test("unsupported errors identify the operation and engine kind", () => {
    const error = new EngineUnsupportedError("thread/list", "app-server");
    expect(error.name).toBe("EngineUnsupportedError");
    expect(error.message).toContain("thread/list is not supported by the app-server engine");
  });

  test("app-server capability declarations cover the full supported surface", () => {
    expect(APP_SERVER_CAPABILITIES).toEqual({
      readThread: true,
      listThreads: true,
      setThreadName: true,
      nativeSubagentItems: true,
      clientUserMessageId: true,
      asyncInterrupt: true,
      itemDeltas: true,
      turnDiff: true,
    });
  });
});
