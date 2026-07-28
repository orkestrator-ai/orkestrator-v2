import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface AgentChatFindMatch {
  itemIndex: number;
  characterIndex: number;
  occurrenceIndex: number;
}

interface UseAgentChatFindOptions<TItem> {
  items: TItem[];
  getSearchText: (item: TItem) => string;
  isActive: boolean;
  ownerRef: RefObject<HTMLElement | null>;
  onNavigate: (match: AgentChatFindMatch) => void;
}

interface AgentChatFindBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  isOpen: boolean;
  currentMatchIndex: number;
  matchCount: number;
  onQueryChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onInputKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}

/**
 * Finds non-overlapping, case-insensitive occurrences in transcript order.
 *
 * The list is intentionally derived from the message model instead of mounted
 * DOM: react-virtuoso only renders the viewport, while Cmd/Ctrl+F must search
 * the complete chat history.
 */
export function findAgentChatMatches(
  searchTexts: readonly string[],
  query: string,
): AgentChatFindMatch[] {
  if (!query.trim()) return [];
  const normalizedQuery = query.toLocaleLowerCase();

  const matches: AgentChatFindMatch[] = [];
  searchTexts.forEach((searchText, itemIndex) => {
    const normalizedText = searchText.toLocaleLowerCase();
    let fromIndex = 0;
    let occurrenceIndex = 0;

    while (fromIndex <= normalizedText.length - normalizedQuery.length) {
      const characterIndex = normalizedText.indexOf(normalizedQuery, fromIndex);
      if (characterIndex === -1) break;

      matches.push({ itemIndex, characterIndex, occurrenceIndex });
      occurrenceIndex += 1;
      fromIndex = characterIndex + normalizedQuery.length;
    }
  });

  return matches;
}

export function useAgentChatFind<TItem>({
  items,
  getSearchText,
  isActive,
  ownerRef,
  onNavigate,
}: UseAgentChatFindOptions<TItem>) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const matches = useMemo(
    () => (
      isActive && query.trim()
        ? findAgentChatMatches(items.map((item) => getSearchText(item)), query)
        : []
    ),
    [getSearchText, isActive, items, query],
  );
  const normalizedCurrentMatchIndex =
    matches.length === 0 ? -1 : Math.min(currentMatchIndex, matches.length - 1);
  const currentMatch =
    normalizedCurrentMatchIndex >= 0 ? matches[normalizedCurrentMatchIndex] : null;

  const open = useCallback(() => {
    if (!isOpen) {
      previousFocusRef.current =
        ownerRef.current?.ownerDocument.activeElement instanceof HTMLElement
          ? ownerRef.current.ownerDocument.activeElement
          : null;
      setIsOpen(true);
      return;
    }

    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isOpen, ownerRef]);

  const close = useCallback(() => {
    setIsOpen(false);
    previousFocusRef.current?.focus();
  }, []);

  const move = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      setCurrentMatchIndex((current) => {
        const normalized = Math.min(current, matches.length - 1);
        return (normalized + direction + matches.length) % matches.length;
      });
    },
    [matches.length],
  );

  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isOpen]);

  useEffect(() => {
    if (!isActive || !isOpen || !currentMatch) return;
    onNavigate(currentMatch);
  }, [currentMatch, isActive, isOpen, onNavigate]);

  useEffect(() => {
    if (!isActive) return;

    const ownerDocument = ownerRef.current?.ownerDocument ?? document;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        (event.key.toLocaleLowerCase() === "f" || event.code === "KeyF")
        && (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        open();
        return;
      }

      if (event.key === "Escape" && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };

    ownerDocument.addEventListener("keydown", handleKeyDown);
    return () => ownerDocument.removeEventListener("keydown", handleKeyDown);
  }, [close, isActive, isOpen, open, ownerRef]);

  const onQueryChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    setCurrentMatchIndex(0);
  }, []);

  const onInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
      }
    },
    [move],
  );

  return {
    inputRef,
    isOpen,
    query,
    matches,
    currentMatch,
    currentMatchIndex: normalizedCurrentMatchIndex,
    onQueryChange,
    onInputKeyDown,
    onPrevious: () => move(-1),
    onNext: () => move(1),
    onClose: close,
  };
}

export function AgentChatFindBar({
  inputRef,
  query,
  isOpen,
  currentMatchIndex,
  matchCount,
  onQueryChange,
  onInputKeyDown,
  onPrevious,
  onNext,
  onClose,
}: AgentChatFindBarProps) {
  if (!isOpen) return null;

  const resultLabel = query.trim()
    ? matchCount > 0
      ? `${currentMatchIndex + 1} of ${matchCount}`
      : "No results"
    : "";

  return (
    <>
      {/*
        Vite's current CSS optimizer warns on Chromium's supported
        `::highlight()` pseudo-element. Keeping these two rules runtime-local
        avoids a misleading production-build warning.
      */}
      <style>{`
        ::highlight(agent-chat-find-match) {
          color: inherit;
          background-color: rgb(250 204 21 / 0.32);
        }
        ::highlight(agent-chat-find-current) {
          color: inherit;
          background-color: rgb(251 146 60 / 0.78);
        }
      `}</style>
      <div
        role="search"
        aria-label="Find in agent chat"
        className="absolute top-2 right-2 z-30 flex h-10 w-[min(22rem,calc(100%-1rem))] items-center gap-1 rounded-lg border border-border bg-popover/95 p-1 shadow-xl backdrop-blur-sm"
      >
        <Search className="ml-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={onQueryChange}
          onKeyDown={onInputKeyDown}
          placeholder="Find in chat"
          aria-label="Find in chat"
          autoComplete="off"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 border-0 px-1.5 text-sm shadow-none focus-visible:ring-0"
        />
        <span
          aria-live="polite"
          className="min-w-[4.5rem] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"
        >
          {resultLabel}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onPrevious}
          disabled={matchCount === 0}
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          className="h-7 w-7"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onNext}
          disabled={matchCount === 0}
          aria-label="Next match"
          title="Next match (Enter)"
          className="h-7 w-7"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close find"
          title="Close (Escape)"
          className="h-7 w-7"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </>
  );
}
