import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { VirtuosoHandle, StateSnapshot } from "react-virtuoso";
import type { NavigationOwner } from "@/lib/transcript-scroll/scroll-intent";
import {
  TranscriptScrollController,
  type InnerAnchor,
  type SemanticAnchor,
  type ScrollDiagnostics,
} from "@/lib/transcript-scroll/transcript-scroll-controller";

/** Virtuoso's reporting band; UI and follow intent use true-bottom geometry. */
const AT_BOTTOM_THRESHOLD = 50;

/** Maximum persisted scroll states to retain (LRU eviction) */
const MAX_PERSISTED_STATES = 200;

/** Readiness retries for activation positioning after the scroller has mounted */
const ACTIVATION_SCROLL_READY_MAX_ATTEMPTS = 30;

/**
 * Bumped when the meaning of a persisted entry changes, so an entry written by
 * another build is dropped rather than misread.
 */
const PERSISTED_LAYOUT_VERSION = 2;

interface PersistedEntry {
  version: number;
  snapshot: StateSnapshot;
  wantsStick: boolean;
  /**
   * The reader's semantic place. Pixel snapshots are presentation state that
   * a reflow (another width, font or projection) invalidates; this identity
   * is what a detached reader is returned to.
   */
  anchor: SemanticAnchor | null;
  /** Scroller width the snapshot was measured at. */
  widthPx: number;
}

const persistedStates = new Map<string, PersistedEntry>();

/**
 * Whether a persisted snapshot is safe to hand back to Virtuoso.
 *
 * `restoreStateFrom` feeds these numbers straight into Virtuoso's size and
 * offset trees, whose binary search throws from inside a render for values it
 * cannot order (negative indices, NaN, inverted ranges). A snapshot is captured
 * by `getState` and should always be well-formed, but a malformed one is not a
 * recoverable degradation: the throw reaches the view's error boundary, and
 * because this map outlives the remount, every retry replays the same crash.
 * Restoring nothing merely costs the scroll position.
 *
 * Only the ranges are checked for orderability, because only they reach that
 * binary search. `scrollTop` is validated for finiteness alone: `getState`
 * records it as `scrollTop - headerHeight`, and restore feeds it straight back
 * as `{ align: "start", index: 0, offset }` — so a view with a Virtuoso Header
 * legitimately persists a *negative* value whenever the viewport sits inside
 * that header, and rejecting the sign would forfeit the position it encodes.
 */
export function isRestorableStateSnapshot(
  snapshot: StateSnapshot | undefined,
): snapshot is StateSnapshot {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (!Number.isFinite(snapshot.scrollTop)) return false;
  if (!Array.isArray(snapshot.ranges)) return false;
  return snapshot.ranges.every((range, index, ranges) => {
    const endIndexIsValid =
      Number.isInteger(range?.endIndex) ||
      (range?.endIndex === Number.POSITIVE_INFINITY && index === ranges.length - 1);
    const previous = ranges[index - 1];
    return (
      Number.isInteger(range?.startIndex) &&
      endIndexIsValid &&
      Number.isFinite(range?.size) &&
      range.startIndex >= 0 &&
      range.endIndex >= range.startIndex &&
      range.size >= 0 &&
      (previous === undefined || range.startIndex > previous.endIndex)
    );
  });
}

function setPersistedState(key: string, entry: PersistedEntry) {
  persistedStates.delete(key);
  persistedStates.set(key, entry);

  if (persistedStates.size > MAX_PERSISTED_STATES) {
    const oldestKey = persistedStates.keys().next().value;
    if (oldestKey) {
      persistedStates.delete(oldestKey);
    }
  }
}

export function clearPersistedVirtuosoState(persistKey: string) {
  persistedStates.delete(persistKey);
}

/**
 * What activating the view does with the viewport.
 *
 * - `respect-intent` (default): a reader who was following catches up to the
 *   latest message; a detached reader is returned to their semantic place; an
 *   explicit message target pending for this view wins over both.
 * - `latest`: every activation jumps to the latest message and follows it.
 *   For views whose documented policy is "show what is happening now".
 */
export type ActivationPolicy = "respect-intent" | "latest";

interface UseVirtuosoScrollStateOptions {
  /** Whether the host view is currently active/visible */
  isActive?: boolean;
  /** Optional persistence key for retaining scroll state across tab switches */
  persistKey?: string;
  activation?: ActivationPolicy;
  /** Legacy spelling of `activation: "latest"`. */
  stickToBottomOnActivation?: boolean;
  /**
   * An explicit navigation (a "scroll to message" request) is waiting for
   * this view. Activation positioning defers to it; if the request is dropped
   * without navigating, activation applies its own policy then.
   */
  explicitTargetPending?: boolean;
  /**
   * Environment this view belongs to. Retained for callers; activation no
   * longer forces the bottom after an environment switch — returning readers
   * keep their place and followers catch up either way.
   */
  environmentId?: string;
}

/** A source tool (or row start) held at its previous viewport offset. */
export interface TranscriptScrollAnchor {
  partId?: string;
  /** The display row's item key, when known; resolves before the index. */
  rowKey?: string;
  /** Hold the target this far below the viewport top; centred when absent. */
  offset?: number;
  /** A member an inner viewport holds, inside the group frame `partId` names. */
  inner?: InnerAnchor;
}

interface UseVirtuosoScrollStateReturn {
  /** Whether the user is currently at the bottom of the scroll area */
  isAtBottom: boolean;
  /** Ref that tracks at-bottom state without triggering re-renders (for use in effects) */
  isAtBottomRef: React.RefObject<boolean>;
  /** Return to the latest message (smooth) and follow it. */
  scrollToBottom: () => void;
  /**
   * Bring one row (and optionally a source part at a viewport offset) into
   * view and read there: following stops, neither activation nor streaming
   * pulls the reader back. False when the list has not mounted yet.
   */
  scrollToIndex: (
    index: number,
    anchor?: TranscriptScrollAnchor,
    owner?: NavigationOwner,
  ) => boolean;
  /** Ref to attach to the Virtuoso component */
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  /** Bounded, content-free counters for diagnostics and tests. */
  getScrollDiagnostics: () => ScrollDiagnostics;
  /** Props to spread onto the Virtuoso component */
  scrollProps: {
    followOutput: (isAtBottom: boolean) => "auto" | false;
    /**
     * Whether automatic following may run now. When false the list passes the
     * literal `false` to Virtuoso: a function prop is truthy to its
     * size-change paths even when it would return false.
     */
    followEnabled: boolean;
    atBottomStateChange: (atBottom: boolean) => void;
    atBottomThreshold: number;
    totalListHeightChanged: (height: number) => void;
    restoreStateFrom: StateSnapshot | undefined;
    scrollerRef: (el: HTMLElement | Window | null) => void;
    /**
     * Hold or release one reason to pause auto-follow (a text selection in
     * the transcript, an open find bar, an expanded artifact). Taking one
     * retires an in-flight automatic journey; while any is held, new content
     * does not move the viewport; a still-following reader is brought to the
     * growth that arrived meanwhile when the last is released.
     */
    setFollowPaused: (reason: string, paused: boolean) => void;
    /** The viewport's single positioning owner; find and targets navigate through it. */
    controller: TranscriptScrollController;
  };
}

/**
 * Scroll state for a react-virtuoso transcript, owned by one
 * `TranscriptScrollController` per mounted view.
 *
 * - Follow is intent: growth that leaves the viewport short of the end does
 *   not stop following; only the reader's own movement away from the end does,
 *   and only their own arrival there (or asking for the latest) resumes it.
 * - Every navigation — latest, a row, find, history restoration — is one
 *   bounded operation that converges on measured geometry, and any reader
 *   input that moves the transcript retires it, in either direction.
 * - Streaming follow pins synchronously after layout and before paint, so the
 *   tail holds still while tokens arrive.
 * - Scroll state persists across tab switches: a pixel snapshot for the
 *   virtualizer plus the reader's semantic place and intent.
 */
export function useVirtuosoScrollState(
  options: UseVirtuosoScrollStateOptions = {},
): UseVirtuosoScrollStateReturn {
  const {
    isActive = true,
    persistKey,
    stickToBottomOnActivation = false,
    explicitTargetPending = false,
  } = options;
  const activation: ActivationPolicy =
    options.activation ?? (stickToBottomOnActivation ? "latest" : "respect-intent");

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // Resolve persisted state once on mount. A snapshot that fails validation is
  // dropped from the map as well: it would fail identically on every future
  // mount, and retaining it keeps a crash-then-retry cycle deterministic.
  const [persisted] = useState<PersistedEntry | undefined>(() => {
    if (!persistKey) return undefined;
    const entry = persistedStates.get(persistKey);
    if (!entry) return undefined;
    if (entry.version !== PERSISTED_LAYOUT_VERSION || !isRestorableStateSnapshot(entry.snapshot)) {
      persistedStates.delete(persistKey);
      return undefined;
    }
    return entry;
  });
  const [controller] = useState(
    () =>
      new TranscriptScrollController(virtuosoRef, {
        initialWantsFollow: persisted?.wantsStick ?? true,
        initialActive: isActive,
      }),
  );
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    setScrollerEl(el instanceof HTMLElement ? el : null);
  }, []);
  useEffect(() => {
    controller.attachScroller(scrollerEl);
    return () => controller.attachScroller(null);
  }, [controller, scrollerEl]);

  // Always restore the snapshot when one exists: it lands the reader near
  // their place with no flash from the top; activation then catches a
  // follower up, or settles a detached reader on their semantic anchor.
  const restoreStateFrom = persisted?.snapshot;

  /** The place captured as this view last deactivated (for a same-mount return). */
  const lastDeactivationAnchor = useRef<SemanticAnchor | null>(null);

  // Deactivation retires every pending write and persists intent and place.
  useEffect(() => {
    controller.setActive(isActive);
    if (isActive) return;
    // A hidden pane has no geometry; the controller keeps the reader's place
    // current while they read, so fall back to that.
    const anchor = controller.wantsFollow
      ? null
      : (controller.captureAnchor() ?? controller.readingAnchor);
    lastDeactivationAnchor.current = anchor;
    if (!persistKey) return;
    const widthPx = scrollerEl?.clientWidth ?? 0;
    const handle = virtuosoRef.current;
    if (!handle || typeof handle.getState !== "function") return;
    handle.getState((snapshot) => {
      setPersistedState(persistKey, {
        version: PERSISTED_LAYOUT_VERSION,
        snapshot,
        wantsStick: controller.wantsFollow,
        anchor,
        widthPx,
      });
    });
  }, [controller, isActive, persistKey, scrollerEl]);

  useEffect(() => () => controller.setActive(false), [controller]);

  // ------------------------------------------------------------ activation

  /** The anchor a detached reader returns to on the next activation. */
  const returnAnchorRef = useRef<SemanticAnchor | null>(
    persisted && !persisted.wantsStick ? persisted.anchor : null,
  );
  const deactivatedSinceMountRef = useRef(false);
  /** Activation positioning still to run: what, and the generation it was decided at. */
  const pendingActivationRef = useRef<{
    kind: "latest" | "restore";
    generation: number;
    attempts: number;
  } | null>(null);
  const activationFrameRef = useRef<number | null>(null);

  const cancelActivationFrame = useCallback(() => {
    if (activationFrameRef.current !== null) {
      cancelAnimationFrame(activationFrameRef.current);
      activationFrameRef.current = null;
    }
  }, []);

  const runPendingActivation = useCallback(
    function runPendingActivation() {
      if (activationFrameRef.current !== null) return;
      activationFrameRef.current = requestAnimationFrame(() => {
        activationFrameRef.current = null;
        const pending = pendingActivationRef.current;
        if (!pending || !controller.active) return;
        // Anything that moved the viewport since (the reader, an explicit
        // target) supersedes the activation decision.
        if (controller.generation !== pending.generation) {
          pendingActivationRef.current = null;
          return;
        }
        let started = false;
        if (pending.kind === "latest") {
          started = controller.navigateToLatest("instant");
        } else {
          const anchor = returnAnchorRef.current;
          started =
            !anchor ||
            controller.navigateTo(
              {
                kind: "row",
                index: anchor.index ?? 0,
                key: anchor.rowKey,
                partId: anchor.partId,
                offsetPx: anchor.offsetPx,
                inner: anchor.inner,
              },
              "restore",
            );
        }
        if (started) {
          pendingActivationRef.current = null;
          returnAnchorRef.current = null;
          return;
        }
        // The scroller exists but the list is not ready: retry briefly. With
        // no scroller (the tab is still connecting) wait for it to mount.
        if (controller.hasScroller) {
          if (pending.attempts < ACTIVATION_SCROLL_READY_MAX_ATTEMPTS) {
            pending.attempts += 1;
            runPendingActivation();
          } else {
            // Give up so a later scroller remount cannot replay a stale
            // activation over a reader who has since moved.
            pendingActivationRef.current = null;
          }
        }
      });
    },
    [controller],
  );

  const explicitTargetPendingRef = useRef(explicitTargetPending);
  const runPendingActivationRef = useRef(runPendingActivation);
  useLayoutEffect(() => {
    explicitTargetPendingRef.current = explicitTargetPending;
    runPendingActivationRef.current = runPendingActivation;
  });

  useEffect(() => {
    if (!isActive) {
      // Counted here rather than on activation so StrictMode's replayed
      // mount effect still reads as the first activation.
      deactivatedSinceMountRef.current = true;
      pendingActivationRef.current = null;
      cancelActivationFrame();
      return;
    }
    const isFirstActivation = !deactivatedSinceMountRef.current;
    let kind: "latest" | "restore" | null;
    if (activation === "latest") {
      kind = "latest";
    } else if (controller.wantsFollow) {
      // First mount: the snapshot and growth pins already land a follower at
      // the end. On return, catch them up in one bounded journey.
      kind = isFirstActivation ? null : "latest";
    } else {
      // A detached reader: on return, settle their semantic place if one was
      // captured (a hidden pane keeps its pixels; a remount may not).
      if (!isFirstActivation) returnAnchorRef.current ??= lastDeactivationAnchor.current;
      kind = returnAnchorRef.current ? "restore" : null;
    }
    if (kind === null) return;
    pendingActivationRef.current = { kind, generation: controller.generation, attempts: 0 };
    // Decided once per activation; a target dropped later re-enters below.
    if (!explicitTargetPendingRef.current) runPendingActivationRef.current();
    return cancelActivationFrame;
  }, [isActive, activation, cancelActivationFrame, controller]);

  // An explicit target waiting for this view holds activation back. Once it
  // is gone, run what remains unless its navigation (or anything else)
  // already moved the viewport — `runPendingActivation` checks the generation.
  useEffect(() => {
    if (!isActive || explicitTargetPending) return;
    if (pendingActivationRef.current) runPendingActivation();
  }, [isActive, explicitTargetPending, scrollerEl, runPendingActivation]);

  // -------------------------------------------------------------- commands

  const scrollToBottom = useCallback(() => {
    controller.navigateToLatest("smooth");
  }, [controller]);

  const scrollToIndex = useCallback(
    (index: number, anchor?: TranscriptScrollAnchor, owner: NavigationOwner = "row"): boolean => {
      if (!Number.isInteger(index) || index < 0) return false;
      pendingActivationRef.current = null;
      cancelActivationFrame();
      return controller.navigateTo(
        {
          kind: "row",
          index,
          key: anchor?.rowKey,
          partId: anchor?.partId,
          offsetPx: anchor?.offset,
          align: anchor?.offset !== undefined ? "start" : "center",
          inner: anchor?.inner,
        },
        owner,
      );
    },
    [cancelActivationFrame, controller],
  );

  const setFollowPaused = useCallback(
    (reason: string, paused: boolean) => controller.setFollowPause(reason, paused),
    [controller],
  );
  const atBottomStateChange = useCallback(
    (atBottom: boolean) => controller.reportAtBottom(atBottom),
    [controller],
  );
  const totalListHeightChanged = useCallback(
    (_height: number) => controller.notifyLayout("list-height"),
    [controller],
  );
  const getScrollDiagnostics = useCallback(() => controller.diagnostics(), [controller]);

  return {
    isAtBottom: view.isAtBottom,
    isAtBottomRef: controller.isAtBottomRef,
    scrollToBottom,
    scrollToIndex,
    virtuosoRef,
    getScrollDiagnostics,
    scrollProps: {
      followOutput: controller.followOutput,
      followEnabled: view.followAllowed,
      atBottomStateChange,
      atBottomThreshold: AT_BOTTOM_THRESHOLD,
      totalListHeightChanged,
      restoreStateFrom,
      scrollerRef,
      setFollowPaused,
      controller,
    },
  };
}
