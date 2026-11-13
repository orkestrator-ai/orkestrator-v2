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
import { classifyKey, classifyWheel, TouchGesture, type ScrollDirection } from "./scroll-input";
import {
  readScrollMetrics,
  type ScrollMetrics,
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

/**
 * How long after upward input an unobserved upward movement is still the
 * reader's (`readerMovedUpUnobserved`). Longer than `INPUT_ARM_MS`: under
 * load WebKit's virtualizer compensation for the tick's first step was seen
 * 555 ms after the wheel event, its scroll events delayed with it.
 */
const UPWARD_INPUT_HOLD_MS = 1_000;

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

/** Room for a glide's legs, the wait for a distant row, and settling (at 120 Hz). */
const GLIDE_BUDGET: OperationBudget = { maxFrames: 360, maxMs: 2_500 };
/** A glide across rendered rows: scaled to its distance, within these bounds. */
const GLIDE_MIN_MS = 280;
const GLIDE_MAX_MS = 560;
const GLIDE_MS_PER_PX = 0.25;
/**
 * Each leg of a glide to an unrendered row: easing out of the current place,
 * then into the target. Equal legs over equal distances meet at the same
 * speed, so the jump between them reads as one continuous movement.
 */
const GLIDE_LEG_MS = 240;
const GLIDE_LEG_MAX_PX = 320;
const GLIDE_LEG_VIEWPORT_FRACTION = 0.6;

const easeInCubic = (t: number) => t * t * t;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Re-issue index navigation for a target still not rendered after this many frames. */
const REISSUE_AFTER_UNMOUNTED_FRAMES = 8;
const MAX_INDEX_REISSUES = 2;
/** Frames a mounted row may lack its target part before falling back to the row. */
const PART_FALLBACK_FRAMES = 4;
/** Frames an inner viewport may take to bring a sought member into its window. */
const INNER_SEEK_FRAMES = 20;

/**
 * Asks an inner viewport (an open long tool group) to bring a member it has
 * virtualized away into its window, dispatched on the inner viewport element
 * with the member's part id as `detail.partId`. The member's offset is then
 * corrected like a mounted one.
 */
export const INNER_SEEK_EVENT = "ork-transcript-inner-seek";

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
  /**
   * A member inside an inner viewport (an open long tool group): `partId`
   * then names the group frame the transcript holds, and this the member the
   * inner viewport holds at its on-screen offset from the transcript's top.
   */
  inner?: InnerAnchor;
  /** The enclosing plain group, held instead if its member rows fold away. */
  foldedGroup?: FoldedGroupAnchor;
}

export interface FoldedGroupAnchor {
  /** A member still represented by the folded summary (the latest call). */
  partId: string;
  offsetPx: number;
}

export interface InnerAnchor {
  partId: string;
  screenOffsetPx: number;
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
      inner?: InnerAnchor;
      foldedGroup?: FoldedGroupAnchor;
    }
  | {
      /** A precise box inside a row, e.g. a find match; resolved every frame. */
      kind: "rect";
      rect: () => DOMRect | null;
      /**
       * The row the box lies in. While the box cannot be resolved (the row
       * left the rendered window as rows above it measured), the navigation
       * brings this row back by index rather than waiting out its budget.
       */
      row?: Extract<NavigationTarget, { kind: "row" }>;
    };

export type OperationOutcome =
  "converged" | "clamped" | "expired" | "unresolved" | "cancelled" | "superseded" | "inactive";

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
  /** Frames operations ran, and the corrections they wrote. */
  operationFrames: number;
  operationCorrections: number;
  /** Operations a newly taken follow pause retired. */
  pauseRetirements: number;
  /** Operations retired because the scroller element changed. */
  scrollerRetirements: number;
  lastOutcome: OperationOutcome | null;
}

type RowTarget = Extract<NavigationTarget, { kind: "row" }>;

/** The row a target can be brought back to by index, if it names one. */
function rowOf(target: NavigationTarget): RowTarget | null {
  if (target.kind === "row") return target;
  if (target.kind === "rect") return target.row ?? null;
  return null;
}

/**
 * An eased navigation's progress. A rendered target is tracked directly; an
 * unrendered one has no known distance, so the viewport departs towards it,
 * asks the virtualizer for a place one leg short of it, and tracks from there.
 */
type Glide =
  | {
      phase: "depart";
      startedAt: number;
      direction: 1 | -1;
      distance: number;
      /** Eased distance covered so far; writes are steps, so size compensation survives. */
      covered: number;
    }
  | { phase: "seek"; direction: 1 | -1; distance: number }
  | {
      phase: "track";
      startedAt: number;
      durationMs: number;
      /** The target's viewport offset when tracking began. */
      fromOffset: number;
      ease: (t: number) => number;
    };

interface Operation {
  generation: number;
  owner: NavigationOwner;
  target: NavigationTarget;
  motion: "instant" | "smooth";
  budget: OperationBudget;
  glide: Glide | null;
  startedAt: number;
  frames: number;
  stableFrames: number;
  lastScrollHeight: number;
  unmountedFrames: number;
  partMissingFrames: number;
  /** Frames spent waiting for an inner viewport to mount a sought member. */
  innerSeekFrames: number;
  reissues: number;
  /** An index navigation has been issued for this operation. */
  indexIssued: boolean;
  /** A resize was delivered since the operation's last frame. */
  measuredSinceFrame: boolean;
  /** The target part's offset inside its row, when both were last measured. */
  partDelta: number;
  smoothIssued: boolean;
  smoothHeight: number;
  /** A latest journey has reached the end at least once. */
  arrived: boolean;
  correctedFrame: number;
  frame: number | null;
}

export interface ScrollViewState {
  /** Async readers retire work on every reader input or newer navigation. */
  generation: number;
  hasScroller: boolean;
  waitingForHistory: boolean;
  /**
   * At the true end, or kept there by following or a latest journey that has
   * reached it (UI affordances: the return-to-latest button). Growth reaches
   * a follower a moment before its pin, so geometry alone flickers while
   * content streams. Idle upward movement away without end growth releases
   * follow even without classified input.
   */
  isAtBottom: boolean;
  /** Literal `false` reaches the virtualizer's follow prop otherwise. */
  followAllowed: boolean;
  mode: ViewportMode;
  /**
   * Row key the current navigation targets. The list keeps that row mounted
   * while the bounded navigation runs (the same budget as a selection).
   */
  targetKey: string | null;
}

/**
 * The scroller exposes its controller's counters under this property, so
 * browser tests and the performance runner can read them without React
 * internals. Content-free numbers only.
 */
export const SCROLL_DIAGNOSTICS_PROPERTY = "orkTranscriptScrollDiagnostics";

export interface TranscriptScrollControllerOptions {
  initialWantsFollow?: boolean;
  initialActive?: boolean;
  initialReadingAnchor?: SemanticAnchor | null;
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
  /** Geometry only: whether the viewport is within a pixel of the true end. */
  private atBottom = true;
  private lastObservedTop = 0;
  private lastObservedEnd = 0;
  private userScrollUntil = 0;
  /** When the reader last gave input that will scroll this transcript. */
  private lastInputAt = Number.NEGATIVE_INFINITY;
  /** Until when the reader's last input, which scrolls up, may still be moving them. */
  private upwardInputUntil = 0;
  private pointerHeld = false;
  /** The held pointer went down on the scroller itself (its scrollbar), not its content. */
  private pointerOnScroller = false;
  private lastPointerInside = false;
  private touchActive = false;
  private touchScrollTop = 0;
  private readonly touch = new TouchGesture();
  private growthFrame: number | null = null;
  private anchorTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReadingAnchor: SemanticAnchor | null = null;
  private historyRecoveryPending = false;
  /** The scroller's last laid-out width; 0 until known (or while hidden). */
  private lastWidth = 0;
  /** The offset last observed while the scroller had a box, kept across a hide. */
  private shownTop: number | null = null;
  /** A resize delivery measured the scroller at zero height (it, or an ancestor, is hidden). */
  private hiddenByLayout = false;

  private rowIndexOf: ((key: string) => number) | null = null;
  private structuralHold = false;
  private preCommitAnchor: SemanticAnchor | null = null;
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
    operationFrames: 0,
    operationCorrections: 0,
    pauseRetirements: 0,
    scrollerRetirements: 0,
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
    this.lastReadingAnchor = options.initialReadingAnchor ?? null;
    this.budget = options.budget ?? DEFAULT_OPERATION_BUDGET;
    this.snapshot = this.computeSnapshot();
    this.isAtBottomRef.current = this.snapshot.isAtBottom;
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

  get waitingForHistory(): boolean {
    return this.historyRecoveryPending;
  }

  /** Semantic recovery owns activation until its missing history is back. */
  setWaitingForHistory(waiting: boolean): void {
    if (this.historyRecoveryPending === waiting) return;
    this.historyRecoveryPending = waiting;
    this.publish();
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

  // ------------------------------------------------- structural transactions

  /**
   * A structural update (a history page) is expected and the reader's place
   * should survive it. While held, the list re-captures the place immediately
   * before each data commit (`capturePreCommit`), so a reader who moved while
   * the page loaded is held where they are now.
   */
  beginStructuralHold(): void {
    this.structuralHold = true;
  }

  endStructuralHold(): void {
    this.structuralHold = false;
    this.preCommitAnchor = null;
  }

  get holdingStructure(): boolean {
    return this.structuralHold;
  }

  /** Called by the list before a data commit mutates the DOM. */
  capturePreCommit(): void {
    if (!this.structuralHold || !this.state.active) return;
    this.preCommitAnchor = this.captureAnchor() ?? this.preCommitAnchor;
  }

  takePreCommitAnchor(): SemanticAnchor | null {
    const anchor = this.preCommitAnchor;
    this.preCommitAnchor = null;
    return anchor;
  }

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
    const target = this.op?.target;
    const following = followAllowed(this.state);
    return {
      generation: this.state.generation,
      hasScroller: this.scroller !== null,
      waitingForHistory: this.historyRecoveryPending,
      // A follower is pinned to the end on every resize delivery, and a
      // latest journey that has reached it is converging there. Between a
      // commit and that pin (a scroll event reading the new height first, or
      // the virtualizer reporting growth beyond its band) the geometry is
      // briefly short of the end; reporting that flashes the return-to-latest
      // button, and the native dock reserves the button's height below the
      // transcript, so each flash also pushed the transcript up and back.
      isAtBottom:
        this.atBottom || following || (this.op?.target.kind === "latest" && this.op.arrived),
      followAllowed: following,
      mode: viewportMode(this.state),
      targetKey: target?.kind === "row" ? (target.key ?? null) : null,
    };
  }

  private publish(): void {
    const next = this.computeSnapshot();
    const previous = this.snapshot;
    if (
      next.generation === previous.generation &&
      next.hasScroller === previous.hasScroller &&
      next.waitingForHistory === previous.waitingForHistory &&
      next.isAtBottom === previous.isAtBottom &&
      next.followAllowed === previous.followAllowed &&
      next.mode === previous.mode &&
      next.targetKey === previous.targetKey
    ) {
      return;
    }
    this.snapshot = next;
    this.isAtBottomRef.current = next.isAtBottom;
    for (const listener of Array.from(this.listeners)) listener();
  }

  private setAtBottom(atBottom: boolean): void {
    if (atBottom && this.op?.target.kind === "latest") this.op.arrived = true;
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
    this.publish();
    if (this.op) {
      this.counters.scrollerRetirements += 1;
      this.dispatch({ type: "user-navigation" }, "cancelled");
    }
    this.hiddenByLayout = false;
    this.shownTop = null;
    if (!element) return;
    this.lastObservedTop = element.scrollTop;
    this.lastObservedEnd = readScrollMetrics(element).maxScrollTop;
    if (element.clientHeight > 0) this.shownTop = element.scrollTop;
    const detach = this.listen(element);
    Object.defineProperty(element, SCROLL_DIAGNOSTICS_PROPERTY, {
      configurable: true,
      value: () => this.diagnostics(),
    });
    this.detachScroller = () => {
      detach();
      delete (element as unknown as Record<string, unknown>)[SCROLL_DIAGNOSTICS_PROPERTY];
    };
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
    if (!mounted && ((target.kind === "rect" && !target.row) || !this.adapter.ready)) return false;
    const op = this.begin(owner, target, "instant");
    if (mounted && target.kind === "row" && target.partId) {
      op.partDelta = this.measurePartDelta(target);
    }
    const row = rowOf(target);
    if (!mounted && row) this.issueIndexNavigation(op, row);
    this.schedule(op);
    return true;
  }

  /**
   * `navigateTo`, eased in and out rather than instant. The target row follows
   * the curve on screen whatever the rows around it measure as. Reader input
   * retires it like any navigation; reduced motion makes it a plain jump.
   */
  glideTo(target: RowTarget, owner: NavigationOwner): boolean {
    const el = this.scroller;
    if (!el || prefersReducedMotion()) return this.navigateTo(target, owner);
    if (!this.state.active || !Number.isInteger(target.index) || target.index < 0) return false;
    const rect = this.resolve(target)?.() ?? null;
    if (!rect && !this.adapter.ready) return false;
    const op = this.begin(owner, target, "instant");
    op.budget = GLIDE_BUDGET;
    op.glide = rect
      ? this.beginWholeGlide(el, op, rect)
      : {
          phase: "depart",
          startedAt: now(),
          direction: this.glideDirection(el, target),
          distance: this.glideLegPx(el),
          covered: 0,
        };
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
      // Waiting for the new target to mount starts again.
      op.unmountedFrames = 0;
      return true;
    }
    if (this.state.generation !== since) return false;
    return this.navigateTo(target, owner);
  }

  setFollowPause(reason: string, paused: boolean): void {
    const op = this.op;
    this.dispatch({ type: "pause", reason, paused }, "cancelled");
    if (op && this.op !== op) this.counters.pauseRetirements += 1;
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
  notifyLayout(source: "resize" | "list-height" | "mutation" | "tool-group-fold"): void {
    if (!this.state.active) return;
    if (source === "mutation") {
      this.scheduleGrowthFrame();
      return;
    }
    if (source === "resize") this.cancelGrowthFrame();
    if (source === "tool-group-fold" && !this.op) this.holdPlaceAcrossToolGroupFold();
    const op = this.op;
    // A settled reader's place follows measurement changes that keep it (a
    // card growing below): recapture once they stop, so a later reflow
    // restores what is on screen now.
    if (!op && source === "resize") this.scheduleAnchorCapture();
    if (op) {
      if (source === "resize") {
        // A measurement changed: not converged until two frames pass without one.
        op.stableFrames = 0;
        op.measuredSinceFrame = true;
        this.reconcile(op, "layout");
        // Virtuoso handles item measurements in a frame it requests from its
        // own resize delivery, which runs before this one. Re-requesting the
        // operation's frame here orders it after that work, so next frame's
        // single correction reads the layout the library actually produced.
        this.reschedule(op);
      }
      return;
    }
    this.followGrowth();
  }

  /**
   * Rows are about to mount beyond the render window (keep-mounted overscan
   * grew because a row took focus or a selection). Virtuoso places them at
   * its estimated row height and, when they measure shorter or taller above
   * the viewport, does not always compensate: the rows on screen jump with no
   * scroll event. Hold a settled reader's place across that measurement.
   */
  holdPlaceAcrossOverscan(): void {
    if (!this.state.active || this.op) return;
    this.holdSettledPlace(true);
  }

  /** Hold a settled reader through one tool-group fold, including its exit animation. */
  private holdPlaceAcrossToolGroupFold(): boolean {
    return this.holdSettledPlace(false);
  }

  /**
   * Restore the place captured once the reader last settled, as a bounded
   * navigation their input still cancels. A pointer held on the transcript's
   * content (a click that focuses a link) may be allowed; one held on the
   * scroller itself is a scrollbar drag and never is.
   */
  private holdSettledPlace(allowContentPointer: boolean): boolean {
    const el = this.scroller;
    const anchor = this.lastReadingAnchor;
    if (
      !el ||
      !anchor ||
      this.state.wantsFollow ||
      Math.abs(el.clientWidth - this.lastWidth) >= 1 ||
      (this.pointerHeld && !(allowContentPointer && !this.pointerOnScroller)) ||
      this.touchActive ||
      now() < Math.max(this.userScrollUntil, this.lastInputAt + INPUT_ARM_MS)
    )
      return false;
    const target: NavigationTarget & { kind: "row" } = {
      kind: "row",
      index: anchor.index ?? 0,
      key: anchor.rowKey,
      partId: anchor.partId,
      offsetPx: anchor.offsetPx,
      inner: anchor.inner,
      foldedGroup: anchor.foldedGroup,
    };
    if (!this.resolve(target)) return false;
    if (!this.navigateTo(target, "reflow")) return false;
    // Resize delivery is before paint. Correct here as well as in subsequent
    // frames, which run after the virtualizer applies its measurements.
    if (this.op) this.reconcile(this.op, "layout");
    return true;
  }

  /**
   * The scroller's width changed. Text above the reader re-wraps and Virtuoso
   * keeps `scrollTop`, so a reading place would drift by however much those
   * rows grew or shrank. Put the place captured before the reflow back, as a
   * bounded navigation (the reader's input still cancels it). A follower is
   * kept at the end by growth; another navigation converges on its own target.
   */
  private holdPlaceAcrossReflow(width: number): void {
    // Hidden (zero width): keep the last real width, so showing the pane at a
    // new width still counts as a reflow.
    if (width <= 0) return;
    const previous = this.lastWidth;
    this.lastWidth = width;
    if (previous === 0 || Math.abs(width - previous) < 1) return;
    if (!this.state.active || this.state.wantsFollow) return;
    if (this.op && this.op.owner !== "reflow") return;
    // A history recovery owns the reader's place until their part is back,
    // and the anchor names a part the list no longer holds. Dropping that
    // history usually shortens the list enough to remove a classic vertical
    // scrollbar, which widens the scroller; a reflow navigation then would
    // bump the generation and cancel the recovery (to-do 0050, task 4).
    if (this.historyRecoveryPending) return;
    const anchor = this.lastReadingAnchor;
    if (!anchor) return;
    this.navigateTo(
      {
        kind: "row",
        index: anchor.index ?? 0,
        key: anchor.rowKey,
        partId: anchor.partId,
        offsetPx: anchor.offsetPx,
        inner: anchor.inner,
        foldedGroup: anchor.foldedGroup,
      },
      "reflow",
    );
  }

  /** The first useful visible content, as an identity and viewport offset. */
  captureAnchor(): SemanticAnchor | null {
    const el = this.scroller;
    if (!el) return null;
    const viewport = el.getBoundingClientRect();
    const top = viewport.top;
    const bottom = top + el.clientHeight;
    const visibleWithin = (element: Element, clipTop: number, clipBottom: number) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > clipTop && rect.top < clipBottom;
    };
    let inner: InnerAnchor | undefined;
    let frameAnchor: HTMLElement | null = null;
    const part = Array.from(el.querySelectorAll<HTMLElement>("[data-transcript-part-id]")).find(
      (element) => {
        if (!visibleWithin(element, top, bottom)) return false;
        const viewportElement = element.closest("[data-transcript-inner-viewport]");
        if (!viewportElement) return true;
        // A member an inner viewport may clip: it counts only where that
        // viewport shows it, and the group frame stands for it outside.
        const clip = viewportElement.getBoundingClientRect();
        if (!visibleWithin(element, Math.max(top, clip.top), Math.min(bottom, clip.bottom))) {
          return false;
        }
        const frame = viewportElement
          .closest("[data-transcript-group-frame]")
          ?.querySelector<HTMLElement>(":scope > [data-transcript-part-id]");
        if (!frame) return false;
        frameAnchor = frame;
        inner = {
          partId: element.dataset.transcriptPartId!,
          screenOffsetPx: element.getBoundingClientRect().top - top,
        };
        return true;
      },
    );
    // The frame itself came first: hold the member its inner viewport shows
    // at the top as well, so the composite place survives either moving.
    const frameHost = part?.parentElement?.matches("[data-transcript-group-frame]")
      ? part.parentElement
      : null;
    const innerViewport = frameHost?.querySelector("[data-transcript-inner-viewport]");
    if (part && !inner && innerViewport) {
      const clip = innerViewport.getBoundingClientRect();
      const member = Array.from(
        innerViewport.querySelectorAll<HTMLElement>("[data-transcript-part-id]"),
      ).find((element) =>
        visibleWithin(element, Math.max(top, clip.top), Math.min(bottom, clip.bottom)),
      );
      if (member) {
        inner = {
          partId: member.dataset.transcriptPartId!,
          screenOffsetPx: member.getBoundingClientRect().top - top,
        };
      }
    }
    const held: HTMLElement | undefined = frameAnchor ?? part;
    const row =
      held?.closest<HTMLElement>("[data-chat-message-index]") ??
      Array.from(el.querySelectorAll<HTMLElement>("[data-chat-message-index]")).find(
        (element) => element.getBoundingClientRect().bottom > top,
      );
    if (!row) return null;
    const index = Number(row.dataset.chatMessageIndex);
    const plainGroup = !inner
      ? held?.closest<HTMLElement>('[data-transcript-group-frame][data-state="open"]')
      : null;
    const latestMember = plainGroup
      ? Array.from(plainGroup.querySelectorAll<HTMLElement>("[data-transcript-part-id]")).at(-1)
      : null;
    const foldedGroup =
      plainGroup && latestMember?.dataset.transcriptPartId
        ? {
            partId: latestMember.dataset.transcriptPartId,
            offsetPx: plainGroup.getBoundingClientRect().top - top,
          }
        : undefined;
    return {
      rowKey: row.dataset.chatMessageKey,
      index: Number.isSafeInteger(index) ? index : undefined,
      partId: held?.dataset.transcriptPartId,
      offsetPx: (held ?? row).getBoundingClientRect().top - top,
      ...(inner ? { inner } : {}),
      ...(foldedGroup ? { foldedGroup } : {}),
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
    if (this.readerMovedUpUnobserved(metrics)) return;
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
      budget: this.budget,
      glide: null,
      startedAt: now(),
      frames: 0,
      stableFrames: 0,
      lastScrollHeight: this.scroller?.scrollHeight ?? 0,
      unmountedFrames: 0,
      partMissingFrames: 0,
      innerSeekFrames: 0,
      reissues: 0,
      indexIssued: false,
      measuredSinceFrame: false,
      partDelta: 0,
      smoothIssued: false,
      smoothHeight: 0,
      arrived: target.kind === "latest" && this.atBottom,
      correctedFrame: -1,
      frame: null,
    };
    this.op = op;
    this.counters.operationsStarted += 1;
    this.publish();
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
      this.counters.operationFrames += 1;
      if (this.scroller) {
        this.reconcile(op, "frame");
      } else if (op.target.kind === "latest") {
        // No scroller to measure: hand the end to the virtualizer once.
        this.adapter.scrollToEnd(op.motion === "smooth" ? "smooth" : "auto");
        this.finish(op, "expired");
        return;
      }
      if (this.op !== op) return;
      if (op.frames >= op.budget.maxFrames || now() - op.startedAt >= op.budget.maxMs) {
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

  private reschedule(op: Operation): void {
    if (op.frame === null || !this.isCurrent(op)) return;
    cancelAnimationFrame(op.frame);
    op.frame = null;
    this.schedule(op);
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
    op.indexIssued = true;
    // The virtualizer positions rows: hold the row so its part lands at the
    // anchor's offset; measured convergence then settles any estimate error.
    const offset =
      target.offsetPx !== undefined
        ? -(target.offsetPx - (target.partId ? op.partDelta : 0))
        : undefined;
    // Identity precedes indices: the row's current index, when the list knows it.
    const resolved = target.key !== undefined ? (this.rowIndexOf?.(target.key) ?? -1) : -1;
    this.adapter.scrollToIndex({
      index: resolved >= 0 ? resolved : target.index,
      align: offset !== undefined ? "start" : (target.align ?? "center"),
      offset,
    });
    op.unmountedFrames = 0;
  }

  /** How far the target part sits below its row's top, if both are rendered. */
  private measurePartDelta(target: Extract<NavigationTarget, { kind: "row" }>): number {
    const row = this.resolve({ ...target, partId: undefined });
    const part = this.resolve(target);
    const rowRect = row?.();
    const partRect = part?.();
    return rowRect && partRect ? partRect.top - rowRect.top : 0;
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
    if (target.foldedGroup && target.offsetPx !== undefined) {
      const summary = findPart(row, target.foldedGroup.partId);
      const group = summary?.closest<HTMLElement>(
        '[data-transcript-group-frame][data-state="closed"]',
      );
      if (group) {
        // Project the old member's offset onto the stable group frame. This
        // applies during the exit animation too, before Radix removes rows.
        const delta = target.offsetPx - target.foldedGroup.offsetPx;
        return () => {
          const rect = group.getBoundingClientRect();
          return new DOMRect(rect.x, rect.y + delta, rect.width, rect.height);
        };
      }
    }
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

  /** The length of one leg of a glide to an unrendered row. */
  private glideLegPx(el: HTMLElement): number {
    return Math.min(GLIDE_LEG_MAX_PX, el.clientHeight * GLIDE_LEG_VIEWPORT_FRACTION);
  }

  /** Which way an unrendered row lies: rendered rows are contiguous, so any one tells. */
  private glideDirection(el: HTMLElement, target: RowTarget): 1 | -1 {
    const row = el.querySelector<HTMLElement>("[data-chat-message-index]");
    const resolved = target.key !== undefined ? (this.rowIndexOf?.(target.key) ?? -1) : -1;
    const index = resolved >= 0 ? resolved : target.index;
    return index > Number(row?.dataset.chatMessageIndex) ? 1 : -1;
  }

  /** One curve from where a rendered target is now, scaled to its distance. */
  private beginWholeGlide(el: HTMLElement, op: Operation, rect: DOMRect): Glide {
    const fromOffset = rect.top - el.getBoundingClientRect().top;
    const distance = Math.abs(fromOffset - this.desiredOffset(op.target, rect, el.clientHeight));
    return {
      phase: "track",
      startedAt: now(),
      durationMs: Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, distance * GLIDE_MS_PER_PX)),
      fromOffset,
      ease: easeInOutCubic,
    };
  }

  /**
   * The journey's last leg, from exactly one leg short of where it can stop.
   * The place the virtualizer found is not that: it was asked for a leg short
   * of the requested offset, which near the transcript's end is past where the
   * scroller stops. Starting from a measured place keeps the departure's speed.
   */
  private beginFinalLeg(
    el: HTMLElement,
    op: Operation,
    rect: DOMRect,
    glide: { direction: 1 | -1; distance: number },
  ): Glide {
    const metrics = readScrollMetrics(el);
    const offset = rect.top - el.getBoundingClientRect().top;
    const clamp = (top: number) => Math.min(Math.max(top, 0), metrics.maxScrollTop);
    const desired = this.desiredOffset(op.target, rect, metrics.clientHeight);
    const end = clamp(metrics.scrollTop + offset - desired);
    const start = clamp(end - glide.direction * glide.distance);
    if (start !== metrics.scrollTop) this.adapter.writeScrollTop(start);
    return {
      phase: "track",
      startedAt: now(),
      durationMs: GLIDE_LEG_MS,
      fromOffset: offset - (start - metrics.scrollTop),
      ease: easeOutCubic,
    };
  }

  /**
   * Run one step of a glide's own movement. True when `reconcile` should carry
   * on (tracking, or settling once the glide has finished); false when this
   * step has done everything for this delivery.
   */
  private advanceGlide(op: Operation, el: HTMLElement, phase: "frame" | "layout"): boolean {
    const glide = op.glide!;
    if (glide.phase === "track") {
      if (now() - glide.startedAt >= glide.durationMs) op.glide = null;
      return true;
    }
    const target = op.target as RowTarget;
    const rect = this.resolve(target)?.() ?? null;
    if (glide.phase === "seek") {
      // Not rendered yet: `reconcile` counts the frames and re-issues.
      if (!rect) return true;
      // The row is here, and the library's retries would now fight the curve.
      this.adapter.cancelPendingNavigation();
      op.glide = this.beginFinalLeg(el, op, rect, glide);
      return true;
    }
    if (phase !== "frame") return false;
    const progress = Math.min(1, (now() - glide.startedAt) / GLIDE_LEG_MS);
    // Keep-mounted overscan can render a nearby target at once: one curve then.
    if (rect && progress < 0.5) {
      op.glide = this.beginWholeGlide(el, op, rect);
      return true;
    }
    if (progress < 1) {
      const covered = easeInCubic(progress) * glide.distance;
      const metrics = readScrollMetrics(el);
      const step = glide.direction * (covered - glide.covered);
      glide.covered = covered;
      this.counters.operationCorrections += 1;
      this.adapter.writeScrollTop(
        Math.min(Math.max(metrics.scrollTop + step, 0), metrics.maxScrollTop),
      );
      return false;
    }
    if (rect) {
      op.glide = this.beginFinalLeg(el, op, rect, glide);
      return true;
    }
    op.glide = { phase: "seek", direction: glide.direction, distance: glide.distance };
    this.issueIndexNavigation(op, {
      ...target,
      offsetPx: (target.offsetPx ?? 0) + glide.direction * glide.distance,
    });
    return false;
  }

  /**
   * Where a tracking glide wants the target now. A destination the transcript
   * cannot reach (the last prompt, short of a viewport from the end) replaces
   * the requested one, so the curve still decelerates into where it stops.
   */
  private glideOffset(
    glide: Extract<Glide, { phase: "track" }>,
    offset: number,
    desired: number,
    metrics: ReturnType<typeof readScrollMetrics>,
  ): number {
    const end = Math.min(Math.max(metrics.scrollTop + offset - desired, 0), metrics.maxScrollTop);
    const reachable = offset - (end - metrics.scrollTop);
    const progress = Math.min(1, (now() - glide.startedAt) / glide.durationMs);
    return glide.fromOffset + (reachable - glide.fromOffset) * glide.ease(progress);
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
    if (op.glide && !this.advanceGlide(op, el, phase)) return;
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
      // The target left the rendered window (estimates moved it): navigate by
      // index at once — pre-paint when this is a layout delivery. A box
      // navigates to the row it lies in; its owner resolves the box afresh
      // once that row is back.
      const row = rowOf(target);
      if (row && !op.indexIssued) {
        this.issueIndexNavigation(op, row);
        return;
      }
      if (
        row &&
        op.unmountedFrames >= REISSUE_AFTER_UNMOUNTED_FRAMES &&
        op.reissues < MAX_INDEX_REISSUES
      ) {
        op.reissues += 1;
        this.issueIndexNavigation(op, row);
      }
      return;
    }
    op.unmountedFrames = 0;
    if (op.target.kind === "row" && op.target.partId) {
      op.partDelta = this.measurePartDelta(op.target);
    }
    // Reads first, then at most one write.
    const rect = rectOf();
    if (!rect) return;
    const viewportTop = el.getBoundingClientRect().top;
    const metrics = readScrollMetrics(el);
    const offset = rect.top - viewportTop;
    const desired = this.desiredOffset(op.target, rect, metrics.clientHeight);
    const error =
      offset -
      (op.glide?.phase === "track"
        ? this.glideOffset(op.glide, offset, desired, metrics)
        : desired);
    const nextTop = Math.min(Math.max(metrics.scrollTop + error, 0), metrics.maxScrollTop);
    const heightStable = metrics.scrollHeight === op.lastScrollHeight;
    op.lastScrollHeight = metrics.scrollHeight;
    if (Math.abs(nextTop - metrics.scrollTop) <= CONVERGENCE_TOLERANCE_PX) {
      // A curve moving slowly is still moving: it cannot converge until it ends.
      if (op.glide) return;
      // The transcript holds the frame (or cannot move further): the inner
      // viewport then puts the member back where the reader saw it, which
      // also absorbs what a clamped transcript could not.
      if (
        op.target.kind === "row" &&
        op.target.inner &&
        this.reconcileInner(op, op.target.inner, phase)
      ) {
        op.stableFrames = 0;
        return;
      }
      if (phase === "frame") {
        op.stableFrames = heightStable && !op.measuredSinceFrame ? op.stableFrames + 1 : 0;
        op.measuredSinceFrame = false;
        if (op.stableFrames >= CONVERGED_FRAMES) {
          this.finish(op, Math.abs(error) > CONVERGENCE_TOLERANCE_PX ? "clamped" : "converged");
        }
      }
      return;
    }
    op.stableFrames = 0;
    // At most one correction per phase per frame: the frame tick's, and the
    // resize delivery's, which reads the layout this frame will paint (rows
    // the frame's own correction brought in included) and so is the one that
    // keeps a displaced anchor off screen.
    const slot = phase === "frame" ? this.frameId * 2 : this.frameId * 2 + 1;
    if (op.correctedFrame === slot) return;
    op.correctedFrame = slot;
    this.counters.operationCorrections += 1;
    this.adapter.writeScrollTop(nextTop);
  }

  /** One inner-viewport correction toward `inner`; true when it wrote. */
  private reconcileInner(op: Operation, inner: InnerAnchor, phase: "frame" | "layout"): boolean {
    const el = this.scroller;
    const frame = op.target.kind === "row" && op.target.partId ? this.resolve(op.target) : null;
    if (!el || !frame) return false;
    const frameElement = Array.from(
      el.querySelectorAll<HTMLElement>("[data-transcript-group-frame]"),
    ).find(
      (candidate) =>
        candidate.querySelector(":scope > [data-transcript-part-id]") !== null &&
        findPart(candidate, (op.target as { partId: string }).partId) !== null,
    );
    const innerScroller = frameElement?.querySelector<HTMLElement>(
      "[data-transcript-inner-viewport] [data-virtuoso-scroller]",
    );
    if (!innerScroller) return false;
    const member = findPart(innerScroller, inner.partId);
    if (!member) {
      // Virtualized away (a history page re-filled the group in front of it):
      // ask the inner viewport for it each frame, for a few frames, since the
      // group may render the member's entry a frame or more after the rows.
      if (op.innerSeekFrames >= INNER_SEEK_FRAMES) return false;
      if (phase === "frame") {
        op.innerSeekFrames += 1;
        innerScroller
          .closest("[data-transcript-inner-viewport]")
          ?.dispatchEvent(new CustomEvent(INNER_SEEK_EVENT, { detail: { partId: inner.partId } }));
      }
      return true;
    }
    const viewportTop = el.getBoundingClientRect().top;
    const error = member.getBoundingClientRect().top - viewportTop - inner.screenOffsetPx;
    const max = Math.max(0, innerScroller.scrollHeight - innerScroller.clientHeight);
    const next = Math.min(Math.max(innerScroller.scrollTop + error, 0), max);
    if (Math.abs(next - innerScroller.scrollTop) <= CONVERGENCE_TOLERANCE_PX) return false;
    const slot = (phase === "frame" ? this.frameId * 2 : this.frameId * 2 + 1) + 0.5;
    if (op.correctedFrame === slot) return true;
    op.correctedFrame = slot;
    this.counters.operationCorrections += 1;
    this.adapter.writeElementScrollTop(innerScroller, next);
    return true;
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
      this.setAtBottom(true);
      if (phase === "frame") {
        op.stableFrames = heightStable && !op.measuredSinceFrame ? op.stableFrames + 1 : 0;
        op.measuredSinceFrame = false;
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
    const slot = phase === "frame" ? this.frameId * 2 : this.frameId * 2 + 1;
    if (op.correctedFrame === slot) return;
    op.correctedFrame = slot;
    this.adapter.writeScrollTop(metrics.maxScrollTop);
  }

  // ------------------------------------------------------------------ input

  /**
   * The reader's own upward movement that no `scroll` event has reported yet,
   * taken as their departure instead of being pinned back to the end.
   *
   * WebKit animates a wheel tick. Its first step can move up by about as much
   * as the list shrinks in the same frame (rows coming into view measure
   * shorter than estimated), so the offset is clamped to the new end and the
   * reader still reads as following. Virtuoso then moves the offset up to keep
   * the rows on screen in place, and the resize delivery that reports the
   * shrink reaches `followGrowth` in the same task, before that movement's
   * `scroll` event. Pinning there put the reader back at the end and cancelled
   * the animation: the tick moved nothing (to-do 7766, retired; transcript-scroll.md,
   * "Reader input"). An offset that fell
   * below the last observed one soon after upward input, ending away from the
   * end, is that movement.
   */
  private readerMovedUpUnobserved(metrics: ScrollMetrics): boolean {
    if (now() >= this.upwardInputUntil) return false;
    if (metrics.scrollTop >= this.lastObservedTop) return false;
    if (metrics.distanceFromEnd < STICK_RELEASE_DISTANCE_PX) return false;
    this.lastObservedTop = metrics.scrollTop;
    this.lastObservedEnd = metrics.maxScrollTop;
    this.shownTop = metrics.scrollTop;
    this.setAtBottom(false);
    this.dispatch({ type: "user-departed" }, "cancelled");
    this.scheduleAnchorCapture();
    return true;
  }

  /** Recognised reader input that will scroll this transcript. */
  private userInput(direction: ScrollDirection | null): void {
    this.lastInputAt = now();
    this.upwardInputUntil = direction === "up" ? this.lastInputAt + UPWARD_INPUT_HOLD_MS : 0;
    this.userScrollUntil = this.lastInputAt + INPUT_ARM_MS;
    if (this.op) this.counters.userInterruptions += 1;
    this.dispatch({ type: "user-navigation" }, "cancelled");
  }

  /**
   * Put back the offset a hide took. WebKit restores a re-shown scroller's
   * offset during a layout that has not yet sized the contents of a container
   * query container inside it (the review report in a pipeline transcript's
   * footer), so the offset is clamped to a range short by that content: 466 px
   * for the report in the long fixture, which put a reader that far up and a
   * follower that far short of the end. It fires `scroll` at the clamped offset
   * before the first frame's animation callbacks. Chromium keeps the offset,
   * so there this writes nothing.
   *
   * Runs from that `scroll` or from the resize delivery that measures the
   * scroller again, whichever comes first; both are before paint, and the
   * `scroll` is before activation's frame. Returns true when the position is
   * the browser's rather than the reader's: still hidden, or just put back.
   */
  private keepOffsetAcrossHide(el: HTMLElement): boolean {
    if (!this.hiddenByLayout) return false;
    if (el.clientHeight === 0) return true;
    this.hiddenByLayout = false;
    // A navigation started since the show (activation) owns the viewport and
    // converges on its own target; the old offset would undo its write.
    if (this.op) return false;
    const kept = this.shownTop;
    if (kept !== null) {
      // Only upward: the engine's clamp (or reset) only lowers the offset,
      // while the virtualizer following growth since the show raises it.
      const top = Math.min(kept, readScrollMetrics(el).maxScrollTop);
      if (top - el.scrollTop >= 1) this.adapter.writeScrollTop(top);
    }
    const metrics = readScrollMetrics(el);
    this.lastObservedTop = metrics.scrollTop;
    this.lastObservedEnd = metrics.maxScrollTop;
    this.shownTop = metrics.scrollTop;
    this.setAtBottom(metrics.distanceFromEnd < STICK_RELEASE_DISTANCE_PX);
    return true;
  }

  private handleScroll(el: HTMLElement): void {
    if (this.keepOffsetAcrossHide(el)) return;
    const metrics = readScrollMetrics(el);
    const previous = this.lastObservedTop;
    const previousEnd = this.lastObservedEnd;
    this.lastObservedTop = metrics.scrollTop;
    this.lastObservedEnd = metrics.maxScrollTop;
    this.shownTop = metrics.scrollTop;
    this.setAtBottom(metrics.distanceFromEnd < STICK_RELEASE_DISTANCE_PX);
    this.scheduleAnchorCapture();
    const written = this.adapter.lastWrittenTop;
    this.adapter.lastWrittenTop = null;
    if (written !== null && Math.abs(metrics.scrollTop - written) < 0.5) return;
    const op = this.op;
    // While a navigation owns the viewport, its own and the virtualizer's
    // compensation writes move it. Movement is the reader's only with a held
    // pointer (a scrollbar drag fires no other event) or input given after
    // the navigation began; the tail of an earlier gesture does not count.
    if (op && !(this.pointerHeld || this.lastInputAt >= op.startedAt)) {
      // The virtualizer moved the viewport (size compensation): the
      // operation has not converged while that is still happening.
      if (metrics.scrollTop !== previous) {
        op.stableFrames = 0;
        op.measuredSinceFrame = true;
      }
      return;
    }
    const t = now();
    // A scrollbar drag has no wheel/key event to arm the input window. Its
    // released tail must also settle before layout may restore an old anchor.
    if (this.pointerHeld && metrics.scrollTop !== previous) {
      this.lastInputAt = t;
    }
    const armed = t < this.userScrollUntil;
    if (!armed && !this.pointerHeld && !this.touchActive) {
      // Browser find, focus navigation and assistive technology can move an
      // idle viewport without a classified input event. Upward movement that
      // increases the gap without end growth is a departure too. Comparing
      // gaps also excludes shrinking-content compensation at the end.
      // Release follow before the affordance resizes the dock and pins again.
      if (
        metrics.maxScrollTop <= previousEnd &&
        metrics.scrollTop < previous - POINTER_SCROLL_UP_TOLERANCE_PX &&
        metrics.distanceFromEnd >= STICK_RELEASE_DISTANCE_PX &&
        metrics.distanceFromEnd >
          Math.max(0, previousEnd - previous) + POINTER_SCROLL_UP_TOLERANCE_PX
      ) {
        this.dispatch({ type: "user-departed" }, "cancelled");
        this.scheduleAnchorCapture();
      }
      return;
    }
    if (armed || this.touchActive) {
      this.userScrollUntil = Math.max(this.userScrollUntil, t + MOMENTUM_CHAIN_MS);
    }
    if ((op || this.pointerHeld) && metrics.scrollTop !== previous) {
      if (op) this.counters.userInterruptions += 1;
      this.dispatch({ type: "user-navigation" }, "cancelled");
    }
    this.evaluateMovement(metrics.scrollTop, previous, metrics.distanceFromEnd, armed);
    // The first departure changes follow intent inside evaluateMovement.
    // Capture only after that transition so a single scroll establishes a place.
    this.scheduleAnchorCapture();
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

  /** Wheel input on a sibling overlay belongs to this viewport. */
  forwardWheel(event: WheelEvent): void {
    const el = this.scroller;
    if (!el || !this.active || event.defaultPrevented) return;
    const direction = classifyWheel(event, el);
    if (!direction) return;
    this.userInput(direction);
    event.preventDefault();
    // WheelEvent units are pixels, lines, or viewport pages respectively.
    const unit = event.deltaMode === 2 ? el.clientHeight : event.deltaMode === 1 ? 16 : 1;
    el.scrollTop += event.deltaY * unit;
    this.handleScroll(el);
  }

  private listen(el: HTMLElement): () => void {
    const doc = el.ownerDocument;
    const view = doc.defaultView ?? window;
    const onWheel = (event: WheelEvent) => {
      const direction = classifyWheel(event, el);
      if (direction) {
        this.userInput(direction);
        return;
      }
      // Scrolling an inner viewport is the reader's too when the current
      // navigation is positioning a member inside one.
      const target = this.op?.target;
      if (
        target?.kind === "row" &&
        target.inner &&
        event.target instanceof Element &&
        event.target.closest("[data-transcript-inner-viewport]")
      ) {
        this.userInput(null);
      }
    };
    const onScroll = () => this.handleScroll(el);
    const onPointerDown = (event: PointerEvent) => {
      this.pointerHeld = true;
      this.pointerOnScroller = event.target === el;
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
        this.userInput(direction);
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
      if (direction) this.userInput(direction);
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
      resizeObserver = new ResizeObserver((entries) => {
        // Before anything measures from the offset: a hide may have taken it.
        if (el.clientHeight === 0) this.hiddenByLayout = true;
        else this.keepOffsetAcrossHide(el);
        this.notifyLayout("resize");
        // A reflow's restore starts after this delivery's reconcile: its first
        // correction runs in the operation frame, after Virtuoso has applied
        // the re-wrapped rows' sizes. Correcting here as well compensated the
        // same growth twice for one painted frame.
        if (entries.some((entry) => entry.target === el))
          this.holdPlaceAcrossReflow(el.clientWidth);
      });
      this.lastWidth = el.clientWidth;
      resizeObserver.observe(el);
      const observed = new WeakSet<Element>();
      // Virtuoso's viewport child is absolutely sized to the scroller; the
      // list inside it (and the header and footer) is what grows. Observe two
      // levels so growth is delivered after layout and before paint.
      const observeChildren = () => {
        for (const child of Array.from(el.children)) {
          for (const element of [child, ...Array.from(child.children)]) {
            if (!observed.has(element)) {
              resizeObserver!.observe(element);
              observed.add(element);
            }
          }
        }
      };
      observeChildren();
      // Footer content is nested inside Virtuoso's wrappers, so watch the
      // subtree; re-walk the observed levels only when one gained a node.
      if (typeof MutationObserver !== "undefined") {
        mutationObserver = new MutationObserver((records) => {
          // A delivery that cannot be classified is treated as structural.
          let structural = records.length === 0;
          let shifted = false;
          let toolGroupFold = false;
          for (const record of records) {
            if (record.type === "attributes") {
              if (
                record.attributeName === "data-state" &&
                (record.target as Element).matches(".tool-group-fold-content")
              ) {
                toolGroupFold = true;
              }
              // Virtuoso keeps rows in place across size changes with a list
              // margin and a deferred scroll; neither resizes what is observed
              // (nor does an inner viewport's own compensation).
              if (
                observed.has(record.target as Element) ||
                (record.target as Element).closest?.("[data-transcript-inner-viewport]")
              ) {
                shifted = true;
              }
              continue;
            }
            structural = true;
            if (
              record.addedNodes.length > 0 &&
              (record.target === el || record.target.parentNode === el)
            ) {
              observeChildren();
            }
          }
          // During a navigation, a structural change (a header removed, rows
          // replaced) can move the target with no resize: settle it before
          // paint. Only while an operation runs, so streaming pays nothing.
          if (toolGroupFold) this.notifyLayout("tool-group-fold");
          if ((shifted || structural) && this.op) this.reconcile(this.op, "layout");
          if (structural) this.notifyLayout("mutation");
        });
        mutationObserver.observe(el, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style", "data-state"],
        });
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
