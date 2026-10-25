import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "./native-message-types";
import {
  applyClaudeBackgroundTaskStates,
  rowlessBackgroundTaskMessages,
  withResumeCleanupNotices,
} from "./native-message-adapters";

describe("tasks Claude cleaned up on resume", () => {
  // The shape a resumed vectorex session reported: eight expired Monitors,
  // each settled by Claude Code's resume scan at the moment it resumed.
  const ORPHAN =
    "Orphaned by a previous Claude Code process exit and reported in an aggregate summary.";
  const cleanup = (id: string, toolUseId?: string) =>
    ({
      id,
      ...(toolUseId ? { toolUseId } : {}),
      description: ORPHAN,
      summary: ORPHAN,
      status: "killed",
      startedAt: "2026-10-25T11:10:47.490Z",
      settledAt: "2026-10-25T11:10:47.490Z",
      endReason: "resume-cleanup",
    }) as const;
  const tasks = Array.from({ length: 8 }, (_, index) => cleanup(`monitor-${index}`));
  const transcript: NativeMessage[] = [
    {
      id: "earlier-reply",
      role: "assistant",
      content: "Release notes are updated.",
      parts: [],
      createdAt: "2026-10-25T07:19:00.000Z",
    },
    {
      id: "question",
      role: "user",
      content: "Where are we in terms of buckets?",
      parts: [],
      createdAt: "2026-10-25T11:10:47.000Z",
    },
    {
      id: "answer",
      role: "assistant",
      content: "Here is where we are.",
      parts: [],
      createdAt: "2026-10-25T11:10:50.000Z",
    },
  ];

  test("gets no card per task", () => {
    expect(rowlessBackgroundTaskMessages(tasks, transcript)).toHaveLength(0);
  });

  test("shares one line placed where the tasks settled", () => {
    const messages = withResumeCleanupNotices(transcript, tasks);
    expect(messages.map((message) => message.id)).toEqual([
      "earlier-reply",
      "question",
      "resume-cleanup:question",
      "answer",
    ]);
    expect(messages[2]).toMatchObject({
      role: "system",
      parts: [
        { type: "status", severity: "info", content: "8 earlier background tasks were cleaned up" },
      ],
    });
  });

  test("says task, not tasks, for one", () => {
    const [, , notice] = withResumeCleanupNotices(transcript, [cleanup("monitor-0")]);
    expect(notice?.content).toBe("1 earlier background task was cleaned up");
  });

  test("leaves the transcript alone when the cleanup is before the loaded window", () => {
    const later = transcript.slice(2);
    expect(withResumeCleanupNotices(later, tasks)).toBe(later);
  });

  test("leaves every other settled task to its own card", () => {
    const stopped = { ...cleanup("shell"), description: "Run tests", endReason: undefined };
    expect(withResumeCleanupNotices(transcript, [stopped])).toBe(transcript);
    expect(rowlessBackgroundTaskMessages([stopped], transcript)).toHaveLength(1);
  });

  test("does not relabel the launch row of a task it cleaned up", () => {
    // The scan covers background shells too, and a shell's launch row is
    // decorated from the snapshot: it would read stopped, under the scan's text.
    const launch: NativeMessage = {
      id: "shell-launch",
      role: "assistant",
      content: "",
      createdAt: "2026-10-24T23:21:20.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolUseId: "toolu-shell",
          toolState: "success",
          toolArgs: {
            command: "bun run gate",
            description: "Run the gate",
            run_in_background: true,
          },
        },
      ],
    };
    const [decorated] = applyClaudeBackgroundTaskStates([launch], {
      "shell-0": cleanup("shell-0", "toolu-shell"),
    });
    expect(decorated).toBe(launch);
  });
});
