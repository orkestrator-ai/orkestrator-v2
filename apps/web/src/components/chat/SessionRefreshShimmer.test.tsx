import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionRefreshShimmer } from "./SessionRefreshShimmer";

describe("SessionRefreshShimmer", () => {
  afterEach(() => cleanup());

  test("defaults to the message-shaped transcript skeleton", () => {
    render(<SessionRefreshShimmer active />);

    const reveal = screen.getByTestId("session-refresh-shimmer-transcript");
    expect(reveal.querySelectorAll(".session-refresh-shimmer > div")).toHaveLength(3);
  });

  test("renders a single compact bar for the pinned variant", () => {
    render(<SessionRefreshShimmer active variant="pinned" />);

    const reveal = screen.getByTestId("session-refresh-shimmer-pinned");
    expect(reveal.querySelectorAll(".session-refresh-shimmer > div")).toHaveLength(1);
    // The dock's notice row supplies its own gutters, so the transcript's do
    // not come along and indent the bar out of alignment.
    expect(reveal.innerHTML).not.toContain("@sm:px-4");
  });

  test("publishes the active state as the attribute the reveal animation keys on", () => {
    const { rerender } = render(<SessionRefreshShimmer active />);

    const reveal = screen.getByTestId("session-refresh-shimmer-transcript");
    expect(reveal.getAttribute("data-active")).toBe("true");
    expect(reveal.className).toContain("session-refresh-reveal");

    rerender(<SessionRefreshShimmer active={false} />);
    // A string, not a dropped attribute: the paused-animation rule selects on
    // `[data-active="false"]`, so an absent attribute would keep it running.
    expect(reveal.getAttribute("data-active")).toBe("false");
  });

  test("keeps the bars mounted while inactive so the collapse has something to animate", () => {
    render(<SessionRefreshShimmer active={false} />);

    const reveal = screen.getByTestId("session-refresh-shimmer-transcript");
    expect(reveal.querySelectorAll(".session-refresh-shimmer > div")).toHaveLength(3);
    // Clipping is what makes a zero-height row invisible rather than overlapping.
    expect(reveal.querySelector(".overflow-hidden")).toBeTruthy();
  });

  test("stays out of the accessibility tree in both states", () => {
    const { rerender } = render(<SessionRefreshShimmer active />);

    const reveal = screen.getByTestId("session-refresh-shimmer-transcript");
    // The shell owns the announcement. A skeleton that also spoke would be
    // heard twice whenever both variants are mounted.
    expect(reveal.getAttribute("aria-hidden")).toBe("true");
    expect(reveal.textContent).toBe("");
    expect(screen.queryByRole("status") === null).toBe(true);

    rerender(<SessionRefreshShimmer active={false} />);
    expect(reveal.getAttribute("aria-hidden")).toBe("true");
  });
});
