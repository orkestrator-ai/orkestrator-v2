import { beforeEach, describe, expect, test } from "bun:test";
import { projectedFrames, emptyProjection, type DesignIntent } from "@/stores/designStore";
import { DRAFT_LIMITS, isPersistable, loadDrafts, saveDrafts } from "./design-drafts";

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

describe("design draft persistence", () => {
  beforeEach(() => window.localStorage.clear());

  test("persists unsettled and unreviewed intents; drops verified successes", () => {
    expect(isPersistable(intent("a"))).toBe(true);
    expect(isPersistable(intent("b", { phase: "prepared", token: "op_x" }))).toBe(true);
    expect(isPersistable(intent("c", { phase: "settled", outcome: "rejected" }))).toBe(true);
    expect(isPersistable(intent("d", { phase: "settled", outcome: "committed" }))).toBe(false);
    expect(isPersistable(intent("e", { phase: "settled", outcome: "canceled" }))).toBe(false);
  });

  test("restored intents are marked restored and never lose their token", () => {
    expect(saveDrafts("key", [intent("a", { phase: "prepared", token: "op_1" })])).toBe(true);
    const restored = loadDrafts("key");
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: "a", token: "op_1", restored: true });
  });

  test("bounds protect accepted work while tokenless drafts are best effort", () => {
    const many = Array.from({ length: DRAFT_LIMITS.perCanvas + 1 }, (_, index) =>
      intent(`i${index}`),
    );
    expect(saveDrafts("key", many.slice(0, 2))).toBe(true);
    expect(saveDrafts("key", many)).toBe(true);
    expect(loadDrafts("key")).toHaveLength(8);
    expect(saveDrafts("key", [])).toBe(true);
    for (let canvas = 0; canvas < 4; canvas++)
      expect(saveDrafts(`c${canvas}`, many.slice(0, 8))).toBe(true);
    expect(saveDrafts("c-over", [intent("x")])).toBe(true);
    expect(loadDrafts("c-over")).toHaveLength(0);
    const accepted = many.map((item) => ({ ...item, token: `op_${item.id}` }));
    expect(saveDrafts("accepted", accepted)).toBe(false);
  });

  test("separate window keys retain their own accepted tokens", () => {
    expect(saveDrafts("canvas|window-a", [intent("a", { token: "op_a" })])).toBe(true);
    expect(saveDrafts("canvas|window-b", [intent("b", { token: "op_b" })])).toBe(true);
    expect(loadDrafts("canvas|window-a").map((item) => item.id)).toEqual(["a"]);
    expect(loadDrafts("canvas|window-b").map((item) => item.id)).toEqual(["b"]);
  });

  test("corrupt storage reads as empty", () => {
    window.localStorage.setItem("orkestrator.design.intents.v1", "{not-json");
    expect(loadDrafts("key")).toEqual([]);
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
