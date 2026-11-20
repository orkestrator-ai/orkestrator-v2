import { describe, expect, test } from "bun:test";
import { DEFAULT_NATIVE_AGENT_LIVE_WINDOW } from "@orkestrator/protocol/native-agent";
import { TOOL_OUTPUT_READ_MAX_BYTES } from "@orkestrator/protocol/native-agent-tool-output";
import { nativeAgentSessionStorageKey } from "./service-shared.js";
import { NativeAgentToolOutputReads, findToolPart } from "./tool-output-reads.js";

const SESSION = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey: "tab-1" };
const SESSION_KEY = nativeAgentSessionStorageKey(
  SESSION.environmentId,
  SESSION.agent,
  SESSION.logicalSessionKey,
);
const VIEW_KEY = `${SESSION_KEY}\0progressive-v1\0transcript:${DEFAULT_NATIVE_AGENT_LIVE_WINDOW.messages}:${DEFAULT_NATIVE_AGENT_LIVE_WINDOW.targetBytes}`;

function toolPart(toolUseId: string, fields: Record<string, unknown> = {}) {
  return { type: "tool-invocation", toolName: "Bash", toolUseId, ...fields };
}

function withIds(messages: unknown[]) {
  return messages.map((message) => ({ id: "row", ...(message as object) }));
}

function harness(
  options: {
    messages?: unknown[];
    revisedMessages?: unknown[];
    details?: Record<string, { toolOutput?: string; toolError?: string }>;
    populateOnRead?: unknown[];
  } = {},
) {
  const cache = new Map<string, { value: { messages: unknown[]; revisedMessages?: unknown[] } }>();
  if (options.messages) {
    cache.set(VIEW_KEY, {
      value: {
        messages: withIds(options.messages),
        ...(options.revisedMessages ? { revisedMessages: withIds(options.revisedMessages) } : {}),
      },
    });
  }
  const detailReads: string[] = [];
  let transcriptReads = 0;
  const context = {
    host: { assertProjectionInput: () => undefined },
    transcript: {
      progressiveTranscriptCache: cache,
      getTranscriptUpdate: async () => {
        transcriptReads += 1;
        if (options.populateOnRead) {
          cache.set(VIEW_KEY, { value: { messages: withIds(options.populateOnRead) } });
        }
        return {};
      },
    },
    toolDetails: {
      readRemoteOutput: async () => undefined,
      getProjectionToolDetails: async (input: { detailRef: string }) => {
        detailReads.push(input.detailRef);
        const details = options.details?.[input.detailRef];
        if (!details) throw new Error("Native agent tool details are no longer available");
        return { detailRef: input.detailRef, ...details };
      },
    },
  };
  const reads = new NativeAgentToolOutputReads(context as never);
  return {
    reads,
    cache,
    detailReads,
    transcriptReads: () => transcriptReads,
    read: (fields: Record<string, unknown>) =>
      reads.readToolOutput({
        ...SESSION,
        toolUseId: "call-1",
        messageId: "row",
        mode: "tail",
        limit: 16,
        ...fields,
      } as never),
  };
}

describe("findToolPart", () => {
  test("finds the newest call in nested groups", () => {
    const messages = [
      { id: "m1", parts: [toolPart("call-1", { detailRef: "old", toolState: "success" })] },
      {
        id: "m2",
        parts: [
          {
            type: "tool-group",
            parts: [
              toolPart("call-2"),
              toolPart("call-1", { detailRef: "new", toolState: "pending" }),
            ],
          },
        ],
      },
    ];
    expect(findToolPart(messages, "call-1")).toEqual({
      detailRef: "new",
      toolState: "pending",
      settled: false,
    });
    expect(findToolPart(messages, "absent")).toBeUndefined();
  });

  test("a call left running or denied is settled", () => {
    expect(
      findToolPart([{ parts: [toolPart("c", { toolLeftRunning: true })] }], "c")?.settled,
    ).toBe(true);
    expect(findToolPart([{ parts: [toolPart("c", { toolDenied: {} })] }], "c")?.settled).toBe(true);
  });
});

describe("NativeAgentToolOutputReads", () => {
  const output = "x".repeat(40) + "tail-end";

  test("reads the tail of a running call through its detail reference", async () => {
    const h = harness({
      messages: [{ parts: [toolPart("call-1", { detailRef: "ref-1", toolState: "pending" })] }],
      details: { "ref-1": { toolOutput: output } },
    });
    const result = await h.read({});
    expect(result).toMatchObject({
      status: "ok",
      complete: false,
      text: "xxxxxxxxtail-end",
      start: 32,
      end: 48,
      totalBytes: 48,
      truncatedBefore: true,
    });
    expect(h.detailReads).toEqual(["ref-1"]);
    expect(h.transcriptReads()).toBe(0);
    expect(h.reads.toolOutputSource(SESSION, "call-1")).toEqual({
      located: true,
      detailRef: "ref-1",
      toolState: "pending",
      complete: false,
    });
  });

  test("appends from a cursor and reports completion", async () => {
    const h = harness({
      messages: [{ parts: [toolPart("call-1", { detailRef: "ref-1", toolState: "success" })] }],
      details: { "ref-1": { toolOutput: "abc\ndef\n", toolError: "exit 1" } },
    });
    const first = await h.read({ mode: "range", cursor: 4, limit: 64 });
    expect(first).toMatchObject({ status: "ok", complete: true, text: "def\n", start: 4, end: 8 });
    expect(first).toMatchObject({ toolError: "exit 1" });
  });

  test("bounds the answer whatever the limit asked", async () => {
    const big = "y".repeat(TOOL_OUTPUT_READ_MAX_BYTES * 2);
    const h = harness({
      messages: [{ parts: [toolPart("call-1", { detailRef: "ref-1", toolState: "pending" })] }],
      details: { "ref-1": { toolOutput: big } },
    });
    const result = await h.read({ limit: 1e9 });
    expect(result.status === "ok" && result.text.length).toBe(TOOL_OUTPUT_READ_MAX_BYTES);
  });

  test("an inline call with no reference is sliced as it is", async () => {
    const h = harness({
      messages: [{ parts: [toolPart("call-1", { toolState: "pending" })] }],
    });
    expect(await h.read({})).toMatchObject({ status: "ok", text: "", totalBytes: 0 });
    expect(h.detailReads).toEqual([]);
  });

  test("finds a call in the revised rows outside the window", async () => {
    const h = harness({
      messages: [{ parts: [] }],
      revisedMessages: [
        { parts: [toolPart("call-1", { detailRef: "ref-r", toolState: "pending" })] },
      ],
      details: { "ref-r": { toolOutput: "revised" } },
    });
    expect(await h.read({})).toMatchObject({ status: "ok", text: "revised", complete: false });
  });

  test("an older detail body keeps its occurrence pending until a revised row settles it", async () => {
    const h = harness({
      messages: [{ parts: [] }],
      details: { "ref-old": { toolOutput: "older" } },
    });
    expect(await h.read({})).toEqual({ status: "pending" });
    expect(await h.read({ detailRef: "ref-old" })).toMatchObject({
      status: "ok",
      text: "older",
      complete: false,
    });
    h.cache.set(VIEW_KEY, {
      value: {
        messages: [{ id: "later", parts: [toolPart("call-1", { toolOutput: "wrong" })] }],
        revisedMessages: [
          { id: "row", parts: [toolPart("call-1", { toolState: "success", toolOutput: "final" })] },
        ],
      },
    });
    expect(await h.read({ detailRef: "ref-old" })).toMatchObject({
      status: "ok",
      text: "final",
      complete: true,
    });
    expect(await h.read({ messageId: "later" })).toMatchObject({
      status: "ok",
      text: "wrong",
      complete: false,
    });
  });

  test("an evicted reference for a settled call is expired", async () => {
    const h = harness({
      messages: [{ parts: [toolPart("call-1", { detailRef: "gone", toolState: "success" })] }],
    });
    expect(await h.read({})).toEqual({ status: "expired" });
  });

  test("with no cached view it reads the live view once", async () => {
    const h = harness({
      populateOnRead: [
        { parts: [toolPart("call-1", { detailRef: "ref-1", toolState: "pending" })] },
      ],
      details: { "ref-1": { toolOutput: "hello" } },
    });
    expect(h.reads.toolOutputSource(SESSION, "call-1")).toBeNull();
    expect(await h.read({})).toMatchObject({ status: "ok", text: "hello" });
    expect(h.transcriptReads()).toBe(1);
    await h.read({});
    expect(h.transcriptReads()).toBe(1);
  });

  test("a session with no view at all does not establish completion", async () => {
    const h = harness();
    expect(await h.read({})).toEqual({ status: "pending" });
  });
});
