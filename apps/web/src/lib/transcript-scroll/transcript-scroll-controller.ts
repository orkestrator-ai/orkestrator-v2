import type { RefObject } from "react";
import {
  followAllowed,
  initialScrollIntent,
  owedOnRelease,
  reduceScrollIntent,
  viewportMode,
  type NavigationOwner,
  type ScrollIntentEvent,
  type ScrollIntentState,
  type ViewportMode,
} from "./scroll-intent";
import { classifyKey, classifyWheel, TouchGesture } from "./scroll-input";
import {
  readScrollMetrics,
  VirtuosoScrollAdapter,
  type TranscriptVirtualizerHandle,
} from "./virtuoso-scroll-adapter";

/**
 * How far above the true end a reader's own upward movement has to end to
 * release follow. Kept at a pixel: while a reader is flagged as following,
 * every growth pin drags them back, so any band here is a band they cannot
 * scroll out of. Sub-pixel positions at the end stay under one pixel.
 */
export const STICK_RELEASE_DISTANCE_PX = 1;

/** A held pointer alone needs this much upward movement to rule out sub-pixel noise. */
const POINTER_SCROLL_UP_TOLERANCE_PX = 2;

/**
 * Wheel and key events fire before the browser moves `scrollTop`. Their
 * resulting scroll events (and a short native keyboard animation) are the
 * reader's for this long; every further scroll event of that movement
 * (trackpad or touch momentum) extends it by `MOMENTUM_CHAIN_MS`.
 */
const INPUT_ARM_MS = 250;
const MOMENTUM_CHAIN_MS = 120;

/** A navigation has converged once its target holds within this for this many frames. */
const CONVERGENCE_TOLERANCE_PX = 1;
const CONVERGED_FRAMES = 2;

/**
 * Guardrails for one bounded navigation. A deadline ends the work where it
 * stands; it never triggers another jump.
 */
export interface OperationBudget {
  maxFrames: number;
  maxMs: number;
}
export const DEFAULT_OPERATION_BUDGET: OperationBudget = { maxFrames: 30, maxMs: 750 };

/** Re-issue index navigation for a target still not rendered after this many frames. */
const REISSUE_AFTER_UNMOUNTED_FRAMES = 8;
const MAX_INDEX_REISSUES = 2;
/** Frames a mounted row may lack its target part before falling back to the row. */
const PART_FALLBACK_FRAMES = 4;

/** A reader's place is recaptured once their scrolling has been idle this long. */
const READING_ANCHOR_IDLE_MS = 150;

/**
 * A place in the transcript by identity: a display row (by key, with its
 * local index as a fallback), optionally one source part inside it, and that
 * element's top relative to the viewport's top (negative when partly above).
 */
export interface SemanticAnchor {
  rowKey?: string;
  index?: number;
  partId?: string;
  offsetPx: number;
}

export type NavigationTarget =
  | { kind: "latest" }
  | {
      kind: "row";
      /** Local data index (never offset by Virtuoso's `firstItemIndex`). */
      index: number;
      key?: string;
      partId?: string;
      /** Hold the target this far below the viewport top; otherwise `align`. */
      offsetPx?: number;
      align?: "start" | "center";
    }
  | {
      /** A precise box inside a row, e.g. a find match; resolved every frame. */
      kind: "rect";
      rect: () => DOMRect | null;
    };

export type OperationOutcome =
  | "converged"
  | "clamped"
  | "expired"
  | "unresolved"
  | "cancelled"
  | "superseded"
  | "inactive";

/** Bounded, content-free counters. */
export interface ScrollDiagnostics {
  operationsStarted: number;
  converged: number;
  clamped: number;
  expired: number;
  unresolved: number;
  cancelled: number;
  superseded: number;
  partFallbacks: number;
  /** Positioning writes issued (adapter: handle commands plus direct writes). */
  writes: number;
  libraryCancellations: number;
  /** Callbacks of retired work that arrived and were refused before writing. */
  staleCallbacksRefused: number;
  growthPins: number;
  userInterruptions: number;
  lastOutcome: OperationOutcome | null;
}

interface Operation {
  generation: number;
  owner: NavigationOwner;
  target: NavigationTarget;
  motion: "instant" | "smooth";
  startedAt: number;
  frames: number;
  stableFrames: number;
  lastScrollHeight: number;
  unmountedFrames: number;
  partMissingFrames: number;
  reissues: number;
  smoothIssued: boolean;
  smoothHeight: number;
  correctedFrame: number;
  frame: number | null;
}

export interface ScrollViewState {
  /** At the true end (UI affordances: the return-to-latest button). */
  isAtBottom: boolean;
  /** Literal `false` reaches the virtualizer's follow prop otherwise. */
  followAllowed: boolean;
  mode: ViewportMode;
}

export interface TranscriptScrollControllerOptions {
  initialWantsFollow?: boolean;
  initialActive?: boolean;
  budget?: OperationBudget;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function findPart(row: Element, partId: string): HTMLElement | null {
  for (const element of Array.from(
    row.querySelectorAll<HTMLElement>("[data-transcript-part-id]"),
  )) {
    if (element.dataset.transcriptPartId === partId) return element;
  }
  return null;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * The single owner of one transcript viewport's scroll position.
 *
 * Every write is attributable to the current generation: follow pins, bounded
 * navigations (latest, find, message link, history, restore) and their
 * measured convergence. User input that will move the transcript, in either
 * direction, retires navigation at every layer — scheduled frames, the
 * virtualizer's own retries, and a native smooth scroll in flight.
 *
 * Following and reading are event-driven: a completed navigation leaves no
 * timer or frame loop behind, and only a later layout change starts work.
 */
export class TranscriptScrollController {
  readonly adapter: VirtuosoScrollAdapter;
  /** Mirrors `isAtBottom` for effects that must not rerender. */
  readonly isAtBottomRef: { current: boolean } = { current: true };

  private state: ScrollIntentState;
  private readonly budget: OperationBudget;
  private scroller: HTMLElement | null = null;
  private detachScroller: (() => void) | null = null;
  private op: Operation | null = null;
  private frameId = 0;
  private atBottom = true;
  private lastObservedTop = 0;
  private userScrollUntil = 0;
  private pointerHeld = false;
  private lastPointerInside = false;
  private touchActive = false;
  private touchScrollTop = 0;
  private readonly touch = new TouchGesture();
  private growthFrame: number | null = null;
  private anchorTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReadingAnchor: SemanticAnchor | null = null;
  private rowIndexOf: ((key: string) => number) | null = null;
  private snapshot: ScrollViewState;
  private readonly listeners = new Set<() => void>();
  private readonly latestListeners = new Set<() => void>();
  private readonly counters: Omit<ScrollDiagnostics, "writes" | "libraryCancellations"> = {
    operationsStarted: 0,
    converged: 0,
    clamped: 0,
    expired: 0,
    unresolved: 0,
    cancelled: 0,
    superseded: 0,
    partFallbacks: 0,
    staleCallbacksRefused: 0,
    growthPins: 0,
    userInterruptions: 0,
    lastOutcome: null,
  };

  constructor(
    handleRef: RefObject<TranscriptVirtualizerHandle | null>,
    options: TranscriptScrollControllerOptions = {},
  ) {
    this.adapter = new VirtuosoScrollAdapter(handleRef, () => this.scroller);
    this.state = initialScrollIntent(
      options.initialWantsFollow ?? true,
      options.initialActive ?? true,
    );
    this.budget = options.budget ?? DEFAULT_OPERATION_BUDGET;
    this.snapshot = this.computeSnapshot();
  }

  // ------------------------------------------------------------------ state

  get wantsFollow(): boolean {
    return this.state.wantsFollow;
  }

  get mode(): ViewportMode {
    return viewportMode(this.state);
  }

  get generation(): number {
    return this.state.generation;
  }

  get active(): boolean {
    return this.state.active;
  }

  get pauseReasons(): ReadonlySet<string> {
    return this.state.pauseReasons;
  }

  /**
   * The reader's place as last captured while they were reading (after their
   * scrolling settled, or a navigation landed). Survives the pane being hidden,
   * when nothing can be measured.
   */
  get readingAnchor(): SemanticAnchor | null {
    return this.state.wantsFollow ? null : this.lastReadingAnchor;
  }

  get hasScroller(): boolean {
    return this.scroller !== null;
  }

  get currentOwner(): NavigationOwner | null {
    return this.state.operation?.owner ?? null;
  }

  /** Subscribe to discrete view state (never to raw scroll offsets). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ScrollViewState => this.snapshot;

  /** The list's key → current local index lookup, for navigation by identity. */
  setRowIndexResolver(resolver: ((key: string) => number) | null): void {
    this.rowIndexOf = resolver;
  }

  /** Notified when the reader asks for the latest message (e.g. to close find). */
  onLatestRequested(listener: () => void): () => void {
    this.latestListeners.add(listener);
    return () => this.latestListeners.delete(listener);
  }

  diagnostics(): ScrollDiagnostics {
    return {
      ...this.counters,
      writes: this.adapter.writes,
      libraryCancellations: this.adapter.cancellations,
    };
  }

  private computeSnapshot(): ScrollViewState {
    return {
      isAtBottom: this.atBottom,
      followAllowed: followAllowed(this.state),
      mode: viewportMode(this.state),
    };
  }

  private publish(): void {
    const next = this.computeSnapshot();
    const previous = this.snapshot;
    if (
      next.isAtBottom === previous.isAtBottom &&
      next.followAllowed === previous.followAllowed &&
      next.mode === previous.mode
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) listener();
  }

  private setAtBottom(atBottom: boolean): void {
    this.isAtBottomRef.current = atBottom;
    if (this.atBottom === atBottom) return;
    this.atBottom = atBottom;
    this.publish();
  }

  private dispatch(event: ScrollIntentEvent, outcome: OperationOutcome = "superseded"): void {
    const previous = this.state;
    const next = reduceScrollIntent(previous, event);
    if (next === previous) return;
    this.state = next;
    const op = this.op;
    if (op && next.operation?.generation !== op.generation) this.retire(op, outcome);
    // Literal false is about to reach the follow prop; the library's queued
    // follow work must not outlive that decision until the prop commits.
    if (followAllowed(previous) && !followAllowed(next)) this.adapter.cancelPendingNavigation();
    if (owedOnRelease(previous, next)) this.followGrowth();
    this.publish();
  }

  // ------------------------------------------------------------- lifecycle

  /** Seed persisted intent (mount or a validated restore); retires nothing. */
  seed(wantsFollow: boolean): void {
    this.dispatch({ type: "seed", wantsFollow });
  }

  setActive(active: boolean): void {
    this.dispatch({ type: active ? "activate" : "deactivate" }, "inactive");
    if (!active) this.cancelGrowthFrame();
  }

  attachScroller(element: HTMLElement | null): void {
    if (element === this.scroller) return;
    this.detachScroller?.();
    this.detachScroller = null;
    this.scroller = element;
    if (this.op) this.dispatch({ type: "user-navigation" }, "cancelled");
    if (!element) return;
    this.lastObservedTop = element.scrollTop;
    this.detachScroller = this.listen(element);
  }

  dispose(): void {
    this.attachScroller(null);
    this.setActive(false);
    this.listeners.clear();
    this.latestListeners.clear();
  }

  // ------------------------------------------------------------- commands

  /**
   * Return to the latest message and follow it: one bounded journey. The
   * index jump is instant (it corrects estimates); `motion` applies to the
   * final scroll into the footer.
   */
  navigateToLatest(motion: "instant" | "smooth" = "instant"): boolean {
    if (!this.state.active) return false;
    // No list yet: callers retry on readiness (activation) or the reader can
    // ask again; nothing is started that could not finish.
    if (!this.adapter.ready) return false;
    for (const listener of Array.from(this.latestListeners)) listener();
    const op = this.begin("latest", { kind: "latest" }, motion);
    this.adapter.scrollToIndex({ index: "LAST", align: "end" });
    this.schedule(op);
    return true;
  }

  /**
   * Bring one target into view and read there. Resolves by identity first
   * (row key, source part), then converges on measured geometry.
   * False when neither the list nor the target is available yet.
   */
  navigateTo(
    target: Exclude<NavigationTarget, { kind: "latest" }>,
    owner: NavigationOwner,
  ): boolean {
    if (!this.state.active) return false;
    if (target.kind === "row" && (!Number.isInteger(target.index) || target.index < 0)) {
      return false;
    }
    const mounted = this.resolve(target) !== null;
    if (!mounted && (target.kind === "rect" || !this.adapter.ready)) return false;
    const op = this.begin(owner, target, "instant");
    if (!mounted && target.kind === "row") this.issueIndexNavigation(op, target);
    this.schedule(op);
    return true;
  }

  /**
   * Refine the target of `owner`'s current navigation (find's match box once
   * its row has rendered). If that navigation already finished, start a fresh
   * one only when nothing — not the reader, not another navigation — has
   * moved the viewport since it began.
   */
  retarget(
    owner: NavigationOwner,
    target: Exclude<NavigationTarget, { kind: "latest" }>,
    since: number,
  ): boolean {
    const op = this.op;
    if (op && op.owner === owner && this.isCurrent(op)) {
      op.target = target;
      op.stableFrames = 0;
      return true;
    }
    if (this.state.generation !== since) return false;
    return this.navigateTo(target, owner);
  }

  setFollowPause(reason: string, paused: boolean): void {
    this.dispatch({ type: "pause", reason, paused }, "cancelled");
  }

  /** Virtuoso's functional follow callback; the authority is intent, not its argument. */
  followOutput = (_atBottom: boolean): "auto" | false => {
    if (this.state.pauseReasons.size > 0) {
      this.dispatch({ type: "growth" });
      return false;
    }
    // Always "auto", never "smooth": Virtuoso re-invokes follow on every item
    // change and a re-issued native smooth scroll restarts its easing.
    return followAllowed(this.state) ? "auto" : false;
  };

  /** Virtuoso's boolean at-bottom report. UI only: it never grants follow. */
  reportAtBottom(atBottom: boolean): void {
    const el = this.scroller;
    const distance = el ? readScrollMetrics(el).distanceFromEnd : 0;
    this.setAtBottom(atBottom && distance < STICK_RELEASE_DISTANCE_PX);
  }

  /**
   * A measurement changed: the list height, a resize the observers saw, or a
   * subtree mutation. `resize` arrives after layout and before paint, so the
   * correction it causes is never painted at the displaced position.
   */
  notifyLayout(source: "resize" | "list-height" | "mutation"): void {
    if (!this.state.active) return;
    if (source === "mutation") {
      this.scheduleGrowthFrame();
      return;
    }
    if (source === "resize") this.cancelGrowthFrame();
    const op = this.op;
    if (op) {
      if (source === "resize") this.reconcile(op, "layout");
      return;
    }
    this.followGrowth();
  }

  /** The first useful visible content, as an identity and viewport offset. */
  captureAnchor(): SemanticAnchor | null {
    const el = this.scroller;
    if (!el) return null;
    const viewport = el.getBoundingClientRect();
    const top = viewport.top;
    const bottom = top + el.clientHeight;
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > top && rect.top < bottom;
    };
    const part = Array.from(el.querySelectorAll<HTMLElement>("[data-transcript-part-id]")).find(
      visible,
    );
    const row =
      part?.closest<HTMLElement>("[data-chat-message-index]") ??
      Array.from(el.querySelectorAll<HTMLElement>("[data-chat-message-index]")).find(
        (element) => element.getBoundingClientRect().bottom > top,
      );
    if (!row) return null;
    const index = Number(row.dataset.chatMessageIndex);
    return {
      rowKey: row.dataset.chatMessageKey,
      index: Number.isSafeInteger(index) ? index : undefined,
      partId: part?.dataset.transcriptPartId,
      offsetPx: (part ?? row).getBoundingClientRect().top - top,
    };
  }

  // ------------------------------------------------------------- following

  /** Follow growth while following: one synchronous downward pin. */
  private followGrowth(): void {
    if (!this.state.active) return;
    if (!followAllowed(this.state)) {
      this.dispatch({ type: "growth" });
      return;
    }
    const el = this.scroller;
    if (!el) {
      // No scroller yet: the handle can still be asked for the end.
      if (this.adapter.ready) this.navigateToLatest("instant");
      return;
    }
    const metrics = readScrollMetrics(el);
    // Only ever move down. Shrinking content is clamped by the browser, and
    // pulling the viewport up would fight a reader mid-gesture.
    if (metrics.maxScrollTop > metrics.scrollTop) {
      this.counters.growthPins += 1;
      this.adapter.writeScrollTop(metrics.maxScrollTop);
    }
  }

  /**
   * A mutation is folded into the frame's resize delivery: measuring inside
   * a MutationObserver forces a synchronous reflow. This frame is the backstop
   * for growth no resize reports (margin-only growth).
   */
  private scheduleGrowthFrame(): void {
    if (this.growthFrame !== null) return;
    if (typeof requestAnimationFrame === "undefined") {
      this.notifyLayout("list-height");
      return;
    }
    this.growthFrame = requestAnimationFrame(() => {
      this.growthFrame = null;
      this.notifyLayout("list-height");
    });
  }

  private cancelGrowthFrame(): void {
    if (this.growthFrame === null) return;
    cancelAnimationFrame(this.growthFrame);
    this.growthFrame = null;
  }

  // ------------------------------------------------------------ operations

  private begin(
    owner: NavigationOwner,
    target: NavigationTarget,
    motion: Operation["motion"],
  ): Operation {
    this.dispatch({ type: "navigate", owner }, "superseded");
    const op: Operation = {
      generation: this.state.generation,
      owner,
      target,
      motion,
      startedAt: now(),
      frames: 0,
      stableFrames: 0,
      lastScrollHeight: this.scroller?.scrollHeight ?? 0,
      unmountedFrames: 0,
      partMissingFrames: 0,
      reissues: 0,
      smoothIssued: false,
      smoothHeight: 0,
      correctedFrame: -1,
      frame: null,
    };
    this.op = op;
    this.counters.operationsStarted += 1;
    return op;
  }

  private isCurrent(op: Operation): boolean {
    return (
      this.op === op &&
      this.state.active &&
      this.state.operation?.generation === op.generation &&
      this.scroller !== null
    );
  }

  private schedule(op: Operation): void {
    if (typeof requestAnimationFrame === "undefined") return;
    op.frame = requestAnimationFrame(() => {
      op.frame = null;
      if (this.op !== op || this.state.operation?.generation !== op.generation) {
        this.counters.staleCallbacksRefused += 1;
        return;
      }
      this.frameId += 1;
      op.frames += 1;
      if (this.scroller) {
        this.reconcile(op, "frame");
      } else if (op.target.kind === "latest") {
        // No scroller to measure: hand the end to the virtualizer once.
        this.adapter.scrollToEnd(op.motion === "smooth" ? "smooth" : "auto");
        this.finish(op, "expired");
        return;
      }
      if (this.op !== op) return;
      if (op.frames >= this.budget.maxFrames || now() - op.startedAt >= this.budget.maxMs) {
        this.finish(
          op,
          this.resolve(op.target) === null && op.target.kind !== "latest"
            ? "unresolved"
            : "expired",
        );
        return;
      }
      this.schedule(op);
    });
  }

  private finish(op: Operation, outcome: OperationOutcome): void {
    this.dispatch({ type: "finish", generation: op.generation }, outcome);
    if (!this.state.wantsFollow) this.lastReadingAnchor = this.captureAnchor();
  }

  /** Recapture the reader's place once their scrolling goes idle. */
  private scheduleAnchorCapture(): void {
    if (this.state.wantsFollow || this.op) return;
    if (this.anchorTimer !== null) clearTimeout(this.anchorTimer);
    this.anchorTimer = setTimeout(() => {
      this.anchorTimer = null;
      if (this.state.active && !this.state.wantsFollow && !this.op) {
        this.lastReadingAnchor = this.captureAnchor() ?? this.lastReadingAnchor;
      }
    }, READING_ANCHOR_IDLE_MS);
  }

  private cancelAnchorCapture(): void {
    if (this.anchorTimer === null) return;
    clearTimeout(this.anchorTimer);
    this.anchorTimer = null;
  }

  /** Stop all of `op`'s work: frames, the library's queue, and native smooth motion. */
  private retire(op: Operation, outcome: OperationOutcome): void {
    if (op.frame !== null) cancelAnimationFrame(op.frame);
    op.frame = null;
    this.op = null;
    this.adapter.cancelPendingNavigation();
    if (op.smoothIssued && outcome === "cancelled" && this.state.active) this.adapter.stopMotion();
    this.counters.lastOutcome = outcome;
    switch (outcome) {
      case "converged":
      case "clamped":
      case "expired":
      case "unresolved":
      case "cancelled":
      case "superseded":
        this.counters[outcome] += 1;
        break;
      case "inactive":
        this.counters.cancelled += 1;
        break;
    }
  }

  private issueIndexNavigation(
    op: Operation,
    target: Extract<NavigationTarget, { kind: "row" }>,
  ): void {
    const offset = target.offsetPx !== undefined ? -target.offsetPx : undefined;
    // Identity precedes indices: the row's current index, when the list knows it.
    const resolved = target.key !== undefined ? (this.rowIndexOf?.(target.key) ?? -1) : -1;
    this.adapter.scrollToIndex({
      index: resolved >= 0 ? resolved : target.index,
      align: offset !== undefined ? "start" : (target.align ?? "center"),
      offset,
    });
    op.unmountedFrames = 0;
  }

  /** The element (or box) a target names, if rendered. */
  private resolve(target: NavigationTarget): (() => DOMRect | null) | null {
    const el = this.scroller;
    if (!el || target.kind === "latest") return null;
    if (target.kind === "rect") return target.rect() ? target.rect : null;
    const row = target.key
      ? el.querySelector<HTMLElement>(`[data-chat-message-key="${cssEscape(target.key)}"]`)
      : el.querySelector<HTMLElement>(`[data-chat-message-index="${target.index}"]`);
    if (!row) return null;
    const element = target.partId ? findPart(row, target.partId) : row;
    if (!element) return null;
    return () => element.getBoundingClientRect();
  }

  private desiredOffset(target: NavigationTarget, rect: DOMRect, clientHeight: number): number {
    if (target.kind === "row" && target.offsetPx !== undefined) return target.offsetPx;
    if (target.kind === "row" && target.align === "start") return 0;
    // Centre a box that fits; a taller one starts at the top, where reading does.
    return Math.max(0, (clientHeight - rect.height) / 2);
  }

  private reconcile(op: Operation, phase: "frame" | "layout"): void {
    if (!this.isCurrent(op)) {
      this.counters.staleCallbacksRefused += 1;
      return;
    }
    const el = this.scroller!;
    if (op.target.kind === "latest") {
      this.reconcileLatest(op, el, phase);
      return;
    }
    let rectOf = this.resolve(op.target);
    const target = op.target;
    if (!rectOf && target.kind === "row" && target.partId) {
      // The row may have rendered before its part (a disclosure, an inner
      // list). Wait briefly, then hold the row itself rather than nothing.
      const rowOnly = this.resolve({ ...target, partId: undefined });
      if (rowOnly) {
        if (phase === "frame") op.partMissingFrames += 1;
        if (op.partMissingFrames >= PART_FALLBACK_FRAMES) {
          this.counters.partFallbacks += 1;
          op.target = { ...target, partId: undefined };
          rectOf = rowOnly;
        }
      }
    }
    if (!rectOf) {
      if (phase === "frame") op.unmountedFrames += 1;
      if (
        target.kind === "row" &&
        op.unmountedFrames >= REISSUE_AFTER_UNMOUNTED_FRAMES &&
        op.reissues < MAX_INDEX_REISSUES
      ) {
        op.reissues += 1;
        this.issueIndexNavigation(op, target);
      }
      return;
    }
    op.unmountedFrames = 0;
    // Reads first, then at most one write.
    const rect = rectOf();
    if (!rect) return;
    const viewportTop = el.getBoundingClientRect().top;
    const metrics = readScrollMetrics(el);
    const error =
      rect.top - viewportTop - this.desiredOffset(op.target, rect, metrics.clientHeight);
    const nextTop = Math.min(Math.max(metrics.scrollTop + error, 0), metrics.maxScrollTop);
    const heightStable = metrics.scrollHeight === op.lastScrollHeight;
    op.lastScrollHeight = metrics.scrollHeight;
    if (Math.abs(nextTop - metrics.scrollTop) <= CONVERGENCE_TOLERANCE_PX) {
      if (phase === "frame") {
        op.stableFrames = heightStable ? op.stableFrames + 1 : 0;
        if (op.stableFrames >= CONVERGED_FRAMES) {
          this.finish(op, Math.abs(error) > CONVERGENCE_TOLERANCE_PX ? "clamped" : "converged");
        }
      }
      return;
    }
    op.stableFrames = 0;
    if (op.correctedFrame === this.frameId && phase === "layout") return;
    op.correctedFrame = this.frameId;
    this.adapter.writeScrollTop(nextTop);
  }

  private reconcileLatest(op: Operation, el: HTMLElement, phase: "frame" | "layout"): void {
    const metrics = readScrollMetrics(el);
    if (phase === "frame" && op.frames === 1) {
      // The journey's first frame scrolls into the footer through the handle,
      // which includes it even while Virtuoso is still measuring the last rows.
      op.smoothIssued = op.motion === "smooth";
      op.smoothHeight = metrics.scrollHeight;
      op.lastScrollHeight = metrics.scrollHeight;
      this.adapter.scrollToEnd(op.motion === "smooth" ? "smooth" : "auto");
      return;
    }
    const heightStable = metrics.scrollHeight === op.lastScrollHeight;
    op.lastScrollHeight = metrics.scrollHeight;
    if (metrics.distanceFromEnd < STICK_RELEASE_DISTANCE_PX) {
      if (phase === "frame") {
        op.stableFrames = heightStable ? op.stableFrames + 1 : 0;
        if (op.stableFrames >= CONVERGED_FRAMES) this.finish(op, "converged");
      }
      return;
    }
    op.stableFrames = 0;
    if (op.frames === 0) return;
    if (op.motion === "smooth") {
      // Re-issue the native smooth scroll only when the end itself moved
      // (late footer content); re-issuing otherwise restarts its easing.
      if (phase === "frame" && metrics.scrollHeight !== op.smoothHeight) {
        op.smoothHeight = metrics.scrollHeight;
        this.adapter.scrollToEnd("smooth");
      }
      return;
    }
    if (op.correctedFrame === this.frameId && phase === "layout") return;
    op.correctedFrame = this.frameId;
    this.adapter.writeScrollTop(metrics.maxScrollTop);
  }

  // ------------------------------------------------------------------ input

  /** Recognised reader input that will scroll this transcript. */
  private userInput(): void {
    this.userScrollUntil = now() + INPUT_ARM_MS;
    if (this.op) this.counters.userInterruptions += 1;
    this.dispatch({ type: "user-navigation" }, "cancelled");
  }

  private handleScroll(el: HTMLElement): void {
    const metrics = readScrollMetrics(el);
    const previous = this.lastObservedTop;
    this.lastObservedTop = metrics.scrollTop;
    this.setAtBottom(metrics.distanceFromEnd < STICK_RELEASE_DISTANCE_PX);
    this.scheduleAnchorCapture();
    const written = this.adapter.lastWrittenTop;
    this.adapter.lastWrittenTop = null;
    if (written !== null && Math.abs(metrics.scrollTop - written) < 0.5) return;
    const t = now();
    const armed = t < this.userScrollUntil;
    if (!armed && !this.pointerHeld && !this.touchActive) return;
    if (armed || this.touchActive) {
      this.userScrollUntil = Math.max(this.userScrollUntil, t + MOMENTUM_CHAIN_MS);
    }
    const moved = metrics.scrollTop !== previous;
    // A scrollbar drag fires no wheel, key or touch event: movement while a
    // pointer is held is the reader's.
    if (moved && !armed && !this.touchActive && this.op) {
      this.counters.userInterruptions += 1;
      this.dispatch({ type: "user-navigation" }, "cancelled");
    }
    this.evaluateMovement(metrics.scrollTop, previous, metrics.distanceFromEnd, armed);
  }

  private evaluateMovement(top: number, previous: number, distance: number, armed: boolean): void {
    const tolerance = armed ? 0 : POINTER_SCROLL_UP_TOLERANCE_PX;
    if (top < previous - tolerance) {
      // A shrinking list or growing viewport lowers scrollTop while leaving
      // the reader at the end; only movement that ends away from it counts.
      if (distance >= STICK_RELEASE_DISTANCE_PX)
        this.dispatch({ type: "user-departed" }, "cancelled");
      return;
    }
    if (top > previous && distance < STICK_RELEASE_DISTANCE_PX) {
      this.dispatch({ type: "user-arrived" });
    }
  }

  private listen(el: HTMLElement): () => void {
    const doc = el.ownerDocument;
    const view = doc.defaultView ?? window;
    const onWheel = (event: WheelEvent) => {
      const direction = classifyWheel(event, el);
      if (direction) this.userInput();
    };
    const onScroll = () => this.handleScroll(el);
    const onPointerDown = () => {
      this.pointerHeld = true;
      this.lastPointerInside = true;
    };
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !el.contains(event.target)) {
        this.lastPointerInside = false;
      }
    };
    const onPointerRelease = () => {
      this.pointerHeld = false;
    };
    const onTouchStart = (event: TouchEvent) => {
      const first = event.touches?.[0];
      this.touch.start(first ?? { clientX: 0, clientY: 0 });
      this.touchActive = true;
      this.touchScrollTop = el.scrollTop;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches && event.touches.length > 0) {
        const direction = this.touch.move(event, el);
        if (direction === null) return;
        this.userInput();
      }
      const metrics = readScrollMetrics(el);
      const previous = this.touchScrollTop;
      this.touchScrollTop = metrics.scrollTop;
      this.evaluateMovement(metrics.scrollTop, previous, metrics.distanceFromEnd, false);
    };
    const onTouchEnd = () => {
      this.touchActive = false;
      this.touch.end();
      // Momentum continues after the finger lifts; its scroll events chain.
      this.userScrollUntil = now() + INPUT_ARM_MS;
    };
    const onKey = (event: KeyboardEvent) => {
      const direction = classifyKey(event, el, this.lastPointerInside);
      if (direction) this.userInput();
    };
    const onDocumentKey = (event: KeyboardEvent) => {
      // Keys targeted inside the transcript are handled by its own listener.
      if (event.target instanceof Node && el.contains(event.target)) return;
      onKey(event);
    };
    const passive = { passive: true } as const;
    el.addEventListener("wheel", onWheel, passive);
    el.addEventListener("scroll", onScroll, passive);
    el.addEventListener("pointerdown", onPointerDown, passive);
    doc.addEventListener("pointerdown", onDocumentPointerDown, { passive: true, capture: true });
    // The pointer is often released outside the scroller (or over its gutter).
    view.addEventListener("pointerup", onPointerRelease, passive);
    view.addEventListener("pointercancel", onPointerRelease, passive);
    el.addEventListener("touchstart", onTouchStart, passive);
    el.addEventListener("touchmove", onTouchMove, passive);
    el.addEventListener("touchend", onTouchEnd, passive);
    el.addEventListener("touchcancel", onTouchEnd, passive);
    el.addEventListener("keydown", onKey);
    doc.addEventListener("keydown", onDocumentKey);

    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => this.notifyLayout("resize"));
      const observed = new WeakSet<Element>();
      const observeChildren = () => {
        for (const child of Array.from(el.children)) {
          if (!observed.has(child)) {
            resizeObserver!.observe(child);
            observed.add(child);
          }
        }
      };
      observeChildren();
      // Footer content is nested inside Virtuoso's wrappers, so watch the
      // subtree; re-walk direct children only when one was added.
      if (typeof MutationObserver !== "undefined") {
        mutationObserver = new MutationObserver((records) => {
          if (records.some((record) => record.target === el && record.addedNodes.length > 0)) {
            observeChildren();
          }
          this.notifyLayout("mutation");
        });
        mutationObserver.observe(el, { childList: true, subtree: true });
      }
    }

    return () => {
      this.cancelGrowthFrame();
      this.cancelAnchorCapture();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("pointerdown", onPointerDown);
      doc.removeEventListener("pointerdown", onDocumentPointerDown, { capture: true });
      view.removeEventListener("pointerup", onPointerRelease);
      view.removeEventListener("pointercancel", onPointerRelease);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("keydown", onKey);
      doc.removeEventListener("keydown", onDocumentKey);
      this.pointerHeld = false;
      this.touchActive = false;
    };
  }
}
