import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { useImperativeHandle } from "react";
import type { Ref } from "react";
import * as realVirtuoso from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";
import { TerminalProvider } from "@/contexts";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { INNER_SEEK_EVENT } from "@/lib/transcript-scroll/transcript-scroll-controller";
import { NativeMessage } from "./NativeMessage";

// Only the virtualizer's imperative handle is faked. Render the real message,
// fold and inner body so its effect must install and remove the seek listener.
const snapshot = { ...realVirtuoso };
const seek = mock((_location: unknown) => {});
mock.module("react-virtuoso", () => ({
  ...snapshot,
  Virtuoso: ({ ref }: { ref: Ref<VirtuosoHandle> }) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: seek }) as unknown as VirtuosoHandle);
    return <div data-testid="inner-list" />;
  },
}));
afterAll(() => mock.module("react-virtuoso", () => snapshot));
afterEach(() => {
  cleanup();
  seek.mockClear();
});

test("an open virtualized group seeks the named member and detaches its listener on unmount", () => {
  const parts: NativeMessagePart[] = Array.from({ length: 100 }, (_, index) => ({
    type: "tool-invocation",
    toolUseId: `seek-call-${index}`,
    toolName: "bash",
    content: `step ${index}`,
    toolState: "success",
  }));
  const { container, unmount } = renderInAppCommandScope(
    <TerminalProvider>
      <NativeMessage
        agentExpansionScope="seek-component"
        message={{
          id: "seek-component",
          role: "assistant",
          content: "",
          createdAt: "2026-11-06T00:00:00Z",
          parts,
        }}
      />
    </TerminalProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Show 100 tool calls:/ }));
  const host = container.querySelector<HTMLElement>("[data-transcript-inner-viewport]")!;
  fireEvent(host, new CustomEvent(INNER_SEEK_EVENT, { detail: { partId: "seek-call-70" } }));
  expect(seek).toHaveBeenCalledWith({ index: 70, align: "start" });
  fireEvent(host, new CustomEvent(INNER_SEEK_EVENT, { detail: { partId: "not-in-group" } }));
  expect(seek).toHaveBeenCalledTimes(1);
  unmount();
  fireEvent(host, new CustomEvent(INNER_SEEK_EVENT, { detail: { partId: "seek-call-2" } }));
  expect(seek).toHaveBeenCalledTimes(1);
});
