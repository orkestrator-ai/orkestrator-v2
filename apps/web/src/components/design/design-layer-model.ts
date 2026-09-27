import type { DesignHierarchyPage, DesignLayer } from "@orkestrator/protocol/design-canvas";

/**
 * Pure, immutable state for the lazily paged layer tree.
 *
 * Every frame owns a structure identity (`key`) and an `epoch`. Branches are keyed
 * by the selector whose direct children they list (`body` is the frame root).
 * A structure change drops every cached branch and bumps the epoch so late
 * responses for old paths are ignored; expanded selectors are kept only as intent
 * and are reloaded from the root, never merged with old pages.
 */

export const ROOT_BRANCH = "body";
export const LAYER_PAGE_SIZE = 200;
export const LAYER_PAGE_BYTES = 128 * 1024;
export const MAX_LOADED_ROWS = 2000;
export const MAX_LOADED_BYTES = 512 * 1024;
export const MAX_FILTER_LENGTH = 100;
export const MAX_FILTER_RESULTS = 500;
const MAX_SELECTOR_LENGTH = 2048;
const MAX_LABEL_LENGTH = 100;
const MAX_CURSOR_LENGTH = 256;
const MAX_ERROR_LENGTH = 160;

export type BranchStatus = "loading" | "loaded" | "error";

export interface LayerBranch {
  status: BranchStatus;
  layers: readonly DesignLayer[];
  nextCursor?: string;
  /** Number of direct children when the source reported it. */
  total?: number;
  truncated: boolean;
  /** Estimated retained bytes for this branch's rows. */
  bytes: number;
  /** In-flight request id; 0 when idle. */
  request: number;
  /** Monotonic use clock for least-recently-used eviction. */
  touched: number;
  error?: string;
  /** The error came from a render/structure race and may be retried automatically. */
  retryable?: boolean;
}

export interface FrameLayers {
  key: string;
  epoch: number;
  expanded: Readonly<Record<string, true>>;
  branches: Readonly<Record<string, LayerBranch>>;
  autoExpanded: boolean;
}

export interface LayerTreeState {
  frames: Readonly<Record<string, FrameLayers>>;
  clock: number;
  sequence: number;
}

export interface LayerRequest {
  frameId: string;
  branch: string;
  epoch: number;
  key: string;
  id: number;
  cursor?: string;
  append: boolean;
}

export interface BranchRef {
  frameId: string;
  branch: string;
}

export function createLayerTree(): LayerTreeState {
  return { frames: {}, clock: 0, sequence: 0 };
}

function freshFrame(
  key: string,
  epoch = 0,
  expanded: Readonly<Record<string, true>> = {},
  autoExpanded = false,
): FrameLayers {
  return { key, epoch, expanded, branches: {}, autoExpanded };
}

function withFrame(state: LayerTreeState, frameId: string, frame: FrameLayers): LayerTreeState {
  return { ...state, frames: { ...state.frames, [frameId]: frame } };
}

/**
 * Reconcile frame structure identities in canvas order. Unchanged frames keep their
 * object identity; changed identities reset that frame; removed frames are dropped.
 */
export function syncFrameKeys(
  state: LayerTreeState,
  keys: ReadonlyArray<readonly [string, string]>,
): LayerTreeState {
  let changed = Object.keys(state.frames).length !== keys.length;
  const frames: Record<string, FrameLayers> = {};
  for (const [frameId, key] of keys) {
    const existing = state.frames[frameId];
    if (existing && existing.key === key) {
      frames[frameId] = existing;
      continue;
    }
    changed = true;
    frames[frameId] = existing
      ? freshFrame(key, existing.epoch + 1, existing.expanded, existing.autoExpanded)
      : freshFrame(key);
  }
  return changed ? { ...state, frames } : state;
}

/** Drop a frame's cached branches and cursors (e.g. the runtime rejected a cursor). */
export function resetFrame(state: LayerTreeState, frameId: string): LayerTreeState {
  const frame = state.frames[frameId];
  if (!frame) return state;
  return withFrame(
    state,
    frameId,
    freshFrame(frame.key, frame.epoch + 1, frame.expanded, frame.autoExpanded),
  );
}

export function isExpanded(state: LayerTreeState, frameId: string, branch: string): boolean {
  return Boolean(state.frames[frameId]?.expanded[branch]);
}

export function setExpanded(
  state: LayerTreeState,
  frameId: string,
  branch: string,
  expanded: boolean,
): LayerTreeState {
  const frame = state.frames[frameId];
  if (!frame || Boolean(frame.expanded[branch]) === expanded) return state;
  const next = { ...frame.expanded };
  if (expanded) next[branch] = true;
  else delete next[branch];
  const clock = state.clock + 1;
  const existing = frame.branches[branch];
  const branches = existing
    ? { ...frame.branches, [branch]: { ...existing, touched: clock } }
    : frame.branches;
  return { ...withFrame(state, frameId, { ...frame, expanded: next, branches }), clock };
}

/** Branch ids that must be expanded to reveal `selector` (the frame root first). */
export function ancestorBranches(selector: string): string[] {
  const parts = selector.split(" > ");
  if (parts[0] !== ROOT_BRANCH || parts.length < 2) return [];
  const result: string[] = [];
  for (let index = 1; index < parts.length; index++) result.push(parts.slice(0, index).join(" > "));
  return result;
}

export function parentBranch(selector: string): string | undefined {
  return ancestorBranches(selector).at(-1);
}

/** Expand the frame root and every ancestor of `selector`, without expanding it. */
export function revealPath(
  state: LayerTreeState,
  frameId: string,
  selector?: string,
): LayerTreeState {
  let next = setExpanded(state, frameId, ROOT_BRANCH, true);
  if (selector)
    for (const branch of ancestorBranches(selector))
      next = setExpanded(next, frameId, branch, true);
  return next;
}

/** Expand a frame's first level once; later user collapses are respected. */
export function autoExpandOnce(state: LayerTreeState, frameId: string): LayerTreeState {
  const frame = state.frames[frameId];
  if (!frame || frame.autoExpanded) return state;
  const marked = withFrame(state, frameId, { ...frame, autoExpanded: true });
  return setExpanded(marked, frameId, ROOT_BRANCH, true);
}

export function layerBytes(layer: DesignLayer): number {
  return layer.selector.length + layer.label.length + layer.tag.length + 48;
}

export function hasChildren(layer: DesignLayer): boolean {
  return layer.childCount === undefined || layer.childCount > 0;
}

/** Whether another page can be appended without the branch alone exceeding the cache bounds. */
export function canAppend(branch: LayerBranch): boolean {
  return (
    branch.layers.length + LAYER_PAGE_SIZE <= MAX_LOADED_ROWS &&
    branch.bytes + LAYER_PAGE_BYTES <= MAX_LOADED_BYTES
  );
}

export function beginLoad(
  state: LayerTreeState,
  frameId: string,
  branch: string,
  append: boolean,
): { state: LayerTreeState; request: LayerRequest | null } {
  const frame = state.frames[frameId];
  const existing = frame?.branches[branch];
  if (!frame || existing?.status === "loading") return { state, request: null };
  if (append && (!existing || !existing.nextCursor || !canAppend(existing)))
    return { state, request: null };
  const id = state.sequence + 1;
  const clock = state.clock + 1;
  const loading: LayerBranch =
    append && existing
      ? {
          ...existing,
          status: "loading",
          request: id,
          touched: clock,
          error: undefined,
          retryable: undefined,
        }
      : { status: "loading", layers: [], truncated: false, bytes: 0, request: id, touched: clock };
  const request: LayerRequest = {
    frameId,
    branch,
    epoch: frame.epoch,
    key: frame.key,
    id,
    append,
    ...(append && existing?.nextCursor ? { cursor: existing.nextCursor } : {}),
  };
  const next = withFrame(state, frameId, {
    ...frame,
    branches: { ...frame.branches, [branch]: loading },
  });
  return { state: { ...next, sequence: id, clock }, request };
}

function currentBranch(state: LayerTreeState, request: LayerRequest): LayerBranch | undefined {
  const frame = state.frames[request.frameId];
  if (!frame || frame.epoch !== request.epoch || frame.key !== request.key) return undefined;
  const branch = frame.branches[request.branch];
  return branch && branch.request === request.id ? branch : undefined;
}

export function isCurrentRequest(state: LayerTreeState, request: LayerRequest): boolean {
  return currentBranch(state, request) !== undefined;
}

function cleanLayer(value: unknown): DesignLayer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const layer = value as Partial<DesignLayer>;
  if (
    typeof layer.selector !== "string" ||
    !layer.selector ||
    layer.selector.length > MAX_SELECTOR_LENGTH
  )
    return undefined;
  const tag = typeof layer.tag === "string" ? layer.tag.slice(0, 32) : "element";
  const label =
    typeof layer.label === "string" && layer.label ? layer.label.slice(0, MAX_LABEL_LENGTH) : tag;
  const childCount =
    typeof layer.childCount === "number" &&
    Number.isFinite(layer.childCount) &&
    layer.childCount >= 0
      ? Math.floor(layer.childCount)
      : undefined;
  return {
    selector: layer.selector,
    tag,
    label,
    depth: typeof layer.depth === "number" ? layer.depth : 1,
    ...(childCount === undefined ? {} : { childCount }),
  };
}

/**
 * Apply a page for a still-current request, then evict to the cache bounds.
 * Responses for an older epoch, structure, or superseded request are ignored.
 */
export function applyPage(
  state: LayerTreeState,
  request: LayerRequest,
  page: DesignHierarchyPage,
  protect: readonly BranchRef[] = [],
): LayerTreeState {
  const branch = currentBranch(state, request);
  if (!branch) return state;
  const frame = state.frames[request.frameId]!;
  const seen = new Set(request.append ? branch.layers.map((layer) => layer.selector) : []);
  const incoming: DesignLayer[] = [];
  for (const raw of Array.isArray(page?.layers) ? page.layers.slice(0, LAYER_PAGE_SIZE) : []) {
    const layer = cleanLayer(raw);
    if (!layer || seen.has(layer.selector)) continue;
    seen.add(layer.selector);
    incoming.push(layer);
  }
  const layers = request.append ? [...branch.layers, ...incoming] : incoming;
  const bytes = layers.reduce((sum, layer) => sum + layerBytes(layer), 0);
  const cursor =
    typeof page?.nextCursor === "string" &&
    page.nextCursor.length <= MAX_CURSOR_LENGTH &&
    incoming.length > 0
      ? page.nextCursor
      : undefined;
  const total =
    typeof page?.total === "number" && Number.isFinite(page.total) && page.total >= 0
      ? Math.floor(page.total)
      : undefined;
  const clock = state.clock + 1;
  const loaded: LayerBranch = {
    status: "loaded",
    layers,
    truncated:
      Boolean(page?.truncated) || (cursor === undefined && typeof page?.nextCursor === "string"),
    bytes,
    request: 0,
    touched: clock,
    ...(cursor ? { nextCursor: cursor } : {}),
    ...(total === undefined ? {} : { total }),
  };
  const next = {
    ...withFrame(state, request.frameId, {
      ...frame,
      branches: { ...frame.branches, [request.branch]: loaded },
    }),
    clock,
  };
  return evict(next, [{ frameId: request.frameId, branch: request.branch }, ...protect]);
}

export function failLoad(
  state: LayerTreeState,
  request: LayerRequest,
  message: string,
  retryable = false,
): LayerTreeState {
  const branch = currentBranch(state, request);
  if (!branch) return state;
  const frame = state.frames[request.frameId]!;
  const failed: LayerBranch = {
    ...branch,
    status: "error",
    request: 0,
    error: message.slice(0, MAX_ERROR_LENGTH),
    ...(retryable ? { retryable: true } : { retryable: undefined }),
  };
  return withFrame(state, request.frameId, {
    ...frame,
    branches: { ...frame.branches, [request.branch]: failed },
  });
}

/** Forget a failed branch so it is requested again. */
export function clearBranch(
  state: LayerTreeState,
  frameId: string,
  branch: string,
): LayerTreeState {
  const frame = state.frames[frameId];
  if (!frame?.branches[branch] || frame.branches[branch]!.status === "loading") return state;
  const branches = { ...frame.branches };
  delete branches[branch];
  return withFrame(state, frameId, { ...frame, branches });
}

export function loadedTotals(state: LayerTreeState): { rows: number; bytes: number } {
  let rows = 0;
  let bytes = 0;
  for (const frame of Object.values(state.frames))
    for (const branch of Object.values(frame.branches)) {
      rows += branch.layers.length;
      bytes += branch.bytes;
    }
  return { rows, bytes };
}

/** Branch ids reachable from the frame root through expanded, loaded rows. */
export function visibleBranches(frame: FrameLayers): Set<string> {
  const visible = new Set<string>();
  if (!frame.expanded[ROOT_BRANCH]) return visible;
  const stack = [ROOT_BRANCH];
  while (stack.length) {
    const id = stack.pop()!;
    if (visible.has(id)) continue;
    visible.add(id);
    for (const layer of frame.branches[id]?.layers ?? [])
      if (frame.expanded[layer.selector] && hasChildren(layer)) stack.push(layer.selector);
  }
  return visible;
}

/**
 * Evict least-recently-used branches until the cache is within bounds: branches
 * hidden by a collapsed ancestor first, then visible ones (which are collapsed so
 * they are not immediately refetched). Protected branches go last, and the first
 * protected branch (the page just applied) is never evicted.
 */
export function evict(state: LayerTreeState, protect: readonly BranchRef[] = []): LayerTreeState {
  let { rows, bytes } = loadedTotals(state);
  if (rows <= MAX_LOADED_ROWS && bytes <= MAX_LOADED_BYTES) return state;
  const protectedKeys = new Set(protect.map((ref) => `${ref.frameId}\u0000${ref.branch}`));
  const keep = protect[0] ? `${protect[0].frameId}\u0000${protect[0].branch}` : undefined;
  const candidates: Array<{ frameId: string; branch: string; data: LayerBranch; rank: number }> =
    [];
  for (const [frameId, frame] of Object.entries(state.frames)) {
    const visible = visibleBranches(frame);
    for (const [branch, data] of Object.entries(frame.branches)) {
      const key = `${frameId}\u0000${branch}`;
      if (data.status === "loading" || key === keep) continue;
      candidates.push({
        frameId,
        branch,
        data,
        rank: protectedKeys.has(key) ? 2 : visible.has(branch) ? 1 : 0,
      });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || a.data.touched - b.data.touched);
  const frames: Record<string, FrameLayers> = { ...state.frames };
  for (const candidate of candidates) {
    if (rows <= MAX_LOADED_ROWS && bytes <= MAX_LOADED_BYTES) break;
    const frame = frames[candidate.frameId]!;
    const branches = { ...frame.branches };
    delete branches[candidate.branch];
    let expanded: Record<string, true> = frame.expanded;
    if (candidate.rank > 0 && expanded[candidate.branch]) {
      expanded = { ...expanded };
      delete expanded[candidate.branch];
    }
    frames[candidate.frameId] = { ...frame, branches, expanded };
    rows -= candidate.data.layers.length;
    bytes -= candidate.data.bytes;
  }
  return { ...state, frames };
}

/**
 * Visible expanded branches that have no data yet (and, when `retry`, first pages
 * that failed for a retryable reason). Order follows `frameIds`.
 */
export function pendingLoads(
  state: LayerTreeState,
  frameIds: readonly string[],
  sourceOf: (frameId: string) => FrameSource,
  retry = false,
): BranchRef[] {
  const result: BranchRef[] = [];
  for (const frameId of frameIds) {
    const frame = state.frames[frameId];
    if (!frame || sourceOf(frameId) !== "ready") continue;
    for (const branch of visibleBranches(frame)) {
      const data = frame.branches[branch];
      if (!data || (retry && data.status === "error" && data.retryable && data.layers.length === 0))
        result.push({ frameId, branch });
    }
  }
  return result;
}

export type FrameSource = "ready" | "wait" | "unavailable";

export type LayerRow =
  | {
      kind: "frame";
      key: string;
      frameId: string;
      level: 1;
      expanded: boolean;
      posinset: number;
      setsize: number;
    }
  | {
      kind: "layer";
      key: string;
      frameId: string;
      layer: DesignLayer;
      level: number;
      expandable: boolean;
      expanded: boolean;
      posinset: number;
      setsize?: number;
    }
  | {
      kind: "more";
      key: string;
      frameId: string;
      branch: string;
      level: number;
      loaded: number;
      total?: number;
      loading: boolean;
      limited: boolean;
      blocked: boolean;
    }
  | {
      kind: "status";
      key: string;
      frameId: string;
      branch: string;
      level: number;
      state: "loading" | "wait" | "unavailable" | "error" | "empty" | "truncated";
      message: string;
    };

export function frameRowKey(frameId: string): string {
  return `${frameId}\u0000frame`;
}

export function layerRowKey(frameId: string, selector: string): string {
  return `${frameId}\u0000${selector}`;
}

function statusRow(
  frameId: string,
  branch: string,
  level: number,
  state: Extract<LayerRow, { kind: "status" }>["state"],
  message: string,
): LayerRow {
  return {
    kind: "status",
    key: `${frameId}\u0000status:${branch}`,
    frameId,
    branch,
    level,
    state,
    message,
  };
}

const UNAVAILABLE = "Bring into view to load layers";
const WAITING = "Waiting for the frame to render…";

/** Flatten frames and their visible expanded branches into tree rows. */
export function flattenRows(
  state: LayerTreeState,
  frameIds: readonly string[],
  sourceOf: (frameId: string) => FrameSource,
): LayerRow[] {
  const rows: LayerRow[] = [];
  frameIds.forEach((frameId, index) => {
    const frame = state.frames[frameId];
    const expanded = Boolean(frame?.expanded[ROOT_BRANCH]);
    rows.push({
      kind: "frame",
      key: frameRowKey(frameId),
      frameId,
      level: 1,
      expanded,
      posinset: index + 1,
      setsize: frameIds.length,
    });
    if (!frame || !expanded) return;
    const source = sourceOf(frameId);
    const walk = (branchId: string, level: number) => {
      const branch = frame.branches[branchId];
      if (!branch) {
        rows.push(
          source === "ready"
            ? statusRow(frameId, branchId, level, "loading", "Loading layers…")
            : statusRow(
                frameId,
                branchId,
                level,
                source,
                source === "wait" ? WAITING : UNAVAILABLE,
              ),
        );
        return;
      }
      const setsize = branch.total ?? (branch.nextCursor ? undefined : branch.layers.length);
      branch.layers.forEach((layer, position) => {
        const expandable = hasChildren(layer);
        const open = expandable && Boolean(frame.expanded[layer.selector]);
        rows.push({
          kind: "layer",
          key: layerRowKey(frameId, layer.selector),
          frameId,
          layer,
          level,
          expandable,
          expanded: open,
          posinset: position + 1,
          ...(setsize === undefined ? {} : { setsize }),
        });
        if (open) walk(layer.selector, level + 1);
      });
      if (branch.status === "loading")
        rows.push(statusRow(frameId, branchId, level, "loading", "Loading layers…"));
      else if (branch.status === "error")
        rows.push(
          statusRow(frameId, branchId, level, "error", branch.error ?? "Could not load layers"),
        );
      else if (branch.layers.length === 0 && !branch.nextCursor)
        rows.push(statusRow(frameId, branchId, level, "empty", "No child elements"));
      if (branch.nextCursor && branch.status !== "loading")
        rows.push({
          kind: "more",
          key: `${frameId}\u0000more:${branchId}`,
          frameId,
          branch: branchId,
          level,
          loaded: branch.layers.length,
          ...(branch.total === undefined ? {} : { total: branch.total }),
          loading: false,
          limited: !canAppend(branch),
          blocked: source !== "ready",
        });
      else if (branch.truncated && !branch.nextCursor && branch.status === "loaded")
        rows.push(
          statusRow(
            frameId,
            branchId,
            level,
            "truncated",
            "Some layers were omitted by the hierarchy limit",
          ),
        );
    };
    walk(ROOT_BRANCH, 2);
  });
  return rows;
}

/**
 * Search only already-loaded rows (expanded or not). Bounded by query length and
 * result count; callers must present results as scoped to loaded content.
 */
export function filterLoadedRows(
  state: LayerTreeState,
  frameIds: readonly string[],
  query: string,
): { rows: LayerRow[]; matches: number; searched: number; limited: boolean } {
  const needle = query.trim().slice(0, MAX_FILTER_LENGTH).toLowerCase();
  const rows: LayerRow[] = [];
  let matches = 0;
  let searched = 0;
  let limited = false;
  frameIds.forEach((frameId, index) => {
    const frame = state.frames[frameId];
    if (!frame) return;
    const found: DesignLayer[] = [];
    const visited = new Set<string>();
    const walk = (branchId: string) => {
      if (visited.has(branchId)) return;
      visited.add(branchId);
      for (const layer of frame.branches[branchId]?.layers ?? []) {
        searched++;
        if (
          layer.label.toLowerCase().includes(needle) ||
          layer.tag.toLowerCase().includes(needle)
        ) {
          if (matches >= MAX_FILTER_RESULTS) limited = true;
          else {
            matches++;
            found.push(layer);
          }
        }
        if (frame.branches[layer.selector]) walk(layer.selector);
      }
    };
    walk(ROOT_BRANCH);
    if (!found.length) return;
    rows.push({
      kind: "frame",
      key: frameRowKey(frameId),
      frameId,
      level: 1,
      expanded: true,
      posinset: index + 1,
      setsize: frameIds.length,
    });
    found.forEach((layer, position) =>
      rows.push({
        kind: "layer",
        key: layerRowKey(frameId, layer.selector),
        frameId,
        layer,
        level: 2,
        expandable: false,
        expanded: false,
        posinset: position + 1,
        setsize: found.length,
      }),
    );
  });
  return { rows, matches, searched, limited };
}
