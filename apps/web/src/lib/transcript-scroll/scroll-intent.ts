/**
 * Scroll intent for one transcript viewport, as a pure transition function.
 *
 * The controller (`transcript-scroll-controller.ts`) is the only writer of a
 * transcript's scroll position. This module decides *who may move it*: whether
 * the reader is following the tail, reading in place, or a bounded navigation
 * (latest, find, a message link, history restoration) currently owns the
 * viewport. It holds no DOM state, so every rule here is unit-testable.
 *
 * Follow is intent, not geometry. Growth that leaves the viewport short of the
 * end never ends following; a navigation or measurement that happens to land
 * near the end never starts it. Only the reader leaving the end, the reader
 * arriving at it, or an explicit request for the latest message changes it.
 */

/** Who owns a bounded navigation. */
export type NavigationOwner = "latest" | "find" | "message-link" | "history" | "restore" | "row";

/** A reason automatic following is temporarily suppressed. */
export type FollowPauseReason = "selection" | "find" | "expanded-artifact";

export type ViewportMode = "inactive" | "following" | "reading" | "navigating";

export interface ScrollOperationState {
  readonly generation: number;
  readonly owner: NavigationOwner;
}

export interface ScrollIntentState {
  readonly active: boolean;
  /** Durable: the reader wants new content to stay in view. */
  readonly wantsFollow: boolean;
  readonly pauseReasons: ReadonlySet<string>;
  /**
   * Bumped by every navigation, every retirement and every user interruption.
   * Asynchronous work captures it and must match it before writing.
   */
  readonly generation: number;
  readonly operation: ScrollOperationState | null;
  /** Growth a pause suppressed for a following reader, owed on release. */
  readonly growthOwed: boolean;
  /** Generation when the current pause began; superseded once it differs. */
  readonly pausedAt: number | null;
}

export type ScrollIntentEvent =
  | { readonly type: "navigate"; readonly owner: NavigationOwner }
  | { readonly type: "finish"; readonly generation: number }
  /** Any recognised reader input that will move this transcript. */
  | { readonly type: "user-navigation" }
  /** The reader's own movement ended away from the end. */
  | { readonly type: "user-departed" }
  /** The reader's own movement arrived at the true end. */
  | { readonly type: "user-arrived" }
  | { readonly type: "pause"; readonly reason: string; readonly paused: boolean }
  | { readonly type: "growth" }
  | { readonly type: "activate" }
  | { readonly type: "deactivate" }
  /** Seed intent from a persisted entry (mount, or a validated restore). */
  | { readonly type: "seed"; readonly wantsFollow: boolean };

export function initialScrollIntent(wantsFollow = true, active = true): ScrollIntentState {
  return {
    active,
    wantsFollow,
    pauseReasons: new Set(),
    generation: 0,
    operation: null,
    growthOwed: false,
    pausedAt: null,
  };
}

/** `pausedAt` once a navigation or the reader's own movement replaced what the pause held. */
const SUPERSEDED = -1;

/** A pause leaves a navigation of this owner in place (find navigates while find pauses). */
function pauseAllows(reason: string, owner: NavigationOwner): boolean {
  return reason === "find" && owner === "find";
}

function retire(state: ScrollIntentState): ScrollIntentState {
  return { ...state, operation: null, generation: state.generation + 1 };
}

export function reduceScrollIntent(
  state: ScrollIntentState,
  event: ScrollIntentEvent,
): ScrollIntentState {
  switch (event.type) {
    case "navigate": {
      const generation = state.generation + 1;
      return {
        ...state,
        generation,
        operation: { generation, owner: event.owner },
        // Asking for the latest message is a choice to follow; any other
        // navigation is a choice to read where it lands.
        wantsFollow: event.owner === "latest",
        growthOwed: false,
        // A navigation supersedes the intent a pause was holding.
        pausedAt: state.pausedAt === null ? null : SUPERSEDED,
      };
    }
    case "finish":
      return state.operation?.generation === event.generation
        ? { ...state, operation: null }
        : state;
    case "user-navigation": {
      const next = state.operation ? retire(state) : { ...state, generation: state.generation + 1 };
      // The reader moved: whatever a pause was holding is now theirs.
      return { ...next, pausedAt: state.pausedAt === null ? null : SUPERSEDED, growthOwed: false };
    }
    case "user-departed":
      return state.wantsFollow || state.operation
        ? { ...(state.operation ? retire(state) : state), wantsFollow: false, growthOwed: false }
        : state;
    case "user-arrived":
      return state.wantsFollow ? state : { ...state, wantsFollow: true };
    case "pause": {
      const reasons = new Set(state.pauseReasons);
      const had = reasons.has(event.reason);
      if (event.paused === had) return state;
      if (event.paused) reasons.add(event.reason);
      else reasons.delete(event.reason);
      let next: ScrollIntentState = { ...state, pauseReasons: reasons };
      if (event.paused) {
        // Taking a pause retires movement it is incompatible with, so an
        // in-flight bottom journey cannot overwrite a selection or find.
        if (next.operation && !pauseAllows(event.reason, next.operation.owner)) next = retire(next);
        if (state.pauseReasons.size === 0) next = { ...next, pausedAt: next.generation };
        return next;
      }
      if (reasons.size > 0) return next;
      return { ...next, pausedAt: null, growthOwed: false };
    }
    case "growth":
      return state.pauseReasons.size > 0 && state.wantsFollow && !state.growthOwed
        ? { ...state, growthOwed: true }
        : state;
    case "activate":
      return state.active ? state : { ...state, active: true };
    case "deactivate":
      return state.active || state.operation
        ? { ...(state.operation ? retire(state) : state), active: false }
        : state;
    case "seed":
      return { ...state, wantsFollow: event.wantsFollow };
  }
}

export function viewportMode(state: ScrollIntentState): ViewportMode {
  if (!state.active) return "inactive";
  if (state.operation) return "navigating";
  return state.wantsFollow ? "following" : "reading";
}

/**
 * Automatic following may run: the library's own follow path, and the
 * controller's growth pins. Literal `false` reaches Virtuoso otherwise.
 */
export function followAllowed(state: ScrollIntentState): boolean {
  return state.active && state.wantsFollow && state.pauseReasons.size === 0 && !state.operation;
}

/**
 * Whether releasing the last pause (the transition `previous` → `next`) owes
 * the reader the growth that arrived meanwhile: they still want to follow and
 * neither a navigation nor their own movement superseded that intent.
 */
export function owedOnRelease(previous: ScrollIntentState, next: ScrollIntentState): boolean {
  return (
    previous.pauseReasons.size > 0 &&
    next.pauseReasons.size === 0 &&
    previous.growthOwed &&
    next.wantsFollow &&
    previous.pausedAt === previous.generation &&
    next.operation === null
  );
}
