import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentMailCard, agentMailCardLayout } from "./AgentMailCard";

describe("agentMailCardLayout", () => {
  test("puts the card beside the transcript column when the pane leaves room", () => {
    // 95rem pane: 56rem column, 19.5rem a side.
    expect(agentMailCardLayout(95)).toEqual({ collapsed: false, cardRem: 18 });
    // Narrower gutters shrink the card down to its minimum.
    expect(agentMailCardLayout(87)).toEqual({ collapsed: false, cardRem: 14 });
  });

  test("collapses to a pill when the card would cover the column", () => {
    expect(agentMailCardLayout(86)).toEqual({ collapsed: true, cardRem: 18 });
    // A phone-width pane opens a card no wider than the pane.
    expect(agentMailCardLayout(16)).toEqual({ collapsed: true, cardRem: 14.5 });
  });

  test("shows the card before the pane is measured", () => {
    expect(agentMailCardLayout(0)).toEqual({ collapsed: false, cardRem: 18 });
  });
});

describe("AgentMailCard", () => {
  const realResizeObserver = globalThis.ResizeObserver;
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  let paneWidth = 0;

  beforeEach(() => {
    cleanup();
    paneWidth = 0;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        width: paneWidth,
        height: 0,
        top: 0,
        left: 0,
        right: paneWidth,
        bottom: 0,
      } as DOMRect;
    };
  });

  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = realRect;
  });

  function renderCard(onDismiss = () => {}) {
    return render(
      <div>
        <AgentMailCard
          tone="info"
          count={2}
          text="2 messages in inbox · pull only"
          newest={{ sender: "You", time: "11:01", subject: "Review findings" }}
          onDismiss={onDismiss}
        >
          <button type="button">Deliver now</button>
        </AgentMailCard>
        <button type="button">Outside</button>
      </div>,
    );
  }

  test("shows the status, the newest message and its actions in a wide pane", () => {
    paneWidth = 1600;
    const onDismiss = mock(() => {});
    renderCard(onDismiss);
    expect(screen.getByRole("region", { name: "Agent mail" })).toBeTruthy();
    expect(screen.getByText("2 messages in inbox · pull only")).toBeTruthy();
    expect(screen.getByText("You · 11:01")).toBeTruthy();
    expect(screen.getByText("Review findings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Agent mail:/ }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss agent mail notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("a narrow pane shows a labelled pill that opens and closes the card", () => {
    paneWidth = 800;
    renderCard();
    const pill = screen.getByRole("button", {
      name: "Agent mail: 2 messages in inbox · pull only",
    });
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Agent mail" }) === null).toBe(true);

    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    const card = screen.getByRole("region", { name: "Agent mail" });
    expect(pill.getAttribute("aria-controls")).toBe(card.id);

    // Escape from inside the card closes it and returns focus to the pill.
    screen.getByRole("button", { name: "Deliver now" }).focus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Deliver now" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Agent mail" }) === null).toBe(true);
    expect(document.activeElement).toBe(pill);

    fireEvent.click(pill);
    act(() => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    });
    expect(screen.queryByRole("region", { name: "Agent mail" }) === null).toBe(true);
  });
});
