import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { overlayCoversHost, useBlockingOverlay, useDeferredPreviewHide } from "./browser-tab-hooks";

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

type Box = { left: number; top: number; width: number; height: number };

function placeAt(element: Element, box: Box) {
  element.getBoundingClientRect = () =>
    ({
      x: box.left,
      y: box.top,
      left: box.left,
      top: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      width: box.width,
      height: box.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

function previewHost(box: Box) {
  const host = document.createElement("div");
  placeAt(host, box);
  document.body.append(host);
  overlays.push(host);
  return { current: host };
}

describe("useBlockingOverlay with a preview host", () => {
  const HOST = { left: 700, top: 140, width: 800, height: 900 };

  test("leaves the preview showing for a listbox that does not overlap it", async () => {
    // The chat composer's slash-command popup sits in the pane beside the preview.
    const hostRef = previewHost(HOST);
    const { result } = renderHook(() => useBlockingOverlay(true, hostRef));
    const { overlay } = siblingOverlay("listbox");
    placeAt(overlay, { left: 320, top: 860, width: 340, height: 160 });
    await act(async () => undefined);
    expect(result.current).toBe(false);
  });

  test("hides the preview for a listbox that overlaps it, and rechecks when it moves", async () => {
    const hostRef = previewHost(HOST);
    const { result } = renderHook(() => useBlockingOverlay(true, hostRef));
    const { overlay } = siblingOverlay("listbox");
    placeAt(overlay, { left: 320, top: 860, width: 340, height: 160 });
    await act(async () => undefined);
    expect(result.current).toBe(false);
    // Floating UI repositions through `style`; the hook rescans on the next frame.
    placeAt(overlay, { left: 600, top: 860, width: 340, height: 160 });
    overlay.setAttribute("style", "transform: translate(600px, 860px)");
    await waitFor(() => expect(result.current).toBe(true));
    placeAt(overlay, { left: 100, top: 860, width: 340, height: 160 });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(result.current).toBe(false));
  });

  test("treats an overlay or host without layout as covering", () => {
    const host = document.createElement("div");
    const overlay = document.createElement("div");
    placeAt(host, HOST);
    expect(overlayCoversHost(overlay, host)).toBe(true);
    placeAt(overlay, { left: 0, top: 0, width: 10, height: 10 });
    expect(overlayCoversHost(overlay, host)).toBe(false);
    placeAt(host, { left: 0, top: 0, width: 0, height: 0 });
    expect(overlayCoversHost(overlay, host)).toBe(true);
    expect(overlayCoversHost(overlay, null)).toBe(true);
  });
});

describe("useDeferredPreviewHide", () => {
  test("a re-run that claims the same tab cancels the pending hide", async () => {
    const { result } = renderHook(() => useDeferredPreviewHide());
    let hidden = 0;
    result.current.release("tab-1", () => (hidden += 1));
    result.current.claim("tab-1");
    await Promise.resolve();
    expect(hidden).toBe(0);
  });

  test("a final teardown, or a different tab, still hides", async () => {
    const { result } = renderHook(() => useDeferredPreviewHide());
    let hidden = 0;
    result.current.release("tab-1", () => (hidden += 1));
    await Promise.resolve();
    expect(hidden).toBe(1);
    result.current.release("tab-1", () => (hidden += 1));
    result.current.claim("tab-2");
    await Promise.resolve();
    expect(hidden).toBe(2);
  });
});
