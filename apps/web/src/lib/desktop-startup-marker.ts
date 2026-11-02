import {
  desktopStartupMessage,
  type DesktopStartupEvent,
} from "@orkestrator/protocol/debug-logging";

/**
 * The only renderer output the desktop saves: `isDesktopStartupMessage` matches
 * these exact strings in the main frame's console (bridge-diagnostics.md).
 *
 * This writes to the raw console on purpose. The text is a contract with the main
 * process rather than a log line, so it must not depend on a logger's level, sink
 * or format, and no renderer logger may use the `desktop.startup` area to imitate
 * it. Everything else in the renderer stays out of the saved log.
 */
export function emitDesktopStartupMarker(event: DesktopStartupEvent): void {
  const message = desktopStartupMessage(event);
  if (event === "checking" || event === "ready") console.info(message);
  else console.error(message);
}
