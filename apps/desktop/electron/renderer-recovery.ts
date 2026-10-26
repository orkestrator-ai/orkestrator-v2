import type { WebContents } from "electron";

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
    log?: (message: string) => void;
    now?: () => number;
    schedule?: (callback: () => void, delayMs: number) => void;
  } = {},
): void {
  const log = options.log ?? ((message) => console.error(message));
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delayMs) => void setTimeout(callback, delayMs));
  const reloads: number[] = [];
  contents.on("render-process-gone", (_event, details) => {
    // A clean exit is the window closing, not a failure.
    if (details.reason === "clean-exit") return;
    const at = now();
    while (reloads.length > 0 && at - reloads[0]! > RENDERER_RECOVERY_WINDOW_MS) reloads.shift();
    if (reloads.length >= RENDERER_RECOVERY_MAX_RELOADS) {
      log(
        `[Desktop] Renderer gone (${details.reason}) ${reloads.length + 1} times within ${RENDERER_RECOVERY_WINDOW_MS / 1000}s; not reloading again`,
      );
      return;
    }
    reloads.push(at);
    log(
      `[Desktop] Renderer gone (${details.reason}, exit ${details.exitCode}); reloading the window`,
    );
    schedule(() => {
      if (!contents.isDestroyed()) contents.reload();
    }, RENDERER_RECOVERY_DELAY_MS);
  });
}
