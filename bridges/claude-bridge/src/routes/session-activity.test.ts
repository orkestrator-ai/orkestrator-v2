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
  waitFor,
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
      [idle.id]: {
        activity: "idle",
        readyForInput: true,
        completionPending: false,
        contentRevision: expect.any(String),
      },
      // Background work keeps the environment working while input is ready.
      [background.id]: {
        activity: "working",
        readyForInput: true,
        completionPending: true,
        contentRevision: expect.any(String),
      },
      "not-a-session-id": { activity: "missing" },
    });
    for (const id of [idle.id, background.id, "not-a-session-id"]) {
      expect(observations[id]).toEqual(await single(id));
    }
  });

  test("distinguishes detached local shells from tasks that owe a root response", async () => {
    for (const taskType of ["local_bash", "local_agent"]) {
      const state = createSession(taskType);
      track(state.id);
      const promptPromise = sendPrompt(state.id, "start background work");
      const call = await nextQueryCall();
      try {
        call.push({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "task-1", task_type: taskType, description: "Background work" }],
        });
        call.push({ type: "result", subtype: "success" });
        await waitFor(() => state.status === "idle");
        const readAt = state.lastAccessedAt;
        for (let poll = 0; poll < 3; poll += 1) {
          expect(await single(state.id)).toEqual({
            activity: "working",
            readyForInput: true,
            completionPending: taskType !== "local_bash",
            contentRevision: expect.any(String),
          });
          expect((await batch([state.id]))[state.id]).toEqual(await single(state.id));
        }
        expect(state.lastAccessedAt).toBe(readAt);
      } finally {
        call.finish();
        await promptPromise;
      }
    }
  });

  test("withholds readiness for a running turn, as the single route does", async () => {
    const state = createSession("running");
    track(state.id);
    const promptPromise = sendPrompt(state.id, "go");
    const call = await nextQueryCall();
    try {
      const observations = await batch([state.id]);
      expect(observations[state.id]).toEqual({
        activity: "working",
        contentRevision: expect.any(String),
      });
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
      [unreadable]: { activity: "idle", contentRevision: expect.any(String) },
      [onDisk]: { activity: "idle", contentRevision: expect.any(String) },
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

  test("moves the content revision for transcript and background-task changes only", async () => {
    const state = createSession("content-revision");
    track(state.id);
    const revision = async () =>
      ((await single(state.id)) as { contentRevision?: string }).contentRevision;
    const first = await revision();
    expect(typeof first).toBe("string");
    // Reading changes nothing and touches nothing.
    const readAt = state.lastAccessedAt;
    expect(await revision()).toBe(first);
    expect(state.lastAccessedAt).toBe(readAt);

    // A background task reports progress: the view changed, activity did not.
    const { emitBackgroundTaskSnapshot } = await import("../services/session-manager.js");
    state.backgroundTasks = { "task-1": { id: "task-1", status: "completed" } };
    emitBackgroundTaskSnapshot(state);
    const afterTask = await revision();
    expect(afterTask).not.toBe(first);

    // A transcript change moves it too.
    const { markTranscriptChanged } = await import("../services/transcript-revision.js");
    markTranscriptChanged(state);
    const afterTranscript = await revision();
    expect(afterTranscript).not.toBe(afterTask);
    expect((await batch([state.id]))[state.id]).toEqual(await single(state.id));
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

test("human-prompt output is bounded and does not hydrate or touch the session", async () => {
  const state = createSession("prompt-observation");
  track(state.id);
  state.messages.push({
    id: "shell",
    role: "assistant",
    content: "",
    createdAt: new Date(0).toISOString(),
    parts: [
      {
        type: "tool-invocation",
        toolName: "Bash",
        toolUseId: "login",
        toolState: "pending",
        toolOutput: "https://github.com/login/device\nPress ENTER",
      },
    ],
  } as (typeof state.messages)[number]);
  const before = JSON.stringify(state.messages);
  const hydrationReads = mockSdkGetSessionMessages.mock.calls.length;
  const response = await app.request(`/session/${state.id}/human-prompts`);
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).toContain("https://github.com/login/device");
  expect(mockSdkGetSessionMessages.mock.calls).toHaveLength(hydrationReads);
  expect(JSON.stringify(state.messages)).toBe(before);
  const missing = await app.request("/session/not-held/human-prompts");
  expect(await missing.json()).toEqual({ messages: [{ parts: [] }], backgroundTasks: [] });
});
