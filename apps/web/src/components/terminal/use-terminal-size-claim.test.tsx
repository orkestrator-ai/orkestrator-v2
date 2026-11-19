import { describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { TERMINAL_SIZE_INPUT_CLAIM_INTERVAL_MS } from "@orkestrator/protocol/terminal-size-ownership";
import { TERMINAL_SIZE_CLAIM_DEDUPE_MS, useTerminalSizeClaim } from "./use-terminal-size-claim";

/** A wrapper with a layout box, as a pane on screen has. */
function laidOutWrapper(laidOut = true): HTMLElement {
  const element = document.createElement("div");
  element.getClientRects = () =>
    (laidOut ? [new DOMRect(0, 0, 800, 600)] : []) as unknown as DOMRectList;
  return element;
}

function setup(options: { canClaim?: boolean; laidOut?: boolean; sessionId?: string } = {}) {
  let now = 10_000;
  const textarea = document.createElement("textarea");
  const terminal = { cols: 80, rows: 24, textarea };
  // Fitting is what gives the terminal its real geometry before a claim.
  const fitAddon = {
    fit: mock(() => {
      terminal.cols = 132;
      terminal.rows = 43;
    }),
  };
  const claimSize = mock(async (_cols: number, _rows: number) => undefined);
  const wrapperRef = { current: laidOutWrapper(options.laidOut ?? true) };
  const clock = () => now;
  const hook = renderHook(
    ({ sessionId }) =>
      useTerminalSizeClaim({
        terminal,
        fitAddon,
        wrapperRef,
        canClaim: options.canClaim ?? true,
        sessionId,
        claimSize,
        now: clock,
      }),
    { initialProps: { sessionId: (options.sessionId ?? "shell") as string | null } },
  );
  return {
    ...hook,
    textarea,
    claimSize,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("useTerminalSizeClaim", () => {
  test("focus alone leaves sizing ownership alone", () => {
    const { textarea, claimSize } = setup();
    act(() => {
      textarea.dispatchEvent(new FocusEvent("focus"));
    });
    expect(claimSize).not.toHaveBeenCalled();
  });

  test("repeat clicks claim the fitted size once per dedupe interval", () => {
    const { result, textarea, claimSize, advance } = setup();
    act(() => {
      textarea.dispatchEvent(new FocusEvent("focus"));
      result.current.claim();
      result.current.claim();
    });
    expect(claimSize).toHaveBeenCalledTimes(1);
    expect(claimSize).toHaveBeenCalledWith(132, 43);
    advance(TERMINAL_SIZE_CLAIM_DEDUPE_MS);
    act(() => result.current.claim());
    expect(claimSize).toHaveBeenCalledTimes(2);
  });

  test("typing claims at most once per interval", () => {
    const { result, claimSize, advance } = setup();
    act(() => {
      result.current.claimOnInput();
      result.current.claimOnInput();
    });
    expect(claimSize).toHaveBeenCalledTimes(1);
    advance(TERMINAL_SIZE_INPUT_CLAIM_INTERVAL_MS - 1);
    act(() => result.current.claimOnInput());
    expect(claimSize).toHaveBeenCalledTimes(1);
    advance(1);
    act(() => result.current.claimOnInput());
    expect(claimSize).toHaveBeenCalledTimes(2);
  });

  test("a hidden view, or one with no layout box, never claims", () => {
    const hidden = setup({ canClaim: false });
    act(() => {
      hidden.textarea.dispatchEvent(new FocusEvent("focus"));
      hidden.result.current.claim();
      hidden.result.current.claimOnInput();
    });
    expect(hidden.claimSize).not.toHaveBeenCalled();
    hidden.unmount();

    const unlaid = setup({ laidOut: false });
    act(() => unlaid.result.current.claim());
    expect(unlaid.claimSize).not.toHaveBeenCalled();
  });

  test("the first input after the session reattaches claims immediately", () => {
    const { result, rerender, claimSize } = setup();
    act(() => result.current.claimOnInput());
    rerender({ sessionId: null });
    rerender({ sessionId: "shell" });
    act(() => result.current.claimOnInput());
    expect(claimSize).toHaveBeenCalledTimes(2);
  });
});
