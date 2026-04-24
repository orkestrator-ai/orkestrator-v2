import { type ReactNode, type RefObject, useMemo } from "react";
import { Virtuoso, type VirtuosoHandle, type StateSnapshot } from "react-virtuoso";

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
    followOutput: (isAtBottom: boolean) => "smooth" | false;
    atBottomStateChange: (atBottom: boolean) => void;
    atBottomThreshold: number;
    restoreStateFrom: StateSnapshot | undefined;
    scrollerRef?: (el: HTMLElement | Window | null) => void;
  };
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}

function FooterWrapper({ children }: { children: ReactNode }) {
  return <div className="min-w-[320px]">{children}</div>;
}

function EmptyPlaceholderWrapper({ children }: { children: ReactNode }) {
  return <div className="min-w-[320px]">{children}</div>;
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
}: VirtualizedMessageListProps<TMessage>) {
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

  return (
    <div className="flex-1 min-h-0">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        context={context}
        computeItemKey={computeItemKey}
        itemContent={(index, data) =>
          renderMessage(index, data, index > 0 ? messages[index - 1] ?? null : null)
        }
        components={components}
        followOutput={scrollProps.followOutput}
        atBottomStateChange={scrollProps.atBottomStateChange}
        atBottomThreshold={scrollProps.atBottomThreshold}
        restoreStateFrom={scrollProps.restoreStateFrom}
        scrollerRef={scrollProps.scrollerRef}
        increaseViewportBy={{ top: 400, bottom: 200 }}
        style={{ height: "100%" }}
        className="py-4"
      />
    </div>
  );
}
