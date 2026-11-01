import { beforeEach, describe, expect, test } from "bun:test";
import { projectedFrames, emptyProjection, type DesignIntent } from "@/stores/designStore";
import { clearLegacyDrafts, readLegacyDrafts } from "./design-drafts";

function intent(id: string, extra: Partial<DesignIntent> = {}): DesignIntent {
  return {
    id,
    environmentId: "env",
    canvasId: "canvas",
    lane: "frame",
    descriptor: {
      input: { kind: "update_frame", frameId: "frame", patch: { x: 1 } },
      preconditions: { frameRevision: 1 },
    },
    label: "Move",
    createdAt: 1,
    phase: "draft",
    ...extra,
  };
}

describe("legacy draft migration", () => {
  beforeEach(() => window.localStorage.clear());
  const KEY = "orkestrator.design.intents.v1";

  test("reads every window's entries of one canvas and leaves other canvases alone", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        "b|env|canvas": [intent("shared")],
        "b|env|canvas|window-a": [intent("a", { token: "op_a" })],
        "b|env|canvas|window-b": [intent("b")],
        "b|env|canvas-2|window-a": [intent("other")],
      }),
    );
    const legacy = readLegacyDrafts("b|env|canvas");
    expect(legacy.keys.sort()).toEqual([
      "b|env|canvas",
      "b|env|canvas|window-a",
      "b|env|canvas|window-b",
    ]);
    expect((legacy.intents as DesignIntent[]).map((item) => item.id).sort()).toEqual([
      "a",
      "b",
      "shared",
    ]);
    clearLegacyDrafts(legacy.keys);
    expect(readLegacyDrafts("b|env|canvas").intents).toEqual([]);
    expect(readLegacyDrafts("b|env|canvas-2").intents).toHaveLength(1);
    clearLegacyDrafts(["b|env|canvas-2|window-a"]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test("corrupt storage reads as empty", () => {
    window.localStorage.setItem(KEY, "{not-json");
    expect(readLegacyDrafts("key")).toEqual({ keys: [], intents: [] });
  });
});

describe("projected frames", () => {
  test("optimistic previews apply over committed frames; failed intents do not", () => {
    const projection = {
      ...emptyProjection("k", "env", "canvas"),
      canvas: {
        format: "orkdes" as const,
        version: 1 as const,
        id: "canvas",
        environmentId: "env",
        name: "n",
        revision: 3,
        frames: [
          { id: "frame", name: "F", x: 0, y: 0, width: 100, height: 100, html: "", revision: 2 },
          { id: "other", name: "O", x: 0, y: 0, width: 100, height: 100, html: "", revision: 1 },
        ],
      },
      intents: [
        intent("move", { preview: { frameId: "frame", patch: { x: 50 } } }),
        intent("resize", { preview: { frameId: "frame", patch: { width: 300 } } }),
        intent("failed", {
          phase: "settled",
          outcome: "rejected",
          failure: { code: "conflict", message: "", retry: "after-refresh" },
          preview: { frameId: "frame", patch: { y: 999 } },
        }),
      ],
    };
    const frames = projectedFrames(projection);
    expect(frames[0]).toMatchObject({ x: 50, width: 300, y: 0, revision: 2 });
    // Unchanged frames keep their identity for memoization.
    expect(frames[1]).toBe(projection.canvas.frames[1]!);
  });
});
