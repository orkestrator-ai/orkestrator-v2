import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { useHeldTranscriptPlace, useRestoreHeldPlace } from "./useHeldTranscriptPlace";
import {
  useRestorePlaceAfterHistoryDrop,
  type ReaderPlaceSource,
} from "./useRestorePlaceAfterHistoryDrop";
import { useAutoLoadEarlier } from "@/components/native-agent/useAutoLoadEarlier";

afterEach(cleanup);
const row = (id: string): NativeMessage => ({
  id,
  role: "assistant",
  content: "",
  createdAt: "2026-11-06T00:00:00Z",
  parts: [{ type: "tool-invocation", toolName: "bash", toolUseId: id, content: id }],
});
const full = [row("old"), row("tail")];
const tail = [full[1]!];

// Use the same ordering and paging exclusion as AgentNativeTab.controller:
// drop recovery supersedes a held ordinary page and blocks automatic paging.
test("drop recovery owns paging and navigation across an inactive tab and a pending held page", async () => {
  const listeners = new Set<() => void>();
  const controller: ReaderPlaceSource & { active: boolean; generation: number } = {
    active: true,
    hasScroller: true,
    wantsFollow: false,
    generation: 0,
    readingAnchor: { partId: "old", rowKey: "old", index: 0, offsetPx: 40 },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const loadRecovery = mock(() => new Promise<void>(() => {}));
  const loadAuto = mock(async () => {});
  const scroll = mock((_index: number, _anchor?: unknown, _owner?: string) => controller.active);
  const available = () => true;
  const hook = renderHook(
    ({ messages, canLoadEarlier, loading, settled }) => {
      const held = useHeldTranscriptPlace("session");
      const restoring = useRestorePlaceAfterHistoryDrop({
        sessionKey: "session",
        controller,
        messages,
        canLoadEarlier,
        loading,
        loadEarlier: loadRecovery,
        scrollToIndex: scroll,
      });
      useRestoreHeldPlace(held, messages, scroll, loading, restoring);
      useAutoLoadEarlier({
        sessionKey: "session",
        isActive: controller.active,
        settled,
        canLoadEarlier,
        headId: messages[0]?.id,
        loading: loading || restoring,
        available,
        load: loadAuto,
      });
      return { held, restoring };
    },
    { initialProps: { messages: full, canLoadEarlier: false, loading: true, settled: false } },
  );
  hook.result.current.held.hold();
  // While an ordinary page is outstanding the epoch drops its source rows.
  hook.rerender({ messages: tail, canLoadEarlier: true, loading: true, settled: false });
  expect(hook.result.current.restoring).toBe(true);
  expect(scroll).not.toHaveBeenCalled();
  hook.rerender({ messages: tail, canLoadEarlier: true, loading: false, settled: true });
  expect(loadRecovery).toHaveBeenCalledTimes(1);
  expect(loadAuto).not.toHaveBeenCalled();
  act(() => {
    controller.active = false;
    for (const listener of listeners) listener();
  });
  hook.rerender({ messages: full, canLoadEarlier: false, loading: false, settled: true });
  expect(hook.result.current.restoring).toBe(true);
  expect(scroll).not.toHaveBeenCalled();
  act(() => {
    controller.active = true;
    for (const listener of listeners) listener();
  });
  expect(hook.result.current.restoring).toBe(false);
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll.mock.calls[0]).toEqual([
    0,
    { rowKey: "old", partId: "old", offset: 40 },
    "history",
  ]);
});
