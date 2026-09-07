/**
 * Folding `progress` parts onto the tool rows they describe.
 *
 * A provider reports progress as its own event, so an adapter can only emit it
 * as a loose part. A progress line *beside* a tool row rather than on it reads
 * as a second thing happening, so the fold happens once here rather than in
 * every renderer.
 */
import { describe, expect, test } from "bun:test";
import { attachProgressToToolRows } from "./native-agent-service-projection.js";

describe("attachProgressToToolRows", () => {
  test("moves a progress part onto the tool row it names", () => {
    expect(
      attachProgressToToolRows([
        { type: "tool-invocation", toolUseId: "t1", content: "Bash" },
        { type: "progress", toolUseId: "t1", content: "running tests", elapsedMs: 12_000 },
      ]),
    ).toEqual([
      {
        type: "tool-invocation",
        toolUseId: "t1",
        content: "Bash",
        progress: { content: "running tests", elapsedMs: 12_000 },
      },
    ]);
  });

  test("keeps only the newest report for one call", () => {
    // Progress is a hint over the authoritative tool state, so a backlog of
    // superseded lines is noise.
    const parts = attachProgressToToolRows([
      { type: "tool-invocation", toolUseId: "t1", content: "Bash" },
      { type: "progress", toolUseId: "t1", content: "compiling" },
      { type: "progress", toolUseId: "t1", content: "running tests" },
    ]);
    expect(parts).toHaveLength(1);
    expect((parts[0] as { progress: { content: string } }).progress.content).toBe("running tests");
  });

  test("drops a progress part naming a call this message does not contain", () => {
    // It belongs to a tool the transcript no longer holds; there is nothing for
    // a reader to relate an orphan row to.
    expect(
      attachProgressToToolRows([
        { type: "text", content: "hello" },
        { type: "progress", toolUseId: "gone", content: "still going" },
      ]),
    ).toEqual([{ type: "text", content: "hello" }]);
  });

  test("leaves a message with no progress parts exactly as it was", () => {
    const parts = [{ type: "tool-invocation", toolUseId: "t1", content: "Bash" }];
    // Same array, not a copy: the common case must not allocate.
    expect(attachProgressToToolRows(parts)).toBe(parts);
  });

  test("does not attach a progress part to an unrelated row", () => {
    const parts = attachProgressToToolRows([
      { type: "tool-invocation", toolUseId: "t1", content: "Bash" },
      { type: "tool-invocation", toolUseId: "t2", content: "Read" },
      { type: "progress", toolUseId: "t2", content: "reading" },
    ]);
    expect(parts[0]).not.toHaveProperty("progress");
    expect(parts[1]).toHaveProperty("progress");
  });

  test("ignores a progress part with no call id", () => {
    expect(
      attachProgressToToolRows([
        { type: "tool-invocation", toolUseId: "t1", content: "Bash" },
        { type: "progress", content: "orphan" },
      ]),
    ).toEqual([{ type: "tool-invocation", toolUseId: "t1", content: "Bash" }]);
  });

  test("drops a malformed elapsed time rather than passing it through", () => {
    const parts = attachProgressToToolRows([
      { type: "tool-invocation", toolUseId: "t1", content: "Bash" },
      { type: "progress", toolUseId: "t1", content: "x", elapsedMs: -5 },
    ]);
    expect((parts[0] as { progress: Record<string, unknown> }).progress).toEqual({ content: "x" });
  });

  test("survives non-object entries without throwing", () => {
    expect(
      attachProgressToToolRows([
        null,
        "text",
        { type: "progress", toolUseId: "t1", content: "x" },
        { type: "tool-invocation", toolUseId: "t1", content: "Bash" },
      ]),
    ).toEqual([
      null,
      "text",
      { type: "tool-invocation", toolUseId: "t1", content: "Bash", progress: { content: "x" } },
    ]);
  });
});
