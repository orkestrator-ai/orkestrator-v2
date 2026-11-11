import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { formatCompactRelativeTime } from "@/lib/format-relative-time";
import { cn } from "@/lib/utils";
import type { CoordinatorActionCard } from "./coordinator-action-cards";
import {
  COORDINATOR_ACTION_KIND_LABELS,
  coordinatorActionIcon,
  coordinatorActionStatus,
  searchCoordinatorActions,
} from "./coordinator-action-search";

/**
 * The Actions panel's search palette, styled and driven like the ⌘K project
 * search: the input is focused on open, arrows move the selection, Enter
 * picks it and Escape closes. It searches every action in the conversation,
 * including those whose messages are not loaded.
 */
export function CoordinatorActionSearchDialog({
  open,
  cards,
  now,
  onSelect,
  onClose,
  onCloseAutoFocus,
}: {
  open: boolean;
  /** Every action, oldest first, history included. */
  cards: readonly CoordinatorActionCard[];
  /** Ages are read against this moment, when the palette opened. */
  now: Date;
  onSelect: (card: CoordinatorActionCard) => void;
  onClose: () => void;
  /** Where focus goes once the dialog has closed (prevent the default to place it). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const optionPrefix = useId();

  // Closing clears the search; a new query moves the selection to the newest hit.
  const [scope, setScope] = useState({ open, query });
  if (scope.open !== open || scope.query !== query) {
    setScope({ open, query });
    setSelectedId(null);
    if (!open) setQuery("");
  }

  const hits = useMemo(
    () => (open ? searchCoordinatorActions(cards, query) : []),
    [open, cards, query],
  );
  const selected = hits.find((card) => card.id === selectedId) ?? hits[0];
  const optionId = (position: number) => `${optionPrefix}-${position}`;

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected?.id]);

  const moveSelection = (delta: number) => {
    if (hits.length === 0) return;
    const current = selected ? hits.indexOf(selected) : 0;
    const next = Math.max(0, Math.min(current + delta, hits.length - 1));
    setSelectedId(hits[next]?.id ?? null);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // While an IME is composing, Enter confirms a candidate and the arrows
    // move through candidates; they belong to the IME, not the palette.
    // WebKit ends the composition before the confirming keydown, so
    // `isComposing` is already false there and `keyCode` 229 is the signal.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter") {
      if (!selected) return;
      event.preventDefault();
      onSelect(selected);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        data-testid="coordinator-action-search-dialog"
        size="2xl"
        overlayClassName="z-[90]"
        className="z-[90] gap-0 overflow-hidden p-0 sm:p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogTitle className="sr-only">Search actions</DialogTitle>
        <DialogDescription className="sr-only">
          Search this conversation's topics, questions and pull requests, including older ones.
        </DialogDescription>

        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={selected ? optionId(hits.indexOf(selected)) : undefined}
            aria-autocomplete="list"
            aria-label="Search actions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search topics, questions, pull requests..."
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 tabular-nums text-[11px] text-zinc-500">
            {hits.length} of {cards.length}
          </span>
        </div>

        <div
          id={listId}
          role="listbox"
          aria-label="Actions"
          className="max-h-[28rem] overflow-y-auto px-2 py-2"
        >
          {hits.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              {cards.length === 0
                ? "No actions in this conversation yet."
                : "No actions match that search."}
            </div>
          ) : (
            <div className="space-y-0.5">
              {hits.map((card, position) => {
                const Icon = coordinatorActionIcon(card);
                const active = card.id === selected?.id;
                const age = formatCompactRelativeTime(card.createdAt, now);
                const status = coordinatorActionStatus(card);
                return (
                  <button
                    key={card.id}
                    ref={
                      active
                        ? (node) => {
                            selectedRef.current = node;
                          }
                        : undefined
                    }
                    type="button"
                    id={optionId(position)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={active}
                    aria-label={`${card.done ? "Done: " : ""}${card.title}`}
                    onMouseEnter={() => setSelectedId(card.id)}
                    onClick={() => onSelect(card)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                      active ? "bg-zinc-800 text-foreground" : "text-zinc-200 hover:bg-zinc-800/70",
                      card.done && "text-muted-foreground",
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        card.done ? "text-zinc-500" : "text-zinc-400",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{card.title}</span>
                    <span className="hidden shrink-0 items-center gap-2 text-[11px] text-zinc-500 sm:flex">
                      {age ? <span className="tabular-nums">{age}</span> : null}
                      <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-zinc-400">
                        {COORDINATOR_ACTION_KIND_LABELS[card.kind]}
                      </span>
                    </span>
                    {status !== COORDINATOR_ACTION_KIND_LABELS[card.kind] && (
                      <span
                        className={cn(
                          "shrink-0 rounded-md px-1.5 py-0.5 text-[11px]",
                          card.done ? "text-zinc-500" : "bg-zinc-800/80 text-zinc-400",
                        )}
                      >
                        {status}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-t border-border/70 px-4 py-2 text-[11px] text-zinc-500">
          <ShortcutHint keys="Enter" label="Go to" />
          <ShortcutHint keys="Esc" label="Close" />
          <ShortcutHint keys="↑↓" label="Move" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
