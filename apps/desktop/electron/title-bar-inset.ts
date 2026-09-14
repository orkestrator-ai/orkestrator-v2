/** In-window gutter that clears hiddenInset traffic lights on macOS only. */
export const DARWIN_TITLE_BAR_INSET = "96px";
export const DEFAULT_TITLE_BAR_INSET = "12px";

export function desktopTitleBarInset(platform: NodeJS.Platform): string {
  return platform === "darwin" ? DARWIN_TITLE_BAR_INSET : DEFAULT_TITLE_BAR_INSET;
}

export function desktopTitleBarStyle(platform: NodeJS.Platform): "hiddenInset" | "default" {
  return platform === "darwin" ? "hiddenInset" : "default";
}

export function applyDesktopTitleBarInset(
  root: { style: { setProperty(name: string, value: string): void } },
  platform: NodeJS.Platform,
): void {
  root.style.setProperty("--desktop-title-bar-inset", desktopTitleBarInset(platform));
}
