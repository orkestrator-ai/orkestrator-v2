import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ContextUsageWheel } from "./ContextUsageWheel";

afterEach(cleanup);

function renderWheel(percentUsed: number, className?: string) {
  const { container } = render(
    <ContextUsageWheel
      className={className}
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

async function openTooltip(button: HTMLElement) {
  fireEvent.focus(button);

  const tooltipContent = await waitFor(() => {
    const content = document.querySelector<HTMLElement>(
      "[data-slot='tooltip-content']",
    );
    expect(content).not.toBeNull();
    return content!;
  });

  return Array.from(tooltipContent.children)
    .filter((child) => child.tagName === "DIV")
    .map((child) => child.textContent);
}

describe("ContextUsageWheel", () => {
  test("remains available before a provider reports usage", async () => {
    const { container } = render(<ContextUsageWheel usage={null} />);
    const button = screen.getByRole("button", {
      name: "Context window usage unavailable",
    });

    expect(button.className).toContain("text-muted-foreground/50");
    expect(container.querySelector("[data-context-usage-progress]")).toBeNull();
    expect(await openTooltip(button)).toEqual([
      "Context window:",
      "Usage is not available yet.",
    ]);
  });

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
    expect(progress?.getAttribute("pathLength")).toBe("100");
    expect(progress?.getAttribute("stroke-dasharray")).toBe(dashArray);
  });

  test("rounds and clamps the displayed percentage", () => {
    let rendered = renderWheel(49.6);
    expect(rendered.progress?.getAttribute("stroke-dasharray")).toBe("50 50");

    cleanup();
    rendered = renderWheel(-25);
    expect(rendered.button.getAttribute("aria-label")).toBe(
      "Context window 0% used",
    );
    expect(rendered.progress?.getAttribute("stroke-dasharray")).toBe("0 100");

    cleanup();
    rendered = renderWheel(150);
    expect(rendered.progress?.getAttribute("stroke-dasharray")).toBe("100 0");
  });

  test("preserves caller classes", () => {
    const { button } = renderWheel(42, "ml-1 test-context-wheel");

    expect(button.className).toContain("text-foreground");
    expect(button.className).toContain("ml-1");
    expect(button.className).toContain("test-context-wheel");
  });

  test("shows formatted usage details and the optional model on focus", async () => {
    render(
      <ContextUsageWheel
        usage={{
          usedTokens: 1_234,
          totalTokens: 10_000,
          percentUsed: 42.4,
          modelId: "gpt-5",
        }}
      />,
    );

    expect(await openTooltip(screen.getByRole("button"))).toEqual([
      "Context window:",
      "42% used (58% left)",
      "1.2k / 10k tokens used",
      "Model: gpt-5",
    ]);
  });

  test("omits the model row when usage has no model", async () => {
    const { button } = renderWheel(42);

    expect(await openTooltip(button)).toEqual([
      "Context window:",
      "42% used (58% left)",
      "42 / 100 tokens used",
    ]);
  });
});
