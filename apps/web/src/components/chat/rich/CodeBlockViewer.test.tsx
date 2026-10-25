import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { setHighlightBackend } from "@/lib/chat/highlighter/client";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import { richViewStoreStats, useRichContentViewStore } from "@/stores/richContentViewStore";
import { CodeBlock } from "./CodeBlock";
import {
  pinRichViewWithRecovery,
  resetRichViewPinRecovery,
  useRichViewPin,
} from "./CodeBlockViewer";

const PIN_LIMIT = FRONTEND_RENDER_POLICY.maxPinnedViewStateEntries;
const SOURCE = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");

beforeEach(() => {
  setHighlightBackend({
    async highlight(input) {
      return { lines: input.code.split("\n").map((line) => [{ c: line }]), stateId: null };
    },
  });
  richRenderScheduler.clear();
  useRichContentViewStore.getState().reset();
  resetRichViewPinRecovery();
});

afterEach(() => {
  cleanup();
  setHighlightBackend(undefined);
});

function block(key: string): HTMLElement {
  return document.querySelector(`[data-rich-block-key="${key}"]`) as HTMLElement;
}

function expandedButton(key: string): HTMLElement | null {
  return within(block(key)).queryByRole("button", { name: "Collapse code" });
}

/** Pin `count` other identities the way another block's expanded view would. */
function pinOthers(prefix: string, count = PIN_LIMIT) {
  act(() => {
    for (let index = 0; index < count; index++) pinRichViewWithRecovery(`${prefix}-${index}`);
  });
}

describe("pin displacement recovery", () => {
  test("expanding past the pin bound displaces the oldest block, which offers Reopen instead of losing its state", () => {
    const { update } = useRichContentViewStore.getState();
    update("a", { expanded: true, wrap: true });
    render(<CodeBlock source={SOURCE} language="ts" closed blockKey="a" />);
    expect(expandedButton("a")).toBeTruthy();

    // Another PIN_LIMIT blocks open their expanded views after it.
    for (let index = 0; index < PIN_LIMIT; index++) update(`b${index}`, { expanded: true });
    render(
      <>
        {Array.from({ length: PIN_LIMIT }, (_, index) => (
          <CodeBlock key={index} source="x" language="ts" closed blockKey={`b${index}`} />
        ))}
      </>,
    );
    expect(richViewStoreStats().pinned).toBe(PIN_LIMIT);

    // The displaced block closed its expanded view visibly, not silently.
    expect(expandedButton("a") === null).toBe(true);
    const notice = within(block("a")).getByRole("status");
    expect(notice.textContent).toContain("expanded code was closed");
    expect(block("b0").querySelector("[data-rich-pin-displaced]") === null).toBe(true);

    // Reopen restores the captured state and pins it again (displacing the next oldest).
    fireEvent.click(within(block("a")).getByRole("button", { name: /Reopen/ }));
    expect(expandedButton("a")).toBeTruthy();
    expect(
      within(block("a")).getByRole("button", { name: "Wrap lines" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(block("a").querySelector("[data-rich-pin-displaced]") === null).toBe(true);
    expect(within(block("b0")).getByRole("status").textContent).toContain("Reopen");
    expect(richViewStoreStats().pinned).toBe(PIN_LIMIT);
  });

  test("Reopen restores the captured view state even after the entry was evicted", () => {
    useRichContentViewStore.getState().update("evicted", { expanded: true, wrap: true });
    render(<CodeBlock source={SOURCE} language="ts" closed blockKey="evicted" />);
    pinOthers("other");
    expect(expandedButton("evicted") === null).toBe(true);
    // Simulate the now-unprotected entry being dropped from the store.
    act(() => useRichContentViewStore.getState().clearPrefixes(["evicted"]));
    expect(
      within(block("evicted"))
        .getByRole("button", { name: "Wrap lines" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(within(block("evicted")).getByRole("button", { name: /Reopen/ }));
    expect(expandedButton("evicted")).toBeTruthy();
    expect(
      within(block("evicted"))
        .getByRole("button", { name: "Wrap lines" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("the recovery action survives unmount/remount of the same identity and can be dismissed", () => {
    useRichContentViewStore.getState().update("remount", { expanded: true });
    const first = render(<CodeBlock source={SOURCE} language="ts" closed blockKey="remount" />);
    pinOthers("other");
    first.unmount();
    render(<CodeBlock source={SOURCE} language="ts" closed blockKey="remount" />);
    expect(within(block("remount")).getByRole("button", { name: /Reopen/ })).toBeTruthy();
    fireEvent.click(within(block("remount")).getByRole("button", { name: "Dismiss" }));
    expect(block("remount").querySelector("[data-rich-pin-displaced]") === null).toBe(true);
    expect(expandedButton("remount") === null).toBe(true);
  });

  test("an unmounted or collapsed block releases its pin and is never displaced", () => {
    function Harness({ active }: { active: boolean }) {
      const pin = useRichViewPin("harness", active, () => {});
      return <span data-testid="displaced">{String(pin.displaced)}</span>;
    }
    const view = render(<Harness active />);
    expect(richViewStoreStats().pinned).toBe(1);
    view.rerender(<Harness active={false} />);
    expect(richViewStoreStats().pinned).toBe(0);
    pinOthers("other");
    expect(screen.getByTestId("displaced").textContent).toBe("false");
  });
});
