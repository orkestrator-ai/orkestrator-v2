/**
 * Moves a host element between layouts without losing the state the browser
 * keeps outside the DOM tree.
 *
 * Moving a node with `appendChild` detaches it first. A detached node loses
 * every scroll offset, blurs its focused descendant and drops its text
 * selection, so a layout switch that reparents content with it scrolls every
 * terminal and transcript back to the top. `moveBefore` (Chromium 133+, so
 * every Electron build) moves a node between two connected parents atomically
 * and keeps scroll offsets and focus, but still collapses a document selection
 * inside the node, which is the caret of a contenteditable composer. So the
 * selection is read before every move and put back after it. Other engines,
 * Safari among them, fall back to `appendChild` and also get back the scroll
 * offsets and focus that can be read before the move. A pane that is hidden
 * with `display: none` after the move cannot be scrolled, so it only keeps its
 * offsets through `moveBefore`.
 */

type MoveBeforeParent = Node & { moveBefore?: (node: Node, child: Node | null) => void };

interface HostState {
  /** False when only the selection was read, because `moveBefore` keeps the rest. */
  complete: boolean;
  scrolled: Array<{ element: Element; top: number; left: number }>;
  focused: HTMLElement | null;
  selection: {
    anchorNode: Node;
    anchorOffset: number;
    focusNode: Node;
    focusOffset: number;
  } | null;
  textSelection: { start: number; end: number; direction: "forward" | "backward" | "none" } | null;
}

/** State read when a host was parked, restored when a slot claims it. */
const parkedStates = new WeakMap<HTMLElement, HostState>();

function canMoveBefore(host: HTMLElement, parent: Node): boolean {
  return (
    typeof (parent as MoveBeforeParent).moveBefore === "function" &&
    host.isConnected &&
    parent.isConnected
  );
}

/** Moves `host` to the end of `parent`, keeping what the engine allows. */
function moveHost(host: HTMLElement, parent: Node, state: HostState | undefined): void {
  if (canMoveBefore(host, parent)) {
    const selection = state ?? captureHostState(host, false);
    try {
      (parent as MoveBeforeParent).moveBefore!(host, null);
      restoreHostState(host, selection);
      return;
    } catch {
      // Different documents or shadow roots; the fallback still moves the node.
    }
  }
  const full = state?.complete ? state : captureHostState(host, true);
  parent.appendChild(host);
  restoreHostState(host, full);
}

function isTextControl(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && element.selectionStart !== null)
  );
}

function captureHostState(host: HTMLElement, complete: boolean): HostState {
  const state: HostState = {
    complete,
    scrolled: [],
    focused: null,
    selection: null,
    textSelection: null,
  };
  if (!host.isConnected) return state;

  const active = host.ownerDocument.activeElement;
  if (complete) {
    for (const element of [host, ...Array.from(host.querySelectorAll("*"))]) {
      if (element.scrollTop !== 0 || element.scrollLeft !== 0) {
        state.scrolled.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
    }
  }

  if (complete && active instanceof HTMLElement && host.contains(active)) {
    state.focused = active;
    if (isTextControl(active)) {
      state.textSelection = {
        start: active.selectionStart ?? 0,
        end: active.selectionEnd ?? 0,
        direction: active.selectionDirection ?? "none",
      };
    }
  }

  const selection = host.ownerDocument.getSelection();
  const { anchorNode, focusNode } = selection ?? {};
  if (
    selection &&
    anchorNode &&
    focusNode &&
    host.contains(anchorNode) &&
    host.contains(focusNode)
  ) {
    state.selection = {
      anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode,
      focusOffset: selection.focusOffset,
    };
  }
  return state;
}

function restoreHostState(host: HTMLElement, state: HostState): void {
  for (const { element, top, left } of state.scrolled) {
    element.scrollTop = top;
    element.scrollLeft = left;
  }

  const { focused } = state;
  if (focused && host.contains(focused) && host.ownerDocument.activeElement !== focused) {
    focused.focus({ preventScroll: true });
    if (state.textSelection && isTextControl(focused)) {
      const { start, end, direction } = state.textSelection;
      focused.setSelectionRange(start, end, direction);
    }
  }

  // `setBaseAndExtent` rather than `addRange`: Chromium canonicalizes a range
  // added to a node it has not laid out since the move to the node's start.
  const selection = host.ownerDocument.getSelection();
  if (state.selection && selection) {
    const { anchorNode, anchorOffset, focusNode, focusOffset } = state.selection;
    try {
      selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    } catch {
      // The selected text changed while the host moved; keep the caret where focus put it.
    }
  }
}

/** Puts `host` into `slot`, restoring state read when it was parked. */
export function placeHost(host: HTMLElement, slot: HTMLElement): void {
  if (host.parentNode === slot) return;
  const parked = parkedStates.get(host);
  parkedStates.delete(host);
  // A media query reports its change before the frame lays out, so a layout
  // switch moves hosts out of a layout Chromium has not laid out since the
  // resize. Moving such a host on again before any layout drops its scroll
  // offsets despite `moveBefore`; laying out once while it is parked keeps them.
  if (parked && !parked.complete) void host.offsetHeight;
  moveHost(host, slot, parked);
}

/**
 * Holds `host` in `park` between two slots.
 *
 * A layout switch unmounts the old slot before the new one mounts, and the old
 * slot's layout cleanup still runs while the old layout is connected. Moving
 * the host to a connected park from there keeps `moveBefore` usable for both
 * steps. What was read here is put back by `placeHost`: a park is invisible, so
 * nothing inside it can take focus, and its selection would be lost again on the
 * way out.
 */
export function parkHost(host: HTMLElement, park: HTMLElement): void {
  if (host.parentNode === park) return;
  const state = captureHostState(host, !canMoveBefore(host, park));
  if (canMoveBefore(host, park)) {
    try {
      (park as MoveBeforeParent).moveBefore!(host, null);
      parkedStates.set(host, state);
      return;
    } catch {
      // Fall through to the complete fallback below.
    }
  }
  parkedStates.set(host, state.complete ? state : captureHostState(host, true));
  park.appendChild(host);
}
