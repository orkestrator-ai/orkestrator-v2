import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTaskSnapshot } from "../types/index.js";
import { CLAUDE_RESUME_ORPHAN_SUMMARY } from "./session-manager-background-tasks.js";
import {
  persistedBackgroundTaskMessage,
  reducePersistedBackgroundTaskMessage,
} from "./session-manager-messages.js";
import { handleTaskNotification } from "./session-manager-prompt-handlers/system-tasks.js";
import {
  createPromptTurnForTesting,
  createSession,
  getSession,
  track,
} from "./session-manager-test-harness.js";

/**
 * A frame exactly as Claude Code 2.1.309 sent it when a session resumed with
 * eight expired Monitors in its transcript: a stop with the scan's summary, no
 * description and an empty output file.
 */
function orphanFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "bfs6uwwmn",
    tool_use_id: "toolu_01ANqJdbdq2X6oagZWiuAgCu",
    status: "stopped",
    output_file: "",
    summary: CLAUDE_RESUME_ORPHAN_SUMMARY,
    ...overrides,
  };
}

function liveSession(tasks?: Record<string, BackgroundTaskSnapshot>) {
  const created = createSession("Resume orphan scan");
  track(created.id);
  const session = getSession(created.id)!;
  if (tasks) session.backgroundTasks = tasks;
  const { turn } = createPromptTurnForTesting(session);
  return {
    session,
    notify: (frame: Record<string, unknown>) =>
      handleTaskNotification(turn, frame as unknown as SDKMessage),
  };
}

function replay(
  frame: Record<string, unknown>,
  tasks?: Record<string, BackgroundTaskSnapshot>,
): Record<string, BackgroundTaskSnapshot> {
  const message = persistedBackgroundTaskMessage({ message: frame });
  expect(message).toBeDefined();
  return reducePersistedBackgroundTaskMessage(tasks, message!, 1_000);
}

const settledMonitor: BackgroundTaskSnapshot = {
  id: "bfs6uwwmn",
  toolUseId: "toolu_01ANqJdbdq2X6oagZWiuAgCu",
  description: "config D guard benchmark",
  status: "completed",
  startedAt: 10,
  endedAt: 20,
};

describe("Claude Code's resume orphan scan", () => {
  test("marks a stopped task this session never saw as cleanup", () => {
    const { session, notify } = liveSession();
    notify(orphanFrame());
    expect(session.backgroundTasks?.bfs6uwwmn).toMatchObject({
      status: "killed",
      endReason: "resume_cleanup",
    });
    expect(replay(orphanFrame()).bfs6uwwmn).toMatchObject({
      status: "killed",
      endReason: "resume_cleanup",
    });
  });

  test("keeps an ending this session already recorded", () => {
    const { session, notify } = liveSession({ bfs6uwwmn: settledMonitor });
    notify(orphanFrame());
    expect(session.backgroundTasks?.bfs6uwwmn).toEqual(settledMonitor);
    expect(replay(orphanFrame(), { bfs6uwwmn: settledMonitor }).bfs6uwwmn).toEqual(settledMonitor);
  });

  test("leaves a task still live here as an ordinary stop", () => {
    const running: BackgroundTaskSnapshot = {
      ...settledMonitor,
      status: "running",
      endedAt: undefined,
    };
    const { session, notify } = liveSession({ bfs6uwwmn: running });
    notify(orphanFrame());
    const task = session.backgroundTasks?.bfs6uwwmn;
    expect(task).toMatchObject({ status: "killed", description: "config D guard benchmark" });
    expect(task?.endReason).toBeUndefined();
  });

  for (const [name, overrides] of [
    // The scan marks agents failed: their in-process state really was lost.
    ["a failed agent", { status: "failed" }],
    ["another summary", { summary: "Stopped" }],
    ["a near miss of the summary", { summary: `${CLAUDE_RESUME_ORPHAN_SUMMARY} x` }],
  ] as const) {
    test(`does not claim ${name}`, () => {
      const { session, notify } = liveSession();
      notify(orphanFrame(overrides));
      expect(session.backgroundTasks?.bfs6uwwmn?.endReason).toBeUndefined();
      expect(replay(orphanFrame(overrides)).bfs6uwwmn?.endReason).toBeUndefined();
    });
  }
});
