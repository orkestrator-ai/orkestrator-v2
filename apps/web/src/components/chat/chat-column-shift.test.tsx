import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  FloatingNoticeLayer,
  TRANSCRIPT_COLUMN_REM,
  useClaimFloatingNoticeColumnShift,
} from "@/components/ui/floating-notice";
import {
  CHAT_COLUMN_SHIFT_DURATION_MS,
  CHAT_COLUMN_SHIFT_SETTLE_MS,
  useChatColumnShiftStyle,
} from "./chat-column-shift";

const realRect = HTMLElement.prototype.getBoundingClientRect;
let clock: ReturnType<typeof installControlledTimeout>;

beforeEach(() => {
  clock = installControlledTimeout(CHAT_COLUMN_SHIFT_SETTLE_MS, { label: "column settle" });
  // An 80rem pane: the panel fits only beside a column moved 7.5rem left.
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 1280, height: 600, top: 0, left: 0, right: 1280, bottom: 600 } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  clock.restore();
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

function Shell({ claim }: { claim: boolean }) {
  return (
    <div data-testid="shell" style={useChatColumnShiftStyle()}>
      <Panel claim={claim} />
    </div>
  );
}

function Panel({ claim }: { claim: boolean }) {
  useClaimFloatingNoticeColumnShift(claim);
  return null;
}

const tree = (claim: boolean) => (
  <FloatingNoticeLayer columnRem={TRANSCRIPT_COLUMN_REM}>
    <Shell claim={claim} />
  </FloatingNoticeLayer>
);

const variable = (name: string) => screen.getByTestId("shell").style.getPropertyValue(name);

test("the shell starts where the column belongs, then slides on later changes", () => {
  const { rerender } = render(tree(true));
  expect(variable("--chat-column-shift")).toBe("7.5rem");
  // The first placement after mount is not animated.
  expect(variable("--chat-column-shift-duration")).toBe("0ms");

  act(() => {
    clock.advance();
  });
  expect(variable("--chat-column-shift-duration")).toBe(`${CHAT_COLUMN_SHIFT_DURATION_MS}ms`);

  rerender(tree(false));
  expect(variable("--chat-column-shift")).toBe("0rem");
  rerender(tree(true));
  expect(variable("--chat-column-shift")).toBe("7.5rem");
});

test("an unmounted shell drops its settle timer", () => {
  const { unmount } = render(tree(false));
  expect(clock.pendingCount()).toBe(1);
  unmount();
  expect(clock.pendingCount()).toBe(0);
});
