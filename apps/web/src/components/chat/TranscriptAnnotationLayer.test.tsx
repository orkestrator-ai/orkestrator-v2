import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TranscriptAnnotation } from "@/lib/chat/transcript-annotations";
import { TranscriptAnnotationLayer } from "./TranscriptAnnotationLayer";

interface AnnotationHarnessProps {
  enabled?: boolean;
  initialComment?: string;
  onOuterKeyDown?: () => void;
}

function AnnotationHarness({
  enabled = true,
  initialComment = "",
  onOuterKeyDown,
}: AnnotationHarnessProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const nextAnnotationId = useRef(1);
  const [annotations, setAnnotations] = useState<TranscriptAnnotation[]>([]);
  const [messages, setMessages] = useState([
    { id: "message-1", text: "First selected transcript text", top: 200 },
    { id: "message-2", text: "Second selected transcript text", top: 300 },
  ]);

  return (
    <div onKeyDown={onOuterKeyDown}>
      <div ref={rootRef}>
        {messages.map((message) => (
          <div
            key={message.id}
            data-chat-message-index={message.id}
            data-testid={message.id}
            data-top={message.top}
          >
            {message.text}
          </div>
        ))}
      </div>
      <button type="button" onClick={() => setAnnotations((current) => current.slice(1))}>
        Remove first annotation
      </button>
      <button type="button" onClick={() => setAnnotations([])}>
        Remove annotations
      </button>
      <button
        type="button"
        onClick={() => setMessages((current) => current.filter(({ id }) => id !== "message-1"))}
      >
        Remove first message
      </button>
      <output data-testid="annotation-comments">
        {JSON.stringify(annotations.map((annotation) => annotation.comment))}
      </output>
      <TranscriptAnnotationLayer
        rootRef={rootRef}
        enabled={enabled}
        annotations={annotations}
        onAddAnnotation={(text) => {
          const id = `annotation-${nextAnnotationId.current++}`;
          const annotation = {
            id,
            text,
            comment: id === "annotation-1" ? initialComment : "",
          };
          setAnnotations((current) => [...current, annotation]);
          return annotation;
        }}
        onUpdateAnnotationComment={(id, comment) =>
          setAnnotations((current) =>
            current.map((annotation) =>
              annotation.id === id ? { ...annotation, comment } : annotation,
            ),
          )
        }
      />
    </div>
  );
}

class TestHighlight {
  readonly ranges: Range[];

  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

const originalHighlight = globalThis.Highlight;
const originalCSS = globalThis.CSS;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
const cssHighlights = new Map<string, TestHighlight>();
let nextFrameId = 1;
let animationFrames = new Map<number, FrameRequestCallback>();

function installBrowserApis() {
  cssHighlights.clear();
  animationFrames = new Map();
  nextFrameId = 1;
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { highlights: cssHighlights },
  });
  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    value: TestHighlight,
    writable: true,
  });
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const frameId = nextFrameId++;
    animationFrames.set(frameId, callback);
    return frameId;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((frameId: number) => {
    animationFrames.delete(frameId);
  }) as typeof cancelAnimationFrame;
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element =
      this.startContainer instanceof Element
        ? this.startContainer
        : this.startContainer.parentElement;
    const message = element?.closest<HTMLElement>("[data-chat-message-index]");
    return new DOMRect(100, Number(message?.dataset.top ?? 200), 160, 20);
  };
}

function flushAnimationFrames() {
  const callbacks = Array.from(animationFrames.values());
  animationFrames.clear();
  act(() => {
    for (const callback of callbacks) callback(0);
  });
}

function selectMessage(messageId: string) {
  const message = screen.getByTestId(messageId);
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(message);
  act(() => {
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function addAnnotation(messageId: string) {
  selectMessage(messageId);
  fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
}

function commentInput(annotationNumber: number): HTMLInputElement {
  return screen.getByRole("textbox", {
    name: `Optional comment for annotation ${annotationNumber}`,
  }) as HTMLInputElement;
}

function currentHighlight(): TestHighlight | undefined {
  return Array.from(cssHighlights.values())[0];
}

describe("TranscriptAnnotationLayer", () => {
  beforeEach(() => {
    installBrowserApis();
  });

  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: originalCSS,
      writable: true,
    });
    Object.defineProperty(globalThis, "Highlight", {
      configurable: true,
      value: originalHighlight,
      writable: true,
    });
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Range.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  test("accepts a single-line comment with Enter and retains an editable marker", () => {
    render(<AnnotationHarness />);
    addAnnotation("message-1");

    const input = commentInput(1);
    expect(input.tagName).toBe("INPUT");
    fireEvent.change(input, { target: { value: "Use a clearer explanation" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByTestId("transcript-annotation-editor") === null).toBe(true);
    const marker = screen.getByRole("button", {
      name: "Edit comment for transcript reference 1",
    });
    expect(marker.textContent).toBe("1");

    fireEvent.click(marker);
    expect(commentInput(1).value).toBe("Use a clearer explanation");

    fireEvent.click(screen.getByRole("button", { name: "Remove annotations" }));
    expect(screen.queryByTestId("transcript-annotation-marker") === null).toBe(true);
    expect(screen.queryByTestId("transcript-annotation-editor") === null).toBe(true);
  });

  test("retains hidden markers and highlights across disable and re-enable", () => {
    const view = render(<AnnotationHarness enabled />);
    addAnnotation("message-1");
    fireEvent.keyDown(commentInput(1), { key: "Enter" });

    expect(
      screen.getByRole("button", { name: "Edit comment for transcript reference 1" }),
    ).toBeTruthy();
    expect(currentHighlight()?.ranges).toHaveLength(1);

    view.rerender(<AnnotationHarness enabled={false} />);
    expect(screen.queryByTestId("transcript-annotation-marker") === null).toBe(true);
    expect(screen.queryByTestId("transcript-annotation-editor") === null).toBe(true);
    expect(cssHighlights.size).toBe(0);

    view.rerender(<AnnotationHarness enabled />);
    expect(
      screen.getByRole("button", { name: "Edit comment for transcript reference 1" }),
    ).toBeTruthy();
    expect(currentHighlight()?.ranges).toHaveLength(1);
  });

  test("keeps IME-confirming Enter events available to the browser", () => {
    render(<AnnotationHarness />);
    addAnnotation("message-1");
    const input = commentInput(1);

    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    act(() => input.dispatchEvent(composingEnter));
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(screen.getByTestId("transcript-annotation-editor")).toBeTruthy();

    const webkitEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      keyCode: 229,
    });
    act(() => input.dispatchEvent(webkitEnter));
    expect(webkitEnter.defaultPrevented).toBe(false);
    expect(screen.getByTestId("transcript-annotation-editor")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByTestId("transcript-annotation-editor") === null).toBe(true);
  });

  test("closes on Escape without propagating it to ancestors", () => {
    const onOuterKeyDown = mock(() => {});
    render(<AnnotationHarness onOuterKeyDown={onOuterKeyDown} />);
    addAnnotation("message-1");
    const input = commentInput(1);
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });

    act(() => input.dispatchEvent(escape));

    expect(escape.defaultPrevented).toBe(true);
    expect(onOuterKeyDown).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Edit comment for transcript reference 1" }),
    ).toBeTruthy();
  });

  test("closes the editor on an outside pointer press", () => {
    render(<AnnotationHarness />);
    addAnnotation("message-1");

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId("transcript-annotation-editor") === null).toBe(true);
    expect(
      screen.getByRole("button", { name: "Edit comment for transcript reference 1" }),
    ).toBeTruthy();
  });

  test("retains multiple markers, switches editors, renumbers, and highlights every range", () => {
    render(<AnnotationHarness />);
    addAnnotation("message-1");
    fireEvent.keyDown(commentInput(1), { key: "Enter" });
    addAnnotation("message-2");

    expect(currentHighlight()?.ranges).toHaveLength(2);
    expect(screen.getByRole("dialog", { name: "Comment on transcript annotation 2" })).toBeTruthy();
    const firstMarker = screen.getByRole("button", {
      name: "Edit comment for transcript reference 1",
    });
    fireEvent.pointerDown(firstMarker);
    fireEvent.click(firstMarker);

    expect(screen.getByRole("dialog", { name: "Comment on transcript annotation 1" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit comment for transcript reference 2" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove first annotation" }));
    expect(
      screen.getByRole("button", { name: "Edit comment for transcript reference 1" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Edit comment for transcript reference 2" }) === null,
    ).toBe(true);
    expect(currentHighlight()?.ranges).toHaveLength(1);
  });

  test("repositions anchors, preserves a no-op highlight, and drops disconnected ranges", () => {
    render(<AnnotationHarness />);
    addAnnotation("message-1");
    fireEvent.keyDown(commentInput(1), { key: "Enter" });
    const marker = screen.getByRole("button", {
      name: "Edit comment for transcript reference 1",
    });
    expect(marker.style.top).toBe("192px");

    screen.getByTestId("message-1").dataset.top = "260";
    fireEvent.resize(window);
    flushAnimationFrames();
    expect(marker.style.top).toBe("252px");

    const stableHighlight = currentHighlight();
    fireEvent.scroll(document);
    flushAnimationFrames();
    expect(currentHighlight()).toBe(stableHighlight);

    fireEvent.click(screen.getByRole("button", { name: "Remove first message" }));
    fireEvent.scroll(document);
    flushAnimationFrames();
    expect(screen.queryByTestId("transcript-annotation-marker") === null).toBe(true);
    expect(cssHighlights.size).toBe(0);
  });

  test("renders and stores a legacy multiline comment as one line", () => {
    render(<AnnotationHarness initialComment={"first line\r\nsecond line"} />);
    addAnnotation("message-1");

    const input = commentInput(1);
    expect(input.value).toBe("first line second line");
    expect(screen.getByTestId("annotation-comments").textContent).toBe(
      '["first line second line"]',
    );
  });
});
