import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { LiveElapsed } from "./LiveElapsed";

afterEach(() => cleanup());

test("the clock ticks itself; the component that owns it renders once", () => {
  const ticks: Array<() => void> = [];
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    ticks.push(callback);
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  const now = spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    let ownerRenders = 0;
    function Owner() {
      ownerRenders += 1;
      return <LiveElapsed startedAt={1_000_000 - 64_000} />;
    }
    render(<Owner />);
    const before = screen.getByText(/\d/).textContent;
    now.mockReturnValue(1_000_000 + 2_000);
    act(() => ticks.forEach((tick) => tick()));
    expect(screen.getByText(/\d/).textContent).not.toBe(before);
    expect(ownerRenders).toBe(1);
  } finally {
    interval.mockRestore();
    now.mockRestore();
  }
});

test("shows nothing before the first second or when not running", () => {
  const { container, rerender } = render(<LiveElapsed startedAt={Date.now()} />);
  expect(container.textContent).toBe("");
  rerender(<LiveElapsed startedAt={Date.now() - 10_000} running={false} />);
  expect(container.textContent).toBe("");
});
