import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { CoordinatorActivityIcon, CoordinatorWorkingOutline } from "./CoordinatorActivityIcon";

afterEach(cleanup);

describe("CoordinatorActivityIcon", () => {
  test.each([
    ["working", "environment-working-spinner"],
    ["waiting", "animate-pulse"],
    [null, "hidden"],
  ] as const)("draws the %s state around the icon", (state, ringClass) => {
    render(<CoordinatorActivityIcon state={state}>icon</CoordinatorActivityIcon>);
    expect(screen.getByTestId("coordinator-activity-icon").getAttribute("data-state")).toBe(
      state ?? "idle",
    );
    const ring = screen.getByTestId("coordinator-activity-ring");
    expect(ring.className).toContain(ringClass);
    expect(ring.className).toContain("rounded-[5px]");
  });
});

describe("CoordinatorWorkingOutline", () => {
  test("is a decorative spinner following its parent's corners", () => {
    render(<CoordinatorWorkingOutline />);
    const outline = screen.getByTestId("coordinator-working-outline");
    const ring = screen.getByTestId("coordinator-working-outline-ring");
    // The shared spinner rules only match a direct child of a shaped parent.
    expect(outline.getAttribute("data-shape")).toBe("square");
    expect(ring.parentElement === outline).toBe(true);
    expect(ring.className).toContain("environment-working-spinner");
    expect(outline.getAttribute("aria-hidden")).toBe("true");
    expect(outline.className).toContain("pointer-events-none");
    expect(outline.className).toContain("rounded-[inherit]");
    expect(ring.className).toContain("rounded-[inherit]");
    expect(ring.className).not.toContain("rounded-[5px]");
  });

  test("replaces the spinner with a static outline in forced colours", () => {
    render(<CoordinatorWorkingOutline />);
    const ring = screen.getByTestId("coordinator-working-outline-ring");
    for (const name of [
      "forced-colors:animate-none",
      "forced-colors:border-2",
      "forced-colors:border-solid",
      "forced-colors:border-[CanvasText]",
    ]) {
      expect(ring.className).toContain(name);
    }
  });
});
