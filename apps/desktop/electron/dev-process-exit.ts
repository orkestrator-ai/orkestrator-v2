export interface ElectronExitHandlers {
  logError: (message: string) => void;
  shutdown: (code: number) => void;
}

/** Convert Electron's child-process exit tuple into one terminal outcome. */
export function handleElectronExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  handlers: ElectronExitHandlers,
): void {
  if (signal) {
    handlers.logError(`Electron exited with signal ${signal}`);
  } else if (code) {
    handlers.logError(`Electron exited with code ${code}`);
  }
  handlers.shutdown(code ?? (signal ? 1 : 0));
}
