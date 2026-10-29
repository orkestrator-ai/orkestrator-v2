/**
 * The projection's pure helpers, through their own module. The projection
 * module re-exports the four that existing importers use, so those must stay
 * the same functions.
 */
import { describe, expect, test } from "bun:test";
import * as helpers from "./native-agent-projection-helpers.js";
import * as projection from "./native-agent-transcript-projection.js";

describe("native agent projection helpers", () => {
  test("the projection module re-exports the shared helpers unchanged", () => {
    expect(projection.attachProgressToToolRows).toBe(helpers.attachProgressToToolRows);
    expect(projection.mergeContextUsageTurns).toBe(helpers.mergeContextUsageTurns);
    expect(projection.mergeNativeAgentQueueItems).toBe(helpers.mergeNativeAgentQueueItems);
    expect(projection.withProviderContextWindow).toBe(helpers.withProviderContextWindow);
  });

  test("a title names the first user message only when the read reaches the start", () => {
    const messages = [
      { role: "assistant", content: "hello" },
      { role: "user", content: "Fix the login bug" },
    ];
    expect(helpers.firstUserMessageOf(messages, undefined)).toEqual({
      firstUserMessage: "Fix the login bug",
      reachesStart: true,
    });
    expect(
      helpers.firstUserMessageOf(messages, { truncated: true, omittedMessages: 3 }).reachesStart,
    ).toBe(false);
  });

  test("provider-reported image paths come from images and successful reads only", () => {
    expect(helpers.providerReportedImagePath({ type: "image", fileUrl: "file:///tmp/a.png" })).toBe(
      "/tmp/a.png",
    );
    expect(
      helpers.providerReportedImagePath({
        type: "tool-invocation",
        toolName: "Read",
        toolState: "success",
        toolArgs: { file_path: "/tmp/b.jpg" },
      }),
    ).toBe("/tmp/b.jpg");
    expect(
      helpers.providerReportedImagePath({
        type: "tool-invocation",
        toolName: "Read",
        toolState: "error",
        toolArgs: { file_path: "/tmp/b.jpg" },
      }),
    ).toBeUndefined();
    expect(helpers.providerReportedImagePath({ type: "image", fileUrl: "relative.png" })).toBe(
      undefined,
    );
    expect(helpers.imageMimeType("/tmp/b.JPG")).toBe("image/jpeg");
    expect(helpers.imageMimeType("/tmp/unknown.xyz")).toBe("image/png");
  });

  test("visible notices drop errors and stops and append the owned notices", () => {
    const notices = helpers.visibleProjectionNotices(
      "codex",
      [
        { kind: "error", message: "boom" },
        { kind: "stopped", message: "stopped" },
        { kind: "warning", message: "kept" },
      ] as never,
      { kind: "failed" } as never,
    );
    expect(notices.map((notice) => notice.kind)).toEqual(["warning", "incomplete-turn"]);
  });

  test("interaction kinds keep known kinds once and distinguish empty from absent", () => {
    expect(helpers.normalizeInteractionKinds(undefined)).toBeUndefined();
    expect(helpers.normalizeInteractionKinds([])).toEqual([]);
    expect(helpers.normalizeInteractionKinds(["question", "question", "bogus"])).toEqual([
      "question",
    ]);
  });

  test("progressive messages must all be normalized rows", () => {
    const row = { id: "m1", role: "user", content: "hi", parts: [], createdAt: "now" };
    expect(helpers.normalizedProgressiveMessages([row])).toEqual([row]);
    expect(helpers.normalizedProgressiveMessages([row, { id: "m2" }])).toBeNull();
    expect(helpers.normalizedProgressiveMessages("not a list")).toBeNull();
  });

  test("discovery and model keys ignore drift counts and answer order", () => {
    expect(
      helpers.discoveryAnnouncementKey({ drift: { unknownEvents: 1, unknownKinds: ["b", "a"] } }),
    ).toBe(
      helpers.discoveryAnnouncementKey({ drift: { unknownEvents: 9, unknownKinds: ["a", "b"] } }),
    );
    const first = { id: "a", platform: "codex" };
    const second = { id: "b", platform: "claude" };
    expect(helpers.modelCatalogKey([first, second] as never)).toBe(
      helpers.modelCatalogKey([second, first] as never),
    );
  });
});
