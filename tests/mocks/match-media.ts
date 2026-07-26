/**
 * Shared `window.matchMedia` stub for suites that render viewport-aware
 * components (anything using `useMediaQuery`).
 *
 * `setMobileViewport` is deliberately silent: it swaps the simulated width but
 * does NOT notify listeners, so it is safe to call in `beforeEach` while a
 * component from the previous test may still be mounted. Use
 * `emitViewportChange` (inside `act`) when a test needs to simulate the user
 * actually resizing across the breakpoint.
 */

type ChangeListener = (event: MediaQueryListEvent) => void;

const MOBILE_WIDTH = 375;
const DESKTOP_WIDTH = 1280;

interface StubbedList {
  query: string;
  listeners: Set<ChangeListener>;
}

let simulatedWidth = DESKTOP_WIDTH;
let installed = false;
let originalMatchMedia: typeof window.matchMedia | undefined;
const lists = new Set<StubbedList>();

/**
 * Evaluate the width-based media features the app actually uses. Anything else
 * (`prefers-color-scheme`, `pointer`, ...) reports no match, which is the same
 * default an unstyled test DOM gives.
 */
function queryMatches(query: string, width: number): boolean {
  const maxWidth = query.match(/\(\s*max-width\s*:\s*(\d+)px\s*\)/);
  if (maxWidth) return width <= Number(maxWidth[1]);
  const minWidth = query.match(/\(\s*min-width\s*:\s*(\d+)px\s*\)/);
  if (minWidth) return width >= Number(minWidth[1]);
  return false;
}

function install(): void {
  if (installed) return;
  originalMatchMedia = window.matchMedia;
  installed = true;
  const stub = (query: string): MediaQueryList => {
    const list: StubbedList = { query, listeners: new Set() };
    lists.add(list);
    return {
      get matches() {
        return queryMatches(query, simulatedWidth);
      },
      media: query,
      onchange: null,
      addEventListener: (_type: "change", listener: EventListenerOrEventListenerObject) => {
        list.listeners.add(listener as ChangeListener);
      },
      removeEventListener: (_type: "change", listener: EventListenerOrEventListenerObject) => {
        list.listeners.delete(listener as ChangeListener);
      },
      addListener: (listener: ChangeListener | null) => {
        if (listener) list.listeners.add(listener);
      },
      removeListener: (listener: ChangeListener | null) => {
        if (listener) list.listeners.delete(listener);
      },
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  };
  // defineProperty rather than assignment: a suite that previously replaced
  // matchMedia via defineProperty may have left it non-writable, and a plain
  // assignment would then silently no-op (or throw under strict mode).
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: stub,
  });
}

/**
 * Set the simulated viewport for components rendered *after* this call.
 * Does not notify existing listeners — see `emitViewportChange`.
 */
export function setMobileViewport(isMobile: boolean): void {
  install();
  simulatedWidth = isMobile ? MOBILE_WIDTH : DESKTOP_WIDTH;
}

/**
 * Simulate a live resize across the breakpoint: updates the width and fires
 * `change` on every registered listener. Mounted components will re-render, so
 * callers must wrap this in `act(...)`.
 */
export function emitViewportChange(isMobile: boolean): void {
  install();
  simulatedWidth = isMobile ? MOBILE_WIDTH : DESKTOP_WIDTH;
  for (const list of lists) {
    const event = {
      matches: queryMatches(list.query, simulatedWidth),
      media: list.query,
    } as MediaQueryListEvent;
    for (const listener of [...list.listeners]) listener(event);
  }
}

/** Restore the environment's own matchMedia. Safe to call when not installed. */
export function restoreMatchMedia(): void {
  lists.clear();
  simulatedWidth = DESKTOP_WIDTH;
  if (!installed) return;
  installed = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  originalMatchMedia = undefined;
}
