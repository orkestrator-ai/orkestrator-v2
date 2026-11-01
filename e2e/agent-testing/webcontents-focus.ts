import type { ElectronApplication } from "playwright";

type FocusState = typeof globalThis & { webContentsFocus?: Map<number, boolean> };

/**
 * Records which webContents Chromium has given keyboard focus, from each
 * contents' `focus` and `blur` events in the main process.
 *
 * `isFocused()` and `getFocusedWebContents()` also need the OS to make the
 * window key, which a locked or shared macOS session never does (todo 1170).
 * These events follow `webContents.focus()` inside the window either way, so
 * the in-window handoff between views stays checkable there. Playwright's
 * focus emulation makes `document.hasFocus()` true in every page it attaches
 * to, so the renderer cannot report this itself.
 */
export async function trackWebContentsFocus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app, webContents }) => {
    const state = globalThis as FocusState;
    if (state.webContentsFocus) return;
    const focus = new Map<number, boolean>();
    state.webContentsFocus = focus;
    const track = (contents: Electron.WebContents) => {
      const id = contents.id;
      contents.on("focus", () => focus.set(id, true));
      contents.on("blur", () => focus.set(id, false));
      contents.once("destroyed", () => focus.delete(id));
    };
    webContents.getAllWebContents().forEach(track);
    app.on("web-contents-created", (_event, contents) => track(contents));
  });
}

/** URLs of the webContents whose last focus event was `focus`. */
export function focusedWebContentsUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) => {
    const focus = (globalThis as FocusState).webContentsFocus;
    if (!focus) throw new Error("trackWebContentsFocus was not installed");
    return webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed() && focus.get(contents.id))
      .map((contents) => contents.getURL());
  });
}
