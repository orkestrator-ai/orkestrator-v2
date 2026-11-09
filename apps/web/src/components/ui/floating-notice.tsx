import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Info, Minus, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Notices that float at the top right of a pane instead of a full-width strip
 * that pushes the content down.
 *
 * A pane mounts one `FloatingNoticeLayer`; every `FloatingNotice` rendered
 * anywhere beneath it portals into that layer's stack, so notices from
 * different components share one corner instead of overlapping. A layer
 * beneath another layer joins the outer stack unless it owns an independent pane.
 * A notice with no layer above it renders in place, as a plain card.
 */

export type FloatingNoticeTone = "info" | "warning" | "error";

const TONE_DOT: Record<FloatingNoticeTone, string> = {
  info: "bg-primary",
  warning: "bg-yellow-300",
  error: "bg-failure",
};

const TONE_ICON: Record<FloatingNoticeTone, LucideIcon> = {
  info: Info,
  warning: AlertCircle,
  error: AlertCircle,
};

/**
 * The tone's dot. Notices carry their tone in this dot on a neutral surface
 * rather than in a tinted background, here and in the transcript's rich
 * blocks (`RichBlockFrame`).
 */
export function NoticeToneDot({
  tone,
  className,
}: {
  tone: FloatingNoticeTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", TONE_DOT[tone], className)}
    />
  );
}

/** Errors first, then warnings, then information. */
const TONE_ORDER: Record<FloatingNoticeTone, number> = { error: 0, warning: 1, info: 2 };

/** The card's margins and sizes, in rem. */
const EDGE_REM = 0.75;
const GAP_REM = 0.75;
const CARD_MAX_REM = 18;
const CARD_MIN_REM = 14;
/** The transcript column's inset from the pane edge (1rem a side). */
const COLUMN_INSET_REM = 2;
/** A pane without a column shows cards over its content from this width. */
const OVERLAY_MIN_PANE_REM = 40;

/** The centred transcript column of agent tabs (`max-w-[56rem]`). */
export const TRANSCRIPT_COLUMN_REM = 56;

/** Clear of the thread-changes row an agent tab shows above its transcript. */
export const AGENT_TAB_NOTICE_POSITION = "top-10 right-3";

/**
 * - `beside`: in the empty space right of a centred column, covering nothing.
 * - `over`: over the pane's content, with a control to fold it into a pill.
 * - `pill`: a pill that opens the card on demand.
 */
export type FloatingNoticePlacement = "beside" | "over" | "pill";

export function floatingNoticeLayout(
  paneWidthRem: number,
  columnRem?: number,
): { placement: FloatingNoticePlacement; cardRem: number } {
  if (paneWidthRem <= 0) {
    return { placement: columnRem ? "beside" : "over", cardRem: CARD_MAX_REM };
  }
  const overRem = Math.max(0, Math.min(CARD_MAX_REM, paneWidthRem - 2 * EDGE_REM));
  if (columnRem) {
    const column = Math.min(paneWidthRem - COLUMN_INSET_REM, columnRem);
    const besideRem = Math.min(CARD_MAX_REM, (paneWidthRem - column) / 2 - EDGE_REM - GAP_REM);
    if (besideRem >= CARD_MIN_REM) return { placement: "beside", cardRem: besideRem };
    return { placement: "pill", cardRem: overRem };
  }
  return {
    placement: paneWidthRem >= OVERLAY_MIN_PANE_REM ? "over" : "pill",
    cardRem: overRem,
  };
}

interface LayerState {
  container: HTMLElement | null;
  widthRem: number;
  columnRem?: number;
  /** Height in px from the stack's top to the pane's bottom margin. */
  heightPx?: number;
}

interface LayerContext {
  state: LayerState;
  setAnchor: (anchor: LayerState) => void;
}

const FloatingNoticeContext = createContext<LayerContext | null>(null);
const FloatingNoticePresenceContext = createContext(false);

/**
 * Collects the notices of everything beneath it. With `anchor` it also shows
 * them, at the top right of its parent; without, a `FloatingNoticeAnchor`
 * further down decides where they go.
 */
export function FloatingNoticeLayer({
  anchor = true,
  independent = false,
  columnRem,
  anchorClassName,
  children,
}: {
  anchor?: boolean;
  /** Own a pane-local stack even inside another layer. */
  independent?: boolean;
  /** Width of the pane's centred content column, when it has one. */
  columnRem?: number;
  /** Where the stack sits; see `FloatingNoticeAnchor`. */
  anchorClassName?: string;
  children?: ReactNode;
}) {
  const parent = useContext(FloatingNoticeContext);
  if (parent && !independent) return <>{children}</>;
  return (
    <FloatingNoticeRoot anchor={anchor} columnRem={columnRem} anchorClassName={anchorClassName}>
      {children}
    </FloatingNoticeRoot>
  );
}

/** Whether notices rendered here float in a layer's stack rather than in place. */
export function useInFloatingNoticeLayer(): boolean {
  return useContext(FloatingNoticePresenceContext);
}

function FloatingNoticeRoot({
  anchor,
  columnRem,
  anchorClassName,
  children,
}: {
  anchor: boolean;
  columnRem?: number;
  anchorClassName?: string;
  children?: ReactNode;
}) {
  const [state, setState] = useState<LayerState>({ container: null, widthRem: 0 });
  const value = useMemo(() => ({ state, setAnchor: setState }), [state]);
  return (
    <FloatingNoticePresenceContext.Provider value={true}>
      <FloatingNoticeContext.Provider value={value}>
        {anchor ? <FloatingNoticeAnchor columnRem={columnRem} className={anchorClassName} /> : null}
        {children}
      </FloatingNoticeContext.Provider>
    </FloatingNoticePresenceContext.Provider>
  );
}

/**
 * Where the layer above shows its notices: the top right of this element's
 * parent, which is also the width the layout is measured against. Zero
 * height, so the content keeps its place.
 */
export function FloatingNoticeAnchor({
  columnRem,
  className,
}: {
  columnRem?: number;
  /** Where the stack sits in the anchor's parent; the top right corner by default. */
  className?: string;
}) {
  const layer = useContext(FloatingNoticeContext);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [stack, setStack] = useState<HTMLDivElement | null>(null);
  const [widthRem, setWidthRem] = useState(0);
  const [availableHeight, setAvailableHeight] = useState<number>();
  const setAnchor = layer?.setAnchor;

  useEffect(() => {
    const element = anchorRef.current;
    const pane = element?.parentElement;
    if (!element || !pane || !stack) return;
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setWidthRem(element.getBoundingClientRect().width / rem);
      setAvailableHeight(
        Math.max(
          0,
          pane.getBoundingClientRect().bottom - stack.getBoundingClientRect().top - EDGE_REM * rem,
        ),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [stack]);

  useEffect(() => {
    if (!setAnchor) return;
    setAnchor({ container: stack, widthRem, columnRem, heightPx: availableHeight });
    return () => setAnchor({ container: null, widthRem: 0 });
  }, [setAnchor, stack, widthRem, columnRem, availableHeight]);

  if (!layer) return null;
  return (
    <div ref={anchorRef} className="relative z-30 h-0 shrink-0" data-floating-notice-anchor="">
      <div
        ref={setStack}
        data-floating-notice-stack=""
        style={
          {
            maxHeight: availableHeight,
            "--floating-notice-height":
              availableHeight === undefined ? "70vh" : `${availableHeight}px`,
          } as React.CSSProperties
        }
        className={cn(
          "pointer-events-auto absolute flex max-w-[calc(100%_-_1.5rem)] flex-col items-end gap-2 overflow-y-auto overscroll-contain",
          className ?? "top-3 right-3",
        )}
      />
    </div>
  );
}

/**
 * One notice. `label` names it (the card's heading and its accessible name),
 * `summary` is the plain-text gist a pill announces, `children` the body and
 * `actions` its buttons.
 */
export function FloatingNotice({
  tone = "info",
  label,
  summary,
  pill,
  icon,
  actions,
  onDismiss,
  dismissLabel,
  role = "region",
  "aria-live": ariaLive,
  "aria-atomic": ariaAtomic = true,
  children,
  className,
  style,
  ...rest
}: {
  tone?: FloatingNoticeTone;
  label: string;
  summary: string;
  /** What the pill shows beside its icon; the label when absent. */
  pill?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: "region" | "status" | "alert";
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "role" | "children">) {
  const layer = useContext(FloatingNoticeContext);
  const pillRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const cardId = useId();
  const { placement, cardRem } = layer
    ? floatingNoticeLayout(layer.state.widthRem, layer.state.columnRem)
    : { placement: "beside" as const, cardRem: CARD_MAX_REM };
  // A choice applies to the placement it was made in; a resize across the
  // breakpoint starts the new placement in its default state.
  const [choice, setChoice] = useState<{ placement: FloatingNoticePlacement; open: boolean }>();
  const open =
    placement === "beside" ||
    (choice?.placement === placement ? choice.open : placement === "over");
  const setOpen = (next: boolean) => setChoice({ placement, open: next });
  // The pill and the card replace each other, so focus follows the one shown:
  // opening moves it into the card, closing from inside returns it to the pill.
  const cardRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (open ? cardRef.current : pillRef.current)?.focus();
  }, [open]);

  useEffect(() => {
    if (placement !== "pill" || !open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!noticeRef.current?.contains(event.target as Node)) {
        setChoice({ placement: "pill", open: false });
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [placement, open]);

  const Icon = icon ?? TONE_ICON[tone];
  const dot = <NoticeToneDot tone={tone} />;
  const foldable = placement !== "beside";
  const iconButton =
    "-my-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-elevated hover:text-foreground focus-hairline";

  const notice = (
    <div
      ref={noticeRef}
      className="pointer-events-none flex max-w-full shrink-0 flex-col items-end gap-2"
      style={{ order: TONE_ORDER[tone] }}
      onKeyDown={(event) => {
        if (foldable && open && event.key === "Escape") {
          moveFocus.current = true;
          setOpen(false);
        }
      }}
    >
      {/* The open card announces its body; the persistent live node announces a closed pill. */}
      {(role === "status" || role === "alert" || ariaLive) && (
        <div
          className="sr-only"
          role={open ? undefined : role === "region" ? "status" : role}
          aria-label="Notice announcement"
          data-floating-notice-announcement=""
          aria-live={open ? "off" : (ariaLive ?? (role === "alert" ? "assertive" : "polite"))}
          aria-atomic={ariaAtomic}
        >
          {open ? null : `${label}: ${summary}`}
        </div>
      )}
      {!open && (
        <button
          ref={pillRef}
          type="button"
          style={{ maxWidth: `${Math.min(16, cardRem)}rem` }}
          aria-expanded={false}
          aria-label={`${label}: ${summary}`}
          onClick={() => {
            moveFocus.current = true;
            setOpen(true);
          }}
          className="pointer-events-auto flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-panel-surface/95 px-2.5 text-xs font-medium text-foreground shadow-lg shadow-black/30 outline-none backdrop-blur-sm transition-colors hover:bg-elevated focus-hairline"
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate">{pill ?? label}</span>
          {dot}
        </button>
      )}
      {open && (
        <div
          {...rest}
          ref={cardRef}
          tabIndex={-1}
          id={cardId}
          role={role}
          aria-live={ariaLive}
          aria-label={label}
          style={{ ...style, width: `${cardRem}rem` }}
          className={cn(
            "pointer-events-auto max-w-full max-h-[min(28rem,var(--floating-notice-height,70vh))] overflow-y-auto rounded-xl outline-none border border-border bg-panel-surface/95 p-3 text-xs text-foreground shadow-xl shadow-black/40 backdrop-blur-sm",
            className,
          )}
        >
          <div className="flex items-start gap-1">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {dot}
              <span className="truncate">{label}</span>
            </div>
            {foldable && (
              <button
                type="button"
                aria-label={`Minimize ${label}`}
                aria-controls={cardId}
                onClick={() => {
                  moveFocus.current = true;
                  setOpen(false);
                }}
                className={iconButton}
              >
                <Minus className="size-3.5" />
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                aria-label={dismissLabel ?? `Dismiss ${label}`}
                onClick={onDismiss}
                className={cn(iconButton, "-mr-1")}
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="mt-1.5 leading-5 break-words">{children}</div>
          {actions ? <div className="mt-2.5 flex flex-wrap gap-1.5">{actions}</div> : null}
        </div>
      )}
    </div>
  );

  if (!layer) return notice;
  // Inside a layer whose anchor has not mounted yet: render nothing rather
  // than in place, so the notice does not remount when the anchor arrives.
  if (!layer.state.container) return null;
  return createPortal(notice, layer.state.container);
}

/** The small buttons notice cards use, so every card's actions line up. */
export const FLOATING_NOTICE_ACTION = "h-7 px-2.5 text-xs";

/**
 * Shares the notice stack and the exact gutter measurement with custom
 * notices. `heightPx` is the stack's available height, from its top to the
 * pane's bottom margin, once measured.
 */
export function FloatingNoticeSlot({
  children,
}: {
  children: (layout: ReturnType<typeof floatingNoticeLayout> & { heightPx?: number }) => ReactNode;
}) {
  const layer = useContext(FloatingNoticeContext);
  const layout = {
    ...floatingNoticeLayout(layer?.state.widthRem ?? 0, layer?.state.columnRem),
    heightPx: layer?.state.heightPx,
  };
  const content = children(layout);
  return layer?.state.container ? createPortal(content, layer.state.container) : content;
}
