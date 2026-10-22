import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { useBlockingOverlay } from "./browser-tab-hooks";

const overlays: Element[] = [];

afterEach(() => {
  cleanup();
  for (const overlay of overlays.splice(0)) overlay.remove();
});

function siblingOverlay(role: string) {
  const parent = document.createElement("div");
  const overlay = document.createElement("div");
  overlay.setAttribute("role", role);
  parent.append(overlay);
  document.body.append(parent);
  overlays.push(parent);
  return { parent, overlay };
}

describe("useBlockingOverlay", () => {
  test.each(["dialog", "alertdialog", "menu", "listbox"])(
    "observes a sibling %s, including one mounted after the preview",
    async (role) => {
      // BrowserTab and ArtifactLiveHost both use this document-wide hook;
      // chat slash/file-mention listboxes live outside their component trees.
      const first = renderHook(() => useBlockingOverlay(true));
      const second = renderHook(() => useBlockingOverlay(true));
      expect(first.result.current).toBe(false);
      const { parent } = siblingOverlay(role);
      await waitFor(() => {
        expect(first.result.current).toBe(true);
        expect(second.result.current).toBe(true);
      });
      parent.remove();
      await waitFor(() => {
        expect(first.result.current).toBe(false);
        expect(second.result.current).toBe(false);
      });
    },
  );

  test.each(["aria-hidden", "data-state"])(
    "keeps a closing overlay blocking until its exit motion ends (%s)",
    async (attribute) => {
      const { overlay } = siblingOverlay("listbox");
      const { result } = renderHook(() => useBlockingOverlay(true));
      expect(result.current).toBe(true);
      overlay.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "closed");
      await act(async () => undefined);
      expect(result.current).toBe(true);
      // Opacity can finish changing without a DOM mutation. Motion events
      // must trigger the final visibility check.
      act(() => {
        overlay.style.opacity = "0";
        overlay.dispatchEvent(new Event("transitionend", { bubbles: true }));
      });
      expect(result.current).toBe(false);
      overlay.remove();
    },
  );

  test.each(["aria-hidden", "data-state"])(
    "detects an already-closing overlay that is still partially visible (%s)",
    (attribute) => {
      const { overlay } = siblingOverlay("menu");
      overlay.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "closed");
      overlay.style.opacity = "0.5";
      const { result } = renderHook(() => useBlockingOverlay(true));
      expect(result.current).toBe(true);
      act(() => {
        overlay.style.visibility = "hidden";
        overlay.dispatchEvent(new Event("animationend", { bubbles: true }));
      });
      expect(result.current).toBe(false);
    },
  );

  test.each([
    ["display", "none"],
    ["visibility", "hidden"],
    ["visibility", "collapse"],
    ["opacity", "0"],
  ])("ignores a closed overlay hidden by ancestor %s: %s", (property, value) => {
    const { parent, overlay } = siblingOverlay("dialog");
    overlay.setAttribute("data-state", "closed");
    parent.style.setProperty(property!, value!);
    const { result } = renderHook(() => useBlockingOverlay(true));
    expect(result.current).toBe(false);
  });

  test("rechecks hidden ancestors and role changes", async () => {
    const { parent, overlay } = siblingOverlay("listbox");
    overlay.setAttribute("aria-hidden", "true");
    parent.hidden = true;
    const { result } = renderHook(() => useBlockingOverlay(true));
    expect(result.current).toBe(false);
    parent.hidden = false;
    await waitFor(() => expect(result.current).toBe(true));
    overlay.setAttribute("role", "presentation");
    await waitFor(() => expect(result.current).toBe(false));
  });

  test("does not observe overlays while disabled and reconciles when enabled", async () => {
    const { result, rerender, unmount } = renderHook(({ enabled }) => useBlockingOverlay(enabled), {
      initialProps: { enabled: false },
    });
    siblingOverlay("listbox");
    await act(async () => undefined);
    expect(result.current).toBe(false);
    rerender({ enabled: true });
    expect(result.current).toBe(true);
    unmount();
  });
});
