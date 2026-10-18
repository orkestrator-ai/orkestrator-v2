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
  parts: [{ type: "tool-invocation", content: "Read", toolName: "Read", createdAt }],
});

function setup(initial: NativeMessage[]) {
  const scrollToIndex = mock((_index: number) => true);
  const hook = renderHook(
    ({ messages }) => {
      const place = useHeldTranscriptPlace();
      useRestoreHeldPlace(place, messages, scrollToIndex);
      return place;
    },
    { initialProps: { messages: initial } },
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

  test("finds a head block that a same-minute page merged into and renamed", () => {
    // The live tail starts mid-minute: its head block coalesces two reads.
    const tail = [
      read("r52", "2026-10-18T01:33:20.000Z"),
      read("r53", "2026-10-18T01:33:30.000Z"),
      text("answer"),
    ];
    const shown = coalesceAdjacentToolMessages(tail);
    expect(shown.map((row) => row.id)).toEqual(["r52", "answer"]);
    const { hook, scrollToIndex } = setup(shown);
    hook.result.current.hold();
    // The page ends in the same minute, so its last reads join the head block,
    // which now carries the id of the page's first read in that minute.
    const loaded = coalesceAdjacentToolMessages([
      text("prompt"),
      read("r50", "2026-10-18T01:32:50.000Z"),
      read("r51", "2026-10-18T01:33:05.000Z"),
      ...tail,
    ]);
    expect(loaded.map((row) => row.id)).toEqual(["prompt", "r50", "r51", "answer"]);
    hook.rerender({ messages: loaded });
    expect(scrollToIndex.mock.calls).toEqual([[2]]);
  });
});

describe("HeldTranscriptPlace", () => {
  test("answers nothing before any render recorded a first row", () => {
    const place = new HeldTranscriptPlace();
    place.hold();
    expect(place.resolve([text("m1"), text("m2")])).toBeUndefined();
  });
});
