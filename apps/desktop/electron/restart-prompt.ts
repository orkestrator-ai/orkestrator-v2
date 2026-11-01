import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("desktop");
/**
 * An error dialog that offers to restart the application, without blocking.
 *
 * `dialog.showErrorBox` is synchronous on Linux: the main process stops until
 * someone answers. A backend that died overnight froze every window, every IPC
 * call and every remote client for hours, then replayed the queued calls as a
 * burst of failures the moment the dialog was dismissed.
 */

const RESTART = 0;

export function showRestartPrompt(options: {
  title: string;
  detail: string;
  showMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue>;
  restart(): void;
}): Promise<void> {
  return options
    .showMessageBox({
      type: "error",
      title: options.title,
      message: options.title,
      detail: options.detail,
      buttons: ["Restart", "Close"],
      defaultId: RESTART,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === RESTART) options.restart();
    })
    .catch((error: unknown) => {
      log.error("restart-prompt.failed", { title: options.title, error: formatLogError(error) });
    });
}
