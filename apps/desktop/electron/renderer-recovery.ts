import type { WebContents } from "electron";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("desktop");

/**
 * Reloads a window whose renderer process went away.
 *
 * Electron leaves the window in place with nothing to paint, so a renderer
 * killed from outside (or crashed, or out of memory) turned the whole window
 * white until the app was restarted, while the backend kept serving remote
 * clients. The window already treats a reload as a fresh document (prompts and
 * realms are dropped on navigation, state is reconciled after load), so a
 * reload is the whole recovery.
 *
 * Bounded: a renderer that dies again straight after loading would otherwise
 * reload forever. After the budget the window stays as Electron left it.
 */

export const RENDERER_RECOVERY_DELAY_MS = 500;
export const RENDERER_RECOVERY_MAX_RELOADS = 3;
export const RENDERER_RECOVERY_WINDOW_MS = 60_000;

export function installRendererRecovery(
  contents: Pick<WebContents, "on" | "reload" | "isDestroyed">,
  options: {
    now?: () => number;
    schedule?: (callback: () => void, delayMs: number) => void;
  } = {},
): void {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delayMs) => void setTimeout(callback, delayMs));
  const reloads: number[] = [];
  let pending = false;
  contents.on("render-process-gone", (_event, details) => {
    // A clean exit is the window closing, not a failure.
    if (details.reason === "clean-exit" || pending) return;
    const at = now();
    while (reloads.length > 0 && at - reloads[0]! > RENDERER_RECOVERY_WINDOW_MS) reloads.shift();
    if (reloads.length >= RENDERER_RECOVERY_MAX_RELOADS) {
      log.error("renderer.gone-giving-up", {
        reason: details.reason,
        count: reloads.length + 1,
        windowSeconds: RENDERER_RECOVERY_WINDOW_MS / 1000,
      });
      return;
    }
    reloads.push(at);
    pending = true;
    log.error("renderer.gone-reloading", { reason: details.reason, exitCode: details.exitCode });
    schedule(() => {
      try {
        if (!contents.isDestroyed()) contents.reload();
      } catch (error) {
        // The frame can be disposed between the event and this callback.
        log.error("renderer.reload-failed", { error: formatLogError(error, { stack: false }) });
      } finally {
        pending = false;
      }
    }, RENDERER_RECOVERY_DELAY_MS);
  });
}
