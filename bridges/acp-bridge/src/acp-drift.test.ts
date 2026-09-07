/**
 * What this bridge does with a `session/update` kind it has no branch for.
 *
 * ACP is a wire the agent versions, so an addition upstream must be countable
 * rather than silent — and countable by *name* only, because an update payload
 * carries prompts, file contents and terminal output.
 */
import { describe, expect, test } from "bun:test";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";

// `acp-context` resolves the provider at module load and refuses to load
// without one. This suite exercises the update reducer, not provider
// selection, so the variable is set before the first import rather than
// spawning a bridge to supply it.
process.env.ACP_PROVIDER ??= "grok";

const { applySessionUpdate } = await import("./acp-session.js");
const { emptySessionConfig } = await import("./acp-persistence.js");
type SessionState = import("./acp-context.js").SessionState;

function state(): SessionState {
  return {
    id: "bridge-session",
    acpSessionId: "acp-1",
    status: "idle",
    messages: [],
    activeSubagentToolIds: new Set(),
    activeSubagentDescriptors: new Map(),
    settledCursorAgentIds: new Set(),
    subagentLimitExceeded: false,
    subagentToolIds: new Map(),
    cursorTodos: [],
    historyMessageIds: new Map(),
    child: null,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
    grokInterjectionJournal: new Map(),
    approvals: new Map(),
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    promptSequence: 0,
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    sessionConfig: emptySessionConfig(),
    dispatching: false,
    historyReplay: false,
    health: new RuntimeHealthRecorder(),
  };
}

function update(session: SessionState, sessionUpdate: string, extra: object = {}): void {
  applySessionUpdate(session, {
    sessionId: session.acpSessionId,
    update: { sessionUpdate, ...extra },
  });
}

describe("unknown session/update kinds", () => {
  test("an unrecognised kind is counted and named, never thrown", () => {
    const session = state();

    expect(() => update(session, "conversation_forked")).not.toThrow();

    expect(session.health.drift()).toEqual({
      unknownEvents: 1,
      unknownKinds: ["conversation_forked"],
    });
  });

  test("the payload is never recorded, only the kind name", () => {
    const session = state();
    update(session, "secret_update", {
      content: { type: "text", text: "the user's private prompt" },
      apiKey: "sk-not-a-real-key",
    });

    const serialized = JSON.stringify(session.health.snapshot());
    expect(serialized).toContain("secret_update");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("sk-not-a-real-key");
  });

  test("kinds the bridge does handle do not count as drift", () => {
    const session = state();
    update(session, "available_commands_update", { availableCommands: [] });
    update(session, "agent_message", { content: { type: "text", text: "hello" } });
    update(session, "plan", { entries: [] });

    expect(session.health.drift()).toBeUndefined();
  });

  test("an update addressed to a different ACP session is not this session's drift", () => {
    const session = state();
    applySessionUpdate(session, {
      sessionId: "some-other-session",
      update: { sessionUpdate: "brand_new_kind" },
    });

    expect(session.health.drift()).toBeUndefined();
  });

  test("an update with no kind at all is still counted, under a placeholder name", () => {
    const session = state();
    applySessionUpdate(session, { sessionId: session.acpSessionId, update: {} });

    expect(session.health.drift()).toEqual({ unknownEvents: 1, unknownKinds: ["(unnamed)"] });
  });

  test("repeats accumulate on the count without repeating the name", () => {
    const session = state();
    for (let index = 0; index < 5; index += 1) update(session, "conversation_forked");

    expect(session.health.drift()).toEqual({
      unknownEvents: 5,
      unknownKinds: ["conversation_forked"],
    });
  });
});

/**
 * Non-text ACP content blocks.
 *
 * ACP content is a union — text, image, audio, resource, resource_link — and
 * only the text arm was read. An agent that answered with a screenshot
 * produced a transcript that said nothing had happened.
 */
describe("non-text content blocks", () => {
  test("an image-only update becomes an image row", () => {
    const session = state();
    update(session, "agent_message", {
      content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png", alt: "the error" }],
    });

    const part = session.messages.at(-1)!.parts[0]!;
    expect(part).toMatchObject({
      type: "image",
      content: "the error",
      fileUrl: "data:image/png;base64,iVBORw0KGgo=",
      imageSource: "viewed",
    });
  });

  test("an oversized image is named rather than shown broken", () => {
    const session = state();
    update(session, "agent_message", {
      content: [{ type: "image", data: "x".repeat(5 * 1024 * 1024), mimeType: "image/png" }],
    });

    expect(session.messages.at(-1)!.parts[0]).toMatchObject({
      type: "file",
      content: "Image (too large to display)",
    });
  });

  test("a resource link becomes a file row carrying its uri", () => {
    const session = state();
    update(session, "agent_message", {
      content: [{ type: "resource_link", uri: "file:///workspace/notes.md", name: "notes.md" }],
    });

    expect(session.messages.at(-1)!.parts[0]).toMatchObject({
      type: "file",
      content: "notes.md",
      fileUrl: "file:///workspace/notes.md",
    });
  });

  test("audio is named by its MIME type, since nothing here can play it", () => {
    const session = state();
    update(session, "agent_message", {
      content: [{ type: "audio", data: "abc", mimeType: "audio/wav" }],
    });

    expect(session.messages.at(-1)!.parts[0]).toMatchObject({
      type: "file",
      content: "Audio (audio/wav)",
    });
  });

  test("text blocks still take the text path, and are not duplicated as parts", () => {
    const session = state();
    update(session, "agent_message", {
      content: [{ type: "text", text: "hello" }],
    });

    const parts = session.messages.at(-1)!.parts;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "text", content: "hello" });
  });

  test("keeps text and an image from the same update", () => {
    const session = state();
    update(session, "agent_message", {
      content: [
        { type: "text", text: "See the screenshot" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png", alt: "result" },
      ],
    });

    expect(session.messages.at(-1)!.parts).toMatchObject([
      { type: "text", content: "See the screenshot" },
      { type: "image", content: "result", fileUrl: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
  });

  test("keeps text and a resource link on a hydrated user message", () => {
    const session = state();
    session.historyReplay = "hydrate";
    update(session, "user_message", {
      content: [
        { type: "text", text: "Use these notes" },
        { type: "resource_link", uri: "file:///workspace/notes.md", name: "notes.md" },
      ],
    });

    expect(session.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Use these notes",
      parts: [
        { type: "text", content: "Use these notes" },
        { type: "file", content: "notes.md", fileUrl: "file:///workspace/notes.md" },
      ],
    });
  });

  test("an update with no renderable block at all adds no message", () => {
    const session = state();
    update(session, "agent_message", { content: [{ type: "something_new" }] });
    expect(session.messages).toEqual([]);
  });

  test("a user image update lands as a user row", () => {
    const session = state();
    session.historyReplay = "hydrate";
    update(session, "user_message", {
      content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });

    expect(session.messages.at(-1)?.role).toBe("user");
  });
});
