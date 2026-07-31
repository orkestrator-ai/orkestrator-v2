import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ContextUsageWheel } from "./ContextUsageWheel";

afterEach(cleanup);

function renderWheel(percentUsed: number) {
  const { container } = render(
    <ContextUsageWheel
      usage={{
        usedTokens: percentUsed,
        totalTokens: 100,
        percentUsed,
      }}
    />,
  );

  const button = screen.getByRole("button");
  const progress = container.querySelector<SVGCircleElement>(
    "[data-context-usage-progress]",
  );

  return { button, progress };
}

describe("ContextUsageWheel", () => {
  test.each([
    [0, "0 100"],
    [42, "42 58"],
    [100, "100 0"],
  ])("renders %i%% as a foreground progress ring", (percentUsed, dashArray) => {
    const { button, progress } = renderWheel(percentUsed);

    expect(button.className).toContain("text-foreground");
    expect(button.getAttribute("aria-label")).toBe(
      `Context window ${percentUsed}% used`,
    );
    expect(progress?.getAttribute("stroke")).toBe("currentColor");
    expect(progress?.getAttribute("stroke-dasharray")).toBe(dashArray);
  });

  test("rounds and clamps the displayed percentage", () => {
    let rendered = renderWheel(49.6);
    expect(rendered.progress?.getAttribute("stroke-dasharray")).toBe("50 50");

    cleanup();
    rendered = renderWheel(150);
    expect(rendered.progress?.getAttribute("stroke-dasharray")).toBe("100 0");
  });
});
