import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { flowGraphViewKey, useFlowGraphViewStore } from "@/stores/flowGraphViewStore";
import { useFlowViewport } from "./FlowViewport";

const viewKey = "viewport-attachment";
/** Outside a provider the viewport remembers its view under the app's command node. */
const storeKey = () => flowGraphViewKey(getWindowScope().commandScope().nodeId, viewKey);
const content = { width: 2000, height: 1200 };

beforeEach(() => useFlowGraphViewStore.setState({ views: new Map() }));
afterEach(cleanup);

describe("viewport attachment", () => {
  for (const measuredWidth of [1000, null]) {
    test(`does not restore a view saved at another width (measured: ${measuredWidth})`, () => {
      const { result } = renderHook(() => useFlowViewport({ viewKey, measuredWidth, content }));
      act(() => {
        useFlowGraphViewStore.getState().saveView(storeKey(), {
          width: 900,
          zoom: 1,
          scrollLeft: 250,
          scrollTop: 180,
        });
      });
      const replacement = document.createElement("div");
      act(() => result.current.attachViewport(replacement));
      expect(replacement.scrollLeft).toBe(0);
      expect(replacement.scrollTop).toBe(0);
    });
  }

  test("waits for the zoomed canvas to commit before applying a pending pan", () => {
    const { result } = renderHook(() => useFlowViewport({ viewKey, measuredWidth: 1000, content }));
    const original = document.createElement("div");
    act(() => result.current.attachViewport(original));

    // Observe writes as well as the final pan: writing before the scaled
    // canvas commits would let a real browser clamp to the old scroll range.
    const replacement = document.createElement("div");
    const writes: { axis: string; value: number }[] = [];
    for (const axis of ["scrollLeft", "scrollTop"] as const) {
      let value = 0;
      Object.defineProperty(replacement, axis, {
        get: () => value,
        set: (next: number) => {
          value = next;
          writes.push({ axis, value });
        },
      });
    }
    act(() => {
      result.current.zoomBy(1);
      result.current.attachViewport(null);
      result.current.attachViewport(replacement);
      expect(writes).toEqual([]);
    });
    expect(result.current.zoom).toBe(1.25);
    expect(writes).toHaveLength(2);
    expect(replacement.scrollLeft).toBeGreaterThan(0);
    expect(replacement.scrollTop).toBeGreaterThan(0);
    const saved = useFlowGraphViewStore.getState().views.get(storeKey())!;
    expect(replacement.scrollLeft).toBe(saved.scrollLeft);
    expect(replacement.scrollTop).toBe(saved.scrollTop);
  });
});
