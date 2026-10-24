/**
 * Classifies reader input by where it will scroll.
 *
 * Only input that will move the outer transcript interrupts transcript
 * navigation. A wheel over a nested code block that can still scroll belongs
 * to that block; a key typed into the composer belongs to the composer. These
 * helpers read computed style and geometry only for elements on the event's
 * path, never the whole transcript.
 */

export type ScrollDirection = "up" | "down";

/** Movement a touch must make before it counts as a vertical scroll gesture. */
export const TOUCH_SLOP_PX = 6;

function isVerticallyScrollable(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.scrollHeight <= element.clientHeight + 1) return false;
  const overflowY = getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

function canScroll(element: HTMLElement, direction: ScrollDirection): boolean {
  if (direction === "up") return element.scrollTop > 0;
  return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
}

function containsScrollChain(element: HTMLElement): boolean {
  const behavior = getComputedStyle(element).overscrollBehaviorY;
  return behavior === "contain" || behavior === "none";
}

/** The event's path from its target up to (excluding) `boundary`. */
function pathWithin(event: Event, boundary: Element): Element[] {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const elements: Element[] = [];
  if (path.length > 0) {
    for (const node of path) {
      if (node === boundary) return elements;
      if (node instanceof Element) elements.push(node);
    }
    return [];
  }
  // Without a composed path (synthetic events in older engines) walk parents.
  let node = event.target instanceof Element ? event.target : null;
  while (node && node !== boundary) {
    elements.push(node);
    node = node.parentElement;
  }
  return node === boundary ? elements : [];
}

/**
 * Whether a nested scroller between the event target and `boundary` consumes
 * a vertical scroll in `direction`: it can still move that way, or it is at
 * its edge but forbids chaining to its ancestors.
 */
export function nestedScrollerConsumes(
  event: Event,
  boundary: Element,
  direction: ScrollDirection,
): boolean {
  for (const element of pathWithin(event, boundary)) {
    if (!isVerticallyScrollable(element)) continue;
    const html = element as HTMLElement;
    if (canScroll(html, direction) || containsScrollChain(html)) return true;
  }
  return false;
}

/** The vertical direction a wheel event will scroll `scroller`, or null when it will not. */
export function classifyWheel(event: WheelEvent, scroller: HTMLElement): ScrollDirection | null {
  // Pinch-zoom arrives as a ctrl-wheel; it never scrolls.
  if (event.ctrlKey) return null;
  // Shift-wheel and trackpad swipes that are mostly horizontal are not
  // transcript navigation.
  if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return null;
  const direction: ScrollDirection = event.deltaY < 0 ? "up" : "down";
  if (nestedScrollerConsumes(event, scroller, direction)) return null;
  return direction;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "reset", "submit", "color", "file"].includes(
    type,
  );
}

/** A modal dialog that the transcript is not part of owns the keyboard. */
function modalOwnsKeyboard(scroller: HTMLElement): boolean {
  const doc = scroller.ownerDocument;
  for (const dialog of Array.from(doc.querySelectorAll('[aria-modal="true"], dialog[open]'))) {
    if (!dialog.contains(scroller)) return true;
  }
  return false;
}

const KEY_DIRECTIONS: Record<string, ScrollDirection> = {
  ArrowUp: "up",
  PageUp: "up",
  Home: "up",
  ArrowDown: "down",
  PageDown: "down",
  End: "down",
};

/**
 * The direction a key press will scroll `scroller`, or null when it will not.
 *
 * `lastPointerInside` covers the case where focus stays on the body after the
 * reader clicked the transcript: the browser then scrolls the clicked scroller.
 */
export function classifyKey(
  event: KeyboardEvent,
  scroller: HTMLElement,
  lastPointerInside: boolean,
): ScrollDirection | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  let direction: ScrollDirection | undefined = KEY_DIRECTIONS[event.key];
  if (event.key === " " || event.key === "Spacebar") {
    direction = event.shiftKey ? "up" : "down";
  }
  if (!direction) return null;
  const target = event.target;
  if (isEditable(target)) return null;
  // Space activates buttons and links rather than scrolling.
  if (
    direction &&
    (event.key === " " || event.key === "Spacebar") &&
    target instanceof HTMLElement &&
    target.closest("button, a[href], [role='button'], summary")
  ) {
    return null;
  }
  if (modalOwnsKeyboard(scroller)) return null;
  const doc = scroller.ownerDocument;
  const focused = doc.activeElement;
  // A key event targets the focused element; one targeted inside the
  // transcript is the transcript's even if focus moved since.
  const focusInside =
    (target instanceof Node && scroller.contains(target)) ||
    (focused !== null && scroller.contains(focused));
  const focusOnBody = focused === null || focused === doc.body || focused === doc.documentElement;
  if (!focusInside && !(focusOnBody && lastPointerInside)) return null;
  if (focusInside && nestedScrollerConsumes(event, scroller, direction)) return null;
  return direction;
}

/** Tracks one touch gesture and reports a vertical scroll once it moves past the slop. */
export class TouchGesture {
  private startX = 0;
  private startY = 0;
  private lastY = 0;
  private claimed: ScrollDirection | "nested" | "horizontal" | null = null;

  start(touch: { clientX: number; clientY: number }): void {
    this.startX = touch.clientX;
    this.startY = touch.clientY;
    this.lastY = touch.clientY;
    this.claimed = null;
  }

  /**
   * The scroll direction of this move (content moves opposite the finger), or
   * null while undecided, horizontal, or owned by a nested scroller.
   */
  move(event: TouchEvent, scroller: HTMLElement): ScrollDirection | null {
    const touch = event.touches[0];
    if (!touch) return null;
    const dy = touch.clientY - this.lastY;
    this.lastY = touch.clientY;
    if (this.claimed === "nested" || this.claimed === "horizontal") return null;
    if (this.claimed === null) {
      const totalX = Math.abs(touch.clientX - this.startX);
      const totalY = Math.abs(touch.clientY - this.startY);
      if (Math.max(totalX, totalY) < TOUCH_SLOP_PX) return null;
      if (totalX > totalY) {
        this.claimed = "horizontal";
        return null;
      }
      const direction: ScrollDirection = touch.clientY > this.startY ? "up" : "down";
      if (nestedScrollerConsumes(event, scroller, direction)) {
        this.claimed = "nested";
        return null;
      }
      this.claimed = direction;
      return direction;
    }
    if (dy === 0) return this.claimed;
    return dy > 0 ? "up" : "down";
  }

  end(): void {
    this.claimed = null;
  }
}
