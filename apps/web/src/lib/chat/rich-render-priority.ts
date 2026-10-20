/**
 * Visible-first scheduling for rich rendering.
 *
 * Virtuoso renders rows a little beyond the viewport (`increaseViewportBy`),
 * so a mounted rich block is not necessarily on screen. Each transcript row
 * publishes whether it intersects the scroller's viewport; rich render hooks
 * read it and request `"visible"` priority for on-screen rows and
 * `"prefetch"` (idle prefetch, after all visible work) for overscan rows.
 *
 * Rich blocks are observed individually as well, so a long row whose first
 * code block is on screen does not request visible work for blocks further
 * down it: each CodeBlock/MermaidBlock registers its frame element with the
 * same transcript observer (`useRichBlockVisibility`) and requests
 * `"visible"` only while that block intersects; a queued prefetch is
 * promoted when the block scrolls in. Until the observer has answered for a
 * block, the block follows its row.
 *
 * One IntersectionObserver per transcript observes only mounted rows and
 * mounted rich blocks, so the observation set is bounded by Virtuoso's
 * render window; block registrations are additionally capped
 * (`MAX_OBSERVED_BLOCKS`), and a block beyond the cap simply follows its row.
 * It uses the implicit root: intersection is clipped by the scroller, so a
 * row or block in Virtuoso's overscan does not intersect. Outside a
 * transcript (previews, dialogs, tests) everything is visible.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type RefCallback,
} from "react";
import type { RichRenderPriority } from "./rich-render-cache";

export interface RichRowVisibility {
  subscribe: (listener: () => void) => () => void;
  visible: () => boolean;
  /** The transcript's shared block observer; absent outside a transcript. */
  blocks?: RichBlockObserver;
}

/** A rich block's own visibility, observed once its element is attached. */
export interface RichBlockVisibility extends RichRowVisibility {
  /** Observe the block's element; returns the unobserve function. */
  attach: (element: Element) => () => void;
}

export interface RichBlockObserver {
  /**
   * A block inside `row`. Creating one registers nothing; only `attach`
   * observes, so it is safe to call while rendering.
   */
  block: (row: RichRowVisibility) => RichBlockVisibility;
}

/** Upper bound on individually observed blocks per transcript. */
export const MAX_OBSERVED_BLOCKS = 256;

export const RichRowVisibilityContext = createContext<RichRowVisibility | null>(null);

const ALWAYS_VISIBLE: RichRowVisibility = {
  subscribe: () => () => {},
  visible: () => true,
};

/**
 * Render priority for rich work in the current transcript row: the value
 * (re-rendering when it changes) plus a reader for the current value, for
 * effects that request work after the row's first visibility check.
 */
export function useRichRenderPriority(override?: RichRowVisibility | null): {
  priority: RichRenderPriority;
  current: () => RichRenderPriority;
} {
  const row = useContext(RichRowVisibilityContext);
  const source = override ?? row ?? ALWAYS_VISIBLE;
  const visible = useSyncExternalStore(source.subscribe, source.visible, source.visible);
  return {
    priority: visible ? "visible" : "prefetch",
    current: () => (source.visible() ? "visible" : "prefetch"),
  };
}

/**
 * Visibility for one rich block: the block's own intersection once observed,
 * its row's until then (and outside a transcript, always visible). Pass
 * `observe` as the ref of an element inside the block; the block's frame
 * (`[data-rich-block]`) is what is observed. Pass `visibility` to
 * `useRichRenderPriority` (or a hook that forwards it) so render requests and
 * promotion follow the block rather than the whole row.
 */
export function useRichBlockVisibility(): {
  /** Callback ref for an element inside the block. */
  observe: RefCallback<Element>;
  visibility: RichRowVisibility | null;
} {
  const row = useContext(RichRowVisibilityContext);
  const block = useMemo(() => (row?.blocks ? row.blocks.block(row) : null), [row]);
  const observe = useCallback<RefCallback<Element>>(
    (element) => {
      if (!element || !block) return;
      return block.attach(element.closest("[data-rich-block]") ?? element);
    },
    [block],
  );
  return { observe, visibility: block };
}

class BlockVisibility implements RichBlockVisibility {
  /** Own intersection; null until the observer (or layout) has answered. */
  own: boolean | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly row: RichRowVisibility,
    private readonly tracker: TranscriptRowVisibilityTracker,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const offRow = this.row.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      offRow();
    };
  };

  visible = () => this.own ?? this.row.visible();

  attach = (element: Element) => this.tracker.observeBlock(this, element);

  set(next: boolean | null): void {
    if (next === this.own) return;
    const before = this.visible();
    this.own = next;
    if (this.visible() === before) return;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

class RowVisibility implements RichRowVisibility {
  private value = true;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly onEmpty: (row: RowVisibility) => void,
    readonly blocks: RichBlockObserver,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.onEmpty(this);
    };
  };

  visible = () => this.value;

  set(next: boolean): void {
    if (next === this.value) return;
    this.value = next;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

/**
 * Tracks which mounted rows of one transcript intersect its viewport. Rows
 * start "visible" until the observer reports otherwise, so first paint never
 * waits on prefetch ordering.
 */
export class TranscriptRowVisibilityTracker implements RichBlockObserver {
  private observer: IntersectionObserver | null = null;
  private readonly rows = new Map<string, RowVisibility>();
  private readonly elements = new Map<string, Element>();
  private readonly keysByElement = new WeakMap<Element, string>();
  /** Observed block elements (one block per element). */
  private readonly blockElements = new Map<Element, BlockVisibility>();

  /** Content-free counters for tests and diagnostics. */
  stats(): { observed: number; tracked: number; blocks: number } {
    return {
      observed: this.elements.size,
      tracked: this.rows.size,
      blocks: this.blockElements.size,
    };
  }

  private ensureObserver(): IntersectionObserver | null {
    if (this.observer) return this.observer;
    if (typeof IntersectionObserver === "undefined") return null;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const block = this.blockElements.get(entry.target);
          if (block) {
            block.set(entry.isIntersecting);
            continue;
          }
          const key = this.keysByElement.get(entry.target);
          if (key !== undefined) this.rows.get(key)?.set(entry.isIntersecting);
        }
      },
      { threshold: 0 },
    );
    return this.observer;
  }

  block(row: RichRowVisibility): RichBlockVisibility {
    return new BlockVisibility(row, this);
  }

  /**
   * Observe one block's element with the transcript's observer. Over the
   * bound, the block is not observed and keeps following its row.
   */
  observeBlock(block: BlockVisibility, element: Element): () => void {
    const existing = this.blockElements.get(element);
    if (existing && existing !== block) return () => {};
    if (!existing && this.blockElements.size >= MAX_OBSERVED_BLOCKS) return () => {};
    this.blockElements.set(element, block);
    const initial = this.intersectsRoot(element);
    if (initial !== null) block.set(initial);
    this.ensureObserver()?.observe(element);
    return () => {
      if (this.blockElements.get(element) !== block) return;
      this.blockElements.delete(element);
      this.observer?.unobserve(element);
      // Detached: follow the row again until observed anew.
      block.set(null);
    };
  }

  /** The visibility source for one row key (shared by every block in it). */
  source(key: string): RichRowVisibility {
    return this.row(key);
  }

  private row(key: string): RowVisibility {
    let row = this.rows.get(key);
    if (!row) {
      row = new RowVisibility((empty) => {
        if (this.rows.get(key) === empty && !this.elements.has(key)) this.rows.delete(key);
      }, this);
      this.rows.set(key, row);
    }
    return row;
  }

  /** Observe a mounted row element; returns the unobserve function. */
  observe(key: string, element: Element): () => void {
    const previous = this.elements.get(key);
    if (previous && previous !== element) this.observer?.unobserve(previous);
    this.elements.set(key, element);
    this.keysByElement.set(element, key);
    // A synchronous first answer (layout is clean when a row's ref attaches),
    // so the row's first render requests already carry the right priority;
    // the observer keeps it current while scrolling.
    const initial = this.intersectsRoot(element);
    if (initial !== null) this.row(key).set(initial);
    this.ensureObserver()?.observe(element);
    return () => {
      if (this.elements.get(key) !== element) return;
      this.elements.delete(key);
      this.observer?.unobserve(element);
      // A row that leaves the render window keeps no state behind.
      this.rows.get(key)?.set(true);
      this.rows.delete(key);
    };
  }

  private intersectsRoot(element: Element): boolean | null {
    const scroller = element.closest("[data-virtuoso-scroller]");
    if (!scroller) return null;
    const rect = element.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    // No layout (detached, hidden, or a DOM without geometry): no opinion.
    if (viewport.height === 0 && viewport.width === 0) return null;
    return rect.bottom >= viewport.top && rect.top <= viewport.bottom;
  }

  /** Tests and non-observer environments: set a row's visibility directly. */
  setVisible(key: string, visible: boolean): void {
    this.row(key).set(visible);
  }

  /** Tests and non-observer environments: report an observed block's visibility. */
  setBlockVisible(element: Element, visible: boolean): void {
    this.blockElements.get(element)?.set(visible);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.elements.clear();
    this.rows.clear();
    this.blockElements.clear();
  }
}
