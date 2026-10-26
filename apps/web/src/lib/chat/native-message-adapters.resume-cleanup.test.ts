import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "./native-message-types";
import {
  applyClaudeBackgroundTaskStates,
  normalizeNativeMessages,
  rowlessBackgroundTaskMessages,
  withResumeCleanupNotices,
} from "./native-message-adapters";
import { pinNativeAgentParts } from "./native-agent-pinning";

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

  test("groups by anchor and uses the earliest settle clock regardless of snapshot order", () => {
    const messages = withResumeCleanupNotices(transcript, [
      { ...cleanup("last"), settledAt: "2026-10-25T11:10:51.000Z" },
      { ...cleanup("later"), settledAt: "2026-10-25T11:10:49.000Z" },
      { ...cleanup("earlier"), settledAt: "2026-10-25T11:10:48.000Z" },
      { ...cleanup("first"), settledAt: "2026-10-25T07:20:00.000Z" },
    ]);

    expect(messages.map(({ id }) => id)).toEqual([
      "earlier-reply",
      "resume-cleanup:earlier-reply",
      "question",
      "resume-cleanup:question",
      "answer",
      "resume-cleanup:answer",
    ]);
    expect(messages.filter(({ role }) => role === "system")).toMatchObject([
      {
        content: "1 earlier background task was cleaned up",
        createdAt: "2026-10-25T07:20:00.000Z",
      },
      {
        content: "2 earlier background tasks were cleaned up",
        createdAt: "2026-10-25T11:10:48.000Z",
      },
      {
        content: "1 earlier background task was cleaned up",
        createdAt: "2026-10-25T11:10:51.000Z",
      },
    ]);
  });

  test("does not count ambient cleanup tasks or create notices for them", () => {
    const ambient = { ...cleanup("housekeeping"), ambient: true };
    expect(withResumeCleanupNotices(transcript, [ambient])).toBe(transcript);
    const messages = withResumeCleanupNotices(transcript, [ambient, cleanup("visible")]);
    expect(messages.filter(({ role }) => role === "system").map(({ content }) => content)).toEqual([
      "1 earlier background task was cleaned up",
    ]);
    expect(rowlessBackgroundTaskMessages([ambient], transcript)).toHaveLength(0);
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
      live: { id: "live", status: "running" },
    });
    expect(decorated).toBe(launch);
  });

  test.each(["projected", "inline"] as const)(
    "preserves a historical launch with task id from %s output through normalization and pinning",
    (source) => {
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
            ...(source === "projected"
              ? { backgroundTaskId: "shell-0" }
              : { toolOutput: "Command running in background with ID: shell-0" }),
          },
        ],
      };
      // Resumed snapshots can identify the task without its launch tool id.
      const cleaned = cleanup("shell-0");
      // A second task prevents the no-work shortcut from masking decoration.
      const live = { id: "live", status: "running" as const, description: "Still running" };
      const raw = [launch, ...transcript];
      const decorated = applyClaudeBackgroundTaskStates(raw, { "shell-0": cleaned, live });
      expect(decorated[0]).toBe(launch);
      const normalized = normalizeNativeMessages(decorated);
      const messages = pinNativeAgentParts(
        withResumeCleanupNotices(normalized, [cleaned]),
        normalized,
      );

      expect(messages.map(({ id }) => id)).toEqual([
        "shell-launch",
        "earlier-reply",
        "question",
        "resume-cleanup:question",
        "answer",
      ]);
      expect(messages[0]?.parts).toEqual([
        { type: "tool-group", content: "", parts: launch.parts },
      ]);
      expect(messages[3]?.content).toBe("1 earlier background task was cleaned up");
      expect(rowlessBackgroundTaskMessages([cleaned], normalized)).toHaveLength(0);
    },
  );

  test("keeps an agent launch's own finished lifecycle after cleanup", () => {
    const launch: NativeMessage = {
      id: "agent-launch",
      role: "assistant",
      content: "",
      createdAt: "2026-10-24T23:21:20.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Agent",
          toolName: "Agent",
          toolUseId: "toolu-agent",
          toolState: "success",
          toolArgs: { description: "Review the release" },
        },
      ],
    };
    const [decorated] = applyClaudeBackgroundTaskStates([launch], {
      agent: cleanup("agent", "toolu-agent"),
    });
    expect(decorated?.parts[0]).toEqual({ ...launch.parts[0]!, agentState: "finished" });
    expect(normalizeNativeMessages([decorated!])[0]?.parts[0]?.type).toBe("task-group");
  });
});
