/**
 * Raw OpenCode transcripts, as build pipelines persist them, through the
 * backend's serve-time normalization and then the renderer's generic pipeline
 * adapter — the path every OpenCode pipeline stage and Multi Review reviewer
 * now renders through. These pin what the renderer's former OpenCode
 * normalizer produced for the same input.
 */
import { describe, expect, test } from "bun:test";
import type { MultiReviewReviewerTranscript } from "@orkestrator/protocol/multi-review";
import { toPipelineTranscript } from "@/components/build-pipeline/pipeline-transcript";
import { toMultiReviewReviewerMessages } from "@/components/review/MultiReviewReviewerTab";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import { classifyTranscriptEntry } from "@/lib/chat/transcript-skew";
import {
  normalizeOpenCodeDisplayEntries,
  normalizeOpenCodeDisplayEntry,
} from "../../../apps/backend/src/core/opencode-display-transcript";

const FALLBACK = "2026-07-29T00:00:00.000Z";

/** What the backend serves for a stored window, rendered as the tab renders it. */
function render(
  entries: unknown[],
  agent: "opencode" | "codex" = "opencode",
  firstIndex = 0,
): NativeMessage[] {
  return toPipelineTranscript(
    normalizeOpenCodeDisplayEntries(entries, firstIndex),
    agent,
    FALLBACK,
  );
}

function flattenedParts(messages: NativeMessage[]): NativeMessagePart[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "tool-group" || part.type === "agent-group" ? part.parts : [part],
    ),
  );
}

describe("OpenCode pipeline transcripts through the backend boundary", () => {
  test.each(["completed", "error"])(
    "retains the complete tail of a long %s tool body through the renderer adapter",
    (status) => {
      const output = "x".repeat(200_001) + "OUTPUT_TAIL";
      const error = "e".repeat(200_001) + "ERROR_TAIL";
      const transcript = render([
        {
          info: { id: "long-log", role: "assistant" },
          parts: [
            {
              id: "long-tool",
              type: "tool",
              tool: "bash",
              state: { status, input: { command: "build" }, output, error },
            },
          ],
        },
      ]);
      const tool = flattenedParts(transcript).find((part) => part.type === "tool-invocation");
      expect(tool?.type === "tool-invocation" && tool.toolOutput).toBe(output);
      expect(tool?.type === "tool-invocation" && tool.toolError).toBe(error);
    },
  );

  test("hides the initial pipeline handoff carried in an OpenCode envelope", () => {
    const handoff = `<orkestrator-handoff format="json-v2">
review context that remains available to the agent
</orkestrator-handoff>

Address every review issue.`;
    const transcript = render([
      {
        info: { id: "opencode-user", role: "user", time: { created: 1_800_000_000_000 } },
        parts: [{ id: "p0", type: "text", text: handoff }],
      },
      {
        info: { id: "opencode-assistant", role: "assistant", time: { created: 1_800_000_001_000 } },
        parts: [{ id: "p1", type: "text", text: "Starting with the useful output" }],
      },
    ]);

    expect(transcript.map((message) => message.content)).toEqual([
      "Starting with the useful output",
    ]);
  });

  test("renders text, reasoning, tools, sub-agents and attachments as before", () => {
    const transcript = render([
      {
        info: {
          id: "message-1",
          role: "assistant",
          time: { created: 1_800_000_000_000 },
          providerID: "anthropic",
          modelID: "claude-sonnet",
        },
        parts: [
          {
            id: "r1",
            messageID: "message-1",
            type: "reasoning",
            text: "**Planning** then inspect",
          },
          { id: "r2", messageID: "message-1", type: "reasoning", text: " \n**Outer wrapper** \n" },
          { id: "t1", messageID: "message-1", type: "text", text: "All criteria pass" },
          {
            id: "tool-1",
            messageID: "message-1",
            type: "tool",
            tool: "edit",
            state: {
              status: "completed",
              title: "Edit file.ts",
              input: { filePath: "file.ts", oldString: "a", newString: "a\nb" },
              output: "done",
              time: { start: 1_800_000_000_100, end: 1_800_000_001_350 },
            },
          },
          {
            id: "task-1",
            messageID: "message-1",
            type: "tool",
            tool: "Task",
            state: {
              status: "running",
              title: "Review import scheduling",
              input: {
                description: "Review import scheduling",
                prompt: "Inspect the scheduling implementation",
                subagent_type: "general",
              },
              metadata: { sessionId: "session-child" },
            },
          },
          {
            id: "file-1",
            messageID: "message-1",
            type: "file",
            filename: "notes.md",
            url: "file:///workspace/notes.md",
            mime: "text/markdown",
          },
          {
            id: "image-1",
            messageID: "message-1",
            type: "file",
            filename: "screenshot.png",
            url: "data:image/png;base64,AAAA",
            mime: "image/png",
          },
          { id: "step", messageID: "message-1", type: "step-finish", reason: "stop" },
        ],
      },
    ]);

    expect(transcript.every((message) => message.modelId === "anthropic/claude-sonnet")).toBe(true);
    const parts = flattenedParts(transcript);
    const byId = new Map(parts.map((part) => [part.sourcePartId, part]));

    // Only OpenCode's balanced outer bold pair is removed; inline Markdown and
    // surrounding whitespace survive.
    expect(byId.get("r1")).toMatchObject({
      type: "thinking",
      content: "**Planning** then inspect",
    });
    expect(byId.get("r2")).toMatchObject({ type: "thinking", content: " \nOuter wrapper \n" });
    expect(byId.get("t1")).toMatchObject({
      type: "text",
      content: "All criteria pass",
      sourceMessageId: "message-1",
    });
    expect(byId.get("tool-1")).toMatchObject({
      type: "tool-invocation",
      toolName: "edit",
      toolState: "success",
      toolTitle: "Edit file.ts",
      toolOutput: "done",
      toolDurationMs: 1_250,
      toolArgs: { filePath: "file.ts", oldString: "a", newString: "a\nb" },
      toolDiff: { filePath: "file.ts", before: "a", after: "a\nb", additions: 2, deletions: 1 },
    });
    expect(byId.get("task-1")).toMatchObject({
      type: "subagent",
      toolState: "pending",
      subagentId: "session-child",
      subagentName: "Review import scheduling",
      subagentRole: "general",
      subagentPrompt: "Inspect the scheduling implementation",
      subagentActions: [],
    });
    expect(byId.get("file-1")).toMatchObject({
      type: "file",
      content: "notes.md",
      fileUrl: "file:///workspace/notes.md",
    });
    // Formerly a generic file row; now the image row the interactive tab shows.
    expect(byId.get("image-1")).toMatchObject({
      type: "image",
      content: "screenshot.png",
      fileUrl: "data:image/png;base64,AAAA",
      imageSource: "attachment",
    });
    expect(parts.some((part) => part.sourcePartId === "step")).toBe(false);
  });

  test("anchors a message with no id or time to its position, stably across pushes", () => {
    const entries = [
      { info: { id: "m0", role: "user", time: { created: 1 } }, parts: [] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "building" }] },
    ];

    const first = render(entries);
    const second = render(structuredClone(entries));

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: "opencode-message-1", createdAt: FALLBACK });
    expect(second[0]).toMatchObject({ id: first[0]!.id, createdAt: first[0]!.createdAt });
  });

  test("names an id-less message by its absolute position in the stored transcript", () => {
    // A patch window starting at 40 must not rename the row it already showed.
    const entry = { info: { role: "assistant" }, parts: [{ type: "text", text: "tail" }] };
    expect(render([entry], "opencode", 40)[0]!.id).toBe("opencode-message-40");
  });

  test("survives timestamps that cannot be a date", () => {
    const transcript = render([
      {
        info: { id: "m1", role: "assistant", time: { created: 1e18 } },
        parts: [{ type: "text", text: "far future" }],
      },
      {
        info: { id: "m2", role: "assistant", time: { created: -1e18 } },
        parts: [{ type: "text", text: "far past" }],
      },
      {
        info: { id: "m3", role: "assistant", time: { created: Number.NaN } },
        parts: [{ type: "text", text: "not a number" }],
      },
      {
        info: { id: "m4", role: "assistant", time: 1_800_000_000_000 },
        parts: [{ type: "text", text: "time is not a record" }],
      },
    ]);

    expect(transcript.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(transcript.every((message) => message.createdAt === FALLBACK)).toBe(true);
  });

  test("drops an entry with nothing to render but shows why a failed one stopped", () => {
    const transcript = render([
      { info: { id: "m1", role: "assistant", time: { created: 1 } }, parts: [] },
      {
        info: {
          id: "m2",
          role: "assistant",
          time: { created: 1_800_000_000_000 },
          error: { name: "UnknownError", data: { message: "provider exploded" } },
        },
        parts: [],
      },
      {
        info: {
          id: "m3",
          role: "assistant",
          time: { created: 1_800_000_000_500 },
          error: { name: "MessageAbortedError" },
        },
        parts: [],
      },
      {
        info: { id: "m4", role: "assistant", time: { created: 1_800_000_001_000 } },
        parts: [{ type: "text", text: "kept" }],
      },
    ]);

    // The failure renders as the inline error row the interactive tab shows; a
    // user stop is not a failure and stays hidden.
    expect(transcript.map((message) => [message.id, message.content])).toEqual([
      ["error-opencode-m2", "provider exploded"],
      ["m4", "kept"],
    ]);
  });

  test("splits an OpenCode turn on its own part clocks", () => {
    const transcript = render([
      {
        info: { id: "m1", role: "assistant", time: { created: 1_800_000_000_000 } },
        parts: [
          { id: "p1", type: "text", text: "Looking", time: { start: 1_800_000_005_000 } },
          {
            id: "p2",
            type: "tool",
            tool: "bash",
            state: { status: "completed" },
            time: { start: 1_800_000_020_000 },
          },
          { id: "p3", type: "text", text: "Finished", time: { start: 1_800_000_040_000 } },
        ],
      },
    ]);

    expect(
      transcript.map((message) => ({
        id: message.id,
        createdAt: message.createdAt,
        partTypes: message.parts.map((part) => part.type),
      })),
    ).toEqual([
      { id: "m1", createdAt: "2027-01-15T08:00:05.000Z", partTypes: ["text"] },
      { id: "m1:text-block:1", createdAt: "2027-01-15T08:00:20.000Z", partTypes: ["tool-group"] },
      { id: "m1:text-block:2", createdAt: "2027-01-15T08:00:40.000Z", partTypes: ["text"] },
    ]);
  });

  test("keeps message order across mixed shapes, whatever agent was recorded", () => {
    const transcript = render(
      [
        { id: "first", role: "user", content: "build it" },
        {
          info: { id: "second", role: "assistant", time: { created: 1 } },
          parts: [{ type: "text", text: "from opencode" }],
        },
        { id: "third", role: "assistant", content: "from a bridge" },
      ],
      "codex",
    );

    expect(transcript.map((message) => [message.id, message.content])).toEqual([
      ["first", "build it"],
      ["second", "from opencode"],
      ["third", "from a bridge"],
    ]);
  });

  test("renders sub-agent, compaction and retry rows the old normalizer dropped", () => {
    const transcript = render([
      {
        info: { id: "m1", role: "assistant", time: { created: 1_800_000_000_000 } },
        parts: [
          {
            id: "sub",
            type: "subtask",
            sessionID: "child",
            agent: "explore",
            description: "Map the module",
            prompt: "Look around",
          },
          { id: "compact", type: "compaction", tokens: 12_000 },
          { id: "retry", type: "retry", attempt: 2, error: "rate limited" },
        ],
      },
    ]);
    const parts = flattenedParts(transcript);
    expect(parts.find((part) => part.sourcePartId === "sub")).toMatchObject({
      type: "subagent",
      subagentId: "child",
      subagentRole: "explore",
      subagentName: "Map the module",
    });
    expect(parts.find((part) => part.sourcePartId === "compact")).toMatchObject({
      type: "compaction",
      compactedTokensBefore: 12_000,
    });
    expect(parts.find((part) => part.sourcePartId === "retry")).toMatchObject({
      type: "retry",
      content: "rate limited",
      retryAttempt: 2,
      toolState: "success",
    });
  });
});

describe("normalizeOpenCodeDisplayEntry", () => {
  test("is one-to-one, passes flat entries through untouched, and is idempotent", () => {
    const flat = { id: "flat", role: "assistant", content: "bridge" };
    const raw = [
      flat,
      null,
      { info: { id: "m1", role: "assistant", time: { created: 1 } }, parts: [] },
      { info: { id: "m2", role: "user", time: { created: 2 } }, parts: [{ text: 1 }] },
    ];

    const once = normalizeOpenCodeDisplayEntries(raw);
    expect(once).toHaveLength(raw.length);
    expect(once[0]).toBe(flat);
    expect(once[1]).toBeNull();
    expect(normalizeOpenCodeDisplayEntries(once)).toEqual(once);
  });

  test("turns an entry the normalizer cannot read into an empty row, not a failed read", () => {
    const hostile = {
      info: { id: "m1", role: "user" },
      get parts(): unknown {
        throw new Error("unreadable");
      },
    };
    expect(normalizeOpenCodeDisplayEntry(hostile, 3)).toEqual({
      id: "m1",
      role: "user",
      content: "",
      parts: [],
    });
  });
});

/*
 * The renderer's skew guard against the backend's own normalizer. A backend
 * older than 2.19.17 serves these transcripts as stored, in OpenCode's raw
 * `{ info, parts }` envelope; a current one normalizes each entry on the way
 * out. The renderer must flag every entry of the first kind and none of the
 * second, or a current backend would show "update the backend" notices.
 */

/** Stored OpenCode entries, including the awkward ones the normalizer must survive. */
const STORED: Array<Record<string, unknown>> = [
  {
    info: { id: "user-1", role: "user", time: { created: 1_800_000_000_000 } },
    parts: [{ id: "p0", type: "text", text: "Review the change" }],
  },
  {
    info: { id: "assistant-1", role: "assistant", time: { created: 1_800_000_001_000 } },
    parts: [
      { id: "p1", type: "reasoning", text: "Reading the diff" },
      {
        id: "p2",
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { command: "git diff" }, output: "diff" },
      },
      { id: "p3", type: "text", text: "Looks correct." },
    ],
  },
  // A failed message with no parts: the normalizer shows its error.
  {
    info: {
      id: "assistant-2",
      role: "assistant",
      time: { created: 1_800_000_002_000 },
      error: { name: "APIError", data: { message: "Provider unavailable" } },
    },
    parts: [],
  },
  // No id, no time, nothing visible.
  { info: { role: "assistant" }, parts: [] },
  // Parts the normalizer cannot read.
  { info: { id: "assistant-3", role: "assistant" }, parts: [{ text: 1 }, null] },
  {
    info: { id: "assistant-4", role: "user" },
    get parts(): unknown {
      throw new Error("unreadable");
    },
  },
];

function reviewerSnapshot(messages: unknown[]): MultiReviewReviewerTranscript {
  return {
    workflowId: "workflow-1",
    reviewerId: "reviewer-1",
    workflowPhase: "reviewing",
    agent: "opencode",
    model: "model",
    status: "running",
    messages,
    startedAt: FALLBACK,
  };
}

describe("OpenCode transcripts across the renderer–backend version boundary", () => {
  test("flags nothing a current backend serves", () => {
    const served = normalizeOpenCodeDisplayEntries(STORED);
    for (const entry of served) {
      expect(classifyTranscriptEntry(entry as Record<string, unknown>)).toBe("display");
    }
    const transcript = toPipelineTranscript(served, "opencode", FALLBACK);
    expect(transcript.some((message) => message.id.startsWith("transcript-skew:"))).toBe(false);
    expect(transcript.map((message) => message.content).join("\n")).toContain("Looks correct.");
  });

  test("keeps the notice through the Multi Review reviewer filters", () => {
    const unknown = [
      { kind: "display-row-v3", row: { text: "Something newer" } },
      { kind: "display-row-v3", row: { text: "Something newer still" } },
    ];
    const messages = toMultiReviewReviewerMessages(reviewerSnapshot(unknown));
    expect(messages.map((message) => message.id)).toEqual(["transcript-skew:unrecognized:0"]);
    expect(messages[0]!.content).toContain("update the older one");

    const current = toMultiReviewReviewerMessages(
      reviewerSnapshot(normalizeOpenCodeDisplayEntries(STORED)),
    );
    expect(current.some((message) => message.id.startsWith("transcript-skew:"))).toBe(false);
  });
});
