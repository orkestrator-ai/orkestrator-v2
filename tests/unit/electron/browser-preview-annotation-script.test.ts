import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  BROWSER_PREVIEW_ANNOTATION_STATUS_SCRIPT,
  browserPreviewAnnotationStartScript,
} from "../../../apps/desktop/electron/browser-preview-annotation-script";

function annotationWindow() {
  const window = new Window({ url: "http://localhost:3000/dashboard" });
  const document = window.document;
  const target = document.createElement("button");
  target.id = "save";
  target.textContent = "Save";
  target.setAttribute("style", "font-family: </span><img data-forged>; color: <script>");
  target.getBoundingClientRect = () =>
    ({
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      top: 20,
      right: 110,
      bottom: 60,
      left: 10,
    }) as DOMRect;
  document.body.append(target);
  Object.defineProperty(document, "elementFromPoint", { value: () => target });
  Object.defineProperty(window, "getComputedStyle", {
    value: () => ({
      color: "<script>",
      fontSize: "12px",
      fontFamily: "</span><img data-forged>",
      getPropertyValue: () => "",
    }),
  });
  return { window, document, target };
}

function runtimeStatus(window: Window): Record<string, unknown> {
  return JSON.parse(window.eval(BROWSER_PREVIEW_ANNOTATION_STATUS_SCRIPT) as string) as Record<
    string,
    unknown
  >;
}

describe("browser preview annotation runtime", () => {
  test("Escape cancellation removes capture listeners and lets preview input through", () => {
    const { window, document, target } = annotationWindow();
    window.eval(browserPreviewAnnotationStartScript("session-1"));

    target.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 15, clientY: 25 }));
    target.dispatchEvent(
      new window.MouseEvent("click", { clientX: 15, clientY: 25, bubbles: true, cancelable: true }),
    );
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );

    expect(runtimeStatus(window)).toEqual({ status: "cancelled", sessionId: "session-1" });
    const clickAfterCancel = new window.MouseEvent("click", {
      clientX: 15,
      clientY: 25,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(clickAfterCancel);
    expect(clickAfterCancel.defaultPrevented).toBe(false);
  });

  test("renders page-controlled computed styles as text instead of tooltip HTML", () => {
    const { window, document, target } = annotationWindow();
    window.eval(browserPreviewAnnotationStartScript("session-2"));

    target.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 15, clientY: 25 }));

    const tooltip = document.querySelectorAll("[data-orkestrator-annotation-ui]")[1];
    expect(tooltip?.textContent).toContain("img data-forged");
    expect(tooltip?.querySelector("img") === null).toBe(true);
    expect(tooltip?.querySelector("script") === null).toBe(true);
  });

  test("bounds selected element details so a large DOM submission fits status transport", () => {
    const { window, document, target } = annotationWindow();
    document.title = "T".repeat(2_000);
    target.textContent = "text ".repeat(2_000);
    for (let index = 0; index < 100; index += 1) {
      target.setAttribute(`data-long-${index}`, "v".repeat(1_000));
      target.classList.add(`class-${index}-${"x".repeat(100)}`);
    }
    window.eval(browserPreviewAnnotationStartScript("session-3"));

    target.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 15, clientY: 25 }));
    target.dispatchEvent(
      new window.MouseEvent("click", { clientX: 15, clientY: 25, bubbles: true, cancelable: true }),
    );
    const comment = document.querySelector<HTMLTextAreaElement>("[data-comment]")!;
    comment.value = "Please simplify this";
    comment.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true }));

    const encoded = window.eval(BROWSER_PREVIEW_ANNOTATION_STATUS_SCRIPT) as string;
    const status = JSON.parse(encoded) as {
      status: string;
      element: { attributes: Record<string, string>; classNames: string[]; outerHtml: string };
    };
    expect(encoded.length).toBeLessThanOrEqual(65_536);
    expect(status.status).toBe("submitted");
    expect(Object.keys(status.element.attributes)).toHaveLength(16);
    expect(status.element.classNames).toHaveLength(20);
    expect(status.element.outerHtml.length).toBeLessThanOrEqual(6_000);
  });

  test("returns a distinct retryable error when an unexpected runtime result exceeds the cap", () => {
    const { window } = annotationWindow();
    Object.assign(window, {
      __orkestratorBrowserAnnotationRuntime__: {
        getStatus: () => ({
          status: "submitted",
          sessionId: "session-4",
          comment: "comment",
          element: { outerHtml: "x".repeat(70_000) },
        }),
      },
    });

    expect(runtimeStatus(window)).toEqual({
      status: "error",
      sessionId: "session-4",
      message: "The selected element contains too much page data. Try a smaller element.",
    });
  });
});
