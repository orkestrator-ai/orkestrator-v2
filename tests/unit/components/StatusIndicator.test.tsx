import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { EnvironmentStatus } from "../../../apps/web/src/types";

// Mock the Tooltip components since they require a context
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
  TooltipContent: ({
    children,
    side,
  }: {
    children: React.ReactNode;
    side?: string;
  }) => <div data-testid="tooltip-content">{children}</div>,
}));

// Import component after mocking (lucide-react is NOT mocked to avoid
// polluting Bun's module cache for other test files)
import { StatusIndicator } from "../../../apps/web/src/components/environments/StatusIndicator";

describe("StatusIndicator", () => {
  test("renders without crashing for running status", () => {
    const { container } = render(<StatusIndicator status="running" />);
    expect(container).toBeTruthy();
  });

  test("renders without crashing for stopped status", () => {
    const { container } = render(<StatusIndicator status="stopped" />);
    expect(container).toBeTruthy();
  });

  test("renders without crashing for error status", () => {
    const { container } = render(<StatusIndicator status="error" />);
    expect(container).toBeTruthy();
  });

  test("renders without crashing for creating status", () => {
    const { container } = render(<StatusIndicator status="creating" />);
    expect(container).toBeTruthy();
  });

  test("shows loader icon for creating status", () => {
    const { container } = render(<StatusIndicator status="creating" />);
    // Loader2 renders an SVG with animate-spin class
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeTruthy();
  });

  test("shows label when showLabel is true", () => {
    const { container } = render(<StatusIndicator status="running" showLabel />);
    // Find the label span (not the tooltip content)
    const label = container.querySelector("span.text-xs");
    expect(label?.textContent).toBe("Running");
  });

  test("shows correct label for stopped status", () => {
    const { container } = render(<StatusIndicator status="stopped" showLabel />);
    const label = container.querySelector("span.text-xs");
    expect(label?.textContent).toBe("Stopped");
  });

  test("shows correct label for error status", () => {
    const { container } = render(<StatusIndicator status="error" showLabel />);
    const label = container.querySelector("span.text-xs");
    expect(label?.textContent).toBe("Error");
  });

  test("shows correct label for creating status", () => {
    const { container } = render(<StatusIndicator status="creating" showLabel />);
    const label = container.querySelector("span.text-xs");
    expect(label?.textContent).toBe("Creating");
  });

  test("does not show label when showLabel is false", () => {
    const { container } = render(<StatusIndicator status="running" showLabel={false} />);
    const label = container.querySelector("span.text-xs");
    expect(label).toBeNull();
  });

  test("applies custom className", () => {
    const { container } = render(
      <StatusIndicator status="running" className="custom-class" />
    );
    const element = container.querySelector(".custom-class");
    expect(element).toBeTruthy();
  });
});
