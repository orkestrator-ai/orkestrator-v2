import type { BrowserWindow } from "electron";
import { PRODUCT_NAME } from "./app-constants.js";
import type {
  EnsurePinnedToolchainsOptions,
  PinnedToolchainResult,
  ToolchainProgress,
} from "./toolchain-manager.js";

type ProgressWindow = Pick<BrowserWindow, "close" | "isDestroyed" | "once">;

export function createToolchainProgressController(options: {
  createWindow(): Promise<ProgressWindow>;
  reportProgress(window: ProgressWindow, progress: ToolchainProgress): void;
  logError(error: unknown): void;
}) {
  let progressWindow: ProgressWindow | null = null;
  let progressWindowPromise: Promise<ProgressWindow | null> | null = null;
  let closed = false;

  const closeWindow = (window: ProgressWindow | null) => {
    if (window && !window.isDestroyed()) window.close();
  };

  const ensureWindow = (): Promise<ProgressWindow | null> => {
    if (progressWindowPromise) return progressWindowPromise;
    const creation = options.createWindow();
    const tracked = creation.then((window) => {
      if (closed) {
        closeWindow(window);
        return null;
      }
      progressWindow = window;
      window.once("closed", () => {
        if (progressWindow === window) progressWindow = null;
        if (progressWindowPromise === tracked) progressWindowPromise = null;
      });
      return window;
    }).catch((error: unknown) => {
      options.logError(error);
      if (progressWindowPromise === tracked) progressWindowPromise = null;
      return null;
    });
    progressWindowPromise = tracked;
    return tracked;
  };

  return {
    report(progress: ToolchainProgress): void {
      if (closed || progress.phase === "checking") return;
      if (progress.phase === "ready" && !progressWindowPromise) return;
      void ensureWindow().then((window) => {
        if (window && !closed && !window.isDestroyed()) options.reportProgress(window, progress);
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const pendingWindow = progressWindowPromise;
      closeWindow(progressWindow);
      const resolvedWindow = await pendingWindow?.catch(() => null);
      closeWindow(resolvedWindow ?? null);
      progressWindow = null;
      progressWindowPromise = null;
    },
  };
}

export async function preparePinnedToolchains(options: {
  dataDir: string;
  ensure(options: EnsurePinnedToolchainsOptions): Promise<PinnedToolchainResult>;
  fetchImpl: NonNullable<EnsurePinnedToolchainsOptions["fetchImpl"]>;
  onProgress(progress: ToolchainProgress): void;
  showMessageBox(options: {
    type: "error";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
  }): Promise<{ response: number }>;
  quit(): void;
  logError(error: unknown): void;
}): Promise<string | null> {
  while (true) {
    try {
      const result = await options.ensure({
        dataDir: options.dataDir,
        fetchImpl: options.fetchImpl,
        onProgress: options.onProgress,
      });
      return result.binDir;
    } catch (error) {
      options.logError(error);
      const message = error instanceof Error ? error.message : String(error);
      const { response } = await options.showMessageBox({
        type: "error",
        title: `${PRODUCT_NAME} tool setup failed`,
        message: "Orkestrator could not prepare its pinned command-line tools.",
        detail: `${message}\n\nCheck your network connection and ensure the Orkestrator data directory permits executable files, then try again.`,
        buttons: ["Retry", "Quit"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) continue;
      options.quit();
      return null;
    }
  }
}
