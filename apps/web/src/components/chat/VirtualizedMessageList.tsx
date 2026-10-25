import { ChatFindActiveContext } from "./chat-find-context";
import {
  Component,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Virtuoso, type ListRange, type VirtuosoHandle, type StateSnapshot } from "react-virtuoso";
import {
  AgentChatFindBar,
  findAgentChatTextMatches,
  useAgentChatFind,
  type AgentChatFindMatch,
} from "@/components/chat/AgentChatFind";
import { cn } from "@/lib/utils";
import { TranscriptAnnotationLayer } from "@/components/chat/TranscriptAnnotationLayer";
import type { TranscriptAnnotation } from "@/lib/chat/transcript-annotations";
import {
  collectSearchTextRuns,
  hiddenMirrorFor,
  restoreRichFindReveals,
  revealRichBlockForFind,
} from "@/lib/chat/rich-markdown/find-reveal";
import {
  decodeBlockViewKey,
  modelMatchGroup,
  pairBlockGroups,
  PROSE_GROUP,
  searchGroupId,
  type SearchGroup,
  type SearchProjection,
  type SearchTextGetter,
} from "@/lib/chat/rich-markdown/search-segments";
import {
  RichRowVisibilityContext,
  TranscriptRowVisibilityTracker,
} from "@/lib/chat/rich-render-priority";
import { useRichViewPinned } from "@/stores/richContentViewStore";
import { useArtifactLiveHostStore } from "@/stores/artifactLiveHostStore";
import type { TranscriptScrollController } from "@/lib/transcript-scroll/transcript-scroll-controller";
import { pureprependCount } from "@/lib/transcript-scroll/prepend";
import { keepMountedOverscan, useRatchetedOverscan } from "@/lib/transcript-scroll/keep-mounted";
import {
  LiveArrivalsContext,
  useLiveArrivalEntrance,
  useLiveArrivals,
  type LiveArrivalBatch,
} from "@/lib/transcript-scroll/arrivals";

interface VirtuosoListContext {
  footer?: ReactNode;
  header?: ReactNode;
  emptyState?: ReactNode;
}

/** The scroll wiring a transcript list receives (from `useVirtuosoScrollState`). */
export interface TranscriptListScrollProps {
  followOutput: (isAtBottom: boolean) => "auto" | false;
  atBottomStateChange: (atBottom: boolean) => void;
  atBottomThreshold: number;
  totalListHeightChanged?: (height: number) => void;
  restoreStateFrom: StateSnapshot | undefined;
  scrollerRef?: (el: HTMLElement | Window | null) => void;
  /** Pause/resume auto-follow for a reason (see `useVirtuosoScrollState`). */
  setFollowPaused?: (reason: string, paused: boolean) => void;
  /**
   * Whether automatic following may run (see `useVirtuosoScrollState`).
   * When false Virtuoso receives the literal `false`.
   */
  followEnabled?: boolean;
  /** The viewport's positioning owner; find navigates through it when present. */
  controller?: TranscriptScrollController;
}

interface VirtualizedMessageListProps<TMessage> {
  messages: TMessage[];
  computeItemKey: (index: number, message: TMessage) => string;
  renderMessage: (index: number, message: TMessage, previousMessage: TMessage | null) => ReactNode;
  /**
   * Optionally computes the predecessor handed to `renderMessage`. Defaults to
   * the immediately preceding message. Message lists that want block-level
   * continuity (e.g. skipping empty assistant placeholders so attribution and
   * duration anchor on real content) provide a resolver here.
   */
  resolvePreviousMessage?: (messages: readonly TMessage[], index: number) => TMessage | null;
  footer?: ReactNode;
  /** Rendered above the first message, e.g. "load earlier messages". */
  header?: ReactNode;
  emptyState?: ReactNode;
  scrollProps: TranscriptListScrollProps;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  /**
   * Item key (as returned by `computeItemKey`) of a row to highlight briefly,
   * e.g. the message a "open full conversation" link jumped to.
   */
  highlightedItemKey?: string | null;
  /**
   * Rows (and tool calls in a group) appended live grow in by their layout
   * height rather than appearing at full size (`lib/transcript-scroll/arrivals.ts`).
   */
  animateArrivals?: boolean;
  find?: {
    isActive: boolean;
    /**
     * The message's searchable text. A getter carrying a `projection`
     * (`withSearchProjection`) enables per-block match pairing.
     */
    getSearchText: SearchTextGetter<TMessage> | ((message: TMessage) => string);
    /** Semantic projection whose `text` equals `getSearchText`'s result. */
    getSearchProjection?: (message: TMessage) => SearchProjection;
  };
  annotation?: {
    enabled: boolean;
    annotations: readonly TranscriptAnnotation[];
    onAdd: (text: string) => TranscriptAnnotation | null;
    onUpdateComment: (id: string, comment: string) => void;
  };
}

const EMPTY_SEARCH_TEXT = () => "";
const SEARCH_CONTENT_SELECTOR = "[data-agent-chat-search-content]";
const ROW_SELECTOR = "[data-chat-message-index]";

/**
 * Virtuoso's `firstItemIndex` starts here and decreases by the number of
 * display rows each pure history prepend adds, so the rows already on screen
 * keep their absolute indices and the library keeps them in place. Headroom
 * for far more prepends than any transcript loads.
 */
export const FIRST_ITEM_INDEX_BASE = 100_000_000;

/**
 * Tracks `firstItemIndex` across renders: lowered atomically with the data
 * when the change is a pure prepend of display rows, unchanged otherwise. A
 * merge into the old first row adds no row and so moves nothing; the semantic
 * anchor settles that residual.
 */
function useFirstItemIndex<TMessage>(
  messages: readonly TMessage[],
  computeItemKey: (index: number, message: TMessage) => string,
): number {
  const [tracked, setTracked] = useState({ messages, firstItemIndex: FIRST_ITEM_INDEX_BASE });
  if (tracked.messages === messages) return tracked.firstItemIndex;
  const added = pureprependCount(tracked.messages, messages, (list, index) =>
    computeItemKey(index, list[index]!),
  );
  const firstItemIndex = Math.max(0, tracked.firstItemIndex - added);
  // Derived from the previous render's data; React re-renders before commit.
  setTracked({ messages, firstItemIndex });
  return firstItemIndex;
}

export {
  KEEP_MOUNTED_MARGIN_ROWS,
  KEEP_MOUNTED_MAX_ROWS,
  keepMountedOverscan,
} from "@/lib/transcript-scroll/keep-mounted";

/** The transcript row key holding `node`, if it is inside a row of `root`. */
function rowKeyOf(root: HTMLElement | null, node: Node | null): string | null {
  if (!root || !node || !root.contains(node)) return null;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>(ROW_SELECTOR)?.dataset.chatMessageKey ?? null;
}

/**
 * The outermost scoped rich block (decoded `data-rich-block-key`) holding
 * `node` inside `root`, as a find group; prose when there is none. Artifact
 * occurrence keys are not Markdown blocks and are passed through.
 */
function domSearchGroup(root: HTMLElement, node: Node): SearchGroup {
  let element = node instanceof Element ? node : node.parentElement;
  let group: SearchGroup = PROSE_GROUP;
  while (element && element !== root) {
    const key = element.getAttribute("data-rich-block-key");
    const decoded = key ? decodeBlockViewKey(key) : null;
    if (decoded) group = { type: "block", blockId: decoded.blockId, part: decoded.sourcePartId };
    element = element.parentElement;
  }
  return group;
}

/**
 * DOM ranges for every match of `query` in one search root. Text inside rich
 * block chrome (toolbars, labels, notices) is skipped, matching the message
 * projection (`getNativeMessageSearchText`), so occurrence ordinals agree.
 */
function createSearchRanges(root: HTMLElement, query: string): Range[] {
  const { text: combinedText, runs } = collectSearchTextRuns(root);

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

/** Scoped rich blocks that contain `node` (an open disclosure, a diagram in source view). */
function enclosingRichBlockKeys(node: Node): Set<string> {
  const keys = new Set<string>();
  let element = node instanceof Element ? node : node.parentElement;
  while (element) {
    const key = element.getAttribute("data-rich-block-key");
    if (key) keys.add(key);
    element = element.parentElement;
  }
  return keys;
}

/**
 * Captures the reader's place before a data commit mutates the transcript,
 * while a structural update (a history page) is held. `getSnapshotBeforeUpdate`
 * is the one point where the DOM still shows the previous rows.
 */
class PreCommitAnchor extends Component<{
  messages: readonly unknown[];
  controller: TranscriptScrollController | undefined;
}> {
  getSnapshotBeforeUpdate(previous: { messages: readonly unknown[] }) {
    const { controller, messages } = this.props;
    if (controller?.holdingStructure && previous.messages !== messages)
      controller.capturePreCommit();
    return null;
  }

  componentDidUpdate() {}

  render() {
    return null;
  }
}

const NO_SCROLL_VIEW = () => () => {};
const NO_TARGET = () => null;

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

function StableHeader({ context }: { context?: VirtuosoListContext }) {
  if (!context?.header) return null;
  return <FooterWrapper>{context.header}</FooterWrapper>;
}

function StableEmptyPlaceholder({ context }: { context?: VirtuosoListContext }) {
  if (!context?.emptyState) return null;
  return <EmptyPlaceholderWrapper>{context.emptyState}</EmptyPlaceholderWrapper>;
}

/**
 * One transcript row: observed for viewport intersection, and providing that
 * visibility to the rich blocks inside it (visible work before prefetch).
 */
function TranscriptRow({
  rowKey,
  index,
  tracker,
  arrivals,
  isCurrentFindMessage,
  isHighlighted,
  children,
}: {
  rowKey: string;
  index: number;
  tracker: TranscriptRowVisibilityTracker;
  arrivals: LiveArrivalBatch;
  isCurrentFindMessage: boolean;
  isHighlighted: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Observe before children's passive effects request render work.
  useLayoutEffect(() => {
    const element = ref.current;
    return element ? tracker.observe(rowKey, element) : undefined;
  }, [rowKey, tracker]);
  useLiveArrivalEntrance(ref, arrivals, rowKey);
  const visibility = tracker.source(rowKey);
  return (
    <div
      ref={ref}
      data-chat-message-index={index}
      data-chat-message-key={rowKey}
      data-conversation-target={isHighlighted ? "true" : undefined}
      className={cn(
        "rounded-sm transition-colors duration-700 motion-reduce:transition-none",
        isCurrentFindMessage && "outline outline-1 outline-offset-[-1px] outline-amber-400/35",
        isHighlighted && "bg-sky-500/10 outline outline-2 outline-offset-[-2px] outline-sky-500/50",
      )}
    >
      <RichRowVisibilityContext value={visibility}>
        <ChatFindActiveContext value={isCurrentFindMessage}>
          {/* One grid track must contain every root returned by the message. */}
          <div>{children}</div>
        </ChatFindActiveContext>
      </RichRowVisibilityContext>
    </div>
  );
}

export function VirtualizedMessageList<TMessage>({
  messages,
  computeItemKey,
  renderMessage,
  resolvePreviousMessage,
  footer,
  header,
  emptyState,
  scrollProps,
  virtuosoRef,
  highlightedItemKey = null,
  animateArrivals = false,
  find,
  annotation,
}: VirtualizedMessageListProps<TMessage>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const findInstanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const matchHighlightName = `agent-chat-find-match-${findInstanceId}`;
  const currentHighlightName = `agent-chat-find-current-${findInstanceId}`;
  const context = useMemo<VirtuosoListContext>(
    () => ({ footer, header, emptyState }),
    [footer, header, emptyState],
  );

  // Only recreate the components object when component presence changes (not content).
  // This keeps component identity stable across re-renders.
  const hasFooter = !!footer;
  const hasHeader = !!header;
  const hasEmptyState = !!emptyState;
  const components = useMemo(
    () => ({
      Footer: hasFooter ? StableFooter : undefined,
      Header: hasHeader ? StableHeader : undefined,
      EmptyPlaceholder: hasEmptyState ? StableEmptyPlaceholder : undefined,
    }),
    [hasFooter, hasHeader, hasEmptyState],
  );

  const controller = scrollProps.controller;
  const forwardScrollerRef = scrollProps.scrollerRef;
  // A library-independent name for the transcript's own scroller, distinct
  // from any nested virtualized viewport (an open long tool group).
  const transcriptScrollerRef = useCallback(
    (element: HTMLElement | Window | null) => {
      if (element instanceof HTMLElement) element.setAttribute("data-transcript-scroller", "true");
      forwardScrollerRef?.(element);
    },
    [forwardScrollerRef],
  );
  const messagesRef = useRef(messages);
  // Callers pass `computeItemKey` inline; read it through a ref so callbacks
  // built from it (find navigation) keep their identity across renders.
  const computeItemKeyRef = useRef(computeItemKey);
  useLayoutEffect(() => {
    messagesRef.current = messages;
    computeItemKeyRef.current = computeItemKey;
  }, [computeItemKey, messages]);
  // Virtuoso's rendered and reported indices include `firstItemIndex`; its
  // `scrollToIndex` takes the local data index. Everything in this component
  // (find matches, DOM index attributes, protected rows) is local.
  const firstItemIndex = useFirstItemIndex(messages, computeItemKey);
  const arrivals = useLiveArrivals(
    messages,
    (list, index) => computeItemKey(index, list[index]!),
    animateArrivals,
  );
  /** Generation of find's own navigation; its match refinement may not outlive the reader moving. */
  const findNavigationRef = useRef<number | null>(null);
  /**
   * The match find last navigated to, by identity. Matches are recomputed
   * whenever the rows change (every streaming update while find is open);
   * only a different match is a navigation — re-navigating to the same one
   * would pull a reader who scrolled away back to it on every token.
   */
  const lastFindMatchRef = useRef<string | null>(null);
  const handleFindNavigate = useCallback(
    (match: AgentChatFindMatch, query: string) => {
      const message = messagesRef.current[match.itemIndex];
      const identity = JSON.stringify([
        query,
        message === undefined
          ? match.itemIndex
          : computeItemKeyRef.current(match.itemIndex, message),
        match.characterIndex,
        match.occurrenceIndex,
      ]);
      if (identity === lastFindMatchRef.current) return;
      lastFindMatchRef.current = identity;
      if (controller) {
        const navigated = controller.navigateTo(
          {
            kind: "row",
            index: match.itemIndex,
            key:
              message === undefined
                ? undefined
                : computeItemKeyRef.current(match.itemIndex, message),
            align: "center",
          },
          "find",
        );
        findNavigationRef.current = navigated ? controller.generation : null;
        return;
      }
      virtuosoRef.current?.scrollToIndex({
        index: match.itemIndex,
        align: "center",
        behavior: "auto",
      });
    },
    [controller, virtuosoRef],
  );
  const chatFind = useAgentChatFind({
    items: messages,
    getSearchText: find?.getSearchText ?? EMPTY_SEARCH_TEXT,
    isActive: find?.isActive ?? false,
    ownerRef: rootRef,
    onNavigate: handleFindNavigate,
  });
  // Asking for the latest message ends a find session rather than leaving
  // find and the latest journey competing for the viewport.
  const closeFind = chatFind.onClose;
  const findOpen = chatFind.isOpen;
  useEffect(() => {
    if (!controller || !findOpen) return;
    return controller.onLatestRequested(closeFind);
  }, [closeFind, controller, findOpen]);
  // Navigation by row identity resolves the row's current index here.
  useLayoutEffect(() => {
    if (!controller) return;
    controller.setRowIndexResolver((key) =>
      messagesRef.current.findIndex(
        (message, index) => computeItemKeyRef.current(index, message) === key,
      ),
    );
    return () => controller.setRowIndexResolver(null);
  }, [controller]);
  // Clearing the query starts a new search even if it returns to the same
  // occurrence. Reset before the hook's passive navigation effect runs.
  useLayoutEffect(() => {
    if (!findOpen || !chatFind.query.trim()) {
      lastFindMatchRef.current = null;
      findNavigationRef.current = null;
    }
  }, [chatFind.query, findOpen]);
  const getSearchProjection =
    find?.getSearchProjection ??
    (find?.getSearchText as SearchTextGetter<TMessage> | undefined)?.projection;

  // Rows report whether they intersect the scroller viewport, so rich blocks
  // in Virtuoso's overscan request idle prefetch rather than visible work.
  const [tracker] = useState(() => new TranscriptRowVisibilityTracker());
  useEffect(() => () => tracker.dispose(), [tracker]);

  // The row holding the reader's selection or focus: kept mounted (bounded)
  // and, for a selection, a reason to pause auto-follow.
  const [selectionRowKey, setSelectionRowKey] = useState<string | null>(null);
  const [focusRowKey, setFocusRowKey] = useState<string | null>(null);
  // The visible range is only held in state while a row is protected, so
  // ordinary scrolling does not re-render the list.
  const latestRangeRef = useRef<ListRange | null>(null);
  const protectedIndexRef = useRef<number | null>(null);
  const [visibleRange, setVisibleRange] = useState<ListRange | null>(null);
  const [releasedTargetKey, setReleasedTargetKey] = useState<string | null>(null);
  const navigationProtectedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ownerDocument = root.ownerDocument;
    const onSelectionChange = () => {
      const selection = ownerDocument.getSelection();
      const key =
        !selection || selection.rangeCount === 0 || selection.isCollapsed
          ? null
          : (rowKeyOf(root, selection.focusNode) ?? rowKeyOf(root, selection.anchorNode));
      setSelectionRowKey(key);
      if (key !== null) setVisibleRange(latestRangeRef.current);
    };
    const onFocusIn = (event: FocusEvent) => {
      const key = rowKeyOf(root, event.target as Node | null);
      setFocusRowKey(key);
      if (key !== null) setVisibleRange(latestRangeRef.current);
    };
    const onFocusOut = (event: FocusEvent) => {
      setFocusRowKey(rowKeyOf(root, event.relatedTarget as Node | null));
    };
    ownerDocument.addEventListener("selectionchange", onSelectionChange);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    return () => {
      ownerDocument.removeEventListener("selectionchange", onSelectionChange);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  const appliedOverscan = useRef({ top: 0, bottom: 0 });
  const handleRangeChanged = useCallback(
    (absolute: ListRange) => {
      // Virtuoso reports absolute indices (offset by `firstItemIndex`).
      const reported = {
        startIndex: absolute.startIndex - firstItemIndex,
        endIndex: absolute.endIndex - firstItemIndex,
      };
      // Virtuoso reports the expanded render window. Recover the viewport
      // range before calculating new protection, avoiding an overscan feedback loop.
      let range = {
        startIndex:
          reported.startIndex === 0
            ? 0
            : Math.min(reported.endIndex, reported.startIndex + appliedOverscan.current.top),
        endIndex:
          reported.endIndex === messages.length - 1
            ? reported.endIndex
            : Math.max(reported.startIndex, reported.endIndex - appliedOverscan.current.bottom),
      };
      const protectedRow = protectedIndexRef.current;
      if (protectedRow !== null) {
        // At either list edge overscan is clipped, so subtracting the applied
        // counts cannot recover the viewport. Measure only while protecting
        // a row (ordinary scrolling never forces this layout read).
        const root = rootRef.current;
        const viewport = root?.querySelector("[data-virtuoso-scroller]")?.getBoundingClientRect();
        if (viewport && viewport.height > 0) {
          let first = Infinity;
          let last = -1;
          for (const row of root!.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
            const rect = row.getBoundingClientRect();
            if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
            const index = Number(row.dataset.chatMessageIndex);
            if (!Number.isSafeInteger(index)) continue;
            first = Math.min(first, index);
            last = Math.max(last, index);
          }
          if (last >= first) range = { startIndex: first, endIndex: last };
        } else if (reported.startIndex === 0 || reported.endIndex === messages.length - 1) {
          // Hidden scrollers have no usable geometry. Keep the last known
          // viewport at a clipped edge until layout returns, avoiding feedback.
          range = latestRangeRef.current ?? range;
        }
      }
      latestRangeRef.current = range;
      if (protectedRow === null) return;
      if (keepMountedOverscan(protectedRow, range) === null) {
        // Beyond the bound the row unmounts like any other: release it.
        setSelectionRowKey(null);
        setFocusRowKey(null);
        setReleasedTargetKey(navigationProtectedKeyRef.current);
        setVisibleRange(null);
        return;
      }
      setVisibleRange((previous) =>
        previous?.startIndex === range.startIndex && previous?.endIndex === range.endIndex
          ? previous
          : range,
      );
    },
    [appliedOverscan, firstItemIndex, messages.length],
  );
  // A bounded navigation's target row stays mounted while it converges,
  // within the same bound as a selection; beyond it the target is released
  // (the navigation then re-navigates by index rather than holding it).
  const navigationTargetKey = useSyncExternalStore(
    controller?.subscribe ?? NO_SCROLL_VIEW,
    controller ? () => controller.getSnapshot().targetKey : NO_TARGET,
  );
  const navigationProtectedKey =
    navigationTargetKey !== null && navigationTargetKey !== releasedTargetKey
      ? navigationTargetKey
      : null;
  useLayoutEffect(() => {
    navigationProtectedKeyRef.current = navigationProtectedKey;
    // Protection measures from the known viewport range, as a selection does.
    if (navigationProtectedKey !== null) setVisibleRange(latestRangeRef.current);
  }, [navigationProtectedKey]);
  const protectedRowKey = selectionRowKey ?? focusRowKey ?? navigationProtectedKey;
  const protectedIndex = useMemo(() => {
    if (protectedRowKey === null) return null;
    const index = messages.findIndex(
      (message, candidate) => computeItemKey(candidate, message) === protectedRowKey,
    );
    return index >= 0 ? index : null;
  }, [computeItemKey, messages, protectedRowKey]);
  useLayoutEffect(() => {
    protectedIndexRef.current = protectedIndex;
  }, [protectedIndex]);
  // A navigation target is only protected against a known range: with none
  // there is nothing to measure the bound from.
  const keepMounted = useRatchetedOverscan(
    protectedIndex === null ? null : protectedRowKey,
    selectionRowKey === null && focusRowKey === null && visibleRange === null
      ? null
      : keepMountedOverscan(protectedIndex, visibleRange),
  );
  useLayoutEffect(() => {
    appliedOverscan.current.top = keepMounted?.top ?? 0;
    appliedOverscan.current.bottom = keepMounted?.bottom ?? 0;
  }, [appliedOverscan, keepMounted?.top, keepMounted?.bottom]);

  // Auto-follow pauses while the reader selects text here, uses find, or
  // has an expanded artifact or viewer open; it resumes when they stop.
  const liveArtifactExpanded = useArtifactLiveHostStore(
    (state) => state.active !== null && state.active.placement !== "inline",
  );
  const viewerOpen = useRichViewPinned();
  const pausedForSelection = selectionRowKey !== null;
  const pausedForFind = chatFind.isOpen;
  const pausedForArtifact = liveArtifactExpanded || viewerOpen;
  const setFollowPaused = scrollProps.setFollowPaused;
  // Without the scroll hook's pause support, pause Virtuoso's follow here.
  const pausedLocally =
    !setFollowPaused && (pausedForSelection || pausedForFind || pausedForArtifact);
  useEffect(() => {
    setFollowPaused?.("selection", pausedForSelection);
  }, [pausedForSelection, setFollowPaused]);
  useEffect(() => {
    setFollowPaused?.("find", pausedForFind);
  }, [pausedForFind, setFollowPaused]);
  useEffect(() => {
    setFollowPaused?.("expanded-artifact", pausedForArtifact);
  }, [pausedForArtifact, setFollowPaused]);
  useEffect(
    () => () => {
      setFollowPaused?.("selection", false);
      setFollowPaused?.("find", false);
      setFollowPaused?.("expanded-artifact", false);
    },
    [setFollowPaused],
  );

  useEffect(() => {
    const cssHighlights =
      typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
        ? CSS.highlights
        : null;

    const clearHighlights = () => {
      cssHighlights?.delete(matchHighlightName);
      cssHighlights?.delete(currentHighlightName);
    };

    if (!find?.isActive || !chatFind.isOpen || !chatFind.query.trim()) {
      // Find closed or emptied: undo every temporary reveal it made.
      restoreRichFindReveals(findInstanceId);
    }
    if (
      !cssHighlights ||
      !find?.isActive ||
      !chatFind.isOpen ||
      !chatFind.query.trim() ||
      chatFind.matches.length === 0
    ) {
      clearHighlights();
      return clearHighlights;
    }

    let frame = 0;
    let attempts = 0;
    const revealedThisMatch = new Set<string>();

    /**
     * Pair one row's model matches with its DOM ranges. With a semantic
     * projection, a match inside a rich block pairs with the n-th range
     * inside that block's element (by block identity, not row ordinal) and
     * prose matches pair by ordinal among prose ranges only; without one,
     * every range pairs by row ordinal.
     */
    const collectRowRanges = (
      row: HTMLElement,
      rowMatches: readonly AgentChatFindMatch[],
      projection: SearchProjection | null,
    ) => {
      const ranges: Range[] = [];
      let activeRange: Range | null = null;
      const taggedRoots = Array.from(row.querySelectorAll<HTMLElement>(SEARCH_CONTENT_SELECTOR));
      const searchableRoots = taggedRoots.length > 0 ? taggedRoots : [row];

      const domGroups = new Map<string, Range[]>();
      const domBlockGroups: Extract<SearchGroup, { type: "block" }>[] = [];
      for (const searchableRoot of searchableRoots) {
        for (const range of createSearchRanges(searchableRoot, chatFind.query)) {
          const group = projection
            ? domSearchGroup(searchableRoot, range.startContainer)
            : PROSE_GROUP;
          const id = searchGroupId(group);
          let list = domGroups.get(id);
          if (!list) {
            list = [];
            domGroups.set(id, list);
            if (group.type === "block") domBlockGroups.push(group);
          }
          list.push(range);
        }
      }

      const modelGroups = rowMatches.map((match) =>
        projection ? modelMatchGroup(projection, match.characterIndex) : PROSE_GROUP,
      );
      const pairs = pairBlockGroups(
        modelGroups.filter(
          (group): group is Extract<SearchGroup, { type: "block" }> => group.type === "block",
        ),
        domBlockGroups,
      );
      const ordinals = new Map<string, number>();
      for (const [index, match] of rowMatches.entries()) {
        const modelId = searchGroupId(modelGroups[index]!);
        const ordinal = ordinals.get(modelId) ?? 0;
        ordinals.set(modelId, ordinal + 1);
        const domId = modelId === "prose" ? "prose" : pairs.get(modelId);
        const range = domId === undefined ? undefined : domGroups.get(domId)?.[ordinal];
        if (!range) continue;
        ranges.push(range);
        if (match === chatFind.currentMatch) activeRange = range;
      }

      return { ranges, activeRange };
    };

    const matchesByItem = new Map<number, AgentChatFindMatch[]>();
    for (const match of chatFind.matches) {
      const list = matchesByItem.get(match.itemIndex) ?? [];
      list.push(match);
      matchesByItem.set(match.itemIndex, list);
    }

    const applyHighlights = () => {
      const root = rootRef.current;
      if (!root) return;

      const allRanges: Range[] = [];
      let activeRange: Range | null = null;
      const rows = root.querySelectorAll<HTMLElement>(ROW_SELECTOR);

      for (const row of rows) {
        const itemIndex = Number(row.dataset.chatMessageIndex);
        const rowMatches = matchesByItem.get(itemIndex);
        if (!rowMatches) continue;
        const message = messages[itemIndex];
        const projection =
          getSearchProjection && message !== undefined ? getSearchProjection(message) : null;
        const rowRanges = collectRowRanges(row, rowMatches, projection);
        allRanges.push(...rowRanges.ranges);
        activeRange ??= rowRanges.activeRange;
      }

      cssHighlights.set(matchHighlightName, new Highlight(...allRanges));
      cssHighlights.set(currentHighlightName, new Highlight(...(activeRange ? [activeRange] : [])));

      // A match in hidden rich content (a collapsed disclosure body, a
      // diagram's source behind its preview) is revealed first; the next
      // frame then highlights the now-visible text. Reveals are temporary.
      const mirror = activeRange ? hiddenMirrorFor(activeRange.startContainer) : null;
      const revealKey = mirror?.getAttribute("data-rich-reveal-key");
      if (activeRange && mirror && revealKey && attempts < 8) {
        revealedThisMatch.add(revealKey);
        revealRichBlockForFind(revealKey, findInstanceId);
        attempts += 1;
        frame = requestAnimationFrame(applyHighlights);
        return;
      }
      if (activeRange) {
        // Keep this match's reveals (and any open block around it); undo the rest.
        const keep = enclosingRichBlockKeys(activeRange.startContainer);
        for (const key of revealedThisMatch) keep.add(key);
        restoreRichFindReveals(findInstanceId, keep);
      }

      // The selected row may contain a long report. Reveal the occurrence,
      // including text well below the row's initial scroll position.
      if (activeRange) {
        // A mirror without a reveal action (a chart's labels) is not laid
        // out; scroll to the block that hosts it instead.
        const anchor =
          mirror?.closest<HTMLElement>("[data-rich-mirror-host]") ?? mirror?.parentElement;
        const node = anchor ?? activeRange.startContainer;
        const element = node instanceof Element ? node : node.parentElement;
        const scroller = element?.closest<HTMLElement>("[data-virtuoso-scroller]");
        const range = activeRange;
        const matchRect = () => {
          if (!node.isConnected) return null;
          return anchor ? anchor.getBoundingClientRect() : range.getBoundingClientRect();
        };
        const findNavigation = findNavigationRef.current;
        if (controller && scroller) {
          // Find owns the viewport only until the reader moves: refine its
          // navigation onto the match box, never snap a reader back to it.
          const box = matchRect();
          const viewport = scroller.getBoundingClientRect();
          const navigating = controller.currentOwner === "find";
          const outside = box !== null && (box.top < viewport.top || box.bottom > viewport.bottom);
          if (findNavigation !== null && (navigating || outside)) {
            controller.retarget("find", { kind: "rect", rect: matchRect }, findNavigation);
          }
        } else if (scroller) {
          // A list without a scroll controller (fixtures) scrolls directly.
          const box = matchRect()!;
          const viewport = scroller.getBoundingClientRect();
          if (box.top < viewport.top || box.bottom > viewport.bottom) {
            scroller.scrollBy({
              top: box.top - viewport.top - (viewport.height - box.height) / 2,
              behavior: "instant",
            });
          }
        }
      }

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
    chatFind.matches,
    chatFind.query,
    controller,
    find?.isActive,
    currentHighlightName,
    findInstanceId,
    getSearchProjection,
    matchHighlightName,
    messages,
  ]);

  // Leaving the transcript ends its find session and its temporary reveals.
  useEffect(() => () => restoreRichFindReveals(findInstanceId), [findInstanceId]);

  return (
    <div ref={rootRef} className="relative min-h-0 flex-1">
      <PreCommitAnchor messages={messages} controller={controller} />
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
      {annotation ? (
        <TranscriptAnnotationLayer
          rootRef={rootRef}
          enabled={annotation.enabled}
          annotations={annotation.annotations}
          onAddAnnotation={annotation.onAdd}
          onUpdateAnnotationComment={annotation.onUpdateComment}
        />
      ) : null}
      <LiveArrivalsContext value={animateArrivals}>
        <Virtuoso
          ref={virtuosoRef}
          data={messages}
          context={context}
          firstItemIndex={firstItemIndex}
          computeItemKey={(absolute, data) => computeItemKey(absolute - firstItemIndex, data)}
          itemContent={(absolute, data) => {
            const index = absolute - firstItemIndex;
            const rowKey = computeItemKey(index, data);
            return (
              <TranscriptRow
                rowKey={rowKey}
                index={index}
                tracker={tracker}
                arrivals={arrivals}
                isCurrentFindMessage={chatFind.isOpen && chatFind.currentMatch?.itemIndex === index}
                isHighlighted={highlightedItemKey !== null && rowKey === highlightedItemKey}
              >
                {renderMessage(
                  index,
                  data,
                  resolvePreviousMessage
                    ? resolvePreviousMessage(messages, index)
                    : index > 0
                      ? (messages[index - 1] ?? null)
                      : null,
                )}
              </TranscriptRow>
            );
          }}
          components={components}
          // Literal false whenever following may not run: Virtuoso's size and
          // viewport paths test `followOutput !== false`, so a function that
          // would return false still lets them scroll.
          followOutput={
            pausedLocally || scrollProps.followEnabled === false ? false : scrollProps.followOutput
          }
          atBottomStateChange={scrollProps.atBottomStateChange}
          atBottomThreshold={scrollProps.atBottomThreshold}
          totalListHeightChanged={scrollProps.totalListHeightChanged}
          restoreStateFrom={scrollProps.restoreStateFrom}
          scrollerRef={transcriptScrollerRef}
          rangeChanged={handleRangeChanged}
          minOverscanItemCount={keepMounted ?? undefined}
          // A tool block can be thousands of pixels tall. Using it as Virtuoso's
          // default probe height overestimates new text/tool rows, briefly pushes
          // visible history out of the window, then remounts it after measurement.
          // 320px is near a representative mixed transcript row while still far
          // below those outliers; it also bounds the cold-fill render count.
          // Measured and restored rows retain their real heights.
          defaultItemHeight={320}
          increaseViewportBy={{ top: 400, bottom: 200 }}
          style={{ height: "100%" }}
          className="py-4"
        />
      </LiveArrivalsContext>
    </div>
  );
}
