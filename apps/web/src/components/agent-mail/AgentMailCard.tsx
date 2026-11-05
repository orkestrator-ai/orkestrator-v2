import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Inbox, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type AgentMailCardTone = "info" | "warning" | "error";

const TONE_DOT: Record<AgentMailCardTone, string> = {
  info: "bg-primary",
  warning: "bg-yellow-300",
  error: "bg-failure",
};

/** The transcript column (`max-w-[56rem]`, inset 1rem a side) and the card's margins, in rem. */
const COLUMN_REM = 56;
const COLUMN_INSET_REM = 2;
const EDGE_REM = 0.75;
const GAP_REM = 0.75;
const CARD_MAX_REM = 18;
const CARD_MIN_REM = 14;

/**
 * Where the card fits. A wide pane leaves empty space to the right of the
 * centred transcript column, and the card sits there without covering text.
 * A narrower pane gets a pill in the corner that opens the same card.
 * Unmeasured (before layout, or without ResizeObserver) means the card.
 */
export function agentMailCardLayout(
  paneWidthRem: number,
): { collapsed: false; cardRem: number } | { collapsed: true; cardRem: number } {
  if (paneWidthRem <= 0) return { collapsed: false, cardRem: CARD_MAX_REM };
  const column = Math.min(paneWidthRem - COLUMN_INSET_REM, COLUMN_REM);
  const gutterCard = Math.min(CARD_MAX_REM, (paneWidthRem - column) / 2 - EDGE_REM - GAP_REM);
  if (gutterCard >= CARD_MIN_REM) return { collapsed: false, cardRem: gutterCard };
  return { collapsed: true, cardRem: Math.min(CARD_MAX_REM, paneWidthRem - 2 * EDGE_REM) };
}

function usePaneWidthRem(ref: RefObject<HTMLDivElement | null>, onResize: () => void): number {
  const [widthRem, setWidthRem] = useState(0);
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setWidthRem(element.getBoundingClientRect().width / rem);
      onResizeRef.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return widthRem;
}

/**
 * Agent mail for one tab, floating at the top right of its pane rather than
 * pushing the transcript down. `text` says where the mail stands; `children`
 * are its actions.
 */
export function AgentMailCard({
  tone,
  count,
  text,
  newest,
  actionError,
  onDismiss,
  children,
}: {
  tone: AgentMailCardTone;
  count: number;
  text: string;
  newest?: { sender: string; time: string; subject?: string };
  actionError?: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const cardId = useId();
  const [expanded, setExpanded] = useState(false);
  // A resize can move the pane across the breakpoint; start that layout closed.
  const widthRem = usePaneWidthRem(anchorRef, () => setExpanded(false));
  const { collapsed, cardRem } = agentMailCardLayout(widthRem);

  useEffect(() => {
    if (!collapsed || !expanded) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setExpanded(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [collapsed, expanded]);

  const dot = (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", TONE_DOT[tone])}
    />
  );

  return (
    // Zero height, so the transcript keeps its place; the card floats over it.
    <div ref={anchorRef} className="relative z-20 h-0 shrink-0">
      <div
        className="pointer-events-none absolute top-3 right-3 flex flex-col items-end gap-2"
        onKeyDown={(event) => {
          if (collapsed && expanded && event.key === "Escape") {
            setExpanded(false);
            pillRef.current?.focus();
          }
        }}
      >
        {collapsed && (
          <button
            ref={pillRef}
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? cardId : undefined}
            aria-label={`Agent mail: ${text}`}
            onClick={() => setExpanded((open) => !open)}
            className="pointer-events-auto flex h-7 items-center gap-1.5 rounded-full border border-border bg-panel-surface/95 px-2.5 text-xs font-medium text-foreground shadow-lg shadow-black/30 outline-none backdrop-blur-sm transition-colors hover:bg-elevated focus-hairline"
          >
            <Inbox className="size-3.5 text-muted-foreground" />
            {count}
            {dot}
          </button>
        )}
        {(!collapsed || expanded) && (
          <section
            id={cardId}
            aria-label="Agent mail"
            style={{ width: `${cardRem}rem` }}
            className="pointer-events-auto rounded-xl border border-border bg-panel-surface/95 p-3 text-xs shadow-xl shadow-black/40 backdrop-blur-sm"
          >
            <div className="flex items-start gap-2">
              <div className="mt-0.5 flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {dot}
                Agent mail
              </div>
              <button
                type="button"
                aria-label="Dismiss agent mail notice"
                onClick={onDismiss}
                className="-mt-1 -mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-elevated hover:text-foreground focus-hairline"
              >
                <X className="size-3.5" />
              </button>
            </div>
            {/* Wraps rather than truncates: the reason is what the person acts on. */}
            <p className="mt-1.5 leading-5 text-foreground">{text}</p>
            {newest && (
              <div className="mt-2 border-t border-border pt-2">
                <p className="truncate text-muted-foreground">
                  {newest.sender}
                  {newest.time ? ` · ${newest.time}` : ""}
                </p>
                {newest.subject && (
                  <p className="mt-0.5 line-clamp-2 text-foreground/90">{newest.subject}</p>
                )}
              </div>
            )}
            {actionError && (
              <p role="alert" className="mt-2 line-clamp-3 text-failure" title={actionError}>
                {actionError}
              </p>
            )}
            <div className="mt-2.5 flex flex-wrap gap-1.5">{children}</div>
          </section>
        )}
      </div>
    </div>
  );
}
