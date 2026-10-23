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
  /**
   * A member inside an inner viewport (an open long tool group): `partId`
   * then names the group frame the transcript holds, and this the member the
   * inner viewport holds at its on-screen offset from the transcript's top.
   */
  inner?: InnerAnchor;
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
  /** Frames operations ran, and the corrections they wrote. */
  operationFrames: number;
  operationCorrections: number;
  /** Operations a newly taken follow pause retired. */
  pauseRetirements: number;
  /** Operations retired because the scroller element changed. */
  scrollerRetirements: number;
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
  /** An index navigation has been issued for this operation. */
  indexIssued: boolean;
  /** A resize was delivered since the operation's last frame. */
  measuredSinceFrame: boolean;
  /** The target part's offset inside its row, when both were last measured. */
  partDelta: number;
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
  /** When the reader last gave input that will scroll this transcript. */
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private pointerHeld = false;
  private lastPointerInside = false;
  private touchActive = false;
  private touchScrollTop = 0;
  private readonly touch = new TouchGesture();
  private growthFrame: number | null = null;
  private anchorTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReadingAnchor: SemanticAnchor | null = null;

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
    return {
      isAtBottom: this.atBottom,
      followAllowed: followAllowed(this.state),
      mode: viewportMode(this.state),
      targetKey: target?.kind === "row" ? (target.key ?? null) : null,
    };
  }

  private publish(): void {
    const next = this.computeSnapshot();
    const previous = this.snapshot;
    if (
      next.isAtBottom === previous.isAtBottom &&
      next.followAllowed === previous.followAllowed &&
      next.mode === previous.mode &&
      next.targetKey === previous.targetKey
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
    if (this.op) {
      this.counters.scrollerRetirements += 1;
      this.dispatch({ type: "user-navigation" }, "cancelled");
    }
    if (!element) return;
    this.lastObservedTop = element.scrollTop;
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
    if (!mounted && (target.kind === "rect" || !this.adapter.ready)) return false;
    const op = this.begin(owner, target, "instant");
    if (mounted && target.kind === "row" && target.partId) {
      op.partDelta = this.measurePartDelta(target);
    }
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
  notifyLayout(source: "resize" | "list-height" | "mutation"): void {
    if (!this.state.active) return;
    if (source === "mutation") {
      this.scheduleGrowthFrame();
      return;
    }
    if (source === "resize") this.cancelGrowthFrame();
    const op = this.op;
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
    return {
      rowKey: row.dataset.chatMessageKey,
      index: Number.isSafeInteger(index) ? index : undefined,
      partId: held?.dataset.transcriptPartId,
      offsetPx: (held ?? row).getBoundingClientRect().top - top,
      ...(inner ? { inner } : {}),
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
      indexIssued: false,
      measuredSinceFrame: false,
      partDelta: 0,
      smoothIssued: false,
      smoothHeight: 0,
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
      // The target left the rendered window (estimates moved it): navigate by
      // index at once — pre-paint when this is a layout delivery.
      if (target.kind === "row" && !op.indexIssued) {
        this.issueIndexNavigation(op, target);
        return;
      }
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
    if (op.target.kind === "row" && op.target.partId) {
      op.partDelta = this.measurePartDelta(op.target);
    }
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
    if (!member) return false;
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

  /** Recognised reader input that will scroll this transcript. */
  private userInput(): void {
    this.lastInputAt = now();
    this.userScrollUntil = this.lastInputAt + INPUT_ARM_MS;
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
    const armed = t < this.userScrollUntil;
    if (!armed && !this.pointerHeld && !this.touchActive) return;
    if (armed || this.touchActive) {
      this.userScrollUntil = Math.max(this.userScrollUntil, t + MOMENTUM_CHAIN_MS);
    }
    if (op && metrics.scrollTop !== previous) {
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
      if (direction) {
        this.userInput();
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
        this.userInput();
      }
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
          for (const record of records) {
            if (record.type === "attributes") {
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
          if ((shifted || structural) && this.op) this.reconcile(this.op, "layout");
          if (structural) this.notifyLayout("mutation");
        });
        mutationObserver.observe(el, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style"],
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
