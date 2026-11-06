import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { SemanticAnchor } from "@/lib/transcript-scroll/transcript-scroll-controller";
import { installControlledTimeout } from "../../../../tests/helpers/controlled-timeout";
import {
  HISTORY_DROP_RESTORE_MAX_EMPTY_PAGES,
  HISTORY_DROP_RESTORE_MAX_PAGES,
  HISTORY_DROP_RESTORE_RETRY_MS,
  useRestorePlaceAfterHistoryDrop,
  type ReaderPlaceSource,
} from "./useRestorePlaceAfterHistoryDrop";

afterEach(() => cleanup());

const prompt = (id: string): NativeMessage => ({
  id,
  role: "user",
  content: "start",
  createdAt: "2026-11-06T04:00:00.000Z",
  parts: [{ type: "text", content: "start", sourcePartId: `${id}:text` }],
});

/** One trail stop: a command whose call id survives a replay, in a row whose id does not. */
const stop = (row: string, call: string): NativeMessage => ({
  id: row,
  role: "assistant",
  content: "",
  createdAt: "2026-11-06T04:00:01.000Z",
  parts: [{ type: "tool-invocation", content: "cat", toolName: "bash", toolUseId: call }],
});

/** Rows minted live, then the same calls after the first replay renamed every row. */
const live = [prompt("live-prompt"), stop("live-1", "call-1"), stop("live-2", "call-2")];
const liveTail = [stop("live-3", "call-3"), stop("live-4", "call-4")];
const replayedTail = [stop("msg-r-3", "call-3"), stop("msg-r-4", "call-4")];
const replayedPage = [prompt("msg-r-0"), stop("msg-r-1", "call-1"), stop("msg-r-2", "call-2")];

type Props = { messages: NativeMessage[]; loading: boolean; canLoadEarlier: boolean };

function setup(
  anchor: SemanticAnchor | null,
  options: { wantsFollow?: boolean; initialMessages?: NativeMessage[] } = {},
) {
  const listeners = new Set<() => void>();
  const controller: { -readonly [K in keyof ReaderPlaceSource]: ReaderPlaceSource[K] } = {
    setWaitingForHistory: () => {},
    wantsFollow: options.wantsFollow ?? false,
    readingAnchor: anchor,
    generation: 0,
    active: true,
    hasScroller: true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const scrollToIndex = mock((_index: number, _anchor?: unknown, _owner?: string) => true);
  // A page settles once the test has committed what it brought, as the tab's does.
  const pending: Array<() => void> = [];
  const loadEarlier = mock(
    (): Promise<void> => new Promise<void>((resolve) => pending.push(() => resolve())),
  );
  const land = async () => {
    for (const resolve of pending.splice(0)) resolve();
    await settle();
  };
  const hook = renderHook(
    ({ messages, loading, canLoadEarlier }: Props) =>
      useRestorePlaceAfterHistoryDrop({
        sessionKey: "env:codex:tab",
        messages,
        controller,
        loading,
        canLoadEarlier,
        loadEarlier,
        scrollToIndex,
      }),
    {
      initialProps: {
        messages: options.initialMessages ?? [...live, ...liveTail],
        loading: false,
        canLoadEarlier: true,
      },
    },
  );
  const notify = () =>
    act(() => {
      for (const listener of listeners) listener();
    });
  return { controller, hook, land, loadEarlier, scrollToIndex, notify };
}

/** Lets settled page promises report back. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const readerOnCall1: SemanticAnchor = {
  rowKey: "live-1",
  index: 1,
  partId: "call-1",
  offsetPx: 228,
};

describe("useRestorePlaceAfterHistoryDrop", () => {
  test("a remount pages back to a persisted anchor missing from its first live tail", () => {
    const { hook, loadEarlier, scrollToIndex } = setup(readerOnCall1, {
      initialMessages: replayedTail,
    });
    expect(hook.result.current).toBe(true);
    expect(loadEarlier).toHaveBeenCalledTimes(1);
    hook.rerender({
      messages: [...replayedPage, ...replayedTail],
      loading: false,
      canLoadEarlier: false,
    });
    expect(hook.result.current).toBe(false);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  test("pages the dropped history back and returns the reader to their call", () => {
    const { hook, loadEarlier, scrollToIndex } = setup(readerOnCall1);

    // The bridge restarted: the tab falls back to the renamed live tail.
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    expect(hook.result.current).toBe(true);
    expect(loadEarlier).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).not.toHaveBeenCalled();

    hook.rerender({ messages: replayedTail, loading: true, canLoadEarlier: true });
    hook.rerender({
      messages: [...replayedPage, ...replayedTail],
      loading: true,
      canLoadEarlier: false,
    });
    expect(scrollToIndex.mock.calls).toEqual([
      [1, { partId: "call-1", rowKey: "msg-r-1", offset: 228 }, "history"],
    ]);
    hook.rerender({
      messages: [...replayedPage, ...replayedTail],
      loading: false,
      canLoadEarlier: false,
    });
    expect(hook.result.current).toBe(false);
    expect(loadEarlier).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  test("keeps paging, one page at a time, until the call is back", async () => {
    const { hook, land, loadEarlier, scrollToIndex } = setup(readerOnCall1);
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    hook.rerender({ messages: replayedTail, loading: true, canLoadEarlier: true });
    // The first page reaches call-2 only.
    const firstPage = [stop("msg-r-2", "call-2"), ...replayedTail];
    hook.rerender({ messages: firstPage, loading: true, canLoadEarlier: true });
    expect(loadEarlier).toHaveBeenCalledTimes(1);
    await land();
    hook.rerender({ messages: firstPage, loading: false, canLoadEarlier: true });
    expect(loadEarlier).toHaveBeenCalledTimes(2);
    hook.rerender({ messages: firstPage, loading: true, canLoadEarlier: true });
    hook.rerender({
      messages: [...replayedPage, ...replayedTail],
      loading: false,
      canLoadEarlier: false,
    });
    expect(scrollToIndex.mock.calls.map(([index]) => index)).toEqual([1]);
    await land();
    expect(loadEarlier).toHaveBeenCalledTimes(2);
  });

  test("holds a member of an open tool group by the member, not the group frame", () => {
    const { hook, scrollToIndex } = setup({
      rowKey: "live-1",
      index: 1,
      partId: "call-4",
      offsetPx: 0,
      inner: { partId: "call-1", screenOffsetPx: 40 },
    });
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    expect(hook.result.current).toBe(true);
    hook.rerender({
      messages: [...replayedPage, ...replayedTail],
      loading: false,
      canLoadEarlier: false,
    });
    expect(scrollToIndex.mock.calls).toEqual([
      [
        1,
        {
          partId: "call-4",
          rowKey: "msg-r-1",
          offset: 0,
          inner: { partId: "call-1", screenOffsetPx: 40 },
        },
        "history",
      ],
    ]);
  });

  test("gives the place up when history runs out without it", async () => {
    const { hook, land, loadEarlier, scrollToIndex } = setup(readerOnCall1);
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    hook.rerender({ messages: replayedTail, loading: true, canLoadEarlier: true });
    // A rewritten history: the page does not hold the call.
    const rewritten = [prompt("msg-r-0"), ...replayedTail];
    hook.rerender({ messages: rewritten, loading: false, canLoadEarlier: false });
    await land();
    expect(hook.result.current).toBe(false);
    expect(loadEarlier).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  test(`stops after ${HISTORY_DROP_RESTORE_MAX_PAGES} pages that bring rows but never the call`, async () => {
    const { hook, land, loadEarlier, scrollToIndex } = setup(readerOnCall1);
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    let messages = replayedTail;
    for (let page = 0; page < HISTORY_DROP_RESTORE_MAX_PAGES + 2; page += 1) {
      hook.rerender({ messages, loading: true, canLoadEarlier: true });
      messages = [stop(`older-${page}`, `older-call-${page}`), ...messages];
      hook.rerender({ messages, loading: false, canLoadEarlier: true });
      await land();
    }
    expect(loadEarlier).toHaveBeenCalledTimes(HISTORY_DROP_RESTORE_MAX_PAGES);
    expect(hook.result.current).toBe(false);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  test("an empty page is retried after a pause, and the call is restored when a page brings it", async () => {
    const retry = installControlledTimeout(HISTORY_DROP_RESTORE_RETRY_MS, { label: "retry" });
    try {
      const { hook, land, loadEarlier, scrollToIndex } = setup(readerOnCall1);
      hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(loadEarlier).toHaveBeenCalledTimes(attempt);
        // A page cut from the epoch before the bridge re-read its rollout.
        hook.rerender({ messages: replayedTail, loading: true, canLoadEarlier: true });
        hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
        await land();
        expect(loadEarlier).toHaveBeenCalledTimes(attempt);
        // A poll landing while it waits does not restart the wait.
        hook.rerender({ messages: [...replayedTail], loading: false, canLoadEarlier: true });
        expect(retry.advance()).toBe(1);
      }
      hook.rerender({ messages: replayedTail, loading: true, canLoadEarlier: true });
      hook.rerender({
        messages: [...replayedPage, ...replayedTail],
        loading: false,
        canLoadEarlier: false,
      });
      expect(scrollToIndex.mock.calls.map(([index]) => index)).toEqual([1]);
      await land();
      expect(retry.pendingCount()).toBe(0);
    } finally {
      retry.restore();
    }
  });

  test(`gives the place up after ${HISTORY_DROP_RESTORE_MAX_EMPTY_PAGES} empty pages`, async () => {
    const retry = installControlledTimeout(HISTORY_DROP_RESTORE_RETRY_MS, { label: "retry" });
    try {
      const { hook, land, loadEarlier, scrollToIndex } = setup(readerOnCall1);
      hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
      for (let attempt = 0; attempt < HISTORY_DROP_RESTORE_MAX_EMPTY_PAGES + 2; attempt += 1) {
        hook.rerender({ messages: replayedTail, loading: true, canLoadEarlier: true });
        hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
        await land();
        retry.advance();
      }
      expect(loadEarlier).toHaveBeenCalledTimes(HISTORY_DROP_RESTORE_MAX_EMPTY_PAGES);
      expect(hook.result.current).toBe(false);
      expect(scrollToIndex).not.toHaveBeenCalled();
      expect(retry.pendingCount()).toBe(0);
    } finally {
      retry.restore();
    }
  });

  test("a failed page gives the place up", async () => {
    const { hook, loadEarlier } = setup(readerOnCall1);
    loadEarlier.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    await act(async () => {
      await Promise.resolve();
    });
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    expect(hook.result.current).toBe(false);
    expect(loadEarlier).toHaveBeenCalledTimes(1);
  });

  test("a reader following the latest message is left following", () => {
    const { hook, loadEarlier } = setup(null, { wantsFollow: true });
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    expect(hook.result.current).toBe(false);
    expect(loadEarlier).not.toHaveBeenCalled();
  });

  test("a reader who starts following while it pages is not moved", () => {
    const { controller, hook, scrollToIndex } = setup(readerOnCall1);
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    controller.wantsFollow = true;
    hook.rerender({
      messages: [...replayedPage, ...replayedTail],
      loading: false,
      canLoadEarlier: false,
    });
    expect(hook.result.current).toBe(false);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  test("streaming under an unchanged head, or a reader whose call is still shown, restores nothing", () => {
    const { hook, loadEarlier } = setup(readerOnCall1);
    hook.rerender({
      messages: [...live, ...liveTail, stop("live-5", "call-5")],
      loading: false,
      canLoadEarlier: true,
    });
    // A history page prepends rows: the head changes but the call stays.
    hook.rerender({
      messages: [prompt("older"), ...live, ...liveTail],
      loading: false,
      canLoadEarlier: true,
    });
    expect(loadEarlier).not.toHaveBeenCalled();
    expect(hook.result.current).toBe(false);
  });

  test("a later independent drop restores the same call again", () => {
    const { hook, loadEarlier, scrollToIndex } = setup(readerOnCall1);
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    hook.rerender({
      messages: [...replayedPage, ...replayedTail],
      loading: false,
      canLoadEarlier: false,
    });
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    expect(loadEarlier).toHaveBeenCalledTimes(2);
    expect(hook.result.current).toBe(true);
    hook.rerender({
      messages: [...replayedPage, ...replayedTail],
      loading: false,
      canLoadEarlier: false,
    });
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    expect(hook.result.current).toBe(false);
  });

  test.each(["scroll", "find", "message-link"])("%s supersedes a pending restoration", async () => {
    const { hook, controller, land, loadEarlier, scrollToIndex, notify } = setup(readerOnCall1);
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    controller.generation += 1;
    notify();
    expect(hook.result.current).toBe(false);
    await land();
    hook.rerender({
      messages: [...replayedPage, ...replayedTail],
      loading: false,
      canLoadEarlier: true,
    });
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(loadEarlier).toHaveBeenCalledTimes(1);
  });

  test("reader input clears an empty-page retry before the timer fires", async () => {
    const timer = installControlledTimeout(HISTORY_DROP_RESTORE_RETRY_MS);
    try {
      const { hook, controller, land, loadEarlier, notify } = setup(readerOnCall1);
      hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
      await land();
      controller.generation += 1;
      notify();
      expect(hook.result.current).toBe(false);
      expect(timer.pendingCount()).toBe(0);
      act(() => timer.advance());
      expect(loadEarlier).toHaveBeenCalledTimes(1);
    } finally {
      timer.restore();
    }
  });

  test("a coalesced row keeping its display id can lose the anchored source part", () => {
    const { hook, scrollToIndex } = setup(readerOnCall1);
    const grouped = {
      ...stop("coalesced", "call-1"),
      parts: [...stop("a", "call-1").parts, ...stop("b", "call-2").parts],
    };
    hook.rerender({ messages: [grouped, ...liveTail], loading: false, canLoadEarlier: true });
    hook.rerender({
      messages: [{ ...grouped, parts: stop("b", "call-2").parts }, ...liveTail],
      loading: false,
      canLoadEarlier: true,
    });
    expect(hook.result.current).toBe(true);
    hook.rerender({ messages: [grouped, ...liveTail], loading: false, canLoadEarlier: false });
    expect(scrollToIndex).toHaveBeenCalledWith(
      0,
      { partId: "call-1", rowKey: "coalesced", offset: 228 },
      "history",
    );
  });

  test("recovered history waits for activation and an accepted navigation", () => {
    const { hook, controller, scrollToIndex } = setup(readerOnCall1);
    hook.rerender({ messages: replayedTail, loading: false, canLoadEarlier: true });
    controller.active = false;
    const messages = [...replayedPage, ...replayedTail];
    hook.rerender({ messages, loading: false, canLoadEarlier: false });
    expect(hook.result.current).toBe(true);
    expect(scrollToIndex).not.toHaveBeenCalled();
    controller.active = true;
    scrollToIndex.mockReturnValueOnce(false);
    hook.rerender({ messages, loading: false, canLoadEarlier: false });
    expect(hook.result.current).toBe(true);
    hook.rerender({ messages, loading: false, canLoadEarlier: false });
    expect(hook.result.current).toBe(true);
    // A ready viewport publishes a new snapshot and retries the rejected move.
    controller.hasScroller = false;
    hook.rerender({ messages, loading: false, canLoadEarlier: false });
    controller.hasScroller = true;
    hook.rerender({ messages, loading: false, canLoadEarlier: false });
    expect(hook.result.current).toBe(false);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
  });
});
