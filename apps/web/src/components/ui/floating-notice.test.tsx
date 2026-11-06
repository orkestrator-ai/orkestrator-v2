import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { memo, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  FloatingNotice,
  FloatingNoticeAnchor,
  FloatingNoticeLayer,
  TRANSCRIPT_COLUMN_REM,
  floatingNoticeLayout,
  useInFloatingNoticeLayer,
} from "./floating-notice";

describe("floatingNoticeLayout", () => {
  test("puts the card beside a centred column when the pane leaves room", () => {
    // 95rem pane: 56rem column, 19.5rem a side.
    expect(floatingNoticeLayout(95, TRANSCRIPT_COLUMN_REM)).toEqual({
      placement: "beside",
      cardRem: 18,
    });
    // Narrower gutters shrink the card down to its minimum.
    expect(floatingNoticeLayout(87, TRANSCRIPT_COLUMN_REM)).toEqual({
      placement: "beside",
      cardRem: 14,
    });
  });

  test("folds into a pill when the card would cover the column", () => {
    expect(floatingNoticeLayout(86, TRANSCRIPT_COLUMN_REM)).toEqual({
      placement: "pill",
      cardRem: 18,
    });
    // A phone-width pane opens a card no wider than the pane.
    expect(floatingNoticeLayout(16, TRANSCRIPT_COLUMN_REM)).toEqual({
      placement: "pill",
      cardRem: 14.5,
    });
  });

  test("a pane without a column shows the card over its content until it is narrow", () => {
    expect(floatingNoticeLayout(60)).toEqual({ placement: "over", cardRem: 18 });
    expect(floatingNoticeLayout(30)).toEqual({ placement: "pill", cardRem: 18 });
  });

  test("shows the card before the pane is measured", () => {
    expect(floatingNoticeLayout(0, TRANSCRIPT_COLUMN_REM)).toEqual({
      placement: "beside",
      cardRem: 18,
    });
    expect(floatingNoticeLayout(0)).toEqual({ placement: "over", cardRem: 18 });
  });
});

describe("FloatingNotice", () => {
  const realResizeObserver = globalThis.ResizeObserver;
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  let paneWidth = 0;
  let paneHeight = 300;
  let resize: () => void;

  beforeEach(() => {
    cleanup();
    paneWidth = 0;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        resize = () => this.callback([], this as unknown as ResizeObserver);
        this.callback([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        width: paneWidth,
        height: paneHeight,
        top: 0,
        left: 0,
        right: paneWidth,
        bottom: this.hasAttribute("data-floating-notice-anchor") ? 0 : paneHeight,
      } as DOMRect;
    };
  });

  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = realRect;
  });

  function notice(onDismiss = () => {}) {
    return (
      <FloatingNotice
        label="Agent mail"
        summary="2 messages in inbox · pull only"
        pill={2}
        onDismiss={onDismiss}
        dismissLabel="Dismiss agent mail notice"
        actions={<button type="button">Deliver now</button>}
      >
        <p>2 messages in inbox · pull only</p>
      </FloatingNotice>
    );
  }

  test("without a layer, renders a plain card in place", () => {
    const onDismiss = mock(() => {});
    render(notice(onDismiss));
    expect(screen.getByRole("region", { name: "Agent mail" })).toBeTruthy();
    expect(screen.getByText("2 messages in inbox · pull only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Agent mail:/ }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Minimize Agent mail" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss agent mail notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("portals into the layer's anchor, and a nested layer joins the outer stack", () => {
    paneWidth = 1600;
    const { container } = render(
      <FloatingNoticeLayer columnRem={TRANSCRIPT_COLUMN_REM}>
        <div data-testid="content">
          <FloatingNoticeLayer columnRem={TRANSCRIPT_COLUMN_REM}>{notice()}</FloatingNoticeLayer>
        </div>
      </FloatingNoticeLayer>,
    );
    const anchors = container.querySelectorAll("[data-floating-notice-anchor]");
    expect(anchors).toHaveLength(1);
    const card = screen.getByRole("region", { name: "Agent mail" });
    expect(anchors[0]!.contains(card)).toBe(true);
    expect(screen.getByTestId("content").contains(card)).toBe(false);
  });

  test("a layer can show its notices at an anchor further down", () => {
    paneWidth = 1600;
    render(
      <FloatingNoticeLayer anchor={false}>
        {notice()}
        <div data-testid="region">
          <FloatingNoticeAnchor columnRem={TRANSCRIPT_COLUMN_REM} />
        </div>
      </FloatingNoticeLayer>,
    );
    expect(
      screen.getByTestId("region").contains(screen.getByRole("region", { name: "Agent mail" })),
    ).toBe(true);
  });

  test("beside a column, the card has no minimize control", () => {
    paneWidth = 1600;
    render(<FloatingNoticeLayer columnRem={TRANSCRIPT_COLUMN_REM}>{notice()}</FloatingNoticeLayer>);
    expect(screen.getByRole("region", { name: "Agent mail" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Minimize Agent mail" }) === null).toBe(true);
  });

  test("a narrow pane shows a labelled pill that opens and closes the card", () => {
    paneWidth = 800;
    render(
      <div>
        <FloatingNoticeLayer columnRem={TRANSCRIPT_COLUMN_REM}>{notice()}</FloatingNoticeLayer>
        <button type="button">Outside</button>
      </div>,
    );
    const pill = () =>
      screen.getByRole("button", { name: "Agent mail: 2 messages in inbox · pull only" });
    expect(pill().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Agent mail" }) === null).toBe(true);

    fireEvent.click(pill());
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Agent mail" }));

    // Escape from inside the card closes it and returns focus to the pill.
    const deliver = screen.getByRole("button", { name: "Deliver now" });
    deliver.focus();
    fireEvent.keyDown(deliver, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Agent mail" }) === null).toBe(true);
    expect(document.activeElement).toBe(pill());

    fireEvent.click(pill());
    act(() => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    });
    expect(screen.queryByRole("region", { name: "Agent mail" }) === null).toBe(true);
  });

  test("over a pane's content, the card can be minimized to a pill and reopened", () => {
    paneWidth = 900;
    render(<FloatingNoticeLayer>{notice()}</FloatingNoticeLayer>);
    fireEvent.click(screen.getByRole("button", { name: "Minimize Agent mail" }));
    expect(screen.queryByRole("region", { name: "Agent mail" }) === null).toBe(true);
    const pill = screen.getByRole("button", {
      name: "Agent mail: 2 messages in inbox · pull only",
    });
    expect(document.activeElement).toBe(pill);
    fireEvent.click(pill);
    expect(screen.getByRole("region", { name: "Agent mail" })).toBeTruthy();
  });

  test("stacks errors above warnings above information", () => {
    paneWidth = 900;
    render(
      <FloatingNoticeLayer>
        <FloatingNotice tone="info" label="Info" summary="info" />
        <FloatingNotice tone="error" label="Error" summary="error" />
        <FloatingNotice tone="warning" label="Warning" summary="warning" />
      </FloatingNoticeLayer>,
    );
    const order = (name: string) =>
      Number((screen.getByRole("region", { name }).parentElement as HTMLElement).style.order);
    expect(order("Error")).toBeLessThan(order("Warning"));
    expect(order("Warning")).toBeLessThan(order("Info"));
  });
  test("bounds the stack to pane height and updates on height-only resize", () => {
    paneWidth = 1600;
    const { container } = render(<FloatingNoticeLayer>{notice()}</FloatingNoticeLayer>);
    const stack = container.querySelector<HTMLElement>("[data-floating-notice-stack]")!;
    expect(stack.style.maxHeight).toBe("288px");
    act(() => {
      paneHeight = 160;
      resize();
    });
    expect(stack.style.maxHeight).toBe("148px");
    expect(stack.style.getPropertyValue("--floating-notice-height")).toBe("148px");
  });

  test("an independent conversation layer keeps its notices in its pane", () => {
    paneWidth = 800;
    render(
      <FloatingNoticeLayer>
        <FloatingNotice label="Panel" summary="panel" />
        <section data-testid="conversation">
          <FloatingNoticeLayer independent columnRem={56}>
            {notice()}
          </FloatingNoticeLayer>
        </section>
      </FloatingNoticeLayer>,
    );
    expect(
      screen
        .getByTestId("conversation")
        .contains(screen.getByRole("button", { name: /^Agent mail:/ })),
    ).toBe(true);
    expect(
      screen
        .getByTestId("conversation")
        .contains(screen.getByRole("button", { name: "Minimize Panel" })),
    ).toBe(false);
  });

  test.each(["status", "alert"] as const)(
    "announces inserted and updated collapsed %s summaries",
    (role) => {
      paneWidth = 128;
      const tree = (summary?: string) => (
        <FloatingNoticeLayer columnRem={56}>
          {summary && <FloatingNotice role={role} label="Attention" summary={summary} />}
        </FloatingNoticeLayer>
      );
      const { rerender } = render(tree());
      rerender(tree("First notice"));
      const live = screen.getByRole(role, { name: "Notice announcement" });
      expect(live.textContent).toBe("Attention: First notice");
      expect(live.getAttribute("aria-live")).toBe(role === "alert" ? "assertive" : "polite");
      rerender(tree("Changed notice"));
      expect(screen.getByRole(role, { name: "Notice announcement" })).toBe(live);
      expect(live.textContent).toBe("Attention: Changed notice");
      expect(
        screen
          .getByRole("button", { name: "Attention: Changed notice" })
          .getAttribute("aria-expanded"),
      ).toBe("false");
    },
  );

  test("layer presence consumers do not render on anchor geometry changes", () => {
    paneWidth = 1600;
    let renders = 0;
    const Controller = memo(function Controller() {
      const inside = useInFloatingNoticeLayer();
      useEffect(() => {
        renders += 1;
      });
      return <span>{String(inside)}</span>;
    });
    render(
      <FloatingNoticeLayer columnRem={56}>
        <Controller />
        {notice()}
      </FloatingNoticeLayer>,
    );
    const before = renders;
    act(() => {
      paneWidth = 800;
      resize();
    });
    expect(screen.getByRole("button", { name: /^Agent mail:/ })).toBeTruthy();
    expect(renders).toBe(before);
  });
});
