/**
 * `POST /sessions/activity` against the real session manager (SDK mocked by
 * the shared harness), compared with `GET /session/:id/activity` answer for
 * answer. The harness must be imported first: it installs its module mocks
 * before the session manager is evaluated.
 */
import {
  createSession,
  getSession,
  materializePersistedSession,
  mockSdkGetSessionInfo,
  mockSdkGetSessionMessages,
  nextQueryCall,
  peekSession,
  sdkSessionInfo,
  sendPrompt,
  track,
} from "../services/session-manager-test-harness.js";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import session from "./session.js";
import { sessionActivityBatch } from "./session-activity.js";

const app = new Hono();
app.route("/session", session);
app.route("/", sessionActivityBatch);

let sequence = 0;
/** A rollout id no other test in this file has probed. */
function freshSdkId(): string {
  sequence += 1;
  return `eeeeeeee-ffff-4aaa-8bbb-${sequence.toString(16).padStart(12, "0")}`;
}

async function batch(sessionIds: string[]): Promise<Record<string, unknown>> {
  const response = await app.request("/sessions/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, sessionIds }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    version: number;
    observations: Record<string, unknown>;
  };
  expect(body.version).toBe(1);
  expect(Object.keys(body.observations).sort()).toEqual([...sessionIds].sort());
  return body.observations;
}

async function single(sessionId: string): Promise<unknown> {
  const response = await app.request(`/session/${encodeURIComponent(sessionId)}/activity`);
  expect(response.status).toBe(200);
  return response.json();
}

describe("POST /sessions/activity", () => {
  test("answers each session exactly as the single route does", async () => {
    const idle = createSession("idle");
    track(idle.id);
    const background = createSession("background");
    track(background.id);
    background.backgroundTasks = { "task-1": { id: "task-1", status: "running" } };

    const observations = await batch([idle.id, background.id, "not-a-session-id"]);
    expect(observations).toEqual({
      [idle.id]: { activity: "idle", readyForInput: true },
      // Background work keeps the environment working while input is ready.
      [background.id]: { activity: "working", readyForInput: true },
      "not-a-session-id": { activity: "missing" },
    });
    for (const id of [idle.id, background.id, "not-a-session-id"]) {
      expect(observations[id]).toEqual(await single(id));
    }
  });

  test("withholds readiness for a running turn, as the single route does", async () => {
    const state = createSession("running");
    track(state.id);
    const promptPromise = sendPrompt(state.id, "go");
    const call = await nextQueryCall();
    try {
      const observations = await batch([state.id]);
      expect(observations[state.id]).toEqual({ activity: "working" });
      expect(observations[state.id]).toEqual(await single(state.id));
    } finally {
      call.finish();
      await promptPromise;
    }
  });

  test("proves missing only from the existence probe; a failed probe stays idle", async () => {
    const gone = `session-${freshSdkId()}`;
    const unreadable = `session-${freshSdkId()}`;
    const onDisk = `session-${freshSdkId()}`;
    const onDiskInfo = sdkSessionInfo({ sessionId: onDisk.slice("session-".length) });
    mockSdkGetSessionInfo.mockImplementation(async (sdkSessionId: string) => {
      if (`session-${sdkSessionId}` === unreadable) throw new Error("claude home unreadable");
      if (`session-${sdkSessionId}` === onDisk) return onDiskInfo;
      return undefined;
    });

    expect(await batch([gone, unreadable, onDisk])).toEqual({
      [gone]: { activity: "missing" },
      // An error is not evidence of deletion: answering `missing` here would
      // have the backend drop the user's session mapping.
      [unreadable]: { activity: "idle" },
      [onDisk]: { activity: "idle" },
    });
    // Answering must not have made the on-disk session resident.
    expect(peekSession(onDisk)).toBeUndefined();
  });

  test("does not touch, materialize or hydrate any session", async () => {
    mockSdkGetSessionMessages.mockClear();
    const state = await materializePersistedSession({ sessionId: freshSdkId() });
    const readAt = Date.now() - 60_000;
    state.lastAccessedAt = readAt;
    const notResident = `session-${freshSdkId()}`;
    mockSdkGetSessionInfo.mockImplementation(async () =>
      sdkSessionInfo({ sessionId: notResident.slice("session-".length) }),
    );

    await batch([state.id, notResident]);

    expect(state.lastAccessedAt).toBe(readAt);
    expect(state.persistedMessagesLoaded).toBe(false);
    expect(mockSdkGetSessionMessages).not.toHaveBeenCalled();
    expect(peekSession(notResident)).toBeUndefined();
    // The contrast: `getSession` is the touching read the sweep must avoid.
    getSession(state.id);
    expect(state.lastAccessedAt).toBeGreaterThan(readAt);
  });

  test("refuses requests outside the contract", async () => {
    const post = (body: string) =>
      app.request("/sessions/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    expect((await post("{")).status).toBe(400);
    expect((await post(JSON.stringify({ version: 1, sessionIds: ["a", "a"] }))).status).toBe(400);
    expect((await post("x".repeat(200_000))).status).toBe(413);
  });
});
