import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Virtuoso, type ListRange, type VirtuosoHandle } from "react-virtuoso";
import { ChevronRight, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatAgentDurationMs } from "@/lib/chat/native-agent-duration";
import { getToolDisplayName, getToolTitleDisplayName } from "@/lib/tool-names";
import type { NativeMessagePart, NativeToolGroupPart } from "@/lib/chat/native-message-types";
import { shouldFoldToolGroup, summarizeToolGroup } from "@/lib/chat/tool-group-summary";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import {
  AgentExpansionScopeContext,
  MessageExpansionScopeContext,
  NativeMessagePartRenderer,
  getToolExpansionKey,
} from "./NativeMessage.shared";
import { toolRowPreview } from "./NativeMessage.basic-parts";
import { pureprependCount } from "@/lib/transcript-scroll/prepend";
import { keepMountedOverscan, useRatchetedOverscan } from "@/lib/transcript-scroll/keep-mounted";

/** Inner `firstItemIndex` start; lowered by members a history page prepends. */
const INNER_FIRST_ITEM_INDEX_BASE = 1_000_000;

/**
 * Entries beyond which an open group's body is virtualized. Below it a plain
 * list is cheaper than a virtualizer and its observers; both share the same
 * entry component, keys and hard height ceiling.
 */
export const TOOL_GROUP_VIRTUALIZE_MIN_ENTRIES = 12;

/**
 * The open body's hard ceiling, expanded details included: `min(28rem, 55dvh)`.
 * A taller entry scrolls inside it (or opens the dedicated viewer), so opening
 * a group can never recreate an unbounded transcript row.
 */
export const TOOL_GROUP_BODY_MAX_HEIGHT = "min(28rem, 55dvh)";

/** Bootstrap estimate for an unmeasured entry; measured sizes replace it. */
const ENTRY_ESTIMATE_PX = 40;

const INNER_FOLLOW = () => "auto" as const;

/** Within this of the inner end, the inner list counts as following its tail. */
const INNER_END_TOLERANCE_PX = 2;

/** A member's identity in its group: its provider call or source part id. */
export function toolGroupEntryKey(part: NativeMessagePart, index: number): string {
  const id =
    part.type === "tool-invocation" ? (part.toolUseId ?? part.sourcePartId) : part.sourcePartId;
  return id ? `id:${id}` : `pos:${index}:${part.type}`;
}

/** The ceiling in pixels, for the virtualized body that needs an explicit height. */
function useBodyMaxHeightPx(): number {
  const read = () => {
    if (typeof window === "undefined") return 448;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    return Math.max(120, Math.min(28 * rem, 0.55 * viewport));
  };
  const [max, setMax] = useState(read);
  useEffect(() => {
    const update = () => setMax(read());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return max;
}

/**
 * One row of a group. Memoized on the member object: coalescing keeps
 * unchanged members by reference, so a tail update re-renders only the
 * members that changed.
 */
const ToolGroupEntry = memo(function ToolGroupEntry({
  part,
  containerId,
  partKey,
  index,
}: {
  part: NativeMessagePart;
  containerId?: string;
  partKey: string;
  /** Local index inside a virtualized body (selection protection). */
  index?: number;
}) {
  return (
    <div className="px-2 py-0.5" data-tool-group-entry-index={index}>
      <NativeMessagePartRenderer part={part} containerId={containerId} partKey={partKey} />
    </div>
  );
});

interface BodyProps {
  entries: readonly NativeMessagePart[];
  containerId?: string;
  partKey: string;
}

function entryPartKey(partKey: string, part: NativeMessagePart, index: number) {
  return `${partKey}/tool:${toolGroupEntryKey(part, index)}`;
}

/**
 * Where an inner list was when it last scrolled: following its end, or a
 * member and its offset. Carried across the plain → virtualized switch so a
 * growing open group keeps the reader's place.
 */
interface InnerPlace {
  atEnd: boolean;
  index: number;
  offset: number;
}

/** A short group: every entry, capped and following its tail while at its end. */
interface PlaceProps {
  readPlace: () => InnerPlace;
  writePlace: (next: InnerPlace) => void;
}

function PlainToolGroupBody({
  entries,
  containerId,
  partKey,
  readPlace,
  writePlace,
}: BodyProps & PlaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const atEnd =
      element.scrollHeight - element.clientHeight - element.scrollTop <= INNER_END_TOLERANCE_PX;
    let index = 0;
    let offset = 0;
    const top = element.getBoundingClientRect().top;
    for (const [candidate, child] of Array.from(element.children).entries()) {
      const rect = child.getBoundingClientRect();
      if (rect.bottom > top) {
        index = candidate;
        offset = rect.top - top;
        break;
      }
    }
    writePlace({ atEnd, index, offset });
  }, [writePlace]);
  // An append while the reader was at the end keeps the end in view; growth
  // of an entry they scrolled away from does not move them.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !readPlace().atEnd) return;
    element.scrollTop = element.scrollHeight;
  }, [entries, readPlace]);
  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="divide-y divide-divider overflow-y-auto"
      style={{ maxHeight: TOOL_GROUP_BODY_MAX_HEIGHT }}
    >
      {entries.map((child, index) => (
        <ToolGroupEntry
          key={toolGroupEntryKey(child, index)}
          part={child}
          containerId={containerId}
          partKey={entryPartKey(partKey, child, index)}
        />
      ))}
    </div>
  );
}

/**
 * A long group: a bounded inner viewport that renders only the visible
 * entries and a small overscan. It owns its own scroll position and follow
 * preference (captured before each append), separate from the transcript's.
 */
function VirtualizedToolGroupBody({
  entries,
  containerId,
  partKey,
  readPlace,
  writePlace,
}: BodyProps & PlaceProps) {
  const maxHeight = useBodyMaxHeightPx();
  const [contentHeight, setContentHeight] = useState(() =>
    Math.min(entries.length * ENTRY_ESTIMATE_PX, maxHeight),
  );
  const handle = useRef<VirtuosoHandle>(null);
  const [initialPlace] = useState(readPlace);
  // History merging older calls in front of an open group must not move the
  // calls the reader is looking at inside it: a pure prepend of members lowers
  // the inner list's base index, as the transcript does for rows.
  const [tracked, setTracked] = useState({ entries, base: INNER_FIRST_ITEM_INDEX_BASE });
  let base = tracked.base;
  if (tracked.entries !== entries) {
    const added = pureprependCount(tracked.entries, entries, (list, index) =>
      toolGroupEntryKey(list[index]!, index),
    );
    base = Math.max(0, tracked.base - added);
    setTracked({ entries, base });
  }
  const baseRef = useRef(INNER_FIRST_ITEM_INDEX_BASE);
  const innerScrollerRef = useRef<HTMLElement | null>(null);
  const [following, setFollowing] = useState(initialPlace.atEnd);
  useLayoutEffect(() => {
    baseRef.current = base;
  });
  // A selection (or, failing that, focus) inside an entry keeps that entry
  // mounted while it stays near the window, with the transcript's own bound;
  // virtualization stays on.
  const hostRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [visibleRange, setVisibleRange] = useState<{ startIndex: number; endIndex: number } | null>(
    null,
  );
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onSelectionChange = () => {
      const selection = host.ownerDocument.getSelection();
      const node = selection && !selection.isCollapsed ? selection.focusNode : null;
      const element = node instanceof Element ? node : (node?.parentElement ?? null);
      const entry =
        element && host.contains(element)
          ? element.closest<HTMLElement>("[data-tool-group-entry-index]")
          : null;
      setSelectedIndex(entry ? Number(entry.dataset.toolGroupEntryIndex) : null);
    };
    const entryIndexOf = (node: EventTarget | null) => {
      const entry =
        node instanceof Element ? node.closest<HTMLElement>("[data-tool-group-entry-index]") : null;
      return entry && host.contains(entry) ? Number(entry.dataset.toolGroupEntryIndex) : null;
    };
    const onFocusIn = (event: FocusEvent) => setFocusedIndex(entryIndexOf(event.target));
    const onFocusOut = (event: FocusEvent) => setFocusedIndex(entryIndexOf(event.relatedTarget));
    host.ownerDocument.addEventListener("selectionchange", onSelectionChange);
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("focusout", onFocusOut);
    return () => {
      host.ownerDocument.removeEventListener("selectionchange", onSelectionChange);
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  // A selection outranks focus, as in the transcript.
  const protectedIndex = selectedIndex ?? focusedIndex;
  const keepMounted = useRatchetedOverscan(
    protectedIndex === null ? null : String(protectedIndex),
    protectedIndex === null ? null : keepMountedOverscan(protectedIndex, visibleRange),
  );
  const onRange = useCallback(
    (range: ListRange) => {
      const local = {
        startIndex: range.startIndex - baseRef.current,
        endIndex: range.endIndex - baseRef.current,
      };
      const current = readPlace();
      if (!current.atEnd) writePlace({ ...current, index: local.startIndex });
      setVisibleRange((previous) =>
        previous?.startIndex === local.startIndex && previous.endIndex === local.endIndex
          ? previous
          : local,
      );
    },
    [readPlace, writePlace],
  );
  return (
    <div
      ref={hostRef}
      // The transcript's anchor capture skips members inside: the group frame
      // stands for them while this viewport owns their scrolling.
      data-transcript-inner-viewport="true"
      className="divide-y divide-divider"
    >
      <Virtuoso
        ref={handle}
        data={entries as NativeMessagePart[]}
        firstItemIndex={base}
        style={{ height: Math.min(contentHeight, maxHeight) }}
        totalListHeightChanged={setContentHeight}
        defaultItemHeight={ENTRY_ESTIMATE_PX}
        increaseViewportBy={{ top: 120, bottom: 120 }}
        computeItemKey={(absolute, child) => toolGroupEntryKey(child, absolute - base)}
        // The top is Virtuoso's default; only another opening place is passed.
        initialTopMostItemIndex={
          initialPlace.atEnd
            ? { index: "LAST", align: "end" }
            : initialPlace.index > 0 || initialPlace.offset !== 0
              ? { index: initialPlace.index, align: "start", offset: -initialPlace.offset }
              : undefined
        }
        // Follows only an append that finds the reader at the inner end; a
        // status update or details arriving changes no count, so never starts
        // following. Literal false otherwise: Virtuoso's viewport-shrink and
        // size paths test `followOutput !== false`, and would otherwise pull
        // this list to its end as its own height settles.
        followOutput={following ? INNER_FOLLOW : false}
        // Trust measured geometry, including a body that fits its viewport.
        // Ignore the empty pre-measurement report at mount.
        atBottomStateChange={(atBottom) => {
          const element = innerScrollerRef.current;
          const atEnd =
            atBottom &&
            element !== null &&
            element.clientHeight > 0 &&
            element.scrollHeight - element.clientHeight - element.scrollTop <=
              INNER_END_TOLERANCE_PX;
          writePlace({ ...readPlace(), atEnd });
          setFollowing(atEnd);
        }}
        scrollerRef={(element) => {
          innerScrollerRef.current = element instanceof HTMLElement ? element : null;
        }}
        atBottomThreshold={INNER_END_TOLERANCE_PX}
        rangeChanged={onRange}
        minOverscanItemCount={keepMounted ?? undefined}
        itemContent={(absolute, child) => (
          <ToolGroupEntry
            part={child}
            containerId={containerId}
            partKey={entryPartKey(partKey, child, absolute - base)}
            index={absolute - base}
          />
        )}
      />
    </div>
  );
}

/**
 * A live group (a call still running) opens following its newest call; a
 * finished one opens at its first, in reading order.
 */
function openingPlace(entries: readonly NativeMessagePart[]): InnerPlace {
  const live = entries.some(
    (entry) => entry.type === "tool-invocation" && entry.toolState === "pending",
  );
  return { atEnd: live, index: 0, offset: 0 };
}

function ToolGroupBody(props: BodyProps) {
  const [initial] = useState(() => openingPlace(props.entries));
  const place = useRef<InnerPlace>(initial);
  const readPlace = useCallback(() => place.current, []);
  const writePlace = useCallback((next: InnerPlace) => {
    place.current = next;
  }, []);
  return props.entries.length >= TOOL_GROUP_VIRTUALIZE_MIN_ENTRIES ? (
    <VirtualizedToolGroupBody {...props} readPlace={readPlace} writePlace={writePlace} />
  ) : (
    <PlainToolGroupBody {...props} readPlace={readPlace} writePlace={writePlace} />
  );
}

/**
 * A run of tool calls in one stable host.
 *
 * Short runs show every call. From `TOOL_GROUP_FOLD_MIN_CALLS` calls the head
 * line appears, summarising the newest call, the count and the span, and the
 * body folds under it. The same host and body element serve every state, so
 * crossing the threshold never remounts the rows.
 *
 * Folding is the reader's choice. A group the reader saw unfolded stays open
 * when it crosses the threshold (no automatic collapse of what they are
 * reading, no height animation); a group that arrives already long — history,
 * a page — starts folded. Opening is remembered across virtualized unmounts.
 */
export function ToolGroupPart({
  part,
  containerId,
  partKey,
}: {
  part: NativeToolGroupPart;
  containerId?: string;
  partKey: string;
}) {
  const folds = shouldFoldToolGroup(part.parts);
  // "pending" while the group is short on screen: crossing the threshold then
  // opens it once. A group that mounts already long starts "done" (folded).
  const [crossing, setCrossing] = useState<"pending" | "done">(folds ? "done" : "pending");
  // Set by the crossing itself, cleared by the reader's first toggle.
  const [openedByCrossing, setOpenedByCrossing] = useState(false);
  if (!folds && crossing === "done") setCrossing("pending");
  if (folds && crossing === "pending") {
    setCrossing("done");
    setOpenedByCrossing(true);
  }

  const messageScope = useContext(MessageExpansionScopeContext);
  const transcriptScope = useContext(AgentExpansionScopeContext);
  const toolKeys = part.parts.flatMap((child, index) =>
    child.type === "tool-invocation"
      ? [getToolExpansionKey(child, entryPartKey(partKey, child, index))]
      : [],
  );
  // A provider call id is unique within its conversation, so it is scoped to
  // the transcript rather than to the row: coalescing renames the row that
  // holds a group whenever earlier rows merge in front of it.
  const groupKey = (toolKey = `part:${partKey}`) =>
    `native-tool-group:${toolKey.startsWith("id:") ? JSON.stringify([transcriptScope]) : messageScope}:${toolKey}`;
  /*
   * Remember every member: paging and streaming can change both ends in one
   * update. The message-local fallback also bridges calls acquiring provider
   * ids. All aliases are cleared together when the reader folds the group.
   */
  const [isOpen, setIsOpen] = useMessagePartExpansion([groupKey(), ...toolKeys.map(groupKey)]);
  // Crossing the threshold on screen keeps the rows the reader is looking at,
  // and remembers them open across virtualized unmounts; from then on folding
  // and unfolding are the reader's.
  useLayoutEffect(() => {
    if (openedByCrossing) setIsOpen(true);
  }, [openedByCrossing, setIsOpen]);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpenedByCrossing(false);
      setIsOpen(next);
    },
    [setIsOpen],
  );

  if (part.parts.length === 0) return null;
  const open = !folds || isOpen || openedByCrossing;

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      // The transcript's anchor for members whose scrolling an inner
      // viewport owns: hold this frame, then the member within it.
      data-transcript-group-frame="true"
      className="my-0 divide-y divide-divider overflow-hidden rounded-lg border border-divider bg-sidebar"
    >
      {folds ? <ToolGroupHeadLine part={part} isOpen={open} /> : null}
      {/*
        Padding lives on the rows, not the card, so the separators run the
        full width of the block rather than stopping short of its outline.
      */}
      <CollapsibleContent className="tool-group-fold-content">
        <ToolGroupBody entries={part.parts} containerId={containerId} partKey={partKey} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolGroupHeadLine({ part, isOpen }: { part: NativeToolGroupPart; isOpen: boolean }) {
  const summary = summarizeToolGroup(part.parts);
  if (!summary) return null;
  const { latestTool, toolCount, pendingCount, failureCount, spanMs } = summary;
  const latestPartId = latestTool.toolUseId ?? latestTool.sourcePartId;
  const latestName = getToolDisplayName(latestTool.toolName);
  const latestPreview = toolRowPreview(latestTool);
  const latestDetail =
    latestPreview?.text ??
    latestTool.toolDiff?.filePath?.split("/").pop() ??
    getToolTitleDisplayName(latestTool.toolTitle, latestTool.toolName);
  const latestDetailMonospace = latestPreview ? latestPreview.monospace : true;
  const countLabel = `${toolCount} tool calls`;
  const spanLabel = spanMs === undefined ? undefined : formatAgentDurationMs(spanMs);
  const virtualized = part.parts.length >= TOOL_GROUP_VIRTUALIZE_MIN_ENTRIES;
  let detail: ReactNode;
  if (isOpen) {
    detail = <span className="flex-1 truncate text-left font-medium">Tool calls</span>;
  } else {
    detail = (
      <>
        <span className="shrink-0 font-medium">{latestName}</span>
        <span
          className={cn(
            "flex-1 truncate text-left text-muted-foreground/80",
            latestDetailMonospace && "font-mono",
          )}
        >
          {latestDetail}
        </span>
      </>
    );
  }

  return (
    /*
      Folded, the line stands in for its newest call, so it carries that
      call's transcript id: a held scroll position still finds its tool. Open
      with a plain body, the call's own row carries it; open with a
      virtualized body, the frame keeps standing in for the calls whose
      scrolling the inner viewport owns.
    */
    <div
      className="px-2 py-0.5"
      data-transcript-part-id={isOpen && !virtualized ? undefined : latestPartId}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <span className="sr-only">
          {isOpen ? "Fold" : "Show"} {countLabel}:{" "}
        </span>
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", isOpen && "rotate-90")}
        />
        <Layers className="h-3.5 w-3.5 shrink-0" />
        {detail}
        {pendingCount > 0 ? (
          <span className="shrink-0 animate-pulse text-yellow-600">running...</span>
        ) : null}
        {failureCount > 0 ? (
          <span className="shrink-0 text-failure">{failureCount} failed</span>
        ) : null}
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
          {countLabel}
        </span>
        {spanLabel ? (
          <span
            className="shrink-0 tabular-nums text-[10px] text-muted-foreground/60"
            title={`First call started to last call finished: ${spanLabel}`}
          >
            {spanLabel}
          </span>
        ) : null}
      </CollapsibleTrigger>
    </div>
  );
}
