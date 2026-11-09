import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { INSPECTOR_SPLIT_MIN_WIDTH_PX, InspectorTranscriptTabs } from "./MultiReviewInspectorViews";

/**
 * happy-dom lays nothing out, so widths come from here, and resize callbacks
 * are run by hand.
 */
let width = 0;
const observers = new Set<() => void>();
const realGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const RealResizeObserver = globalThis.ResizeObserver;

class FakeResizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe() {
    observers.add(this.callback);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.callback);
  }
}

function resizeTo(next: number) {
  width = next;
  act(() => {
    for (const callback of Array.from(observers)) callback();
  });
}

beforeEach(() => {
  width = 0;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      width,
      height: 400,
      top: 0,
      left: 0,
      right: width,
      bottom: 400,
      x: 0,
      y: 0,
    } as DOMRect;
  };
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  observers.clear();
  HTMLElement.prototype.getBoundingClientRect = realGetBoundingClientRect;
  globalThis.ResizeObserver = RealResizeObserver;
});

function renderViews() {
  return render(
    <InspectorTranscriptTabs
      transcript={<p>transcript body</p>}
      report={<p>report body</p>}
      tab="report"
      onTabChange={() => undefined}
    />,
  );
}

describe("InspectorTranscriptTabs", () => {
  test("shows only the transcript while there is no report", () => {
    width = INSPECTOR_SPLIT_MIN_WIDTH_PX * 2;
    render(
      <InspectorTranscriptTabs
        transcript={<p>transcript body</p>}
        report={null}
        tab="transcript"
        onTabChange={() => undefined}
      />,
    );
    expect(screen.getByText("transcript body")).toBeTruthy();
    expect(screen.queryByRole("tab") === null).toBe(true);
    expect(screen.queryByTestId("multi-review-inspector-side-by-side") === null).toBe(true);
  });

  test("uses tabs when the inspector is narrower than the split width", () => {
    width = INSPECTOR_SPLIT_MIN_WIDTH_PX - 1;
    renderViews();
    expect(screen.getByRole("tab", { name: "Report" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("multi-review-inspector-side-by-side") === null).toBe(true);
  });

  test("shows transcript and report side by side once wide enough, without tabs", () => {
    width = INSPECTOR_SPLIT_MIN_WIDTH_PX;
    renderViews();
    const split = screen.getByTestId("multi-review-inspector-side-by-side");
    expect(screen.queryByRole("tab") === null).toBe(true);
    expect(split.contains(screen.getByRole("region", { name: "Transcript" }))).toBe(true);
    expect(screen.getByRole("region", { name: "Transcript" }).textContent).toBe("transcript body");
    expect(screen.getByRole("region", { name: "Report" }).textContent).toBe("report body");
  });

  test("follows the inspector's width as it changes", () => {
    width = INSPECTOR_SPLIT_MIN_WIDTH_PX - 200;
    renderViews();
    expect(screen.getByRole("tab", { name: "Transcript" })).toBeTruthy();

    resizeTo(INSPECTOR_SPLIT_MIN_WIDTH_PX + 200);
    expect(screen.getByTestId("multi-review-inspector-side-by-side")).toBeTruthy();

    resizeTo(INSPECTOR_SPLIT_MIN_WIDTH_PX - 200);
    expect(screen.queryByTestId("multi-review-inspector-side-by-side") === null).toBe(true);
    expect(screen.getByRole("tab", { name: "Transcript" })).toBeTruthy();
  });

  test("keeps its layout while hidden, when the inspector measures zero wide", () => {
    width = INSPECTOR_SPLIT_MIN_WIDTH_PX;
    renderViews();
    resizeTo(0);
    expect(screen.getByTestId("multi-review-inspector-side-by-side")).toBeTruthy();
  });
});
