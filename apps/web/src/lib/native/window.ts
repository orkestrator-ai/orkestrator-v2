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
