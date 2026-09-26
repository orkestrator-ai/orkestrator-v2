// Drives `POST /session/:id/close` through the bridge's real composition root
// (`index.ts` → `app.route("/session", session)`) and the real session manager,
// with only the Claude SDK and filesystem edges mocked by the shared harness.
import { afterAll, describe, expect, mock, test } from "bun:test";

import {
  PERSISTED_SDK_ID,
  createSession,
  deleteSessionDurably,
  getSession,
  materializePersistedSession,
  mockSdkDeleteSession,
  mockSdkListSessions,
  reconcilePersistedSessions,
  sdkSessionInfo,
  track,
  waitFor,
} from "../services/session-manager-test-harness.js";

const envKeys = ["CLAUDE_BRIDGE_NO_SERVER", "CLAUDE_BRIDGE_AUTH_DISABLED_FOR_TESTING"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
// The bridge skips `serve()` and its token check only under both flags.
for (const key of envKeys) process.env[key] = "1";
const { app } = await import("../index.js");

afterAll(() => {
  for (const key of envKeys) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function closeRequest(id: string) {
  return app.request(`/session/${encodeURIComponent(id)}/close`, { method: "POST" });
}

describe("POST /session/:id/close", () => {
  test("answers an unknown session in band, never 404", async () => {
    // 404 is reserved for "this bridge predates the route".
    const response = await closeRequest("session-never-existed");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closed: true, missing: true });
  });

  test("closes a live session, retains its rollout, and answers a repeat as missing", async () => {
    const state = await materializePersistedSession();
    const close = mock(() => {});
    state.queryControl = { close };

    const response = await closeRequest(state.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closed: true, retained: true });
    expect(close).toHaveBeenCalledTimes(1);
    expect(getSession(state.id)).toBeUndefined();
    expect(mockSdkDeleteSession).not.toHaveBeenCalled();

    const repeat = await closeRequest(state.id);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ closed: true, missing: true });

    // The conversation is still listed and re-adopted for a deliberate resume.
    mockSdkListSessions.mockImplementation(async () => [sdkSessionInfo()]);
    await reconcilePersistedSessions();
    expect(getSession(state.id)?.sdkSessionId).toBe(PERSISTED_SDK_ID);
  });

  test("answers 503 pending with a fixed error when query close fails, then a retry closes", async () => {
    const state = createSession("close fails once");
    track(state.id);
    let failClose = true;
    state.queryControl = {
      close: () => {
        if (failClose) throw new Error("/home/user/.claude/projects/secret.jsonl: EIO");
      },
    };

    const pending = await closeRequest(state.id);
    expect(pending.status).toBe(503);
    expect(await pending.json()).toEqual({
      closed: false,
      pending: true,
      error: "Session close did not complete",
    });
    // Still registered so the backend's retry has something to close.
    expect(getSession(state.id)).toBe(state);

    failClose = false;
    const retried = await closeRequest(state.id);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ closed: true, retained: true });
    expect(getSession(state.id)).toBeUndefined();
  });

  test("answers 503 pending while a permanent deletion owns the session", async () => {
    const state = await materializePersistedSession();
    let finishDelete: (() => void) | undefined;
    mockSdkDeleteSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    const deletion = deleteSessionDurably(state.id);

    const pending = await closeRequest(state.id);
    expect(pending.status).toBe(503);
    expect(await pending.json()).toEqual({
      closed: false,
      pending: true,
      error: "Session is already being closed or deleted",
    });

    await waitFor(() => finishDelete !== undefined);
    finishDelete!();
    await expect(deletion).resolves.toBe(true);
  });
});
