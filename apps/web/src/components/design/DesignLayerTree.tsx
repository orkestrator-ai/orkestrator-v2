import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import type { DesignFrame, DesignHierarchyPage } from "@orkestrator/protocol/design-canvas";
import type { DesignFrameMeta } from "@orkestrator/protocol/design-operations";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { designApi } from "./design-client";
import type { DesignFrameAction } from "./design-canvas-context";
import {
  applyPage,
  autoExpandOnce,
  beginLoad,
  clearBranch,
  createLayerTree,
  failLoad,
  filterLoadedRows,
  flattenRows,
  frameRowKey,
  isCurrentRequest,
  layerRowKey,
  loadedTotals,
  LAYER_PAGE_SIZE,
  MAX_FILTER_LENGTH,
  MAX_LOADED_ROWS,
  MAX_FILTER_RESULTS,
  parentBranch,
  pendingLoads,
  resetFrame,
  revealPath,
  ROOT_BRANCH,
  setExpanded,
  syncFrameKeys,
  type BranchRef,
  type FrameSource,
  type LayerRequest,
  type LayerRow,
  type LayerTreeState,
} from "./design-layer-model";
import type { DesignSelection } from "./design-selection";
import type { DesignFrameBridge } from "./frame-bridge";

export const LAYER_ROW_HEIGHT = 24;
const OVERSCAN_ROWS = 8;
const DEFAULT_VIEWPORT_HEIGHT = 480;
const AUTO_EXPAND_FRAME_LIMIT = 4;

export type HierarchyQuery = {
  rootSelector?: string;
  cursor?: string;
  maxNodes?: number;
  maxDepth?: number;
};
export type HierarchyLoader = (
  environmentId: string,
  canvasId: string,
  frameId: string,
  query: HierarchyQuery,
) => Promise<{ revision?: number; structureId?: string; page: DesignHierarchyPage }>;

export interface DesignLayerTreeProps {
  environmentId: string;
  canvasId: string;
  frames: DesignFrame[];
  metas: Record<string, DesignFrameMeta>;
  legacy: boolean;
  getBridge: (frameId: string) => DesignFrameBridge | undefined;
  liveFrames: ReadonlySet<string>;
  renderedVersion: number;
  selection: DesignSelection | null;
  focusedFrameId: string | null;
  onFocusFrame: (frameId: string) => void;
  onSelectElement: (frameId: string, selector: string) => void;
  onFrameAction: (frameId: string, action: DesignFrameAction) => void;
  /** Frames with an unsettled optimistic edit; labelled "(saving)". */
  pendingFrames?: ReadonlySet<string>;
  /** Backend hierarchy source for frames without a live, current iframe. Defaults to `designApi.hierarchy`. */
  loadHierarchy?: HierarchyLoader;
}

class StaleHierarchyError extends Error {}

function contentKey(frame: DesignFrame, meta: DesignFrameMeta | undefined): string {
  return meta?.contentId ?? `revision:${frame.revision}`;
}

function structureKey(
  frame: DesignFrame,
  meta: DesignFrameMeta | undefined,
  legacy: boolean,
): string {
  return !legacy && meta ? `structure:${meta.structureId}` : `content:${contentKey(frame, meta)}`;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message ? `Could not load layers: ${message}` : "Could not load layers";
}

function frameStates(meta: DesignFrameMeta | undefined, pending: boolean): string[] {
  const states: string[] = [];
  if (pending) states.push("saving");
  const validation = meta?.validation.state;
  if (validation === "invalid") states.push("needs repair");
  else if (validation === "validating") states.push("validating");
  else if (validation === "renderer-unavailable") states.push("renderer unavailable");
  return states;
}

function parentRowIndex(rows: readonly LayerRow[], index: number): number {
  const level = rows[index]!.level;
  for (let cursor = index - 1; cursor >= 0; cursor--)
    if (rows[cursor]!.level < level) return cursor;
  return -1;
}

export function DesignLayerTree(props: DesignLayerTreeProps) {
  const {
    canvasId,
    frames,
    metas,
    legacy,
    liveFrames,
    renderedVersion,
    selection,
    focusedFrameId,
    pendingFrames,
    onFocusFrame,
    onSelectElement,
    onFrameAction,
  } = props;
  const latest = useRef(props);
  latest.current = props;
  const treeRef = useRef<LayerTreeState>(createLayerTree());
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);
  const commit = useCallback((next: LayerTreeState) => {
    if (next === treeRef.current) return;
    treeRef.current = next;
    if (mounted.current) setVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const frameIds = useMemo(() => frames.map((frame) => frame.id), [frames]);
  const frameById = useMemo(() => new Map(frames.map((frame) => [frame.id, frame])), [frames]);

  // Structure identity per frame: a change drops the frame's cached branches and cursors.
  const identities = useMemo(
    () => frames.map((frame) => [frame.id, structureKey(frame, metas[frame.id], legacy)] as const),
    [frames, metas, legacy],
  );
  // Derived synchronously so a structure change never renders old paths for a frame.
  treeRef.current = syncFrameKeys(treeRef.current, identities);
  const tree = treeRef.current;

  const sourceOf = useCallback((frameId: string): FrameSource | "bridge" | "backend" => {
    const current = latest.current;
    const frame = current.frames.find((candidate) => candidate.id === frameId);
    if (!frame) return "unavailable";
    const bridge = current.getBridge(frameId);
    if (
      bridge &&
      !bridge.closed &&
      bridge.renderedContentId === contentKey(frame, current.metas[frameId])
    )
      return "bridge";
    if (current.liveFrames.has(frameId)) return "wait";
    return current.legacy ? "unavailable" : "backend";
  }, []);
  const readiness = useCallback(
    (frameId: string): FrameSource => {
      const source = sourceOf(frameId);
      return source === "bridge" || source === "backend" ? "ready" : source;
    },
    [sourceOf],
  );

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const activeFrame = useRef<string | null>(null);
  const selectionKey = selection
    ? layerRowKey(selection.frameId, selection.element.selector)
    : null;

  const protectedBranches = useCallback((): BranchRef[] => {
    const refs: BranchRef[] = [];
    const current = latest.current.selection;
    if (current) {
      const branch = parentBranch(current.element.selector);
      if (branch) refs.push({ frameId: current.frameId, branch });
    }
    // Keep the branch holding the keyboard-active row so focus is not evicted from under the user.
    const active = activeKeyRef.current;
    const separator = active?.indexOf("\u0000") ?? -1;
    if (active && separator > 0) {
      const branch = parentBranch(active.slice(separator + 1));
      if (branch) refs.push({ frameId: active.slice(0, separator), branch });
    }
    return refs;
  }, []);

  const startLoad = useCallback(
    (frameId: string, branch: string, append: boolean) => {
      const frame = latest.current.frames.find((candidate) => candidate.id === frameId);
      const source = sourceOf(frameId);
      if (!frame || (source !== "bridge" && source !== "backend")) return;
      const started = beginLoad(treeRef.current, frameId, branch, append);
      if (!started.request) return;
      const request: LayerRequest = started.request;
      commit(started.state);
      const query = {
        ...(branch === ROOT_BRANCH ? {} : { rootSelector: branch }),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        maxNodes: LAYER_PAGE_SIZE,
        maxDepth: 1,
      };
      const current = latest.current;
      const key = contentKey(frame, current.metas[frameId]);
      let pending: Promise<DesignHierarchyPage>;
      if (source === "bridge") {
        const bridge = current.getBridge(frameId)!;
        pending = bridge
          .ask<DesignHierarchyPage>({ op: "hierarchyPage", ...query })
          .then((page) => {
            if (bridge.renderedContentId !== key)
              throw new StaleHierarchyError("Frame re-rendered");
            return page;
          });
      } else {
        const loader = current.loadHierarchy ?? designApi.hierarchy;
        const expected = current.metas[frameId]?.structureId;
        pending = loader(current.environmentId, current.canvasId, frameId, query).then((result) => {
          if (expected && result.structureId && result.structureId !== expected)
            throw new StaleHierarchyError("Layers changed while loading");
          return result.page;
        });
      }
      pending.then(
        (page) => commit(applyPage(treeRef.current, request, page, protectedBranches())),
        (error: unknown) => {
          if (!isCurrentRequest(treeRef.current, request)) return;
          if (error instanceof StaleHierarchyError) {
            commit(
              failLoad(
                treeRef.current,
                request,
                "Layers changed; reloading after the next render",
                true,
              ),
            );
            return;
          }
          if (error instanceof Error && error.message.includes("Hierarchy changed")) {
            // The cursor belongs to an older structure: restart the frame from its root.
            commit(resetFrame(treeRef.current, frameId));
            return;
          }
          commit(failLoad(treeRef.current, request, errorMessage(error)));
        },
      );
    },
    [commit, protectedBranches, sourceOf],
  );

  // Auto-expansion: selection/focus reveal their frame; small canvases open live frames once.
  const selectionFrame = selection?.frameId;
  const selectionSelector = selection?.element.selector;
  useLayoutEffect(() => {
    if (!selectionFrame) return;
    commit(revealPath(treeRef.current, selectionFrame, selectionSelector));
    setActiveKey(layerRowKey(selectionFrame, selectionSelector ?? ""));
    activeFrame.current = selectionFrame;
  }, [commit, selectionFrame, selectionSelector]);
  useLayoutEffect(() => {
    if (focusedFrameId) commit(setExpanded(treeRef.current, focusedFrameId, ROOT_BRANCH, true));
  }, [commit, focusedFrameId]);
  useLayoutEffect(() => {
    if (frameIds.length > AUTO_EXPAND_FRAME_LIMIT) return;
    let next = treeRef.current;
    for (const frameId of frameIds)
      if (liveFrames.has(frameId)) next = autoExpandOnce(next, frameId);
    commit(next);
  }, [commit, frameIds, liveFrames]);

  // Request missing visible branches; after a render, also retry first pages that lost a render race.
  const lastRendered = useRef(renderedVersion);
  useEffect(() => {
    const retry = lastRendered.current !== renderedVersion;
    lastRendered.current = renderedVersion;
    let state = treeRef.current;
    const loads = pendingLoads(state, frameIds, readiness, retry);
    for (const load of loads) {
      state = clearBranch(state, load.frameId, load.branch);
    }
    if (state !== treeRef.current) commit(state);
    for (const load of loads) startLoad(load.frameId, load.branch, false);
  }, [commit, frameIds, liveFrames, readiness, renderedVersion, startLoad, version, metas, legacy]);

  // Rows: filtered (loaded rows only) or the expanded tree.
  const [filter, setFilter] = useState("");
  const filtering = filter.trim().length > 0;
  const filtered = useMemo(
    () => (filtering ? filterLoadedRows(tree, frameIds, filter) : null),
    [filtering, tree, frameIds, filter],
  );
  // Readiness reads bridges through a ref; this snapshot makes it a real memo input.
  const sourceKey = frameIds.map((frameId) => readiness(frameId)).join(",");
  const rows = useMemo(() => {
    if (filtered) return filtered.rows;
    const sources = sourceKey.split(",");
    const byFrame = new Map(
      frameIds.map((frameId, index) => [frameId, sources[index] as FrameSource]),
    );
    return flattenRows(tree, frameIds, (frameId) => byFrame.get(frameId) ?? "unavailable");
  }, [filtered, tree, frameIds, sourceKey]);
  const indexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);

  // Roving tabindex target: the active row, else its frame, else the selection, else the first row.
  let activeIndex = activeKey !== null ? (indexByKey.get(activeKey) ?? -1) : -1;
  if (activeIndex < 0 && activeFrame.current)
    activeIndex = indexByKey.get(frameRowKey(activeFrame.current)) ?? -1;
  if (activeIndex < 0 && selectionKey) activeIndex = indexByKey.get(selectionKey) ?? -1;
  if (activeIndex < 0 && rows.length) activeIndex = 0;
  const activeRowKey = activeIndex >= 0 ? rows[activeIndex]!.key : null;
  const selectedIndex = selectionKey ? (indexByKey.get(selectionKey) ?? -1) : -1;

  // Windowing: fixed row height, overscan, plus the active and selected rows always mounted.
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewportHeight(element.clientHeight || DEFAULT_VIEWPORT_HEIGHT);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scrollTop / LAYER_ROW_HEIGHT) - OVERSCAN_ROWS);
  const last = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / LAYER_ROW_HEIGHT) + OVERSCAN_ROWS,
  );
  const mountedIndexes: number[] = [];
  for (let index = first; index < last; index++) mountedIndexes.push(index);
  for (const pinned of [activeIndex, selectedIndex])
    if (pinned >= 0 && (pinned < first || pinned >= last) && !mountedIndexes.includes(pinned))
      mountedIndexes.push(pinned);
  mountedIndexes.sort((a, b) => a - b);

  // Focus management: move DOM focus deliberately and restore it if the focused row vanished.
  const rowElements = useRef(new Map<string, HTMLElement>());
  const focusRequest = useRef<string | null>(null);
  const focusWithin = useRef(false);
  useLayoutEffect(() => {
    const target = focusRequest.current;
    focusRequest.current = null;
    const container = scroller.current;
    if (target) {
      rowElements.current.get(target)?.focus();
      return;
    }
    if (!focusWithin.current || !container || !activeRowKey) return;
    const active = document.activeElement;
    if (!active || active === document.body || !container.contains(active))
      rowElements.current.get(activeRowKey)?.focus();
  });

  const ensureVisible = useCallback(
    (index: number) => {
      const element = scroller.current;
      const top = index * LAYER_ROW_HEIGHT;
      let next = scrollTop;
      if (top < scrollTop) next = top;
      else if (top + LAYER_ROW_HEIGHT > scrollTop + viewportHeight)
        next = top + LAYER_ROW_HEIGHT - viewportHeight;
      if (next === scrollTop) return;
      if (element) element.scrollTop = next;
      setScrollTop(next);
    },
    [scrollTop, viewportHeight],
  );

  const moveTo = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setActiveKey(row.key);
      activeFrame.current = row.frameId;
      focusRequest.current = row.key;
      ensureVisible(index);
    },
    [ensureVisible, rows],
  );

  // Bring the selection into view once its row is loaded.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!selectionKey || revealed.current === selectionKey || selectedIndex < 0) return;
    revealed.current = selectionKey;
    ensureVisible(selectedIndex);
  }, [ensureVisible, selectedIndex, selectionKey]);

  const toggle = useCallback(
    (frameId: string, branch: string, expanded: boolean) => {
      commit(setExpanded(treeRef.current, frameId, branch, expanded));
    },
    [commit],
  );

  const [menuFrame, setMenuFrame] = useState<string | null>(null);

  const activate = useCallback(
    (row: LayerRow) => {
      setActiveKey(row.key);
      activeFrame.current = row.frameId;
      if (row.kind === "frame") onFocusFrame(row.frameId);
      else if (row.kind === "layer") onSelectElement(row.frameId, row.layer.selector);
      else if (row.kind === "more") startLoad(row.frameId, row.branch, true);
      else if (row.kind === "status" && row.state === "unavailable") onFocusFrame(row.frameId);
      else if (row.kind === "status" && row.state === "error") {
        const branch = treeRef.current.frames[row.frameId]?.branches[row.branch];
        const append = Boolean(branch && branch.layers.length > 0 && branch.nextCursor);
        if (append) startLoad(row.frameId, row.branch, true);
        else {
          commit(clearBranch(treeRef.current, row.frameId, row.branch));
        }
      }
    },
    [commit, onFocusFrame, onSelectElement, startLoad],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Menus rendered in portals still bubble React events here; only handle keys from the tree itself.
    if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
    // The row that received the key wins over the remembered active row.
    const origin = event.target.closest('[role="treeitem"]')?.getAttribute("data-row-key");
    const currentIndex = origin ? (indexByKey.get(origin) ?? activeIndex) : activeIndex;
    if (currentIndex < 0) return;
    const row = rows[currentIndex]!;
    const expandable = row.kind === "frame" || (row.kind === "layer" && row.expandable);
    const expanded = row.kind === "frame" || row.kind === "layer" ? row.expanded : false;
    const branch =
      row.kind === "frame" ? ROOT_BRANCH : row.kind === "layer" ? row.layer.selector : null;
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        moveTo(Math.min(rows.length - 1, currentIndex + 1));
        break;
      case "ArrowUp":
        moveTo(Math.max(0, currentIndex - 1));
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (expandable && !expanded && branch !== null && !filtering)
          toggle(row.frameId, branch, true);
        else if (expanded && rows[currentIndex + 1] && rows[currentIndex + 1]!.level > row.level)
          moveTo(currentIndex + 1);
        break;
      case "ArrowLeft":
        if (expandable && expanded && branch !== null && !filtering)
          toggle(row.frameId, branch, false);
        else {
          const parent = parentRowIndex(rows, currentIndex);
          if (parent >= 0) moveTo(parent);
        }
        break;
      case "Enter":
      case " ":
        activate(row);
        break;
      case "ContextMenu":
      case "F10":
        if (row.kind === "frame" && (event.key === "ContextMenu" || event.shiftKey))
          setMenuFrame(row.frameId);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const loaded = useMemo(() => loadedTotals(tree).rows, [tree]);

  const renderRow = (row: LayerRow, index: number): ReactNode => {
    const tabIndex = row.key === activeRowKey ? 0 : -1;
    const common = {
      role: "treeitem" as const,
      tabIndex,
      "aria-level": row.level,
      "data-row-key": row.key,
      ref: (element: HTMLDivElement | null) => {
        if (element) rowElements.current.set(row.key, element);
        else rowElements.current.delete(row.key);
      },
      onFocus: () => {
        if (row.key !== activeRowKey) {
          setActiveKey(row.key);
          activeFrame.current = row.frameId;
        }
      },
      className:
        "absolute inset-x-0 flex items-center gap-1 rounded-sm pr-1 outline-none focus-visible:ring-1 focus-visible:ring-ring",
      style: {
        top: index * LAYER_ROW_HEIGHT,
        height: LAYER_ROW_HEIGHT,
        paddingLeft: 4 + Math.min(row.level - 1, 12) * 10,
      },
    };
    if (row.kind === "frame") {
      const frame = frameById.get(row.frameId)!;
      const meta = metas[row.frameId];
      const states = frameStates(meta, Boolean(pendingFrames?.has(row.frameId)));
      const count = meta?.validation.elementCount;
      const label = `${frame.name}${states.map((state) => ` (${state})`).join("")}${
        count === undefined ? "" : `, ${count} ${count === 1 ? "element" : "elements"}`
      }`;
      return (
        <div
          key={row.key}
          {...common}
          aria-label={label}
          aria-expanded={row.expanded}
          aria-setsize={row.setsize}
          aria-posinset={row.posinset}
          aria-selected={!selection && focusedFrameId === row.frameId}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuFrame(row.frameId);
          }}
        >
          <span
            aria-hidden
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => !filtering && toggle(row.frameId, ROOT_BRANCH, !row.expanded)}
          >
            {row.expanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </span>
          <button
            type="button"
            tabIndex={-1}
            className="min-w-0 flex-1 truncate text-left font-medium"
            onClick={() => activate(row)}
          >
            {frame.name}
          </button>
          {states.length > 0 && (
            <span
              aria-hidden
              className={
                states.includes("needs repair")
                  ? "shrink-0 text-destructive"
                  : "shrink-0 text-muted-foreground"
              }
            >
              {states.join(", ")}
            </span>
          )}
          {count !== undefined && (
            <span aria-hidden className="shrink-0 tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
          <DropdownMenu
            open={menuFrame === row.frameId}
            onOpenChange={(open) => setMenuFrame(open ? row.frameId : null)}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Frame actions for ${frame.name}`}
                className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted"
              >
                <MoreHorizontal className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onFrameAction(row.frameId, "rename")}>
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onFrameAction(row.frameId, "duplicate")}>
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onFrameAction(row.frameId, "properties")}>
                Properties
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onFrameAction(row.frameId, "ask-agent")}>
                Ask agent
              </DropdownMenuItem>
              {meta?.validation.state === "invalid" && (
                <DropdownMenuItem onSelect={() => onFrameAction(row.frameId, "retry-validation")}>
                  Retry validation
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onFrameAction(row.frameId, "delete")}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      );
    }
    if (row.kind === "layer") {
      const selected = row.key === selectionKey;
      const { layer } = row;
      return (
        <div
          key={row.key}
          {...common}
          aria-label={layer.label === layer.tag ? layer.label : `${layer.label} (${layer.tag})`}
          aria-expanded={row.expandable && !filtering ? row.expanded : undefined}
          aria-selected={selected}
          aria-setsize={row.setsize}
          aria-posinset={row.posinset}
          data-selected={selected || undefined}
          className={`${common.className} ${selected ? "bg-muted" : "hover:bg-muted/60"}`}
        >
          {row.expandable && !filtering ? (
            <span
              aria-hidden
              className="flex size-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggle(row.frameId, layer.selector, !row.expanded)}
            >
              {row.expanded ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
            </span>
          ) : (
            <span aria-hidden className="size-4 shrink-0" />
          )}
          <button
            type="button"
            tabIndex={-1}
            className="min-w-0 flex-1 truncate text-left"
            onClick={() => activate(row)}
          >
            {layer.label}
          </button>
          {layer.label !== layer.tag && (
            <span aria-hidden className="shrink-0 text-[10px] text-muted-foreground">
              {layer.tag}
            </span>
          )}
        </div>
      );
    }
    if (row.kind === "more") {
      const summary =
        row.total === undefined ? `Showing ${row.loaded}` : `Showing ${row.loaded} of ${row.total}`;
      const reason = row.limited
        ? `Limit of ${MAX_LOADED_ROWS} loaded layers reached`
        : row.blocked
          ? "Bring the frame into view to load more"
          : "";
      return (
        <div key={row.key} {...common} aria-label={`${summary}${reason ? `. ${reason}` : ""}`}>
          <span aria-hidden className="size-4 shrink-0" />
          <button
            type="button"
            tabIndex={-1}
            disabled={row.limited || row.blocked}
            className="shrink-0 rounded-sm px-1 text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
            onClick={() => activate(row)}
          >
            Load more
          </button>
          <span className="min-w-0 truncate text-muted-foreground">
            {summary}
            {reason ? ` · ${reason}` : ""}
          </span>
        </div>
      );
    }
    return (
      <div
        key={row.key}
        {...common}
        aria-label={row.message}
        aria-busy={row.state === "loading" || row.state === "wait" || undefined}
      >
        <span aria-hidden className="size-4 shrink-0" />
        <span
          className={`min-w-0 truncate ${row.state === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {row.message}
        </span>
        {row.state === "error" && (
          <button
            type="button"
            tabIndex={-1}
            className="shrink-0 px-1 text-primary hover:underline"
            onClick={() => activate(row)}
          >
            Retry
          </button>
        )}
        {row.state === "unavailable" && (
          <button
            type="button"
            tabIndex={-1}
            className="shrink-0 px-1 text-primary hover:underline"
            onClick={() => activate(row)}
          >
            Show
          </button>
        )}
      </div>
    );
  };

  return (
    <nav aria-label="Design hierarchy" className="flex min-w-0 flex-1 flex-col p-2 text-xs">
      <h3 className="mb-2 text-muted-foreground">Layers</h3>
      <input
        type="search"
        value={filter}
        maxLength={MAX_FILTER_LENGTH}
        onChange={(event) => setFilter(event.target.value.slice(0, MAX_FILTER_LENGTH))}
        placeholder="Filter loaded layers"
        aria-label="Filter loaded layers"
        aria-describedby={`${canvasId}-layer-filter-scope`}
        className="mb-1 h-6 w-full rounded-sm border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <p
        id={`${canvasId}-layer-filter-scope`}
        className="mb-1 text-[10px] text-muted-foreground"
        aria-live="polite"
      >
        {filtered
          ? `${filtered.matches}${filtered.limited ? "+" : ""} matches in ${filtered.searched} loaded layers${
              filtered.limited ? ` (first ${MAX_FILTER_RESULTS} shown)` : ""
            }. Only loaded layers are searched.`
          : `Filter searches only loaded layers (${loaded} loaded).`}
      </p>
      <div
        ref={scroller}
        role="tree"
        aria-label="Layers"
        className="relative min-h-0 flex-1 overflow-auto"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          focusWithin.current = true;
        }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          if (next) {
            focusWithin.current = false;
            return;
          }
          // Focus left without a destination: either the user clicked elsewhere, or the
          // focused row was unmounted (collapse/reset). Only the latter restores focus.
          const blurred = event.target;
          queueMicrotask(() => {
            if (blurred.isConnected) focusWithin.current = false;
          });
        }}
      >
        <div className="relative" style={{ height: rows.length * LAYER_ROW_HEIGHT }}>
          {mountedIndexes.map((index) => renderRow(rows[index]!, index))}
        </div>
      </div>
      {frames.length === 0 && <p className="text-muted-foreground">No frames yet</p>}
    </nav>
  );
}
