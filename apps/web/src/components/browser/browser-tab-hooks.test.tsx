import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import {
  overlayCoversHost,
  useBlockingOverlay,
  useDeferredPreviewHide,
  useObservedElement,
} from "./browser-tab-hooks";

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
  return host;
}

const HOST = { left: 700, top: 140, width: 800, height: 900 };
// The chat composer's slash-command popup, in the pane to the left of the preview.
const BESIDE_HOST = { left: 320, top: 860, width: 340, height: 160 };
const WINDOW = { left: 0, top: 0, width: 1500, height: 1040 };

describe("useBlockingOverlay with a preview host", () => {
  test("leaves the preview showing for a listbox that does not overlap it", async () => {
    const host = previewHost(HOST);
    const { result } = renderHook(() => useBlockingOverlay(true, { host }));
    const { overlay } = siblingOverlay("listbox");
    placeAt(overlay, BESIDE_HOST);
    await act(async () => undefined);
    expect(result.current).toBe(false);
  });

  test("hides the preview for a listbox that overlaps it, and rechecks when it moves", async () => {
    const host = previewHost(HOST);
    const { result } = renderHook(() => useBlockingOverlay(true, { host }));
    const { overlay } = siblingOverlay("listbox");
    placeAt(overlay, BESIDE_HOST);
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

  test.each([
    ["dialog", true],
    ["alertdialog", true],
    ["menu", false],
    ["listbox", false],
  ])("a %s beside the preview blocks: %p", async (role, blocks) => {
    // Modal surfaces block the whole window wherever their content sits;
    // menus and listboxes block only where they overlap the preview.
    const host = previewHost(HOST);
    const { result } = renderHook(() => useBlockingOverlay(true, { host }));
    const { overlay } = siblingOverlay(role);
    placeAt(overlay, BESIDE_HOST);
    await act(async () => undefined);
    expect(result.current).toBe(blocks);
  });

  test("an aria-modal surface beside the preview still blocks", async () => {
    const host = previewHost(HOST);
    const { result } = renderHook(() => useBlockingOverlay(true, { host }));
    const surface = document.createElement("div");
    surface.setAttribute("aria-modal", "true");
    placeAt(surface, BESIDE_HOST);
    document.body.append(surface);
    overlays.push(surface);
    await waitFor(() => expect(result.current).toBe(true));
  });

  test("a modal whose content misses the preview blocks until its backdrop finishes closing", async () => {
    // The dialog primitive renders a full-window backdrop as a sibling of a
    // small centred content box that sits beside a right-hand preview.
    const host = previewHost({ left: 1100, top: 140, width: 400, height: 900 });
    const backdrop = document.createElement("div");
    backdrop.setAttribute("data-slot", "dialog-overlay");
    backdrop.setAttribute("data-state", "open");
    placeAt(backdrop, WINDOW);
    const content = document.createElement("div");
    content.setAttribute("role", "dialog");
    content.setAttribute("aria-modal", "true");
    content.setAttribute("data-state", "open");
    placeAt(content, { left: 400, top: 300, width: 500, height: 400 });
    document.body.append(backdrop, content);
    overlays.push(backdrop, content);

    const { result } = renderHook(() => useBlockingOverlay(true, { host }));
    expect(result.current).toBe(true);

    // Closing: the content box finishes its exit first, the backdrop is
    // still fading out over the preview.
    act(() => {
      backdrop.setAttribute("data-state", "closed");
      backdrop.style.opacity = "0.4";
      content.remove();
    });
    await act(async () => undefined);
    expect(result.current).toBe(true);

    act(() => {
      backdrop.style.opacity = "0";
      backdrop.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(result.current).toBe(false);
  });

  test("binds to a host that mounts after the hook, and to its replacement", async () => {
    const observed: Element[] = [];
    const callbacks: ResizeObserverCallback[] = [];
    const RealResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(target: Element) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { overlay } = siblingOverlay("listbox");
      placeAt(overlay, { left: 900, top: 860, width: 340, height: 160 });
      const { result, rerender } = renderHook(
        ({ host }: { host: Element | null }) => useBlockingOverlay(true, { host }),
        { initialProps: { host: null as Element | null } },
      );
      // No host yet: an unknown geometry counts as covered.
      expect(result.current).toBe(true);
      expect(observed).toEqual([]);

      // The host lands to the left of the listbox.
      const first = previewHost({ left: 0, top: 0, width: 600, height: 900 });
      rerender({ host: first });
      expect(observed).toEqual([first]);
      expect(result.current).toBe(false);

      // A layout move that mutates nothing the document observer sees: only
      // the host's ResizeObserver reports it.
      placeAt(first, { left: 700, top: 140, width: 800, height: 900 });
      act(() => callbacks.at(-1)!([], {} as ResizeObserver));
      await waitFor(() => expect(result.current).toBe(true));

      // A remounted host is observed in place of the detached one.
      const second = previewHost({ left: 0, top: 0, width: 600, height: 900 });
      rerender({ host: second });
      expect(observed.at(-1)).toBe(second);
      expect(result.current).toBe(false);
    } finally {
      globalThis.ResizeObserver = RealResizeObserver;
    }
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

describe("useObservedElement", () => {
  test("writes the element to the ref and re-renders when it changes", () => {
    const ref: { current: HTMLDivElement | null } = { current: null };
    const { result } = renderHook(() => useObservedElement(ref));
    expect(result.current[0]).toBeNull();
    const element = document.createElement("div");
    act(() => result.current[1](element));
    expect(result.current[0]).toBe(element);
    expect(ref.current).toBe(element);
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    expect(ref.current).toBeNull();
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
