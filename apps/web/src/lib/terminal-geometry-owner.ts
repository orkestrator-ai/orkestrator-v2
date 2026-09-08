/** Prevent background Electron windows from fighting over one shared PTY size. */
export function shouldPublishTerminalGeometry(
  isVisibleTerminal: boolean,
  documentHasFocus = document.hasFocus(),
): boolean {
  return window.orkestrator?.isolatedViewState !== true || (isVisibleTerminal && documentHasFocus);
}

export async function publishTerminalGeometryIfOwned(
  isVisibleTerminal: boolean,
  cols: number,
  rows: number,
  publish: (cols: number, rows: number) => void | Promise<void>,
  documentHasFocus = document.hasFocus(),
): Promise<boolean> {
  if (!shouldPublishTerminalGeometry(isVisibleTerminal, documentHasFocus)) return false;
  await publish(cols, rows);
  return true;
}
