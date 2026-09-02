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

function rectEquals(left: DOMRect, right: DOMRect): boolean {
  return (
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom &&
    left.left === right.left &&
    left.width === right.width &&
    left.height === right.height
  );
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
  const [annotationAnchors, setAnnotationAnchors] = useState<ActiveAnnotationAnchor[]>([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addAttemptedRef = useRef(false);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const highlightName = `transcript-annotation-${instanceId}`;
  const activeAnchor = activeAnnotationId
    ? (annotationAnchors.find((anchor) => anchor.annotationId === activeAnnotationId) ?? null)
    : null;

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
      setActiveAnnotationId(null);
      return;
    }
    ownerDocument.addEventListener("selectionchange", readSelection);
    return () => ownerDocument.removeEventListener("selectionchange", readSelection);
  }, [enabled, readSelection, rootRef]);

  useEffect(() => {
    const annotationIds = new Set(annotations.map((annotation) => annotation.id));
    setAnnotationAnchors((current) => {
      const retained = current.filter((anchor) => annotationIds.has(anchor.annotationId));
      return retained.length === current.length ? current : retained;
    });
    if (activeAnnotationId && !annotationIds.has(activeAnnotationId)) {
      setActiveAnnotationId(null);
    }
  }, [activeAnnotationId, annotations]);

  useEffect(() => {
    for (const annotation of annotations) {
      const normalizedComment = normalizeTranscriptAnnotationComment(annotation.comment);
      if (normalizedComment !== annotation.comment) {
        onUpdateAnnotationComment(annotation.id, normalizedComment);
      }
    }
  }, [annotations, onUpdateAnnotationComment]);

  useEffect(() => {
    const cssHighlights =
      typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
        ? CSS.highlights
        : null;
    if (!enabled || annotationAnchors.length === 0 || !cssHighlights) return;
    cssHighlights.set(
      highlightName,
      new Highlight(...annotationAnchors.map((anchor) => anchor.range)),
    );
    return () => {
      cssHighlights.delete(highlightName);
    };
  }, [annotationAnchors, enabled, highlightName]);

  const hasPendingSelection = selection !== null;
  useEffect(() => {
    if (!enabled || (annotationAnchors.length === 0 && !hasPendingSelection)) return;
    let frame = 0;
    const syncAnchor = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setSelection((current) => {
          if (!current || !current.range.startContainer.isConnected) return null;
          const rect = selectionRect(current.range);
          if (!rect) return null;
          return rectEquals(current.rect, rect) ? current : { ...current, rect };
        });
        setAnnotationAnchors((current) => {
          let changed = false;
          const next: ActiveAnnotationAnchor[] = [];
          for (const anchor of current) {
            if (!anchor.range.startContainer.isConnected) {
              changed = true;
              continue;
            }
            const rect = selectionRect(anchor.range);
            if (!rect) {
              changed = true;
              continue;
            }
            if (rectEquals(anchor.rect, rect)) {
              next.push(anchor);
            } else {
              changed = true;
              next.push({ ...anchor, rect });
            }
          }
          return changed ? next : current;
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
  }, [annotationAnchors.length, enabled, hasPendingSelection]);

  useEffect(() => {
    if (!activeAnnotationId) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (editorRef.current?.contains(event.target as Node)) return;
      setActiveAnnotationId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [activeAnnotationId]);

  const addSelection = useCallback(() => {
    if (!selection || addAttemptedRef.current) return;
    addAttemptedRef.current = true;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    const annotation = onAddAnnotation(selection.text);
    if (!annotation) return;
    setAnnotationAnchors((current) => [
      ...current,
      {
        annotationId: annotation.id,
        range: selection.range,
        rect: selection.rect,
      },
    ]);
    setActiveAnnotationId(annotation.id);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [onAddAnnotation, selection]);

  const editAnnotation = useCallback((annotationId: string) => {
    setActiveAnnotationId(annotationId);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  if (typeof document === "undefined") return null;

  const activeAnnotation = activeAnchor
    ? annotations.find((annotation) => annotation.id === activeAnchor.annotationId)
    : undefined;
  const visibleAnnotationAnchors = enabled ? annotationAnchors : [];

  return createPortal(
    <>
      <style>{`::highlight(${highlightName}) { background: rgba(37, 99, 235, 0.5); color: inherit; }`}</style>
      {enabled && selection ? (
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
      {visibleAnnotationAnchors.map((anchor) => {
        const annotation = annotations.find((candidate) => candidate.id === anchor.annotationId);
        if (!annotation) return null;
        const annotationNumber =
          annotations.findIndex((candidate) => candidate.id === annotation.id) + 1;
        const isActive = annotation.id === activeAnnotation?.id;

        return isActive ? (
          <div
            key={annotation.id}
            ref={editorRef}
            data-transcript-selection-ignore
            data-testid="transcript-annotation-editor"
            className="fixed z-[70] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col items-center"
            style={anchoredStyle(anchor.rect, 74)}
            role="dialog"
            aria-label={`Comment on transcript annotation ${annotationNumber}`}
          >
            <input
              ref={inputRef}
              type="text"
              value={normalizeTranscriptAnnotationComment(annotation.comment)}
              maxLength={MAX_TRANSCRIPT_ANNOTATION_COMMENT_LENGTH}
              placeholder="Add an optional comment…"
              aria-label={`Optional comment for annotation ${annotationNumber}`}
              onChange={(event) =>
                onUpdateAnnotationComment(
                  annotation.id,
                  normalizeTranscriptAnnotationComment(event.target.value),
                )
              }
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== "Escape") return;
                if (
                  event.key === "Enter" &&
                  (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                ) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                setActiveAnnotationId(null);
              }}
              className="w-full rounded-2xl border border-zinc-600/70 bg-zinc-800/95 px-4 py-3 text-sm text-zinc-100 shadow-[0_16px_42px_rgba(0,0,0,0.46)] outline-none placeholder:text-zinc-500 focus:border-blue-400/70 focus:ring-2 focus:ring-blue-500/20"
            />
            <span
              className="relative -mt-0.5 flex h-9 min-w-9 items-center justify-center rounded-full border-2 border-white bg-blue-500 px-2 text-sm font-semibold text-white shadow-lg after:absolute after:-bottom-1 after:left-1 after:h-2 after:w-2 after:-rotate-12 after:rounded-bl-sm after:bg-blue-500"
              aria-label={`Transcript reference ${annotationNumber}`}
            >
              {annotationNumber}
            </span>
          </div>
        ) : (
          <button
            key={annotation.id}
            type="button"
            data-transcript-selection-ignore
            data-testid="transcript-annotation-marker"
            className="fixed z-[70] flex h-9 min-w-9 items-center justify-center rounded-full border-2 border-white bg-blue-500 px-2 text-sm font-semibold text-white shadow-lg transition-colors after:absolute after:-bottom-1 after:left-1 after:h-2 after:w-2 after:-rotate-12 after:rounded-bl-sm after:bg-blue-500 hover:bg-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
            style={anchoredStyle(anchor.rect, 36)}
            aria-label={`Edit comment for transcript reference ${annotationNumber}`}
            onClick={() => editAnnotation(annotation.id)}
          >
            {annotationNumber}
          </button>
        );
      })}
    </>,
    document.body,
  );
}
