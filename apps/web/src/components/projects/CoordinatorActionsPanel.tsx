import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ListTodo, Minus, RotateCcw, Search } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  FloatingNoticeSlot,
  useClaimFloatingNoticeColumnShift,
} from "@/components/ui/floating-notice";
import type { CoordinatorActionCard } from "./coordinator-action-cards";
import { coordinatorActionIcon, coordinatorActionStatus } from "./coordinator-action-search";
import { CoordinatorActionSearchDialog } from "./CoordinatorActionSearch";
import {
  setCoordinatorActionsDockedOpen,
  useCoordinatorActionsDockedOpen,
} from "./coordinator-actions-preference";
import { cn } from "@/lib/utils";

export function CoordinatorActionsPanel({
  cards,
  searchCards,
  onNavigate,
  onMarkDone,
}: {
  cards: readonly CoordinatorActionCard[];
  /** Every action in the conversation, for search; defaults to `cards`. */
  searchCards?: readonly CoordinatorActionCard[];
  onNavigate: (anchorId: string) => void;
  /** Marks a card done by hand or clears that mark; without it cards have no menu. */
  onMarkDone?: (card: CoordinatorActionCard, done: boolean) => void;
}) {
  return (
    <FloatingNoticeSlot>
      {(layout) => {
        // Where the centred column leaves no room, the panel still docks if
        // moving the column left makes room for it.
        const shift = layout.placement === "beside" ? null : layout.columnShift;
        return (
          <ActionsPanel
            cards={cards}
            searchCards={searchCards}
            onNavigate={onNavigate}
            onMarkDone={onMarkDone}
            docked={layout.placement === "beside" || shift !== null}
            shiftsColumn={shift !== null}
            width={shift?.cardRem ?? layout.cardRem}
            availableHeight={layout.heightPx}
          />
        );
      }}
    </FloatingNoticeSlot>
  );
}

export function ActionsPanel({
  cards,
  searchCards = cards,
  onNavigate,
  onMarkDone,
  docked,
  shiftsColumn = false,
  width = 18,
  availableHeight,
}: {
  cards: readonly CoordinatorActionCard[];
  /**
   * Every action in the conversation, older and unloaded ones included. The
   * panel shows only the newest few; search covers all of these.
   */
  searchCards?: readonly CoordinatorActionCard[];
  onNavigate: (anchorId: string) => void;
  /**
   * Marks a card done by hand (`true`) or clears that mark (`false`). When
   * present, every card opens a context menu (right-click, the context-menu
   * key or Shift+F10) offering "Mark done", or "Mark not done" on a card only
   * the user marked.
   */
  onMarkDone?: (card: CoordinatorActionCard, done: boolean) => void;
  /** Room to dock beside the column: the panel stays open until its header folds it. */
  docked: boolean;
  /**
   * The room to dock exists only once the column moves left, so the open
   * panel moves it there and folding the panel lets it slide back.
   */
  shiftsColumn?: boolean;
  width?: number;
  /** The notice stack's height in px, from its top to the pane's bottom margin. */
  availableHeight?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  // The search palette holds a narrow overlay open behind it, so closing it
  // can hand focus back to the button that opened it.
  const [searching, setSearching] = useState(false);
  const searchOrigin = useRef<HTMLButtonElement | null>(null);
  const searchChose = useRef(false);
  const [searchedAt, setSearchedAt] = useState(() => new Date());
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
  /** A card's context menu is open: it renders outside the panel, which must stay open. */
  const menuOpen = useRef(false);
  const suppressed = useRef(false);
  const touch = useRef(false);
  // The header and the icon replace each other as the control, so focus
  // follows whichever one a toggle leaves in place.
  const focusAfter = useRef<"icon" | "header" | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useLayoutEffect(() => {
    pointer.current = false;
    suppressed.current = false;
    touch.current = false;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, [docked]);
  const open = () => {
    cancel();
    if (!docked && !suppressed.current) setExpanded(true);
  };
  const leave = () => {
    cancel();
    timer.current = setTimeout(() => {
      if (!pointer.current && !menuOpen.current && !root.current?.contains(document.activeElement))
        setExpanded(false);
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
    if (docked || !expanded || searching) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      suppressed.current = true;
      setExpanded(false);
    };
    // A click or tap anywhere but the overlay and its icon folds it at once.
    const outside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node | null)) return;
      // A card's menu is portalled outside the panel; choosing from it is not leaving.
      if (
        menuOpen.current ||
        (event.target instanceof Element && event.target.closest(ACTION_MENU_SELECTOR))
      )
        return;
      cancel();
      setExpanded(false);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [docked, expanded, searching]);
  const shown = docked ? dockedOpen : expanded || searching;
  useClaimFloatingNoticeColumnShift(docked && shiftsColumn && shown);
  useLayoutEffect(() => {
    // Shared preference updates and resizing can hide a focused card too.
    if (!shown && box.current?.contains(document.activeElement)) {
      suppressed.current = true;
      focusAfter.current = "icon";
    }
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
    update();
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

  const openSearch = (button: HTMLButtonElement) => {
    cancel();
    searchOrigin.current = button;
    searchChose.current = false;
    setSearchedAt(new Date());
    setSearching(true);
  };
  const closeSearch = () => {
    setSearching(false);
    if (docked) return;
    // Dismissed: the overlay stays open around the button focus returns to.
    suppressed.current = false;
    setExpanded(true);
  };
  const chooseAction = (card: CoordinatorActionCard) => {
    searchChose.current = true;
    setSearching(false);
    if (!docked) {
      // Chosen: the overlay folds so the conversation it moves to is in view,
      // and stays folded until the pointer or focus leaves it.
      suppressed.current = true;
      setExpanded(false);
    }
    onNavigate(card.anchorId);
  };
  const searchButton = (placement: "header" | "folded") => (
    <button
      type="button"
      aria-label="Search actions"
      aria-haspopup="dialog"
      tabIndex={placement === "header" && !shown ? -1 : 0}
      onClick={(event) => openSearch(event.currentTarget)}
      className={cn(
        "flex shrink-0 items-center justify-center focus-hairline",
        placement === "header"
          ? "size-6 rounded-md text-muted-foreground hover:bg-elevated hover:text-foreground"
          : "size-8 rounded-full border border-border bg-panel-surface shadow-lg hover:bg-elevated",
      )}
    >
      <Search className={placement === "header" ? "size-3.5" : "size-4"} aria-hidden="true" />
    </button>
  );

  const waiting = cards.filter((card) => card.kind !== "topic" && !card.done).length;
  return (
    <>
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
          <div className="ml-auto flex w-fit items-center gap-1">
            {/* Docked and folded, nothing expands on hover, so search sits beside the icon. */}
            {docked && searchButton("folded")}
            <button
              ref={icon}
              type="button"
              aria-label={`Actions, ${waiting} waiting`}
              aria-expanded={shown}
              className="flex h-8 items-center gap-1 rounded-full border border-border bg-panel-surface px-2 shadow-lg focus-hairline"
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
          </div>
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
              {/* The search button sits in the header row, beside the fold control. */}
              <h2 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <button
                  ref={header}
                  type="button"
                  aria-label="Collapse actions"
                  aria-expanded={shown}
                  tabIndex={shown ? 0 : -1}
                  onClick={collapse}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-elevated hover:text-foreground focus-hairline"
                >
                  <span className="flex-1">Actions</span>
                  <span>{waiting} waiting</span>
                  <Minus className="size-3.5 shrink-0" aria-hidden="true" />
                </button>
                {searchButton("header")}
              </h2>
              {cards.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground">No actions here yet.</p>
              )}
              <ol ref={list} className="flex flex-col gap-1">
                {present.map(({ card, leaving }) => {
                  const Icon = coordinatorActionIcon(card);
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
                        <ActionCardButton
                          card={card}
                          Icon={Icon}
                          focusable={shown && !leaving}
                          onNavigate={onNavigate}
                          onMarkDone={leaving ? undefined : onMarkDone}
                          onMenuOpenChange={(open) => {
                            menuOpen.current = open;
                            if (!open) leave();
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </section>
      </div>
      <CoordinatorActionSearchDialog
        open={searching}
        cards={searchCards}
        now={searchedAt}
        onSelect={chooseAction}
        onClose={closeSearch}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // A dismissal returns to the button that opened the palette. After a
          // choice the narrow overlay has folded, so its icon takes focus.
          const target =
            searchChose.current && !docked ? icon.current : (searchOrigin.current ?? icon.current);
          (target?.isConnected ? target : (header.current ?? icon.current))?.focus();
        }}
      />
    </>
  );
}

const ACTION_MENU_SELECTOR = "[data-coordinator-action-menu]";

/**
 * One action card. With `onMarkDone` it carries the card's context menu: "Mark
 * done" on an open card, "Mark not done" on a card only the user marked, and a
 * disabled note on a card the conversation itself finished (a manual mark
 * cannot reopen it). The menu opens from the pointer, the context-menu key or
 * Shift+F10, and gives focus back to the card when it closes.
 */
function ActionCardButton({
  card,
  Icon,
  focusable,
  onNavigate,
  onMarkDone,
  onMenuOpenChange,
}: {
  card: CoordinatorActionCard;
  Icon: ReturnType<typeof coordinatorActionIcon>;
  focusable: boolean;
  onNavigate: (anchorId: string) => void;
  onMarkDone?: (card: CoordinatorActionCard, done: boolean) => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const element = (
    <button
      ref={button}
      type="button"
      tabIndex={focusable ? 0 : -1}
      onClick={() => onNavigate(card.anchorId)}
      onKeyDown={
        onMarkDone
          ? (event) => {
              if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
              event.preventDefault();
              const { left, bottom } = event.currentTarget.getBoundingClientRect();
              event.currentTarget.dispatchEvent(
                new MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                  clientX: left,
                  clientY: bottom,
                }),
              );
            }
          : undefined
      }
      aria-keyshortcuts={onMarkDone ? "Shift+F10" : undefined}
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
          {coordinatorActionStatus(card)}
        </span>
      </span>
    </button>
  );
  if (!onMarkDone) return element;
  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <ContextMenuTrigger asChild>{element}</ContextMenuTrigger>
      <ContextMenuContent
        data-coordinator-action-menu=""
        aria-label={`Actions for ${card.title}`}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (button.current?.isConnected) button.current.focus({ preventScroll: true });
        }}
      >
        {!card.done ? (
          <ContextMenuItem onSelect={() => onMarkDone(card, true)}>
            <Check aria-hidden="true" />
            Mark done
          </ContextMenuItem>
        ) : card.markedDone ? (
          <ContextMenuItem onSelect={() => onMarkDone(card, false)}>
            <RotateCcw aria-hidden="true" />
            Mark not done
          </ContextMenuItem>
        ) : (
          <ContextMenuItem disabled>Done in the conversation</ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
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
  return { count, maxHeight: Math.max(limit, chrome) };
}
