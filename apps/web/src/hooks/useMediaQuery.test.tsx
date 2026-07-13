import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useMediaQuery } from "./useMediaQuery";

class MatchMediaController {
  matches: boolean;
  readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  asMediaQueryList(query: string): MediaQueryList {
    const controller = this;
    return {
      get matches() { return controller.matches; },
      media: query,
      onchange: null,
      addEventListener: (_type: "change", listener: EventListenerOrEventListenerObject) =>
        this.listeners.add(listener as (event: MediaQueryListEvent) => void),
      removeEventListener: (_type: "change", listener: EventListenerOrEventListenerObject) =>
        this.listeners.delete(listener as (event: MediaQueryListEvent) => void),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    };
  }

  update(matches: boolean): void {
    this.matches = matches;
    const event = { matches } as MediaQueryListEvent;
    for (const listener of this.listeners) listener(event);
  }
}

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

describe("useMediaQuery", () => {
  test("reads the initial match and responds to change events", () => {
    const controller = new MatchMediaController(false);
    window.matchMedia = (query) => controller.asMediaQueryList(query);
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));

    expect(result.current).toBe(false);
    act(() => controller.update(true));
    expect(result.current).toBe(true);
  });

  test("moves the listener when the query changes and cleans it up on unmount", () => {
    const first = new MatchMediaController(false);
    const second = new MatchMediaController(true);
    window.matchMedia = (query) => (query.includes("767") ? first : second).asMediaQueryList(query);
    const { result, rerender, unmount } = renderHook(
      ({ query }) => useMediaQuery(query),
      { initialProps: { query: "(max-width: 767px)" } },
    );

    expect(first.listeners.size).toBe(1);
    rerender({ query: "(max-width: 1024px)" });
    expect(result.current).toBe(true);
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    unmount();
    expect(second.listeners.size).toBe(0);
  });

  test("returns false when matchMedia is unavailable", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);
  });
});
