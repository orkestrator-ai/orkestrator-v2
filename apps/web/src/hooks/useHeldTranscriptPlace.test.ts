import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { coalesceAdjacentToolMessages } from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  HeldTranscriptPlace,
  useHeldTranscriptPlace,
  useRestoreHeldPlace,
} from "./useHeldTranscriptPlace";

afterEach(() => cleanup());

const text = (id: string): NativeMessage => ({
  id,
  role: "assistant",
  content: id,
  createdAt: "2026-10-18T01:30:00.000Z",
  parts: [{ type: "text", content: id }],
});

const read = (id: string, createdAt: string): NativeMessage => ({
  id,
  role: "assistant",
  content: "",
  createdAt,
  parts: [
    {
      type: "tool-invocation",
      content: "Read",
      toolName: "Read",
      toolUseId: `call${id.slice(1)}`,
      createdAt,
    },
  ],
});

function setup(initial: NativeMessage[], loading?: boolean) {
  const scrollToIndex = mock((_index: number, _anchor?: unknown, _owner?: string) => true);
  const hook = renderHook(
    ({ messages, loading }) => {
      const place = useHeldTranscriptPlace();
      useRestoreHeldPlace(place, messages, scrollToIndex, loading);
      return place;
    },
    {
      initialProps: { messages: initial, loading } as {
        messages: NativeMessage[];
        loading?: boolean;
      },
    },
  );
  return { hook, scrollToIndex };
}

describe("useRestoreHeldPlace", () => {
  test("scrolls back to the row that was first once a page lands above it", () => {
    const { hook, scrollToIndex } = setup([text("m52"), text("m53")]);
    hook.result.current.hold();
    hook.rerender({ messages: [text("m1"), text("m2"), text("m52"), text("m53")] });
    expect(scrollToIndex.mock.calls).toEqual([[2]]);
    // The place is consumed: a later change does not scroll again.
    hook.rerender({ messages: [text("m1"), text("m2"), text("m52"), text("m53"), text("m54")] });
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  test("keeps one place per mount across renders", () => {
    const { hook } = setup([text("m1")]);
    const first = hook.result.current;
    hook.rerender({ messages: [text("m1"), text("m2")] });
    expect(hook.result.current).toBe(first);
  });

  test("waits while the page is in flight and through renders that prepend nothing", () => {
    const { hook, scrollToIndex } = setup([text("m52"), text("m53")]);
    hook.result.current.hold();
    // A tail update arrives before the page does.
    hook.rerender({ messages: [text("m52"), text("m53"), text("m54")] });
    expect(scrollToIndex).not.toHaveBeenCalled();
    hook.rerender({ messages: [text("m50"), text("m51"), text("m52"), text("m53"), text("m54")] });
    expect(scrollToIndex.mock.calls).toEqual([[2]]);
  });

  test("drops the place when its row leaves the transcript", () => {
    const { hook, scrollToIndex } = setup([text("m52"), text("m53")]);
    hook.result.current.hold();
    hook.rerender({ messages: [text("n1"), text("n2")] });
    hook.rerender({ messages: [text("n0"), text("n1"), text("m52")] });
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  test("release forgets a held place", () => {
    const { hook, scrollToIndex } = setup([text("m52"), text("m53")]);
    hook.result.current.hold();
    hook.result.current.release();
    hook.rerender({ messages: [text("m1"), text("m52"), text("m53")] });
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  test("holds nothing on an empty transcript", () => {
    const { hook, scrollToIndex } = setup([]);
    hook.result.current.hold();
    hook.rerender({ messages: [text("m1"), text("m2")] });
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  test("restores index zero when the whole page merges into the head block", () => {
    const reads = Array.from({ length: 40 }, (_, index) =>
      read(`r${index}`, "2026-10-18T01:33:20.000Z"),
    );
    const { hook, scrollToIndex } = setup(coalesceAdjacentToolMessages(reads.slice(30)));
    hook.result.current.hold();
    hook.rerender({ messages: coalesceAdjacentToolMessages(reads) });
    expect(scrollToIndex.mock.calls).toEqual([[0]]);
  });

  test("captures a visible tool inside a tall row and preserves its viewport offset", () => {
    const reads = [
      read("r52", "2026-10-18T01:33:20.000Z"),
      read("r53", "2026-10-18T01:33:30.000Z"),
    ];
    const { hook, scrollToIndex } = setup(coalesceAdjacentToolMessages(reads));
    const scroller = document.createElement("div");
    scroller.innerHTML =
      '<div data-chat-message-index="0"><div data-transcript-part-id="call52"></div><div data-transcript-part-id="call53"></div></div>';
    const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
    scroller.getBoundingClientRect = () => rect(100, 600);
    Object.defineProperty(scroller, "clientHeight", { value: 500 });
    const row = scroller.firstElementChild as HTMLElement;
    row.getBoundingClientRect = () => rect(-300, 700);
    (row.children[0] as HTMLElement).getBoundingClientRect = () => rect(-200, 90);
    (row.children[1] as HTMLElement).getBoundingClientRect = () => rect(90, 700);
    hook.result.current.hold(scroller);
    hook.rerender({
      // Live output advances the block's last source id while history renames
      // its first id. Only the captured source tool can identify this block.
      messages: coalesceAdjacentToolMessages([
        read("r51", "2026-10-18T01:33:05.000Z"),
        ...reads,
        read("r54", "2026-10-18T01:33:40.000Z"),
      ]),
    });
    expect(scrollToIndex).toHaveBeenCalledWith(
      0,
      // The block keeps its id ("r52") although r51 merged in front of it.
      { partId: "call53", rowKey: "r52", offset: -10 },
      "history",
    );
  });

  test("holds a visible source tool below prose whose author header can change", () => {
    const tool = { ...read("r52", "2026-10-18T01:33:20.000Z"), id: "intro:text-block:1" };
    const { hook, scrollToIndex } = setup([text("intro"), tool]);
    const scroller = document.createElement("div");
    scroller.innerHTML =
      '<div data-chat-message-index="0"></div><div data-chat-message-index="1"><div data-transcript-part-id="call52"></div></div>';
    const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
    scroller.getBoundingClientRect = () => rect(100, 600);
    Object.defineProperty(scroller, "clientHeight", { value: 500 });
    (scroller.children[0] as HTMLElement).getBoundingClientRect = () => rect(70, 150);
    (scroller.children[1] as HTMLElement).getBoundingClientRect = () => rect(150, 250);
    (scroller.children[1]!.firstElementChild as HTMLElement).getBoundingClientRect = () =>
      rect(180, 230);
    hook.result.current.hold(scroller);
    hook.rerender({ messages: [text("earlier"), text("intro"), tool] });
    expect(scrollToIndex).toHaveBeenCalledWith(
      2,
      { partId: "call52", rowKey: "intro:text-block:1", offset: 80 },
      "history",
    );
  });

  test("finds a head block that a cross-minute page merged into", () => {
    // The live tail starts inside a tool run: its head block coalesces two reads.
    const tail = [
      read("r52", "2026-10-18T01:33:20.000Z"),
      read("r53", "2026-10-18T01:33:30.000Z"),
      text("answer"),
    ];
    const shown = coalesceAdjacentToolMessages(tail);
    expect(shown.map((row) => row.id)).toEqual(["r52", "answer"]);
    const { hook, scrollToIndex } = setup(shown);
    hook.result.current.hold();
    // Earlier reads join the head block across minute boundaries, renaming it.
    const loaded = coalesceAdjacentToolMessages([
      text("prompt"),
      read("r50", "2026-10-18T01:32:50.000Z"),
      read("r51", "2026-10-18T01:33:05.000Z"),
      ...tail,
    ]);
    // The merged block keeps its surviving id; where it now starts changed.
    expect(loaded.map((row) => row.id)).toEqual(["prompt", "r52", "answer"]);
    expect(loaded[1]!.earliestSourceMessageId).toBe("r50");
    hook.rerender({ messages: loaded });
    expect(scrollToIndex.mock.calls).toEqual([[1]]);
  });

  test("restores past a separate tool row from an earlier turn", () => {
    const tail = [
      { ...read("r52", "2026-10-18T01:33:20.000Z"), turnId: "current" },
      text("answer"),
    ];
    const { hook, scrollToIndex } = setup(coalesceAdjacentToolMessages(tail));
    hook.result.current.hold();
    const loaded = coalesceAdjacentToolMessages([
      text("prompt"),
      { ...read("r50", "2026-10-18T01:32:50.000Z"), turnId: "earlier" },
      ...tail,
    ]);
    expect(loaded.map((row) => row.id)).toEqual(["prompt", "r50", "r52", "answer"]);
    hook.rerender({ messages: loaded });
    expect(scrollToIndex.mock.calls).toEqual([[2]]);
  });
});

describe("held place with the scroll controller", () => {
  function fakeController(
    anchors: Array<{ rowKey: string; index: number; partId?: string; offsetPx: number }>,
  ) {
    let holding = false;
    let preCommit: (typeof anchors)[number] | null = null;
    return {
      captureAnchor: () => anchors[0] ?? null,
      beginStructuralHold: mock(() => {
        holding = true;
      }),
      endStructuralHold: mock(() => {
        holding = false;
      }),
      get holdingStructure() {
        return holding;
      },
      /** The list re-captures the reader's place just before a data commit. */
      readerMovedTo(anchor: (typeof anchors)[number]) {
        preCommit = anchor;
      },
      takePreCommitAnchor: mock(() => {
        const anchor = preCommit;
        preCommit = null;
        return anchor;
      }),
    };
  }

  test("a reader who moved while the page loaded is held where they are, not where they clicked", () => {
    const { hook, scrollToIndex } = setup([text("m52"), text("m53"), text("m54")]);
    const controller = fakeController([{ rowKey: "m52", index: 0, offsetPx: 4 }]);
    hook.result.current.hold(null, controller as never);
    expect(controller.beginStructuralHold).toHaveBeenCalled();
    // While the request is in flight the reader scrolls down to m54.
    controller.readerMovedTo({ rowKey: "m54", index: 2, offsetPx: 120 });
    hook.rerender({ messages: [text("m50"), text("m51"), text("m52"), text("m53"), text("m54")] });
    expect(scrollToIndex.mock.calls).toEqual([
      [4, { rowKey: "m54", offset: 120, partId: undefined }, "history"],
    ]);
    // The transaction is over: the controller stops capturing.
    expect(controller.holdingStructure).toBe(false);
  });

  test("a tail update while waiting refreshes the place; the page then restores the latest one", () => {
    const { hook, scrollToIndex } = setup([text("m52"), text("m53")]);
    const controller = fakeController([{ rowKey: "m52", index: 0, offsetPx: 0 }]);
    hook.result.current.hold(null, controller as never);
    controller.readerMovedTo({ rowKey: "m53", index: 1, offsetPx: 30 });
    hook.rerender({ messages: [text("m52"), text("m53"), text("m54")] });
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(controller.holdingStructure).toBe(true);
    hook.rerender({ messages: [text("m51"), text("m52"), text("m53"), text("m54")] });
    expect(scrollToIndex.mock.calls).toEqual([
      [2, { rowKey: "m53", offset: 30, partId: undefined }, "history"],
    ]);
  });

  test.each(["failed", "empty"])(
    "a %s history request releases its hold before further streaming",
    async (outcome) => {
      const messages = [text("m52"), text("m53")];
      const { hook, scrollToIndex } = setup(messages, true);
      const controller = fakeController([{ rowKey: "m52", index: 0, offsetPx: 0 }]);
      hook.result.current.hold(null, controller as never);
      controller.readerMovedTo({ rowKey: "m53", index: 1, offsetPx: 30 });
      hook.rerender({ messages: [...messages, text("m54")], loading: true });
      expect(controller.holdingStructure).toBe(true);
      const request =
        outcome === "failed" ? Promise.reject(new Error("history unavailable")) : Promise.resolve();
      await request.catch(() => {}).finally(() => hook.rerender({ messages, loading: false }));
      expect(controller.holdingStructure).toBe(false);
      expect(hook.result.current.scrollAnchor).toBeUndefined();
      const captures = controller.takePreCommitAnchor.mock.calls.length;
      const holds = controller.beginStructuralHold.mock.calls.length;
      hook.rerender({ messages: [...messages, text("m55")], loading: false });
      hook.rerender({ messages: [...messages, text("m56")], loading: false });
      expect(controller.takePreCommitAnchor).toHaveBeenCalledTimes(captures);
      expect(controller.beginStructuralHold).toHaveBeenCalledTimes(holds);
      expect(scrollToIndex).not.toHaveBeenCalled();
    },
  );

  test("completion restores a landed page before releasing the hold", () => {
    const { hook, scrollToIndex } = setup([text("m52"), text("m53")], true);
    const controller = fakeController([{ rowKey: "m52", index: 0, offsetPx: 4 }]);
    hook.result.current.hold(null, controller as never);
    hook.rerender({ messages: [text("m51"), text("m52"), text("m53")], loading: false });
    expect(scrollToIndex.mock.calls).toEqual([
      [1, { rowKey: "m52", offset: 4, partId: undefined }, "history"],
    ]);
    expect(controller.holdingStructure).toBe(false);
  });

  test("release ends the structural hold; a removed anchor restores nothing rather than jumping", () => {
    const { hook, scrollToIndex } = setup([text("m52"), text("m53")]);
    const controller = fakeController([{ rowKey: "m52", index: 0, partId: "gone", offsetPx: 0 }]);
    hook.result.current.hold(null, controller as never);
    hook.result.current.release();
    expect(controller.endStructuralHold).toHaveBeenCalled();
    hook.result.current.hold(null, controller as never);
    // Authoritative reconciliation replaced the held rows entirely.
    hook.rerender({ messages: [text("n1"), text("n2"), text("n3")] });
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});

describe("HeldTranscriptPlace", () => {
  test("answers nothing before any render recorded a first row", () => {
    const place = new HeldTranscriptPlace();
    place.hold();
    expect(place.resolve([text("m1"), text("m2")])).toBeUndefined();
  });
});
