/** Prevent background Electron windows from fighting over one shared PTY size. */
export function shouldPublishTerminalGeometry(
  isFocusedTerminal: boolean,
  documentHasFocus = document.hasFocus(),
): boolean {
  return window.orkestrator?.isolatedViewState !== true || (isFocusedTerminal && documentHasFocus);
}
