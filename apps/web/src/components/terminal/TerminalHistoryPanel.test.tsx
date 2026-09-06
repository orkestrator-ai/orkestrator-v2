import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const realBackend = await import("@/lib/backend");
const getTerminalHistoryPage = mock(async (_sessionId: string, cursor?: string) =>
  cursor
    ? {
        formatVersion: 1 as const,
        historyId: "history",
        rows: [{ id: "1:0", text: "earliest line" }],
        previousCursor: null,
        earliestAvailable: true,
        historyTruncated: true,
        historyGap: false,
      }
    : {
        formatVersion: 1 as const,
        historyId: "history",
        rows: [{ id: "2:0", text: "recent line" }],
        previousCursor: "earlier-cursor",
        earliestAvailable: false,
        historyTruncated: true,
        historyGap: false,
      },
);

mock.module("@/lib/backend", () => ({ ...realBackend, getTerminalHistoryPage }));
const { TerminalHistoryPanel } = await import("./TerminalHistoryPanel");

afterEach(() => cleanup());
afterAll(() => mock.module("@/lib/backend", () => realBackend));
beforeEach(() => getTerminalHistoryPage.mockClear());

describe("TerminalHistoryPanel", () => {
  test("loads recent output first and pages earlier output on demand", async () => {
    const onClose = mock(() => undefined);
    render(<TerminalHistoryPanel sessionId="session-1" onClose={onClose} />);

    expect(await screen.findByText("recent line")).toBeDefined();
    expect(getTerminalHistoryPage).toHaveBeenCalledWith("session-1", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    expect(await screen.findByText("earliest line")).toBeDefined();
    expect(getTerminalHistoryPage).toHaveBeenLastCalledWith("session-1", "earlier-cursor");
    expect(screen.getByRole("status").textContent).toContain("Older output expired");
    expect(screen.getByText("Start of retained history")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Return to live terminal" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("shows retryable load errors separately from archive expiry", async () => {
    getTerminalHistoryPage.mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    render(<TerminalHistoryPanel sessionId="session-1" onClose={() => undefined} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "storage temporarily unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("recent line")).toBeDefined());
  });

  test("preserves the scroll anchor and ignores concurrent load requests", async () => {
    render(<TerminalHistoryPanel sessionId="session-1" onClose={() => undefined} />);
    expect(await screen.findByText("recent line")).toBeDefined();
    const scroller = screen
      .getByRole("region", { name: "Earlier terminal output" })
      .querySelector(".overflow-auto") as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => (getTerminalHistoryPage.mock.calls.length > 1 ? 160 : 100),
    });
    scroller.scrollTop = 25;

    const earlier = new Promise<Awaited<ReturnType<typeof getTerminalHistoryPage>>>((resolve) => {
      setTimeout(
        () =>
          resolve({
            formatVersion: 1,
            historyId: "history",
            rows: [{ id: "1:0", text: "anchored line" }],
            previousCursor: null,
            earliestAvailable: true,
            historyTruncated: false,
            historyGap: false,
          }),
        5,
      );
    });
    getTerminalHistoryPage.mockImplementationOnce(() => earlier);
    const loadEarlier = screen.getByRole("button", { name: "Load earlier" });
    fireEvent.click(loadEarlier);
    fireEvent.click(loadEarlier);

    expect(await screen.findByText("anchored line")).toBeDefined();
    expect(getTerminalHistoryPage).toHaveBeenCalledTimes(2);
    expect(scroller.scrollTop).toBe(85);
  });

  test("keeps the page cache bounded during repeated backward paging", async () => {
    let page = 20;
    getTerminalHistoryPage.mockImplementation(async (_sessionId) => ({
      formatVersion: 1,
      historyId: "history",
      rows: [{ id: `${page}:0`, text: `page-${page}` }],
      previousCursor: page > 1 ? `cursor-${page - 1}` : null,
      earliestAvailable: page <= 1,
      historyTruncated: false,
      historyGap: false,
    }));
    render(<TerminalHistoryPanel sessionId="session-1" onClose={() => undefined} />);
    expect(await screen.findByText("page-20")).toBeDefined();
    const scroller = screen
      .getByRole("region", { name: "Earlier terminal output" })
      .querySelector(".overflow-auto") as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 160 });
    for (page = 19; page >= 1; page -= 1) {
      const expectedCalls = 21 - page;
      if (page === 4) scroller.scrollTop = 25;
      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
      await waitFor(() => expect(getTerminalHistoryPage).toHaveBeenCalledTimes(expectedCalls));
      if (page >= 5) expect(await screen.findByText(`page-${page}`)).toBeDefined();
    }
    const visiblePages = screen
      .getByRole("region", { name: "Earlier terminal output" })
      .querySelectorAll(".whitespace-pre-wrap");
    expect(visiblePages.length).toBeLessThanOrEqual(16);
    expect(screen.getByText("page-20")).toBeDefined();
    expect(screen.queryByText("page-1")).toBeNull();
    expect(scroller.scrollTop).toBe(25);
  });
});
