export const VISIBLE_TUI_CAPTURE_INTERVAL_MS = 500;
export const HIDDEN_TUI_CAPTURE_INTERVAL_MS = 3_000;

export interface ClaudeTmuxCapturePolling {
  enabled: boolean;
  intervalMs: number;
}

/**
 * Hidden panes still need snapshots for prompt detection, but can tolerate a
 * slower cadence than the visible interactive TUI.
 */
export function getClaudeTmuxCaptureIntervalMs(showTui: boolean): number {
  return showTui
    ? VISIBLE_TUI_CAPTURE_INTERVAL_MS
    : HIDDEN_TUI_CAPTURE_INTERVAL_MS;
}

export function getClaudeTmuxCapturePolling(
  showTui: boolean,
  running: boolean,
): ClaudeTmuxCapturePolling {
  return {
    enabled: showTui || running,
    intervalMs: getClaudeTmuxCaptureIntervalMs(showTui),
  };
}
