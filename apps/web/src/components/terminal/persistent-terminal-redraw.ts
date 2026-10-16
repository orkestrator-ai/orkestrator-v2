interface TerminalViewportLike {
  cols: number;
  rows: number;
  refresh: (start: number, end: number) => void;
}

interface FitAddonLike {
  fit: () => void;
}

interface ForceTerminalVisibilityRedrawOptions {
  terminal: TerminalViewportLike;
  fitAddon: FitAddonLike;
  resize: (cols: number, rows: number) => Promise<void>;
  /** False while the terminal has no layout box; see `hasLayoutBox`. */
  canFit?: () => boolean;
  isCancelled?: () => boolean;
  requestAnimationFrameFn?: (callback: FrameRequestCallback) => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
  finalRefreshDelayMs?: number;
}

export interface ForceRedrawCleanup {
  cancel: () => void;
}

interface ShouldTriggerVisibilityRedrawOptions {
  isEnvironmentVisible: boolean;
  wasEnvironmentVisible: boolean;
  wasDomReattached?: boolean;
  isActive: boolean;
  terminalIsOpened: boolean;
  isConnected: boolean;
}

/**
 * Whether an element has a layout box a terminal can be fitted to.
 *
 * Under `display: none` the fit addon reads the container's computed `100%`
 * width as 100px and would shrink the terminal, and the PTY with it, to about
 * ten columns. A terminal without a box keeps its size until it has one again.
 */
export function hasLayoutBox(element: Element | null | undefined): boolean {
  return Boolean(element && element.getClientRects().length > 0);
}

/**
 * Compute a slightly larger terminal size for a "bounce" resize.
 * Returns null when no bounce is possible (zero/negative dimensions, or both
 * cols and rows are already at the uint16 maximum — an unrealistic scenario).
 */
export function getTerminalResizeBounceDimensions(
  cols: number,
  rows: number,
): { cols: number; rows: number } | null {
  if (cols <= 0 || rows <= 0) {
    return null;
  }

  const nudgedRows = rows < 65535 ? rows + 1 : rows;
  const nudgedCols = nudgedRows === rows && cols < 65535 ? cols + 1 : cols;

  if (nudgedRows === rows && nudgedCols === cols) {
    return null;
  }

  return { cols: nudgedCols, rows: nudgedRows };
}

export function shouldTriggerEnvironmentVisibilityRedraw({
  isEnvironmentVisible,
  wasEnvironmentVisible,
  wasDomReattached = false,
  isActive,
  terminalIsOpened,
  isConnected,
}: ShouldTriggerVisibilityRedrawOptions): boolean {
  return (
    isEnvironmentVisible &&
    (!wasEnvironmentVisible || wasDomReattached) &&
    isActive &&
    terminalIsOpened &&
    isConnected
  );
}

export async function forceTerminalVisibilityRedraw({
  terminal,
  fitAddon,
  resize,
  canFit = () => true,
  isCancelled = () => false,
  requestAnimationFrameFn = requestAnimationFrame,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  finalRefreshDelayMs = 50,
}: ForceTerminalVisibilityRedrawOptions): Promise<ForceRedrawCleanup> {
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const cleanup: ForceRedrawCleanup = {
    cancel: () => {
      if (timerId !== null) {
        clearTimeoutFn(timerId);
        timerId = null;
      }
    },
  };

  // Without a layout box the bounce below still runs, at the size the PTY
  // already has, so a TUI redraws without being resized to nothing.
  const refreshViewport = () => {
    if (canFit()) fitAddon.fit();
    if (terminal.rows > 0) {
      terminal.refresh(0, terminal.rows - 1);
    }
  };

  await new Promise<void>((resolve) => {
    requestAnimationFrameFn(() => {
      if (!isCancelled()) {
        refreshViewport();
      }
      resolve();
    });
  });

  if (isCancelled()) return cleanup;

  // Bounce around the *post-fit* size. This redraw also fires when the xterm
  // DOM node is reattached into a differently sized pane, where the pre-fit
  // dimensions describe the pane the terminal just left — settling the PTY
  // there would leave it permanently out of step with the rendered viewport.
  // Bouncing off the fitted size still guarantees a SIGWINCH, because the
  // nudged size differs from the target in both directions.
  const targetCols = terminal.cols;
  const targetRows = terminal.rows;

  if (targetCols <= 0 || targetRows <= 0) {
    return cleanup;
  }

  const bounceSize = getTerminalResizeBounceDimensions(targetCols, targetRows);
  if (bounceSize) {
    await resize(bounceSize.cols, bounceSize.rows);
  }

  if (isCancelled()) return cleanup;

  await resize(targetCols, targetRows);

  if (isCancelled()) return cleanup;

  refreshViewport();
  timerId = setTimeoutFn(() => {
    timerId = null;
    if (isCancelled()) return;
    refreshViewport();
  }, finalRefreshDelayMs);

  return cleanup;
}
