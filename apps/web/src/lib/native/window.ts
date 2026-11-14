export function getCurrentWindow() {
  return {
    startDragging(): Promise<void> {
      return window.orkestrator?.window.startDragging() ?? Promise.resolve();
    },
    setZoomFactor(factor: number): Promise<boolean> {
      return window.orkestrator?.window.setZoomFactor?.(factor) ?? Promise.resolve(false);
    },
  };
}

/**
 * Captures this desktop window as a base64 PNG (the same capture Report a
 * bug uses), or `null` in a client that cannot capture its own window, such
 * as a browser tab.
 */
export function windowCapture(): (() => Promise<string>) | null {
  const capturer = window.orkestrator?.bugReport;
  return capturer ? () => capturer.captureWindow() : null;
}
