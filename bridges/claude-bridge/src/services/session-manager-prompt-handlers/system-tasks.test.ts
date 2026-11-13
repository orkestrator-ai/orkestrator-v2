import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test } from "bun:test";
import type { BackgroundTaskSnapshot, SSEEvent } from "../../types/index.js";
import { SNAPSHOT_BACKGROUND_TASKS_MAX_BYTES } from "../background-task-snapshot.js";
import { eventEmitter } from "../event-emitter.js";
import { MAX_TERMINAL_BACKGROUND_TASKS } from "../session-manager-background-tasks.js";
import { handleTaskEdge } from "./system-tasks.js";
import { turnFixture } from "./turn-fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A settled shell task at the bridge's own shell bounds (~6 KB encoded). */
function settledShell(index: number): BackgroundTaskSnapshot {
  return {
    id: `shell-${index}`,
    status: "completed",
    startedAt: 1_000 + index,
    endedAt: 2_000 + index,
    taskType: "local_bash",
    command: "c".repeat(4_000),
    outputTail: "o".repeat(2_000),
  };
}

const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("task edge session.updated frames", () => {
  test("carry the bounded projection, not the raw task map", () => {
    const { session, turn, dispose } = turnFixture();
    cleanups.push(dispose);
    session.backgroundTasks = Object.fromEntries(
      Array.from({ length: MAX_TERMINAL_BACKGROUND_TASKS }, (_, index) => {
        const task = settledShell(index);
        return [task.id, task];
      }),
    );
    expect(encodedBytes(session.backgroundTasks)).toBeGreaterThan(512 * 1024);

    const frames: SSEEvent[] = [];
    cleanups.push(eventEmitter.subscribe((event) => void frames.push(event)));
    handleTaskEdge(turn, {
      type: "system",
      subtype: "task_progress",
      task_id: "live-agent",
      description: "Keep going",
    } as unknown as SDKMessage);

    const updates = frames.filter(
      (event) => event.type === "session.updated" && event.sessionId === turn.sessionId,
    );
    expect(updates).toHaveLength(1);
    const served = (updates[0]!.data as { backgroundTasks: Record<string, BackgroundTaskSnapshot> })
      .backgroundTasks;
    expect(encodedBytes(served)).toBeLessThanOrEqual(SNAPSHOT_BACKGROUND_TASKS_MAX_BYTES);
    // The live task the edge reported is always served.
    expect(served["live-agent"]).toMatchObject({ status: "running" });
    // The stored record keeps every task's full detail.
    expect(session.backgroundTasks?.["shell-0"]?.command).toHaveLength(4_000);
  });
});
