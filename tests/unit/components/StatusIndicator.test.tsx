import { describe, test, expect, mock } from "bun:test";
import { render } from "@testing-library/react";

// Mock the Tooltip components since they require a context
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode; side?: string }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

// Import component after mocking (lucide-react is NOT mocked to avoid
// polluting Bun's module cache for other test files)
import { StatusIndicator } from "../../../apps/web/src/components/environments/StatusIndicator";

describe("StatusIndicator", () => {
  test.each([
    ["running", "Running", "text-status-running", "div.bg-current.animate-pulse", "text-xs"],
    [
      "stopped",
      "Stopped",
      "text-status-stopped",
      "div.bg-current",
      "text-xs text-muted-foreground",
    ],
    ["error", "Error", "text-status-error", "div.bg-current", "text-xs"],
    [
      "creating",
      "Creating",
      "text-status-creating",
      'svg.animate-spin[stroke="currentColor"]',
      "text-xs",
    ],
    [
      "stopping",
      "Stopping",
      "text-status-stopped",
      'svg.animate-spin[stroke="currentColor"]',
      "text-xs text-muted-foreground",
    ],
  ] as const)(
    "renders the %s token, glyph and inline label",
    (status, labelText, tokenClass, glyphSelector, labelClass) => {
      const { container } = render(<StatusIndicator status={status} showLabel />);
      const indicator = container.querySelector(`.${tokenClass}`);
      expect(indicator?.querySelector(`:scope > ${glyphSelector}`)).toBeTruthy();
      const label = indicator?.querySelector(":scope > span.text-xs");
      expect(label?.textContent).toBe(labelText);
      expect(label?.className).toBe(labelClass);
    },
  );

  test("does not show label when showLabel is false", () => {
    const { container } = render(<StatusIndicator status="running" showLabel={false} />);
    const label = container.querySelector("span.text-xs");
    expect(label).toBeNull();
  });

  test("applies custom className", () => {
    const { container } = render(<StatusIndicator status="running" className="custom-class" />);
    const element = container.querySelector(".custom-class");
    expect(element).toBeTruthy();
  });
});
