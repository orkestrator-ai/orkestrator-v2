export function getCurrentWindow() {
  return {
    startDragging(): Promise<void> {
      return window.orkestrator?.window.startDragging() ?? Promise.resolve();
    },
  };
}
