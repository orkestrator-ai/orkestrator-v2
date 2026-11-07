import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  artifactSearchBodyRevision,
  subscribeArtifactSearchBodies,
} from "@/lib/chat/artifact-requests";
import { registerProtectedRichCache } from "@/lib/chat/rich-content-reset";
import { useRichTranscriptScope } from "@/lib/chat/rich-identity";
import type { SearchProjection } from "@/lib/chat/rich-markdown/search-segments";
import {
  resolveFindSelection,
  selectionOfMatch,
  type AgentChatFindSelection,
} from "./agent-chat-find-selection";
import { AgentChatSearchIndex } from "./agent-chat-search-index";

export interface AgentChatFindMatch {
  itemIndex: number;
  characterIndex: number;
  occurrenceIndex: number;
}

export interface AgentChatTextMatch {
  characterIndex: number;
  length: number;
}

interface UseAgentChatFindOptions<TItem> {
  items: TItem[];
  getSearchText: (item: TItem) => string;
  /** Names a match by its source in the row, so text arriving before it cannot move it. */
  getSearchProjection?: (item: TItem) => SearchProjection;
  isActive: boolean;
  ownerRef: RefObject<HTMLElement | null>;
  /** Called once per selected match; recomputing around a selection is not a navigation. */
  onNavigate: (match: AgentChatFindMatch, query: string) => void;
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
  matchHighlightName: string;
  currentHighlightName: string;
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

  const matches: AgentChatFindMatch[] = [];
  searchTexts.forEach((searchText, itemIndex) => {
    let occurrenceIndex = 0;
    for (const { characterIndex } of findAgentChatTextMatches(searchText, query)) {
      matches.push({ itemIndex, characterIndex, occurrenceIndex });
      occurrenceIndex += 1;
    }
  });

  return matches;
}

/**
 * Finds literal, non-overlapping matches while preserving offsets from the
 * original UTF-16 string. Unlike indexing into a lowercased copy, these offsets
 * remain valid DOM Range boundaries when Unicode case folding changes length.
 */
export function findAgentChatTextMatches(searchText: string, query: string): AgentChatTextMatch[] {
  if (!query.trim()) return [];

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(escapedQuery, "giu");
  const matches: AgentChatTextMatch[] = [];

  for (const match of searchText.matchAll(expression)) {
    if (match.index === undefined || match[0].length === 0) continue;
    matches.push({
      characterIndex: match.index,
      length: match[0].length,
    });
  }

  return matches;
}

const NO_BODY_SUBSCRIPTION = () => () => {};
const NO_BODY_REVISION = () => 0;

export function useAgentChatFind<TItem>({
  items,
  getSearchText,
  getSearchProjection,
  isActive,
  ownerRef,
  onNavigate,
}: UseAgentChatFindOptions<TItem>) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<AgentChatFindSelection | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [searchIndex] = useState(() => new AgentChatSearchIndex<TItem>());
  const searching = isActive && isOpen;
  // A closed bar stays out of this: a card publishing its body must not re-render
  // the transcript around it.
  const bodyRevision = useSyncExternalStore(
    searching ? subscribeArtifactSearchBodies : NO_BODY_SUBSCRIPTION,
    searching ? artifactSearchBodyRevision : NO_BODY_REVISION,
  );

  const matches = useMemo(
    () =>
      searching && query.trim()
        ? findAgentChatMatches(searchIndex.texts(items, getSearchText, bodyRevision), query)
        : [],
    [bodyRevision, getSearchText, items, query, searchIndex, searching],
  );

  useEffect(() => {
    if (!searching) searchIndex.clear();
  }, [searchIndex, searching]);

  // The index holds message text: cleared with other protected rich content.
  // It is one transcript's, so a clear of another node leaves it; a transcript
  // that does not know its node yet is cleared by any node's clear.
  const searchIndexCacheId = useId();
  const transcriptBackendId = useRichTranscriptScope()?.backendId ?? null;
  useEffect(
    () =>
      registerProtectedRichCache(`agent-chat-find:${searchIndexCacheId}`, {
        clearAll: () => searchIndex.clear(),
        clearBackend: (nodeId) => {
          if (transcriptBackendId === null || transcriptBackendId === nodeId) searchIndex.clear();
        },
      }),
    [searchIndex, searchIndexCacheId, transcriptBackendId],
  );
  const resolved = useMemo(
    () => resolveFindSelection(selection, matches, items, getSearchProjection),
    [getSearchProjection, items, matches, selection],
  );
  if (resolved.selection !== selection) setSelection(resolved.selection);
  const normalizedCurrentMatchIndex = resolved.index;
  const currentMatch =
    normalizedCurrentMatchIndex >= 0 ? matches[normalizedCurrentMatchIndex] : null;
  const selectionIdentity = resolved.selection
    ? JSON.stringify([
        query,
        resolved.selection.key,
        resolved.selection.root,
        resolved.selection.offset,
      ])
    : null;

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
      const next = (normalizedCurrentMatchIndex + direction + matches.length) % matches.length;
      setSelection(selectionOfMatch(matches[next]!, next, items, getSearchProjection));
    },
    [getSearchProjection, items, matches, normalizedCurrentMatchIndex],
  );

  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isOpen]);

  // Matches are recomputed whenever the rows or a body change (every streaming
  // update while find is open); only a different selection is a navigation.
  // Going back to the same one would pull a reader who scrolled away back to it.
  const navigatedRef = useRef<string | null>(null);
  useEffect(() => {
    // Clearing the query starts a new search even if it returns to the same match.
    if (!isOpen || !query.trim()) navigatedRef.current = null;
    if (!isActive || !isOpen || !currentMatch || selectionIdentity === navigatedRef.current) return;
    navigatedRef.current = selectionIdentity;
    onNavigate(currentMatch, query);
  }, [currentMatch, isActive, isOpen, onNavigate, query, selectionIdentity]);

  useEffect(() => {
    if (!isActive) return;

    const ownerDocument = ownerRef.current?.ownerDocument ?? document;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        (event.key.toLocaleLowerCase() === "f" || event.code === "KeyF") &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
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
    setSelection(null);
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
  matchHighlightName,
  currentHighlightName,
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
        ::highlight(${matchHighlightName}) {
          color: inherit;
          background-color: rgb(250 204 21 / 0.32);
        }
        ::highlight(${currentHighlightName}) {
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
          className="h-8 min-w-0 flex-1 border-0 px-1.5 text-sm shadow-none focus-visible:outline-none"
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
