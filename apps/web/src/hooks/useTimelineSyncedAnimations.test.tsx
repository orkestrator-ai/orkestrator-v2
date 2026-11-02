import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { useRef } from "react";
import { useTimelineSyncedAnimations } from "./useTimelineSyncedAnimations";

type FakeAnimation = {
  startTime: number | null;
  animationName?: string;
  transitionProperty?: string;
  effect?: { getTiming: () => { iterations: number } };
};

function loop(startTime: number | null): FakeAnimation {
  return {
    startTime,
    animationName: "pulse",
    effect: { getTiming: () => ({ iterations: Infinity }) },
  };
}

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
  animations = [loop(4321), loop(null)];
  render(<Ring state="working" />);
  expect(animations.map((animation) => animation.startTime)).toEqual([0, 0]);
});

test("re-pins when the key brings in a new animation", () => {
  const { rerender } = render(<Ring state="idle" />);
  animations = [loop(987)];
  rerender(<Ring state="working" />);
  expect(animations[0]!.startTime).toBe(0);
});

test("re-pins an animation that starts without a render", () => {
  const { getByTestId } = render(<Ring state="working" />);
  animations = [loop(555)];
  getByTestId("ring").dispatchEvent(new Event("animationstart", { bubbles: true }));
  expect(animations[0]!.startTime).toBe(0);
});

test("preserves transitions and non-looping effects on mount, key change and animationstart", () => {
  const transition = { startTime: 4321, transitionProperty: "background-color" };
  const oneShot = { ...loop(1234), effect: { getTiming: () => ({ iterations: 1 }) } };
  const scripted = { startTime: 2468, effect: { getTiming: () => ({ iterations: Infinity }) } };
  const pulse = loop(555);
  animations = [transition, oneShot, scripted, pulse];
  const { rerender, getByTestId } = render(<Ring state="working" />);
  expect(animations.map((animation) => animation.startTime)).toEqual([4321, 1234, 2468, 0]);
  rerender(<Ring state="waiting" />);
  getByTestId("ring").dispatchEvent(new Event("animationstart"));
  expect(animations.map((animation) => animation.startTime)).toEqual([4321, 1234, 2468, 0]);
});

test("rings mounted at different document times share the same phase", () => {
  const first = loop(1000);
  animations = [first];
  render(<Ring state="working" />);
  const second = loop(2750);
  animations = [second];
  render(<Ring state="working" />);
  const documentTime = 3000;
  expect(first.startTime).toBe(0);
  expect(second.startTime).toBe(0);
  expect(documentTime - first.startTime!).toBe(documentTime - second.startTime!);
});
