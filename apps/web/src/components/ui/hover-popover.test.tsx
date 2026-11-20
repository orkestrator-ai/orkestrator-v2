import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import {
  HOVER_POPOVER_CLOSE_DELAY_MS,
  HOVER_POPOVER_EXIT_FALLBACK_MS,
  HOVER_POPOVER_OPEN_DELAY_MS,
  HoverPopoverPanel,
  useHoverPopoverGroup,
} from "./hover-popover";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../../tests/helpers/controlled-timeout";

const originalMatchMedia = window.matchMedia;
const timers: ControlledTimeout[] = [];

function control(delay: number, label: string): ControlledTimeout {
  const timer = installControlledTimeout(delay, { label });
  timers.push(timer);
  return timer;
}

afterEach(() => {
  cleanup();
  for (const timer of timers.splice(0).reverse()) timer.restore();
  window.matchMedia = originalMatchMedia;
});

function preferReducedMotion() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function Triggers() {
  const group = useHoverPopoverGroup<string>();
  const anchors = useRef(new Map<string, HTMLButtonElement>());
  return (
    <>
      {["one", "two"].map((key) => (
        <button
          key={key}
          type="button"
          ref={(element) => {
            if (element) anchors.current.set(key, element);
          }}
          onPointerEnter={() => group.enter(key)}
          onPointerLeave={() => group.leave()}
          onFocus={() => group.openNow(key)}
          onBlur={() => group.blurred()}
        >
          {key}
        </button>
      ))}
      <HoverPopoverPanel
        getAnchor={() => (group.openKey ? (anchors.current.get(group.openKey) ?? null) : null)}
        anchorKey={group.openKey}
        open={group.openKey !== null}
        data-testid="panel"
        onPointerEnter={() => {
          if (group.openKey) group.enter(group.openKey);
        }}
        onPointerLeave={() => group.leave()}
      >
        {group.openKey}
      </HoverPopoverPanel>
    </>
  );
}

describe("useHoverPopoverGroup", () => {
  test("a pointer passing across opens nothing; resting opens after the delay", () => {
    const open = control(HOVER_POPOVER_OPEN_DELAY_MS, "open delay");
    render(<Triggers />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "one" }));
    fireEvent.pointerLeave(screen.getByRole("button", { name: "one" }));
    expect(open.pendingCount()).toBe(0);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "two" }));
    expect(screen.queryByTestId("panel") === null).toBe(true);
    act(() => void open.advance());
    expect(screen.getByTestId("panel").textContent).toBe("two");
  });

  test("once open, another trigger switches at once and the gap does not close it", () => {
    const open = control(HOVER_POPOVER_OPEN_DELAY_MS, "open delay");
    const close = control(HOVER_POPOVER_CLOSE_DELAY_MS, "close delay");
    render(<Triggers />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "one" }));
    act(() => void open.advance());
    fireEvent.pointerLeave(screen.getByRole("button", { name: "one" }));
    expect(close.pendingCount()).toBe(1);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "two" }));
    expect(close.pendingCount()).toBe(0);
    expect(open.pendingCount()).toBe(0);
    expect(screen.getAllByTestId("panel")).toHaveLength(1);
    expect(screen.getByTestId("panel").textContent).toBe("two");

    // Into the panel across the gap: the pending close is cancelled.
    fireEvent.pointerLeave(screen.getByRole("button", { name: "two" }));
    const strip = document.querySelector('[data-slot="hover-popover"]') as HTMLElement;
    fireEvent.pointerEnter(strip);
    expect(close.pendingCount()).toBe(0);
    expect(screen.getByTestId("panel").dataset.state).toBe("open");
  });

  test("leaving both closes after the delay, sliding back in before it unmounts", () => {
    const open = control(HOVER_POPOVER_OPEN_DELAY_MS, "open delay");
    const close = control(HOVER_POPOVER_CLOSE_DELAY_MS, "close delay");
    const exit = control(HOVER_POPOVER_EXIT_FALLBACK_MS, "exit fallback");
    render(<Triggers />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "one" }));
    act(() => void open.advance());
    fireEvent.pointerLeave(screen.getByRole("button", { name: "one" }));
    act(() => void close.advance());
    const panel = screen.getByTestId("panel");
    expect(panel.dataset.state).toBe("closed");
    expect(panel.className).toContain("hover-popover");
    // The exit animation reporting its end unmounts it.
    fireEvent.animationEnd(panel);
    expect(screen.queryByTestId("panel") === null).toBe(true);
    expect(exit.pendingCount()).toBe(0);
  });

  test("an exit animation that never ends still unmounts", () => {
    const open = control(HOVER_POPOVER_OPEN_DELAY_MS, "open delay");
    const close = control(HOVER_POPOVER_CLOSE_DELAY_MS, "close delay");
    const exit = control(HOVER_POPOVER_EXIT_FALLBACK_MS, "exit fallback");
    render(<Triggers />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "one" }));
    act(() => void open.advance());
    fireEvent.pointerLeave(screen.getByRole("button", { name: "one" }));
    act(() => void close.advance());
    expect(screen.getByTestId("panel").dataset.state).toBe("closed");
    act(() => void exit.advance());
    expect(screen.queryByTestId("panel") === null).toBe(true);
  });

  test("under reduced motion it disappears without the exit animation", () => {
    preferReducedMotion();
    const open = control(HOVER_POPOVER_OPEN_DELAY_MS, "open delay");
    const close = control(HOVER_POPOVER_CLOSE_DELAY_MS, "close delay");
    render(<Triggers />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "one" }));
    act(() => void open.advance());
    fireEvent.pointerLeave(screen.getByRole("button", { name: "one" }));
    act(() => void close.advance());
    expect(screen.queryByTestId("panel") === null).toBe(true);
  });

  test("focus opens at once, and blurring closes unless the pointer holds it", () => {
    render(<Triggers />);
    act(() => screen.getByRole("button", { name: "one" }).focus());
    expect(screen.getByTestId("panel").textContent).toBe("one");
    act(() => screen.getByRole("button", { name: "one" }).blur());
    expect(screen.getByTestId("panel").dataset.state).toBe("closed");
  });
});

describe("HoverPopoverPanel", () => {
  test("sits beside its anchor, joined by a strip the width of the gap, inside the viewport", () => {
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () =>
      ({ left: 6, top: 120, right: 50, bottom: 164, width: 44, height: 44 }) as DOMRect;
    document.body.append(anchor);
    try {
      render(
        <HoverPopoverPanel getAnchor={() => anchor} open sideOffset={8} data-testid="panel">
          content
        </HoverPopoverPanel>,
      );
      const strip = document.querySelector('[data-slot="hover-popover"]') as HTMLElement;
      expect(strip.style.left).toBe("50px");
      expect(strip.style.paddingLeft).toBe("8px");
      expect(strip.style.top).toBe("116px");
      expect(screen.getByTestId("panel").dataset.state).toBe("open");
    } finally {
      anchor.remove();
    }
  });
});
