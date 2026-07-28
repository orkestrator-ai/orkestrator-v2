import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { Virtuoso, type VirtuosoHandle, type StateSnapshot } from "react-virtuoso";
import {
  AgentChatFindBar,
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
      cssHighlights?.delete("agent-chat-find-match");
      cssHighlights?.delete("agent-chat-find-current");
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
    const normalizedQuery = chatFind.query.toLocaleLowerCase();

    const collectRowRanges = (
      row: HTMLElement,
      activeOccurrenceIndex: number | null,
    ) => {
      const ranges: Range[] = [];
      let activeRange: Range | null = null;
      let rowOccurrenceIndex = 0;
      const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();

      while (textNode) {
        const text = textNode.textContent ?? "";
        const normalizedText = text.toLocaleLowerCase();
        let fromIndex = 0;

        while (fromIndex <= normalizedText.length - normalizedQuery.length) {
          const characterIndex = normalizedText.indexOf(normalizedQuery, fromIndex);
          if (characterIndex === -1) break;

          const range = row.ownerDocument.createRange();
          range.setStart(textNode, characterIndex);
          range.setEnd(textNode, characterIndex + normalizedQuery.length);
          ranges.push(range);
          if (rowOccurrenceIndex === activeOccurrenceIndex) {
            activeRange = range;
          }
          rowOccurrenceIndex += 1;
          fromIndex = characterIndex + normalizedQuery.length;
        }

        textNode = walker.nextNode();
      }

      return { ranges, activeRange };
    };

    const applyHighlights = () => {
      const root = rootRef.current;
      if (!root) return;

      const allRanges: Range[] = [];
      let activeRange: Range | null = null;
      const rows = root.querySelectorAll<HTMLElement>("[data-chat-message-index]");

      rows.forEach((row) => {
        const itemIndex = Number(row.dataset.chatMessageIndex);
        const activeOccurrenceIndex =
          chatFind.currentMatch?.itemIndex === itemIndex
            ? chatFind.currentMatch.occurrenceIndex
            : null;
        const rowRanges = collectRowRanges(row, activeOccurrenceIndex);
        allRanges.push(...rowRanges.ranges);
        activeRange ??= rowRanges.activeRange;
      });

      cssHighlights.set("agent-chat-find-match", new Highlight(...allRanges));
      cssHighlights.set(
        "agent-chat-find-current",
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
