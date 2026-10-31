/**
 * The one way this process opens a native dialog.
 *
 * On macOS, Electron shows `dialog.showMessageBox` with a parent window as a
 * sheet, which returns at once. Without a parent it runs `NSAlert runModal`,
 * and `dialog.showErrorBox` always does. That nested loop runs no Chromium
 * tasks and no Node, so the windows, their IPC, remote clients and the reader
 * of the backend's stdout all freeze. macOS may refuse to bring the alert to
 * the front, so it can wait behind other apps for hours (see
 * docs/todo/cross-cutting/0880-desktop-main-thread-held-by-modal-dialog.md).
 *
 * So on macOS every dialog gets a parent. Any window will do, whatever its
 * state: a sheet on a minimized or hidden window brings it back. With no window
 * at all a small host window is opened for the dialog. `install` also routes
 * Electron's own callers through here: web contents' JavaScript dialogs and its
 * default uncaught-exception box have no other hook.
 *
 * Log lines name the dialog's source and never its text, which can carry paths
 * and errors.
 */

export type DialogParentState = "none" | "hidden" | "visible" | "host";

type DialogWindow = {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  close(): void;
};

type MessageBoxResult = Electron.MessageBoxReturnValue;

/** The slice of Electron's `dialog` this module wraps. */
export type NativeDialogApi<Window> = {
  showMessageBox: {
    (window: Window, options: Electron.MessageBoxOptions): Promise<MessageBoxResult>;
    (options: Electron.MessageBoxOptions): Promise<MessageBoxResult>;
  };
  showErrorBox(title: string, content: string): void;
};

type DialogRecord = {
  source: string;
  parent: DialogParentState;
  openedAt: number;
  closedAt: number | null;
};

/** Closed dialogs kept so a stall reported after one closed can still name it. */
const RECENT_CLOSED_DIALOGS = 8;

export type NativeDialogs<Window> = {
  /** Without `window`, the current window is used; see `currentWindow`. */
  showMessageBox(
    source: string,
    options: Electron.MessageBoxOptions,
    window?: Window | null,
  ): Promise<MessageBoxResult>;
  /** Routes Electron's own `dialog` callers through this module. */
  install(): void;
  /** Log suffix naming the last dialog open in the `lagMs` before now, or "". */
  describeStall(lagMs: number): string;
};

export function createNativeDialogs<Window extends DialogWindow>(options: {
  dialog: NativeDialogApi<Window>;
  platform: NodeJS.Platform;
  currentWindow(): Window | null;
  createHostWindow(): Promise<Window>;
  /** Tells someone away from the app that a dialog is waiting for them. */
  requestAttention(window: Window, message: string): void;
  log?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
  /** Monotonic milliseconds. */
  now?: () => number;
}): NativeDialogs<Window> {
  const { dialog, platform, currentWindow, createHostWindow, requestAttention } = options;
  const log = options.log ?? ((message: string) => console.info(message));
  const logError = options.logError ?? ((message, error) => console.error(message, error));
  const now = options.now ?? (() => performance.now());
  const original = dialog.showMessageBox.bind(dialog) as NativeDialogApi<Window>["showMessageBox"];
  let routed: NativeDialogApi<Window>["showMessageBox"] | null = null;
  // Anything that replaced the method after `install` wins: the Electron agent
  // tests stub it to answer dialogs.
  const nativeBox = (): NativeDialogApi<Window>["showMessageBox"] =>
    dialog.showMessageBox === routed ? original : dialog.showMessageBox;

  const records: DialogRecord[] = [];
  let host: { window: Promise<Window>; users: number } | null = null;

  const acquireHost = (): Promise<Window> => {
    host ??= { window: createHostWindow(), users: 0 };
    host.users += 1;
    return host.window;
  };

  const releaseHost = (): void => {
    if (!host) return;
    host.users -= 1;
    if (host.users > 0) return;
    const { window } = host;
    host = null;
    void window
      .then((created) => {
        if (!created.isDestroyed()) created.close();
      })
      .catch(() => undefined);
  };

  const usable = (window: Window | null | undefined): Window | null =>
    window && !window.isDestroyed() ? window : null;

  const parentState = (window: Window | null): DialogParentState => {
    if (!window) return "none";
    return window.isVisible() && !window.isMinimized() ? "visible" : "hidden";
  };

  const open = async (
    source: string,
    dialogOptions: Electron.MessageBoxOptions,
    parent: Window | null,
    state: DialogParentState,
  ): Promise<MessageBoxResult> => {
    const record: DialogRecord = { source, parent: state, openedAt: now(), closedAt: null };
    records.push(record);
    log(`[Dialog] ${source} opening (parent: ${state})`);
    try {
      if (!parent) return await nativeBox()(dialogOptions);
      try {
        requestAttention(parent, dialogOptions.message);
      } catch (error) {
        logError(`[Dialog] ${source} could not ask for attention:`, error);
      }
      return await nativeBox()(parent, dialogOptions);
    } finally {
      record.closedAt = now();
      log(`[Dialog] ${source} closed after ${Math.round(record.closedAt - record.openedAt)} ms`);
      const closed = records.filter((entry) => entry.closedAt !== null);
      for (const entry of closed.slice(0, -RECENT_CLOSED_DIALOGS)) {
        records.splice(records.indexOf(entry), 1);
      }
    }
  };

  const show = async (
    source: string,
    dialogOptions: Electron.MessageBoxOptions,
    window?: Window | null,
  ): Promise<MessageBoxResult> => {
    const requested = usable(window);
    // Elsewhere a windowless box does not hold the main thread, and a parent
    // would newly block that window, so the caller's choice stands.
    if (platform !== "darwin")
      return open(source, dialogOptions, requested, parentState(requested));
    const parent = requested ?? usable(currentWindow());
    if (parent) return open(source, dialogOptions, parent, parentState(parent));
    try {
      return await open(source, dialogOptions, await acquireHost(), "host");
    } catch (error) {
      // Never fall back to a windowless box: refuse, as if it were cancelled.
      logError(`[Dialog] ${source} could not open:`, error);
      return { response: dialogOptions.cancelId ?? 0, checkboxChecked: false };
    } finally {
      releaseHost();
    }
  };

  return {
    showMessageBox: show,
    install() {
      const unrouted = "unrouted";
      routed = ((
        first: Window | null | Electron.MessageBoxOptions,
        second?: Electron.MessageBoxOptions,
      ) =>
        second
          ? show(unrouted, second, first as Window | null)
          : show(
              unrouted,
              first as Electron.MessageBoxOptions,
            )) as NativeDialogApi<Window>["showMessageBox"];
      dialog.showMessageBox = routed;
      dialog.showErrorBox = (title, content) => {
        void show("error-box", {
          type: "error",
          title,
          message: title,
          detail: content,
          buttons: ["OK"],
        });
      };
    },
    describeStall(lagMs) {
      const end = now();
      const start = end - lagMs;
      const overlapping = records.filter(
        (record) => record.openedAt <= end && (record.closedAt ?? end) >= start,
      );
      const last = overlapping.at(-1);
      return last ? `; dialog ${last.source} (parent: ${last.parent}) was open` : "";
    },
  };
}

/**
 * Logs an uncaught exception and shows it as a sheet. Electron's default
 * handler shows the same text in a blocking box and logs nothing. Only one box
 * at a time: a repeating exception should fill the log, not queue dialogs.
 */
export function installUncaughtExceptionDialog<Window>(
  target: { on(event: "uncaughtException", listener: (error: Error) => void): unknown },
  dialogs: Pick<NativeDialogs<Window>, "showMessageBox">,
  logError: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): void {
  let showing = false;
  target.on("uncaughtException", (error) => {
    logError("[Desktop] Uncaught exception:", error);
    if (showing) return;
    showing = true;
    void dialogs
      .showMessageBox("uncaught-exception", {
        type: "error",
        title: "A JavaScript error occurred in the main process",
        message: "A JavaScript error occurred in the main process",
        detail: error.stack ?? `${error.name}: ${error.message}`,
        buttons: ["OK"],
      })
      .catch((failure: unknown) => logError("[Desktop] Could not show the exception:", failure))
      .finally(() => {
        showing = false;
      });
  });
}
