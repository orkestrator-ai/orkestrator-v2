/**
 * The clipboard belongs to the window's host, regardless of the command node.
 * Read it at the host boundary, alongside the window's transport adapters.
 * Browser gateway clients expose a no-op writeImage; use the browser instead.
 */
export function desktopClipboard() {
  if (typeof window === "undefined") return undefined;
  const gateway = window.orkestratorGateway;
  if (gateway?.enabled && !gateway.desktop) return undefined;
  const clipboard = window.orkestrator?.clipboard;
  return typeof clipboard?.writeImage === "function" ? clipboard : undefined;
}
