import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { Virtuoso, type VirtuosoHandle, type StateSnapshot } from "react-virtuoso";
import {
  AgentChatFindBar,
  findAgentChatTextMatches,
  useAgentChatFind,
} from "@/components/chat/AgentChatFind";
import { cn } from "@/lib/utils";

interface VirtuosoListContext {
  footer?: ReactNode;
  emptyState?: ReactNode;
}

interface VirtualizedMessageListProps<TMessage> {
  messages: TMessage[];
  computeItemKey: (index: number, message: TMessage) => string;
  renderMessage: (index: number, message: TMessage, previousMessage: TMessage | null) => ReactNode;
  footer?: ReactNode;
  emptyState?: ReactNode;
  scrollProps: {
    followOutput: (isAtBottom: boolean) => "auto" | false;
    atBottomStateChange: (atBottom: boolean) => void;
    atBottomThreshold: number;
    totalListHeightChanged?: (height: number) => void;
    restoreStateFrom: StateSnapshot | undefined;
    scrollerRef?: (el: HTMLElement | Window | null) => void;
  };
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  find?: {
    isActive: boolean;
    getSearchText: (message: TMessage) => string;
  };
}

const EMPTY_SEARCH_TEXT = () => "";
const SEARCH_CONTENT_SELECTOR = "[data-agent-chat-search-content]";

interface TextNodeRun {
  node: Text;
  start: number;
  end: number;
}

function createSearchRanges(root: HTMLElement, query: string): Range[] {
  const runs: TextNodeRun[] = [];
  let combinedText = "";
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentNode = walker.nextNode();

  while (currentNode) {
    if (currentNode instanceof Text && currentNode.data.length > 0) {
      const start = combinedText.length;
      combinedText += currentNode.data;
      runs.push({ node: currentNode, start, end: combinedText.length });
    }
    currentNode = walker.nextNode();
  }

  const boundaryForOffset = (offset: number, isEnd: boolean) => {
    const run = runs.find(({ start, end }) =>
      isEnd ? offset > start && offset <= end : offset >= start && offset < end,
    );
    if (!run) return null;
    return {
      node: run.node,
      offset: offset - run.start,
    };
  };

  const ranges: Range[] = [];
  for (const match of findAgentChatTextMatches(combinedText, query)) {
    const start = boundaryForOffset(match.characterIndex, false);
    const end = boundaryForOffset(match.characterIndex + match.length, true);
    if (!start || !end) continue;

    const range = root.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  return ranges;
}

function FooterWrapper({ children }: { children: ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}

function EmptyPlaceholderWrapper({ children }: { children: ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}

// Stable module-level component references for Virtuoso.
// Dynamic content is passed via Virtuoso's `context` prop instead of closures,
// preventing unmount/remount cycles when the parent re-renders.
// (Inline arrow functions in `components` create new component types each render,
// which destroys local state in children like ClaudeQuestionCard.)
function StableFooter({ context }: { context?: VirtuosoListContext }) {
  if (!context?.footer) return null;
  return <FooterWrapper>{context.footer}</FooterWrapper>;
}

function StableEmptyPlaceholder({ context }: { context?: VirtuosoListContext }) {
  if (!context?.emptyState) return null;
  return <EmptyPlaceholderWrapper>{context.emptyState}</EmptyPlaceholderWrapper>;
}

export function VirtualizedMessageList<TMessage>({
  messages,
  computeItemKey,
  renderMessage,
  footer,
  emptyState,
  scrollProps,
  virtuosoRef,
  find,
}: VirtualizedMessageListProps<TMessage>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const findInstanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const matchHighlightName = `agent-chat-find-match-${findInstanceId}`;
  const currentHighlightName = `agent-chat-find-current-${findInstanceId}`;
  const context = useMemo<VirtuosoListContext>(
    () => ({ footer, emptyState }),
    [footer, emptyState]
  );

  // Only recreate the components object when component presence changes (not content).
  // This keeps component identity stable across re-renders.
  const hasFooter = !!footer;
  const hasEmptyState = !!emptyState;
  const components = useMemo(
    () => ({
      Footer: hasFooter ? StableFooter : undefined,
      EmptyPlaceholder: hasEmptyState ? StableEmptyPlaceholder : undefined,
    }),
    [hasFooter, hasEmptyState]
  );

  const handleFindNavigate = useCallback(
    (match: { itemIndex: number }) => {
      virtuosoRef.current?.scrollToIndex({
        index: match.itemIndex,
        align: "center",
        behavior: "auto",
      });
    },
    [virtuosoRef],
  );
  const chatFind = useAgentChatFind({
    items: messages,
    getSearchText: find?.getSearchText ?? EMPTY_SEARCH_TEXT,
    isActive: find?.isActive ?? false,
    ownerRef: rootRef,
    onNavigate: handleFindNavigate,
  });

  useEffect(() => {
    const cssHighlights =
      typeof CSS !== "undefined"
      && "highlights" in CSS
      && typeof Highlight !== "undefined"
        ? CSS.highlights
        : null;

    const clearHighlights = () => {
      cssHighlights?.delete(matchHighlightName);
      cssHighlights?.delete(currentHighlightName);
    };

    if (
      !cssHighlights
      || !find?.isActive
      || !chatFind.isOpen
      || !chatFind.query.trim()
      || chatFind.matches.length === 0
    ) {
      clearHighlights();
      return clearHighlights;
    }

    let frame = 0;
    let attempts = 0;

    const collectRowRanges = (
      row: HTMLElement,
      activeOccurrenceIndex: number | null,
      expectedMatchCount: number,
    ) => {
      const ranges: Range[] = [];
      let activeRange: Range | null = null;
      let rowOccurrenceIndex = 0;
      const taggedRoots =
        Array.from(row.querySelectorAll<HTMLElement>(SEARCH_CONTENT_SELECTOR));
      const searchableRoots = taggedRoots.length > 0 ? taggedRoots : [row];

      for (const searchableRoot of searchableRoots) {
        for (const range of createSearchRanges(searchableRoot, chatFind.query)) {
          if (rowOccurrenceIndex >= expectedMatchCount) break;
          ranges.push(range);
          if (rowOccurrenceIndex === activeOccurrenceIndex) {
            activeRange = range;
          }
          rowOccurrenceIndex += 1;
        }
      }

      return { ranges, activeRange };
    };

    const applyHighlights = () => {
      const root = rootRef.current;
      if (!root) return;

      const allRanges: Range[] = [];
      let activeRange: Range | null = null;
      const rows = root.querySelectorAll<HTMLElement>("[data-chat-message-index]");
      const matchCountsByItem = new Map<number, number>();
      for (const match of chatFind.matches) {
        matchCountsByItem.set(
          match.itemIndex,
          (matchCountsByItem.get(match.itemIndex) ?? 0) + 1,
        );
      }

      rows.forEach((row) => {
        const itemIndex = Number(row.dataset.chatMessageIndex);
        const activeOccurrenceIndex =
          chatFind.currentMatch?.itemIndex === itemIndex
            ? chatFind.currentMatch.occurrenceIndex
            : null;
        const rowRanges = collectRowRanges(
          row,
          activeOccurrenceIndex,
          matchCountsByItem.get(itemIndex) ?? 0,
        );
        allRanges.push(...rowRanges.ranges);
        activeRange ??= rowRanges.activeRange;
      });

      cssHighlights.set(matchHighlightName, new Highlight(...allRanges));
      cssHighlights.set(
        currentHighlightName,
        new Highlight(...(activeRange ? [activeRange] : [])),
      );

      // Virtuoso may need more than one paint to materialize a distant row.
      if (!activeRange && attempts < 5) {
        attempts += 1;
        frame = requestAnimationFrame(applyHighlights);
      }
    };

    frame = requestAnimationFrame(applyHighlights);
    return () => {
      cancelAnimationFrame(frame);
      clearHighlights();
    };
  }, [
    chatFind.currentMatch,
    chatFind.isOpen,
    chatFind.matches.length,
    chatFind.query,
    find?.isActive,
    currentHighlightName,
    matchHighlightName,
    messages,
  ]);

  return (
    <div ref={rootRef} className="relative min-h-0 flex-1">
      <AgentChatFindBar
        inputRef={chatFind.inputRef}
        query={chatFind.query}
        isOpen={chatFind.isOpen}
        currentMatchIndex={chatFind.currentMatchIndex}
        matchCount={chatFind.matches.length}
        onQueryChange={chatFind.onQueryChange}
        onInputKeyDown={chatFind.onInputKeyDown}
        onPrevious={chatFind.onPrevious}
        onNext={chatFind.onNext}
        onClose={chatFind.onClose}
        matchHighlightName={matchHighlightName}
        currentHighlightName={currentHighlightName}
      />
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        context={context}
        computeItemKey={computeItemKey}
        itemContent={(index, data) => {
          const isCurrentFindMessage =
            chatFind.isOpen
            && chatFind.currentMatch?.itemIndex === index;
          return (
            <div
              data-chat-message-index={index}
              className={cn(
                "rounded-sm",
                isCurrentFindMessage
                  && "outline outline-1 outline-offset-[-1px] outline-amber-400/35",
              )}
            >
              {renderMessage(
                index,
                data,
                index > 0 ? messages[index - 1] ?? null : null,
              )}
            </div>
          );
        }}
        components={components}
        followOutput={scrollProps.followOutput}
        atBottomStateChange={scrollProps.atBottomStateChange}
        atBottomThreshold={scrollProps.atBottomThreshold}
        totalListHeightChanged={scrollProps.totalListHeightChanged}
        restoreStateFrom={scrollProps.restoreStateFrom}
        scrollerRef={scrollProps.scrollerRef}
        increaseViewportBy={{ top: 400, bottom: 200 }}
        style={{ height: "100%" }}
        className="py-4"
      />
    </div>
  );
}
