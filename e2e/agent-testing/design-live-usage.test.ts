import { describe, expect, test } from "bun:test";
import { detailBytes, summarizeDesignToolCalls } from "./design-live-usage";

const tool = (toolName: string, toolOutput?: unknown, extra: Record<string, unknown> = {}) => ({
  type: "tool-invocation",
  toolName,
  ...(toolOutput === undefined ? {} : { toolOutput }),
  ...extra,
});

describe("summarizeDesignToolCalls", () => {
  test("counts Claude and Codex design tools, failures and output bytes, ignoring other tools", () => {
    const usage = summarizeDesignToolCalls([
      { role: "user", content: "brief" },
      {
        role: "assistant",
        parts: [
          tool("mcp__orkestrator-design__get_canvas_summary", "abc"),
          tool("Bash", "ignored output"),
          tool(
            "create_frame",
            { frameId: "f" },
            {
              toolTitle: "orkestrator-design:create_frame",
              toolState: "failure",
            },
          ),
          tool("mcp__orkestrator__send_message", "ignored"),
          { type: "text", content: "done" },
        ],
      },
      {
        role: "assistant",
        parts: [
          tool("get_frame", "é", { toolTitle: "orkestrator-design:get_frame" }),
          // A same-named tool from another server is not a design call.
          tool("get_frame", "ignored", { toolTitle: "other:get_frame" }),
          tool("exec", "ignored", { toolTitle: "exec" }),
        ],
      },
    ]);
    expect(usage.calls).toEqual(["get_canvas_summary", "create_frame", "get_frame"]);
    expect(usage.byTool).toEqual({ get_canvas_summary: 1, create_frame: 1, get_frame: 1 });
    expect(usage.failed).toEqual(["create_frame"]);
    // "abc" + '{"frameId":"f"}' + a two-byte character.
    expect(usage.responseBytes).toBe(3 + 15 + 2);
  });

  test("requires explicit success for inspection and capture", () => {
    const usage = summarizeDesignToolCalls([
      { role: "user" },
      {
        role: "assistant",
        parts: [
          tool("mcp__orkestrator-design__inspect_element", undefined, { toolState: "failure" }),
          tool("mcp__orkestrator-design__capture_frame", undefined, { toolState: "running" }),
          tool("mcp__orkestrator-design__inspect_element"),
          tool("capture_frame", "image", {
            toolTitle: "other:capture_frame",
            toolState: "success",
          }),
        ],
      },
    ]);
    expect(usage.succeeded).toEqual([]);
    const completed = summarizeDesignToolCalls([
      { role: "user" },
      {
        role: "assistant",
        parts: [
          tool("mcp__orkestrator-design__inspect_element", "{}", { toolState: "success" }),
          tool("capture_frame", undefined, {
            toolTitle: "orkestrator-design:capture_frame",
            toolState: "success",
            detailRef: "image",
          }),
        ],
      },
    ]);
    expect(completed.succeeded).toEqual(["inspect_element", "capture_frame"]);
  });

  test("afterUserMessage keeps only the calls after that many user messages", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", parts: [tool("mcp__orkestrator-design__create_canvas", "x")] },
      { role: "user" },
      { role: "assistant", parts: [tool("mcp__orkestrator-design__get_frame", "yy")] },
    ];
    expect(summarizeDesignToolCalls(messages, { afterUserMessage: 1 })).toEqual({
      calls: ["get_frame"],
      responseBytes: 2,
      detailRefs: [],
      byTool: { get_frame: 1 },
      failed: [],
      succeeded: [],
    });
    expect(summarizeDesignToolCalls(messages).calls).toHaveLength(2);
  });

  test("tolerates rows without parts and parts that are not objects", () => {
    expect(
      summarizeDesignToolCalls([
        { role: "assistant", content: "text only" },
        { role: "assistant", parts: [null, "x", tool("mcp__orkestrator-design__undo")] },
      ]),
    ).toEqual({
      calls: ["undo"],
      responseBytes: 0,
      detailRefs: [],
      byTool: { undo: 1 },
      failed: [],
      succeeded: [],
    });
  });

  test("collects detail references for calls whose output is fetched on demand", () => {
    const usage = summarizeDesignToolCalls([
      {
        role: "assistant",
        parts: [
          tool("mcp__orkestrator-design__capture_frame", undefined, { detailRef: "ref-1" }),
          tool("mcp__orkestrator-design__get_frame", "{}", { detailRef: "ref-2" }),
          tool("Bash", undefined, { detailRef: "ignored" }),
        ],
      },
    ]);
    expect(usage.detailRefs).toEqual(["ref-1"]);
    expect(usage.responseBytes).toBe(2);
    expect(detailBytes({ toolOutput: "abc", toolError: "é", fileDataUrl: "data:x" })).toBe(
      3 + 2 + 6,
    );
    expect(detailBytes({})).toBe(0);
  });
});
