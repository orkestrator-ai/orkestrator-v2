import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  type InsightCursor,
  MAX_SEGMENT_CHARS,
  renderSegment,
  selectSegments,
  SETTLE_MS,
} from "./prepare.js";
import { parseClaude, parseCodex, projectOf, type TranscriptSources } from "./transcripts.js";
import { DAY, HOUR, temporaryDirectory } from "../testing/fixtures.js";
import {
  claudeJsonl,
  codexJsonl,
  type FixtureTurn,
  writeTranscript,
} from "../testing/transcript-fixtures.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const CWD = "/home/someone/orkestrator-v2/workspaces/orkestrator-v2-20261109-175407-894d9e3cdfc3";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(): string {
  const { dir, remove } = temporaryDirectory("improvement-transcripts-");
  cleanups.push(remove);
  return dir;
}

const TURNS: FixtureTurn[] = [
  {
    user: "Use mise, not npm. <system-reminder>injected rule</system-reminder>",
    at: NOW - 3 * HOUR,
  },
  {
    assistant: "Running the tests now.",
    at: NOW - 3 * HOUR + 1000,
    tools: ["Bash", "Bash", "Edit"],
    toolError: true,
  },
  { interrupt: true, at: NOW - 3 * HOUR + 2000 },
  { user: "Background task finished", at: NOW - 3 * HOUR + 3000, origin: "task-notification" },
  { user: "No, I said mise. Again.", at: NOW - 2 * HOUR },
  { assistant: "Sorry, using mise.", at: NOW - 2 * HOUR + 1000 },
];

describe("reading transcripts", () => {
  test("a Claude history keeps what people and agents wrote, and drops tool data, thinking and sub-agents", () => {
    const conversation = parseClaude("/x/abc.jsonl", claudeJsonl("abc", CWD, TURNS))!;
    expect(conversation.id).toBe("claude:abc");
    expect(conversation.project).toBe("orkestrator-v2");
    expect(conversation.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "interrupt",
      "user",
      "user",
      "assistant",
    ]);
    const [first, reply, , notification] = conversation.entries;
    expect(first).toMatchObject({ origin: "typed", text: "Use mise, not npm." });
    expect(reply).toMatchObject({
      text: "Running the tests now.",
      tools: { Bash: 2, Edit: 1 },
      toolErrors: 1,
    });
    expect(notification).toMatchObject({ origin: "system" });
    const everything = JSON.stringify(conversation);
    for (const hidden of [
      "private reasoning",
      "tool input",
      "tool output",
      "sub-agent",
      "injected rule",
    ]) {
      expect(everything).not.toContain(hidden);
    }
  });

  test("a Codex history skips context blocks and counts tool calls and aborted turns", () => {
    const conversation = parseCodex("/x/rollout.jsonl", codexJsonl("t-1", CWD, TURNS))!;
    expect(conversation.id).toBe("codex:t-1");
    const users = conversation.entries.filter((entry) => entry.role === "user");
    expect(users.map((entry) => entry.role === "user" && entry.text)).not.toContainEqual(
      expect.stringContaining("environment_context"),
    );
    expect(conversation.entries.some((entry) => entry.role === "interrupt")).toBe(true);
    const reply = conversation.entries.find((entry) => entry.role === "assistant");
    expect(reply).toMatchObject({ tools: { Bash: 2, Edit: 1 } });
    expect(JSON.stringify(conversation)).not.toContain("secret output");
  });

  test("a worktree folder names its project", () => {
    expect(projectOf(CWD)).toBe("orkestrator-v2");
    expect(projectOf(`${CWD}/bridges/claude-bridge`)).toBe("orkestrator-v2");
    expect(projectOf("/home/someone/code/my-app")).toBe("my-app");
  });
});

describe("choosing what to read", () => {
  function sources(root: string): TranscriptSources {
    return {
      claudeProjectDirs: [path.join(root, "claude", "projects")],
      codexSessionDirs: [path.join(root, "codex", "sessions")],
    };
  }

  test("reads settled conversations once, resumes where it stopped, and skips the excluded and the too-old", () => {
    const root = scratch();
    const claudeDir = path.join(root, "claude", "projects", "-p");
    writeTranscript(
      path.join(claudeDir, "settled.jsonl"),
      claudeJsonl("settled", CWD, TURNS),
      NOW - 2 * HOUR,
    );
    writeTranscript(
      path.join(claudeDir, "active.jsonl"),
      claudeJsonl("active", CWD, TURNS),
      NOW - SETTLE_MS / 2,
    );
    writeTranscript(
      path.join(claudeDir, "old.jsonl"),
      claudeJsonl("old", CWD, TURNS),
      NOW - 20 * DAY,
    );
    writeTranscript(
      path.join(claudeDir, "own.jsonl"),
      claudeJsonl("own", "/state/dir/sub", TURNS),
      NOW - 2 * HOUR,
    );
    writeTranscript(
      path.join(root, "codex", "sessions", "2026", "11", "09", "rollout-a.jsonl"),
      codexJsonl("t-1", CWD, TURNS),
      NOW - 3 * HOUR,
    );

    const cursor: InsightCursor = { schemaVersion: 1, conversations: {} };
    const first = selectSegments({
      sources: sources(root),
      cursor,
      now: NOW,
      excludeDirs: ["/state/dir"],
    });
    expect(first.segments.map((segment) => segment.conversationId).sort()).toEqual([
      "claude:settled",
      "codex:t-1",
    ]);
    const settled = first.segments.find((segment) => segment.conversationId === "claude:settled")!;
    expect(settled.typedMessages).toBe(2);

    // Mark both read; the next run finds nothing until a conversation grows.
    for (const segment of first.segments) {
      cursor.conversations[segment.conversationId] = {
        analyzedEntries: segment.to,
        lastAt: segment.lastAt,
        project: segment.project,
        analyzedAt: NOW,
      };
    }
    expect(
      selectSegments({ sources: sources(root), cursor, now: NOW, excludeDirs: [] }).segments.map(
        (s) => s.conversationId,
      ),
    ).toEqual(["claude:own"]);

    writeTranscript(
      path.join(claudeDir, "settled.jsonl"),
      claudeJsonl("settled", CWD, [
        ...TURNS,
        { user: "Why did the pipeline stop again?", at: NOW - 90 * 60 * 1000 },
        { assistant: "It waited for review.", at: NOW - 89 * 60 * 1000 },
      ]),
      NOW - 80 * 60 * 1000,
    );
    const grown = selectSegments({
      sources: sources(root),
      cursor,
      now: NOW,
      excludeDirs: ["/state/dir"],
    });
    expect(grown.segments).toHaveLength(1);
    expect(grown.segments[0]).toMatchObject({ conversationId: "claude:settled", from: 6, to: 8 });
    expect(grown.segments[0]!.text).toContain("earlier context, already read");
    expect(grown.segments[0]!.text).toContain("Why did the pipeline stop again?");
  });

  test("leaves the rest for the next run past the limit, and marks system-only conversations read", () => {
    const root = scratch();
    const claudeDir = path.join(root, "claude", "projects", "-p");
    for (let index = 0; index < 4; index += 1) {
      writeTranscript(
        path.join(claudeDir, `c${index}.jsonl`),
        claudeJsonl(`c${index}`, CWD, TURNS),
        NOW - (2 + index) * HOUR,
      );
    }
    writeTranscript(
      path.join(claudeDir, "system.jsonl"),
      claudeJsonl("system", CWD, [
        { user: "Task finished", at: NOW - 3 * HOUR, origin: "task-notification" },
      ]),
      NOW - 2 * HOUR,
    );
    const selection = selectSegments({
      sources: sources(root),
      cursor: { schemaVersion: 1, conversations: {} },
      now: NOW,
      excludeDirs: [],
      maxSegments: 2,
    });
    expect(selection.segments).toHaveLength(2);
    expect(selection.waiting).toBe(2);
    expect(selection.skipped.map((skip) => skip.conversationId)).toEqual(["claude:system"]);
  });
});

describe("rendering a part for the model", () => {
  test("labels who wrote what, redacts secrets and stays under the size cap", () => {
    const conversation = parseClaude(
      "/x/big.jsonl",
      claudeJsonl("big", CWD, [
        { user: "deploy with token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", at: NOW - 3 * HOUR },
        ...Array.from({ length: 200 }, (_, index): FixtureTurn =>
          index % 2 === 0
            ? { user: `step ${index} ${"x".repeat(3000)}`, at: NOW - 3 * HOUR + index * 1000 }
            : {
                assistant: `reply ${index} ${"y".repeat(3000)}`,
                at: NOW - 3 * HOUR + index * 1000,
                tools: ["Read"],
              },
        ),
      ]),
    )!;
    const text = renderSegment(conversation, 0);
    expect(text.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).toContain("PERSON:");
    expect(text).toContain("ASSISTANT:");
    expect(text).toContain("tools: Read×1");
  });
});
