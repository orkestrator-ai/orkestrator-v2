/**
 * The two OpenCode boundaries that must fail a typecheck rather than a user.
 *
 * Both tables are `Record`s over the SDK's own unions, so an OpenCode release
 * that adds an event type or a part kind breaks the build here instead of
 * quietly dropping content from transcripts. These tests pin what the tables
 * say and, for parts, that the normalizer reports what it dropped.
 */
import { describe, expect, test } from "bun:test";
import {
  KNOWN_OPEN_CODE_PART_TYPES,
  isKnownOpenCodePartType,
  normalizeOpenCodeInteractiveMessage,
} from "./opencode-messages.js";
import { KNOWN_OPENCODE_EVENTS, isKnownOpenCodeEvent } from "./opencode-events.js";

function message(parts: unknown[]): unknown {
  return {
    info: { id: "msg-1", role: "assistant", time: { created: 0 } },
    parts,
  };
}

describe("the v2 event-kind table", () => {
  test("recognizes representative v2-only stream events", () => {
    expect(isKnownOpenCodeEvent("mcp.tools.changed")).toBe(true);
    expect(isKnownOpenCodeEvent("session.next.text.delta")).toBe(true);
    expect(isKnownOpenCodeEvent("permission.v2.asked")).toBe(true);
    expect(isKnownOpenCodeEvent("workspace.ready")).toBe(true);
    expect(isKnownOpenCodeEvent("invented.event")).toBe(false);
  });

  test("marks exactly the interaction and projection events it consumes", () => {
    expect(
      Object.entries(KNOWN_OPENCODE_EVENTS)
        .filter(([, handled]) => handled)
        .map(([type]) => type)
        .sort(),
    ).toEqual([
      "global.disposed",
      "mcp.tools.changed",
      "message.part.delta",
      "message.part.removed",
      "message.part.updated",
      "message.removed",
      "message.updated",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.rejected",
      "question.replied",
      "server.connected",
      "server.instance.disposed",
      "session.compacted",
      "session.deleted",
      "session.diff",
      "session.error",
      "session.idle",
      "session.status",
      "session.updated",
      "todo.updated",
    ]);
  });
});

describe("the part-kind table", () => {
  test("names every kind the SDK union carries", () => {
    // If the SDK adds one, the `Record` type in `opencode-messages.ts` fails to
    // compile — this only pins that the entries mean what they say.
    expect(Object.keys(KNOWN_OPEN_CODE_PART_TYPES).sort()).toEqual([
      "agent",
      "compaction",
      "file",
      "patch",
      "reasoning",
      "retry",
      "snapshot",
      "step-finish",
      "step-start",
      "subtask",
      "text",
      "tool",
    ]);
  });

  test("marks exactly the kinds this normalizer renders", () => {
    const rendered = Object.entries(KNOWN_OPEN_CODE_PART_TYPES)
      .filter(([, isRendered]) => isRendered)
      .map(([kind]) => kind)
      .sort();
    expect(rendered).toEqual([
      "compaction",
      "file",
      "reasoning",
      "retry",
      "subtask",
      "text",
      "tool",
    ]);
  });

  test("an invented kind is not known", () => {
    expect(isKnownOpenCodePartType("holographic")).toBe(false);
    expect(isKnownOpenCodePartType(undefined)).toBe(false);
    expect(isKnownOpenCodePartType(7)).toBe(false);
  });
});

describe("normalizeOpenCodeInteractiveMessage drift", () => {
  test("reports a part kind the SDK added and this normalizer has never seen", () => {
    const dropped: string[] = [];
    normalizeOpenCodeInteractiveMessage(
      message([{ id: "p1", type: "holographic", payload: "the user's private prompt" }]),
      0,
      (type) => dropped.push(type),
    );
    expect(dropped).toEqual(["holographic"]);
  });

  test("does not report a kind the table names as a documented drop", () => {
    // Per-step accounting carriers and internal bookkeeping. Counting them as
    // drift would drown the signal that matters.
    const dropped: string[] = [];
    normalizeOpenCodeInteractiveMessage(
      message([
        { id: "p1", type: "step-start" },
        { id: "p2", type: "step-finish" },
        { id: "p3", type: "snapshot" },
        { id: "p4", type: "patch" },
        { id: "p5", type: "agent" },
      ]),
      0,
      (type) => dropped.push(type),
    );
    expect(dropped).toEqual([]);
  });

  test("renders a first-class subtask and drops the heuristic row for the same child", () => {
    // OpenCode reports the same child twice. Without the dedupe the transcript
    // carries two cards for one sub-agent.
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        {
          id: "p1",
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "review the parser" },
            metadata: { sessionID: "child-1" },
          },
        },
        {
          id: "p2",
          type: "subtask",
          sessionID: "child-1",
          description: "review the parser",
          agent: "reviewer",
          prompt: "look at the parser",
          model: { providerID: "opencode", modelID: "sonnet" },
        },
      ]),
      0,
    );

    const parts = normalized!.parts as Array<Record<string, unknown>>;
    const subagents = parts.filter((part) => part.type === "subagent");
    expect(subagents).toHaveLength(1);
    // The provider's own record wins over the heuristic.
    expect(subagents[0]).toMatchObject({
      subagentSource: "part",
      subagentId: "child-1",
      subagentRole: "reviewer",
      subagentModelId: "opencode/sonnet",
    });
  });

  test("keeps the heuristic row when the server reports no subtask part", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        {
          id: "p1",
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "review the parser" },
            metadata: { sessionID: "child-1" },
          },
        },
      ]),
      0,
    );

    const parts = normalized!.parts as Array<Record<string, unknown>>;
    expect(parts.filter((part) => part.type === "subagent")).toMatchObject([
      { subagentSource: "tool", subagentId: "child-1" },
    ]);
  });

  test("an image attachment is an image row, not a file row", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([{ id: "p1", type: "file", filename: "shot.png", mime: "image/png", url: "u" }]),
      0,
    );
    expect((normalized!.parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "image",
      imageSource: "attachment",
      mime: "image/png",
    });
  });

  test("a non-image attachment stays a file row", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([{ id: "p1", type: "file", filename: "notes.md", mime: "text/markdown" }]),
      0,
    );
    expect((normalized!.parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "file",
      mime: "text/markdown",
    });
  });

  test("compaction and retry become their own rows", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        { id: "p1", type: "compaction", summary: "kept the plan", tokens: 120_000 },
        { id: "p2", type: "retry", error: "overloaded", attempt: 2 },
      ]),
      0,
    );
    const parts = normalized!.parts as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({
      type: "compaction",
      content: "kept the plan",
      compactedTokensBefore: 120_000,
    });
    // A retry in a persisted message already resolved: the message it belongs
    // to exists.
    expect(parts[1]).toMatchObject({ type: "retry", content: "overloaded", toolState: "success" });
  });

  test("the dedupe does not depend on the subtask part arriving first", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        { id: "p1", type: "subtask", sessionID: "child-1", description: "d" },
        {
          id: "p2",
          type: "tool",
          tool: "task",
          state: { status: "completed", input: {}, metadata: { sessionID: "child-1" } },
        },
      ]),
      0,
    );
    expect(
      (normalized!.parts as Array<Record<string, unknown>>).filter(
        (part) => part.type === "subagent",
      ),
    ).toHaveLength(1);
  });

  test("does not report the kinds it renders", () => {
    const dropped: string[] = [];
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        { id: "p1", type: "text", text: "hello" },
        { id: "p2", type: "reasoning", text: "thinking" },
        { id: "p3", type: "file", filename: "a.ts" },
      ]),
      0,
      (type) => dropped.push(type),
    );
    expect(dropped).toEqual([]);
    expect(normalized?.content).toBe("hello");
  });

  test("names an untyped part rather than passing undefined along", () => {
    const dropped: string[] = [];
    normalizeOpenCodeInteractiveMessage(message([{ id: "p1" }]), 0, (type) => dropped.push(type));
    expect(dropped).toEqual(["(untyped)"]);
  });

  test("works without a recorder at all, for the pure callers", () => {
    expect(() =>
      normalizeOpenCodeInteractiveMessage(message([{ id: "p1", type: "holographic" }]), 0),
    ).not.toThrow();
  });
});
