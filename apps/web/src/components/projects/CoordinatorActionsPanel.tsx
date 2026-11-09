import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, GitPullRequest, ListTodo, MessageCircle, Minus, Tag } from "lucide-react";
import { FloatingNoticeSlot } from "@/components/ui/floating-notice";
import type { CoordinatorActionCard } from "./coordinator-action-cards";
import {
  setCoordinatorActionsDockedOpen,
  useCoordinatorActionsDockedOpen,
} from "./coordinator-actions-preference";
import { cn } from "@/lib/utils";

export function CoordinatorActionsPanel({
  cards,
  onNavigate,
}: {
  cards: readonly CoordinatorActionCard[];
  onNavigate: (anchorId: string) => void;
}) {
  return (
    <FloatingNoticeSlot>
      {(layout) => (
        <ActionsPanel
          cards={cards}
          onNavigate={onNavigate}
          docked={layout.placement === "beside"}
          width={layout.cardRem}
          availableHeight={layout.heightPx}
        />
      )}
    </FloatingNoticeSlot>
  );
}

export function ActionsPanel({
  cards,
  onNavigate,
  docked,
  width = 18,
  availableHeight,
}: {
  cards: readonly CoordinatorActionCard[];
  onNavigate: (anchorId: string) => void;
  /** Room to dock beside the column: the panel stays open until its header folds it. */
  docked: boolean;
  width?: number;
  /** The notice stack's height in px, from its top to the pane's bottom margin. */
  availableHeight?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [present, setPresent] = useState(() => cards.map((card) => ({ card, leaving: false })));
  useEffect(() => {
    // Keep only the preceding ten cards during the short exit. Semantic
    // visibility changes immediately; removed cards are never focusable.
    const enter = setTimeout(() => {
      setPresent((previous) =>
        [
          ...previous
            .filter((item) => !cards.some((card) => card.id === item.card.id))
            .slice(-10)
            .map((item) => ({ ...item, leaving: true })),
          ...cards.map((card) => ({ card, leaving: false })),
        ].sort((a, b) => a.card.index - b.card.index),
      );
    }, 0);
    const retire = setTimeout(
      () => setPresent((previous) => previous.filter((item) => !item.leaving)),
      160,
    );
    return () => {
      clearTimeout(enter);
      clearTimeout(retire);
    };
  }, [cards]);

  const dockedOpen = useCoordinatorActionsDockedOpen();
  // The narrow overlay's open state is transient: a resize across the
  // breakpoint starts each mode in its own state, so going narrow shows the
  // folded icon and going wide restores the remembered docked choice.
  const [mode, setMode] = useState(docked);
  if (mode !== docked) {
    setMode(docked);
    setExpanded(false);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLButtonElement>(null);
  const icon = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const pointer = useRef(false);
  const suppressed = useRef(false);
  const touch = useRef(false);
  // The header and the icon replace each other as the control, so focus
  // follows whichever one a toggle leaves in place.
  const focusAfter = useRef<"icon" | "header" | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const open = () => {
    cancel();
    if (!docked && !suppressed.current) setExpanded(true);
  };
  const leave = () => {
    cancel();
    timer.current = setTimeout(() => {
      if (!pointer.current && !root.current?.contains(document.activeElement)) setExpanded(false);
    }, 160);
  };
  const collapse = () => {
    cancel();
    focusAfter.current = "icon";
    if (docked) {
      setCoordinatorActionsDockedOpen(false);
      return;
    }
    // The pointer and focus are still inside: stay folded until they leave.
    suppressed.current = true;
    setExpanded(false);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (docked || !expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      suppressed.current = true;
      setExpanded(false);
    };
    // A click or tap anywhere but the overlay and its icon folds it at once.
    const outside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node | null)) return;
      cancel();
      setExpanded(false);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [docked, expanded]);
  const shown = docked ? dockedOpen : expanded;
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    (target === "icon" ? icon.current : header.current)?.focus();
  }, [shown]);

  // Where this panel sits in the stack moves when a notice above it appears,
  // disappears or changes size; the stack's available height comes from the
  // layer. Either changes how many whole cards fit.
  const [topOffset, setTopOffset] = useState(0);
  useEffect(() => {
    const element = root.current;
    const stack = element?.parentElement;
    if (!element || !stack || typeof ResizeObserver === "undefined") return;
    const update = () => setTopOffset(element.offsetTop);
    const resize = new ResizeObserver(update);
    // Never this panel itself: its own height follows the fit.
    const observe = () => {
      resize.disconnect();
      for (const child of Array.from(stack.children)) if (child !== element) resize.observe(child);
    };
    observe();
    const mutation =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            observe();
            update();
          });
    mutation?.observe(stack, { childList: true });
    return () => {
      resize.disconnect();
      mutation?.disconnect();
    };
  }, []);

  // The panel never scrolls: it shows the newest whole cards that fit. A
  // render with every card measures them, then the fit hides the oldest,
  // both before the browser paints.
  const current = present.filter((item) => !item.leaving);
  const fitKey = [
    shown,
    docked,
    width,
    availableHeight ?? "",
    topOffset,
    ...current.map(({ card }) => `${card.id}:${card.title}:${card.state ?? ""}:${card.done}`),
  ].join("|");
  const [fit, setFit] = useState<{ key: string; count: number; maxHeight?: number } | null>(null);
  const measuring = fit?.key !== fitKey;
  const fitted = measuring ? current.length : fit.count;
  useLayoutEffect(() => {
    if (!measuring) return;
    const measured =
      shown && box.current && list.current
        ? measureFit(box.current, list.current, availableHeight)
        : null;
    setFit({
      key: fitKey,
      count: measured?.count ?? current.length,
      maxHeight: measured?.maxHeight,
    });
  }, [measuring, fitKey, shown, availableHeight, current.length]);
  const trimmed = new Set(
    current.slice(0, Math.max(0, current.length - fitted)).map(({ card }) => card.id),
  );

  const waiting = cards.filter((card) => card.kind !== "topic" && !card.done).length;
  return (
    <div
      ref={root}
      className="pointer-events-auto max-w-full shrink-0"
      style={{ order: 3, width: shown ? `${width}rem` : "fit-content", position: "relative" }}
      onPointerEnter={(event) => {
        if (docked || event.pointerType === "touch") return;
        pointer.current = true;
        suppressed.current = false;
        open();
      }}
      onPointerLeave={(event) => {
        if (docked || event.pointerType === "touch") return;
        pointer.current = false;
        suppressed.current = false;
        leave();
      }}
      onFocus={open}
      onBlur={(event) => {
        if (docked) return;
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          suppressed.current = false;
          leave();
        }
      }}
      onKeyDown={(event) => {
        if (docked || event.key !== "Escape") return;
        event.stopPropagation();
        cancel();
        suppressed.current = true;
        setExpanded(false);
      }}
    >
      {(!docked || !shown) && (
        <button
          ref={icon}
          type="button"
          aria-label={`Actions, ${waiting} waiting`}
          aria-expanded={shown}
          className="ml-auto flex h-8 items-center gap-1 rounded-full border border-border bg-panel-surface px-2 shadow-lg focus-hairline"
          onPointerDown={(event) => {
            touch.current = event.pointerType === "touch";
            if (touch.current && !docked) suppressed.current = true;
          }}
          onClick={() => {
            cancel();
            if (docked) {
              focusAfter.current = "header";
              setCoordinatorActionsDockedOpen(true);
            } else if (touch.current) {
              setExpanded((value) => !value);
              suppressed.current = false;
            } else setExpanded(true);
          }}
        >
          <ListTodo className="size-4" />
          <span className="text-xs">{waiting}</span>
        </button>
      )}
      <section
        aria-label="Actions"
        aria-hidden={!shown}
        className={cn(
          "grid origin-top-right transition-[grid-template-rows,opacity,transform] duration-150 motion-reduce:transition-none",
          shown
            ? "grid-rows-[1fr] scale-100 opacity-100"
            : "pointer-events-none grid-rows-[0fr] scale-95 opacity-0",
        )}
        style={{
          width: `${width}rem`,
          maxWidth: shown ? "100%" : undefined,
          position: shown ? "relative" : "absolute",
          right: 0,
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            ref={box}
            data-actions-panel-box=""
            className="mt-1 overflow-hidden rounded-xl border border-border bg-panel-surface/95 p-2 shadow-xl backdrop-blur-sm"
            style={{ maxHeight: fit?.maxHeight }}
          >
            <h2 className="text-xs font-medium text-muted-foreground">
              <button
                ref={header}
                type="button"
                aria-label="Collapse actions"
                aria-expanded={shown}
                tabIndex={shown ? 0 : -1}
                onClick={collapse}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-elevated hover:text-foreground focus-hairline"
              >
                <span className="flex-1">Actions</span>
                <span>{waiting} waiting</span>
                <Minus className="size-3.5 shrink-0" aria-hidden="true" />
              </button>
            </h2>
            {cards.length === 0 && (
              <p className="p-2 text-xs text-muted-foreground">No actions here yet.</p>
            )}
            <ol ref={list} className="flex flex-col gap-1">
              {present.map(({ card, leaving }) => {
                const Icon = card.done
                  ? Check
                  : card.kind === "topic"
                    ? Tag
                    : card.kind === "pr"
                      ? GitPullRequest
                      : MessageCircle;
                return (
                  <li
                    key={card.id}
                    hidden={trimmed.has(card.id) || undefined}
                    data-leaving={leaving || undefined}
                    aria-hidden={leaving || undefined}
                    className={cn(
                      "grid transition-[grid-template-rows,opacity,transform] duration-150 motion-reduce:transition-none",
                      leaving
                        ? "grid-rows-[0fr] translate-y-2 opacity-0"
                        : "grid-rows-[1fr] opacity-100 animate-in fade-in slide-in-from-bottom-1 motion-reduce:animate-none",
                    )}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <button
                        type="button"
                        tabIndex={shown && !leaving ? 0 : -1}
                        onClick={() => onNavigate(card.anchorId)}
                        className={cn(
                          "flex w-full gap-2 rounded-lg border border-border p-2 text-left text-xs hover:bg-elevated focus-hairline",
                          card.done && "text-muted-foreground opacity-60",
                        )}
                        aria-label={`${card.done ? "Done: " : ""}${card.title}`}
                      >
                        <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="line-clamp-2">{card.title}</span>
                          <span className="mt-0.5 block text-[10px] text-muted-foreground">
                            {card.done
                              ? "Done"
                              : (card.state ??
                                (card.kind === "topic" ? "Topic" : "Awaiting answer"))}
                          </span>
                        </span>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * How many of `heights` (oldest first) fit in `budget` px with `gap` px
 * between them, keeping the newest.
 */
export function fitNewestCards(heights: readonly number[], gap: number, budget: number): number {
  let used = 0;
  let count = 0;
  for (let index = heights.length - 1; index >= 0; index -= 1) {
    const next = used + (count > 0 ? gap : 0) + heights[index]!;
    if (next > budget) break;
    used = next;
    count += 1;
  }
  return count;
}

function px(value: string): number {
  return Number.parseFloat(value) || 0;
}

/** Measures a render that holds every current card. */
function measureFit(
  box: HTMLElement,
  list: HTMLOListElement,
  availableHeight: number | undefined,
): { count: number; maxHeight: number } | null {
  // Rendered in place, outside a measured stack, nothing limits the height.
  const stack = box.closest<HTMLElement>("[data-floating-notice-stack]");
  if (!stack || availableHeight === undefined) return null;
  const top = box.getBoundingClientRect().top - stack.getBoundingClientRect().top + stack.scrollTop;
  const limit = Math.max(0, Math.floor(availableHeight - top));
  const style = getComputedStyle(box);
  const chrome =
    px(style.paddingTop) +
    px(style.paddingBottom) +
    px(style.borderTopWidth) +
    px(style.borderBottomWidth) +
    Array.from(box.children)
      .filter((child) => child !== list)
      .reduce((sum, child) => sum + (child as HTMLElement).offsetHeight, 0);
  const heights = Array.from(list.children)
    .filter((item) => !(item as HTMLElement).dataset.leaving)
    .map((item) => (item as HTMLElement).offsetHeight);
  // Rounding in the measured heights must never leave a sliver of a card.
  const count = fitNewestCards(heights, px(getComputedStyle(list).rowGap), limit - chrome - 1);
  return { count, maxHeight: limit };
}
