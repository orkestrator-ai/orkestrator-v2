import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createNativeAgentDisplayTail,
  isNativeAgentDisplayTail,
  preparedDisplayTailPayload,
  stripDisplayTailPayload,
  type NativeAgentDisplayTail,
} from "./native-agent-display-tails.js";
import { normalizeOpenCodeEnvelope } from "./opencode-display-transcript.js";

describe("native agent display tails", () => {
  test("strips tool payloads, data URLs and approval state", () => {
    const stripped = stripDisplayTailPayload({
      id: "m1",
      content: "hello",
      toolOutput: "secret tool dump",
      toolError: "boom",
      fileUrl: "data:image/png;base64,abc",
      interactions: [{ id: "approval" }],
      token: "sync-token",
      toolDiff: { filePath: "a.ts", additions: 1, deletions: 0, diff: "---" },
    });
    expect(stripped).toEqual({
      id: "m1",
      content: "hello",
      toolDiff: { filePath: "a.ts", additions: 1, deletions: 0, deferred: true },
    });
  });

  test("keeps an OpenCode edit path and counts when its diff body is stripped", () => {
    const normalized = normalizeOpenCodeEnvelope(
      {
        info: { id: "m1", role: "assistant", time: { created: 0 } },
        parts: [
          {
            id: "p1",
            type: "tool",
            tool: "edit",
            state: {
              status: "completed",
              title: "apps/web/src/a.ts",
              input: {},
              output: "Edit applied successfully.",
              metadata: {
                filediff: {
                  file: "apps/web/src/a.ts",
                  patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
                  additions: 1,
                  deletions: 1,
                },
              },
            },
          },
        ],
      },
      0,
    );

    const stripped = stripDisplayTailPayload(normalized) as {
      parts: Array<{ toolDiff?: Record<string, unknown> }>;
    };
    expect(stripped.parts[0]?.toolDiff).toEqual({
      filePath: "apps/web/src/a.ts",
      additions: 1,
      deletions: 1,
      deferred: true,
    });
  });

  test("rejects an oversized or tampered preview", () => {
    const ok = createNativeAgentDisplayTail({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "tab-1",
      providerSessionId: "provider-1",
      historyEpoch: "epoch-1",
      messages: [{ id: "m1", role: "assistant", content: "hi", parts: [] }],
      updatedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(ok).not.toBeNull();
    expect(isNativeAgentDisplayTail(ok)).toBe(true);
    expect(isNativeAgentDisplayTail({ ...ok, checksum: "nope" })).toBe(false);

    const huge = createNativeAgentDisplayTail({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "tab-1",
      providerSessionId: "provider-1",
      historyEpoch: "epoch-1",
      messages: Array.from({ length: 20 }, (_, index) => ({
        id: `m${index}`,
        content: "x".repeat(40_000),
        parts: [],
      })),
      updatedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(huge).toBeNull();
  });

  test("serializes a checkpoint once for size and row, with the checksum unchanged", () => {
    const input = {
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "tab-1",
      providerSessionId: "provider-1",
      historyEpoch: "epoch-1",
      title: "Title",
      messages: [{ id: "m1", role: "assistant", content: "é", parts: [{ toolOutput: "x" }] }],
      historyComplete: true,
      messageWindow: { limit: 100, truncated: false },
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    const stringify = spyOn(JSON, "stringify");
    let tail: NativeAgentDisplayTail | null;
    try {
      tail = createNativeAgentDisplayTail(input);
      // The checksum's positional array, then the row that is also measured.
      expect(stringify).toHaveBeenCalledTimes(2);
      stringify.mockClear();
      expect(isNativeAgentDisplayTail(tail)).toBe(true);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
    if (!tail) throw new Error("expected a tail");
    // The v2 checksum, computed independently: stored tails keep verifying.
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          2,
          "native-agent-display-tail-v2",
          "env-1",
          "codex",
          "tab-1",
          "provider-1",
          "epoch-1",
          "Title",
          [{ id: "m1", role: "assistant", content: "é", parts: [{}] }],
          true,
          { limit: 100, truncated: false },
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    expect(tail.checksum).toBe(expected);
    expect(preparedDisplayTailPayload(tail)).toEqual({
      payload: JSON.stringify(tail),
      bytes: Buffer.byteLength(JSON.stringify(tail)),
    });
    expect(Object.isFrozen(tail)).toBe(true);
    expect(Object.isFrozen(tail.messages[0])).toBe(true);
    // The caller's messages are untouched: the tail holds stripped copies.
    expect(Object.isFrozen(input.messages[0])).toBe(false);
    // A copy is not the prepared tail, so it is validated in full.
    expect(preparedDisplayTailPayload({ ...tail })).toBeUndefined();
    expect(isNativeAgentDisplayTail({ ...tail, title: "Other" })).toBe(false);
  });

  test("persists history completeness and rejects a tampered recovery flag", () => {
    const incomplete = createNativeAgentDisplayTail({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "tab-1",
      providerSessionId: "provider-1",
      historyEpoch: "epoch-1",
      messages: [{ id: "m1", role: "assistant", content: "hi", parts: [] }],
      historyComplete: false,
      messageWindow: {
        limit: 100,
        truncated: true,
        canLoadEarlier: true,
        truncationReason: "count",
      },
      updatedAt: "2026-09-09T00:00:00.000Z",
    });
    expect(incomplete).not.toBeNull();
    expect(incomplete?.historyComplete).toBe(false);
    expect(incomplete?.messageWindow).toMatchObject({
      truncated: true,
      canLoadEarlier: true,
    });
    expect(isNativeAgentDisplayTail(incomplete)).toBe(true);
    expect(isNativeAgentDisplayTail({ ...incomplete, historyComplete: true })).toBe(false);
  });

  test("rejects a version 1 tail: no stored row can hold one", () => {
    const record = {
      version: 1,
      schema: "native-agent-display-tail-v1",
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "tab-1",
      providerSessionId: "provider-1",
      historyEpoch: "epoch-1",
      messages: [{ id: "m1", role: "assistant", content: "hi", parts: [] }],
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    const tail = { ...record, checksum: "0".repeat(32) };
    expect(isNativeAgentDisplayTail(tail)).toBe(false);
  });
});
