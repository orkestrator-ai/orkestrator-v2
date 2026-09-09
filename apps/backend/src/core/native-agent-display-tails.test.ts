import { describe, expect, test } from "bun:test";
import {
  createNativeAgentDisplayTail,
  isNativeAgentDisplayTail,
  stripDisplayTailPayload,
} from "./native-agent-display-tails.js";

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
});
