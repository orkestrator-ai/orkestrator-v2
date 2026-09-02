import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus } from "lucide-react";
import {
  MAX_TRANSCRIPT_ANNOTATION_COMMENT_LENGTH,
  normalizeTranscriptAnnotationComment,
  normalizeTranscriptAnnotationText,
  type TranscriptAnnotation,
} from "@/lib/chat/transcript-annotations";

interface SelectionAnchor {
  text: string;
  range: Range;
  rect: DOMRect;
}

interface ActiveAnnotationAnchor {
  annotationId: string;
  range: Range;
  rect: DOMRect;
}

interface TranscriptAnnotationLayerProps {
  rootRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  annotations: readonly TranscriptAnnotation[];
  onAddAnnotation: (text: string) => TranscriptAnnotation | null;
  onUpdateAnnotationComment: (id: string, comment: string) => void;
}

function elementForNode(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function selectionRect(range: Range): DOMRect | null {
  const boundingRect = range.getBoundingClientRect();
  if (boundingRect.width > 0 || boundingRect.height > 0) return boundingRect;
  return range.getClientRects().item(0);
}

function anchoredStyle(rect: DOMRect, panelHeight: number): CSSProperties {
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const left = Math.min(Math.max(rect.left + rect.width / 2, 24), viewportWidth - 24);
  const roomAbove = rect.top >= panelHeight + 16;
  return {
    left,
    top: roomAbove ? rect.top - 8 : rect.bottom + 8,
    transform: roomAbove ? "translate(-50%, -100%)" : "translate(-50%, 0)",
  };
}

/**
 * Browser-selection affordance shared by every native transcript.
 *
 * The DOM Range is intentionally transient. The durable value is the copied
 * text in the compose draft; a virtualized message may unmount at any time.
 */
export function TranscriptAnnotationLayer({
  rootRef,
  enabled,
  annotations,
  onAddAnnotation,
  onUpdateAnnotationComment,
}: TranscriptAnnotationLayerProps) {
  const [selection, setSelection] = useState<SelectionAnchor | null>(null);
  const [activeAnchor, setActiveAnchor] = useState<ActiveAnnotationAnchor | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const addAttemptedRef = useRef(false);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const highlightName = `transcript-annotation-${instanceId}`;
  const activeAnnotationId = activeAnchor?.annotationId;

  const readSelection = useCallback(() => {
    if (!enabled || activeAnchor) return;
    addAttemptedRef.current = false;
    const root = rootRef.current;
    const ownerDocument = root?.ownerDocument;
    const browserSelection = ownerDocument?.getSelection();
    if (
      !root ||
      !browserSelection ||
      browserSelection.isCollapsed ||
      browserSelection.rangeCount === 0
    ) {
      setSelection(null);
      return;
    }

    const range = browserSelection.getRangeAt(0);
    const startElement = elementForNode(range.startContainer);
    const endElement = elementForNode(range.endContainer);
    if (
      !startElement ||
      !endElement ||
      !root.contains(startElement) ||
      !root.contains(endElement) ||
      !startElement.closest("[data-chat-message-index]") ||
      !endElement.closest("[data-chat-message-index]") ||
      startElement.closest("[data-transcript-selection-ignore]") ||
      endElement.closest("[data-transcript-selection-ignore]")
    ) {
      setSelection(null);
      return;
    }

    const text = normalizeTranscriptAnnotationText(browserSelection.toString());
    const rect = selectionRect(range);
    if (!text || !rect) {
      setSelection(null);
      return;
    }
    setSelection({ text, range: range.cloneRange(), rect });
  }, [activeAnchor, enabled, rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    const ownerDocument = root?.ownerDocument;
    if (!enabled || !ownerDocument) {
      setSelection(null);
      setActiveAnchor(null);
      return;
    }
    ownerDocument.addEventListener("selectionchange", readSelection);
    return () => ownerDocument.removeEventListener("selectionchange", readSelection);
  }, [enabled, readSelection, rootRef]);

  useEffect(() => {
    if (!activeAnnotationId) return;
    if (!annotations.some((annotation) => annotation.id === activeAnnotationId)) {
      setActiveAnchor(null);
    }
  }, [activeAnnotationId, annotations]);

  useEffect(() => {
    const cssHighlights =
      typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
        ? CSS.highlights
        : null;
    if (!activeAnchor || !cssHighlights) return;
    cssHighlights.set(highlightName, new Highlight(activeAnchor.range));
    return () => {
      cssHighlights.delete(highlightName);
    };
  }, [activeAnchor, highlightName]);

  const hasPendingSelection = selection !== null;
  useEffect(() => {
    if (!activeAnnotationId && !hasPendingSelection) return;
    let frame = 0;
    const syncAnchor = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setSelection((current) => {
          if (!current || !current.range.startContainer.isConnected) return null;
          const rect = selectionRect(current.range);
          return rect ? { ...current, rect } : null;
        });
        setActiveAnchor((current) => {
          if (!current || !current.range.startContainer.isConnected) return null;
          const rect = selectionRect(current.range);
          return rect ? { ...current, rect } : null;
        });
      });
    };
    window.addEventListener("resize", syncAnchor);
    document.addEventListener("scroll", syncAnchor, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", syncAnchor);
      document.removeEventListener("scroll", syncAnchor, true);
    };
  }, [activeAnnotationId, hasPendingSelection]);

  useEffect(() => {
    if (!activeAnchor) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (editorRef.current?.contains(event.target as Node)) return;
      setActiveAnchor(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [activeAnchor]);

  const addSelection = useCallback(() => {
    if (!selection || addAttemptedRef.current) return;
    addAttemptedRef.current = true;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    const annotation = onAddAnnotation(selection.text);
    if (!annotation) return;
    setActiveAnchor({
      annotationId: annotation.id,
      range: selection.range,
      rect: selection.rect,
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [onAddAnnotation, selection]);

  if (typeof document === "undefined") return null;

  const activeAnnotation = activeAnchor
    ? annotations.find((annotation) => annotation.id === activeAnchor.annotationId)
    : undefined;
  const activeNumber = activeAnnotation
    ? annotations.findIndex((annotation) => annotation.id === activeAnnotation.id) + 1
    : 0;

  return createPortal(
    <>
      <style>{`::highlight(${highlightName}) { background: rgba(37, 99, 235, 0.5); color: inherit; }`}</style>
      {selection ? (
        <button
          type="button"
          data-transcript-selection-ignore
          data-testid="add-transcript-selection"
          className="fixed z-[70] flex items-center gap-1.5 whitespace-nowrap rounded-full border border-blue-300/25 bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-[0_10px_30px_rgba(0,0,0,0.42)] transition-colors hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
          style={anchoredStyle(selection.rect, 34)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={addSelection}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
          Add to chat
        </button>
      ) : null}
      {activeAnchor && activeAnnotation ? (
        <div
          ref={editorRef}
          data-transcript-selection-ignore
          data-testid="transcript-annotation-editor"
          className="fixed z-[70] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col items-center"
          style={anchoredStyle(activeAnchor.rect, 90)}
          role="dialog"
          aria-label={`Comment on transcript annotation ${activeNumber}`}
        >
          <textarea
            ref={textareaRef}
            value={activeAnnotation.comment}
            maxLength={MAX_TRANSCRIPT_ANNOTATION_COMMENT_LENGTH}
            rows={2}
            placeholder="Add an optional comment…"
            aria-label={`Optional comment for annotation ${activeNumber}`}
            onChange={(event) =>
              onUpdateAnnotationComment(
                activeAnnotation.id,
                normalizeTranscriptAnnotationComment(event.target.value),
              )
            }
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setActiveAnchor(null);
            }}
            className="w-full resize-none rounded-2xl border border-zinc-600/70 bg-zinc-800/95 px-4 py-3 text-sm text-zinc-100 shadow-[0_16px_42px_rgba(0,0,0,0.46)] outline-none placeholder:text-zinc-500 focus:border-blue-400/70 focus:ring-2 focus:ring-blue-500/20"
          />
          <span
            className="relative -mt-0.5 flex h-9 min-w-9 items-center justify-center rounded-full border-2 border-white bg-blue-500 px-2 text-sm font-semibold text-white shadow-lg after:absolute after:-bottom-1 after:left-1 after:h-2 after:w-2 after:-rotate-12 after:rounded-bl-sm after:bg-blue-500"
            aria-label={`Transcript reference ${activeNumber}`}
          >
            {activeNumber}
          </span>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
