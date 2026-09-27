/**
 * happy-dom harness for the page-side capture runtime and pin layer.
 * `elementFromPoint` is mocked; `isTrusted` is set explicitly on user events.
 */
import { expect } from "bun:test";
import { Window } from "happy-dom";
import {
  BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT,
  BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT,
  browserPreviewCapturePrepareScript,
  browserPreviewCaptureStartScript,
} from "../../../apps/desktop/electron/browser-preview-annotation-script";
import { browserPreviewPinsShowScript } from "../../../apps/desktop/electron/browser-preview-pins-script";

export type Json = Record<string, any>;
export type Mode = "element" | "text" | "region" | "page";

export function page(html: string, url = "http://localhost:3000/dashboard") {
  const window = new Window({ url, width: 1024, height: 768 });
  const document = window.document;
  document.body.innerHTML = html;
  let pointTarget: Element | null = null;
  Object.defineProperty(document, "elementFromPoint", { value: () => pointTarget });
  return {
    window,
    document,
    point(element: Element | null) {
      pointTarget = element;
    },
    start(mode: Mode, captureId = "capture-1") {
      return JSON.parse(
        window.eval(
          browserPreviewCaptureStartScript({ captureId, nonce: "nonce-1", mode }),
        ) as string,
      ) as Json;
    },
    status() {
      return JSON.parse(window.eval(BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT) as string) as Json;
    },
    async prepare(captureId = "capture-1") {
      const encoded = await (window.eval(browserPreviewCapturePrepareScript(captureId)) as Promise<
        string | null
      >);
      return encoded ? (JSON.parse(encoded) as Json) : null;
    },
    pins(
      queries: Array<{ annotationId: string; number: number; target: unknown }>,
      focusedAnnotationId: string | null = null,
    ) {
      return (
        JSON.parse(
          window.eval(
            browserPreviewPinsShowScript({
              queries: queries.map((query) => ({ label: "Target", ...query })),
              focusedAnnotationId,
              scrollIntoView: false,
            }),
          ) as string,
        ) as { results: Json[] }
      ).results;
    },
    ui() {
      return Array.from(document.querySelectorAll("[data-orkestrator-annotation-ui]"));
    },
  };
}

/** Pin badges currently displayed (matched targets only). */
export function visiblePins(harness: ReturnType<typeof page>): HTMLElement[] {
  return Array.from(
    harness.document.querySelectorAll<HTMLElement>("[data-orkestrator-pins] [role='img']"),
  ).filter((node) => node.style.display === "block");
}

export function setRect(
  element: Element,
  rect: { x: number; y: number; width: number; height: number },
) {
  (element as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  });
}

/**
 * Mark an event as browser-generated. happy-dom leaves `isTrusted` undefined;
 * in Chromium it is an unforgeable own property the page cannot set.
 */
export function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

export function click(harness: ReturnType<typeof page>, element: Element) {
  const { window } = harness;
  harness.point(element);
  element.dispatchEvent(
    trusted(new window.PointerEvent("pointermove", { clientX: 5, clientY: 5, bubbles: true })),
  );
  const event = trusted(
    new window.MouseEvent("click", {
      clientX: 5,
      clientY: 5,
      bubbles: true,
      cancelable: true,
    }),
  );
  element.dispatchEvent(event);
  return event;
}

export function key(harness: ReturnType<typeof page>, name: string) {
  const event = trusted(
    new harness.window.KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
    }),
  );
  harness.document.dispatchEvent(event);
  return event;
}

/** Capture an element target through the real runtime. */
export function captureElement(harness: ReturnType<typeof page>, element: Element): Json {
  harness.start("element");
  click(harness, element);
  const status = harness.status();
  expect(status.status).toBe("selected");
  harness.window.eval(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
  return status.selection.target as Json;
}
