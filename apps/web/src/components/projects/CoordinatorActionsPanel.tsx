import { useEffect, useRef, useState } from "react";
import { Check, GitPullRequest, ListTodo, MessageCircle, Tag } from "lucide-react";
import { FloatingNoticeSlot } from "@/components/ui/floating-notice";
import type { CoordinatorActionCard } from "./coordinator-action-cards";
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
}: {
  cards: readonly CoordinatorActionCard[];
  onNavigate: (anchorId: string) => void;
  docked: boolean;
  width?: number;
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

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pointer = useRef(false);
  const suppressed = useRef(false);
  const touch = useRef(false);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const open = () => {
    cancel();
    if (!suppressed.current) setExpanded(true);
  };
  const leave = () => {
    cancel();
    timer.current = setTimeout(() => {
      if (!pointer.current && !root.current?.contains(document.activeElement)) setExpanded(false);
    }, 160);
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
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [docked, expanded]);
  const shown = docked || expanded;
  const waiting = cards.filter((card) => card.kind !== "topic" && !card.done).length;
  return (
    <div
      ref={root}
      className="pointer-events-auto max-w-full shrink-0"
      style={{ order: 3 }}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          pointer.current = true;
          suppressed.current = false;
          open();
        }
      }}
      onPointerLeave={() => {
        pointer.current = false;
        suppressed.current = false;
        leave();
      }}
      onFocus={open}
      onBlur={leave}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          cancel();
          suppressed.current = true;
          setExpanded(false);
        }
      }}
    >
      {!docked && (
        <button
          type="button"
          aria-label={`Actions, ${waiting} waiting`}
          aria-expanded={shown}
          className="ml-auto flex h-8 items-center gap-1 rounded-full border border-border bg-panel-surface px-2 shadow-lg focus-hairline"
          onPointerDown={(event) => {
            touch.current = event.pointerType === "touch";
            if (touch.current) suppressed.current = true;
          }}
          onClick={() => {
            cancel();
            if (touch.current) {
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
        style={{ width: `${width}rem`, maxWidth: "100%" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-1 max-h-[min(32rem,var(--floating-notice-height,70vh))] overflow-y-auto rounded-xl border border-border bg-panel-surface/95 p-2 shadow-xl backdrop-blur-sm">
            <h2 className="px-2 py-1 text-xs font-medium text-muted-foreground">
              Actions <span className="float-right">{waiting} waiting</span>
            </h2>
            {cards.length === 0 && (
              <p className="p-2 text-xs text-muted-foreground">No actions here yet.</p>
            )}
            <ol className="space-y-1">
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
