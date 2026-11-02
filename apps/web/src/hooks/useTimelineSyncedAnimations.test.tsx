import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { useRef } from "react";
import { useTimelineSyncedAnimations } from "./useTimelineSyncedAnimations";

type FakeAnimation = { startTime: number | null };

const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
let animations: FakeAnimation[] = [];

beforeEach(() => {
  animations = [];
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => animations,
  });
});

afterEach(() => {
  cleanup();
  if (descriptor) Object.defineProperty(Element.prototype, "getAnimations", descriptor);
  else delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
});

function Ring({ state }: { state: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTimelineSyncedAnimations(ref, state);
  return <span ref={ref} data-testid="ring" />;
}

test("pins the element's animations to the timeline origin before paint", () => {
  animations = [{ startTime: 4321 }, { startTime: null }];
  render(<Ring state="working" />);
  expect(animations.map((animation) => animation.startTime)).toEqual([0, 0]);
});

test("re-pins when the key brings in a new animation", () => {
  const { rerender } = render(<Ring state="idle" />);
  animations = [{ startTime: 987 }];
  rerender(<Ring state="working" />);
  expect(animations[0]!.startTime).toBe(0);
});

test("re-pins an animation that starts without a render", () => {
  const { getByTestId } = render(<Ring state="working" />);
  animations = [{ startTime: 555 }];
  getByTestId("ring").dispatchEvent(new Event("animationstart", { bubbles: true }));
  expect(animations[0]!.startTime).toBe(0);
});
