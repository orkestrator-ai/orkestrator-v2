import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  NATIVE_TOOL_DETAIL_MEMO_LIMITS,
  ToolDetailEncodingMemo,
} from "./native-agent-tool-detail-memo.js";

/** The reference as the projection minted it before the memo existed. */
function freshRef(
  sessionKey: string,
  messageId: string,
  partPath: string,
  details: object,
  localImagePath = "",
): string {
  return createHash("sha256")
    .update(
      `${sessionKey}\0${messageId}\0${partPath}\0${JSON.stringify(details)}\0${localImagePath}`,
    )
    .digest("hex")
    .slice(0, 32);
}

describe("tool detail encoding memo", () => {
  test("a hit answers exactly what a fresh hash would, and anything different misses", () => {
    const memo = new ToolDetailEncodingMemo(NATIVE_TOOL_DETAIL_MEMO_LIMITS);
    const body = () => ({ toolOutput: "é output", toolDiff: { filePath: "a.ts", diff: "-a\n+b" } });
    const first = memo.encode("s", "m", "0", body());
    expect(first).toEqual({
      detailRef: freshRef("s", "m", "0", body()),
      serializedBytes: Buffer.byteLength(JSON.stringify(body())),
    });
    // A structurally equal fresh object (bridges parse anew each read) hits.
    expect(memo.encode("s", "m", "0", body())).toBe(first);
    expect(memo.hits).toBe(1);

    const cases: Array<[string, string, string, object, string?]> = [
      ["s", "m", "0", { toolOutput: "é output!", toolDiff: body().toolDiff }],
      ["s", "m", "0", { toolDiff: body().toolDiff, toolOutput: "é output" }],
      ["s", "m", "0", body(), "/tmp/image.png"],
      ["s", "m", "1", body()],
      ["s", "other", "0", body()],
      ["other", "m", "0", body()],
    ];
    for (const [sessionKey, messageId, partPath, details, imagePath] of cases) {
      const encoding = memo.encode(sessionKey, messageId, partPath, details, imagePath);
      expect(encoding.detailRef).toBe(
        freshRef(sessionKey, messageId, partPath, details, imagePath),
      );
    }
    expect(memo.hits).toBe(1);
  });

  test("an entry is a private copy: a provider mutating its object cannot fake a hit", () => {
    const memo = new ToolDetailEncodingMemo(NATIVE_TOOL_DETAIL_MEMO_LIMITS);
    const body = { toolArgs: { command: "ls" } };
    const first = memo.encode("s", "m", "0/args", body);
    body.toolArgs.command = "rm -rf .";
    const second = memo.encode("s", "m", "0/args", body);
    expect(second.detailRef).not.toBe(first.detailRef);
    expect(second.detailRef).toBe(freshRef("s", "m", "0/args", body));
  });

  test("keeps to its count and byte bounds, least recently used first", () => {
    const memo = new ToolDetailEncodingMemo({
      maxEntries: 2,
      maxBytes: 4 * 1024,
      maxEntryBytes: 2 * 1024,
    });
    memo.encode("s", "m", "0", { toolOutput: "a" });
    memo.encode("s", "m", "1", { toolOutput: "b" });
    memo.encode("s", "m", "0", { toolOutput: "a" });
    memo.encode("s", "m", "2", { toolOutput: "c" });
    expect(memo.size).toBe(2);
    // "1" was the least recently used.
    memo.encode("s", "m", "1", { toolOutput: "b" });
    expect(memo.hits).toBe(1);

    memo.clear();
    memo.encode("s", "m", "big", { toolOutput: "x".repeat(3 * 1024) });
    expect(memo.size).toBe(0);
    for (let index = 0; index < 2; index += 1) {
      memo.encode("s", "m", String(index), { toolOutput: "y".repeat(1_500) });
    }
    expect(memo.bytes).toBeLessThanOrEqual(4 * 1024);
    memo.encode("s", "m", "2", { toolOutput: "y".repeat(1_500) });
    expect(memo.size).toBe(2);
    expect(memo.bytes).toBeLessThanOrEqual(4 * 1024);
  });

  test("forgets one session's entries and nothing else", () => {
    const memo = new ToolDetailEncodingMemo(NATIVE_TOOL_DETAIL_MEMO_LIMITS);
    memo.encode("a", "m", "0", { toolOutput: "1" });
    memo.encode("b", "m", "0", { toolOutput: "2" });
    const kept = memo.bytes;
    memo.forgetSession("a");
    expect(memo.size).toBe(1);
    expect(memo.bytes).toBeLessThan(kept);
    memo.encode("b", "m", "0", { toolOutput: "2" });
    expect(memo.hits).toBe(1);
    memo.clear();
    expect(memo.size).toBe(0);
    expect(memo.bytes).toBe(0);
  });
});
