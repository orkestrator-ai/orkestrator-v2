import type { WebContents } from "electron";
import { desktopStartupEventOf } from "@orkestrator/protocol/debug-logging";
import { createLogger } from "@orkestrator/protocol/logger";

const startupLog = createLogger("desktop.startup");
const dialogLog = createLogger("desktop.dialog");

function preloadFailureKind(error: Error): string {
  // Never persist raw messages, stacks, paths, URLs or arbitrary error names.
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND")
    return "module-missing";
  if (code === "EACCES" || code === "EPERM") return "permission-denied";
  if (code === "ERR_REQUIRE_ESM" || code === "ERR_REQUIRE_ASYNC_MODULE") return "module-format";
  if (error.name === "SyntaxError") return "syntax-error";
  return "unknown";
}

export function installRendererDiagnostics(contents: Pick<WebContents, "mainFrame" | "on">): void {
  // A broken renderer must not flood the persistent log. Reset on a reload so
  // the recovery attempt has its own trace; keep both count and strings bounded.
  const seen = new Set<string>();
  const record = (key: string, write: () => void) => {
    if (seen.has(key) || seen.size >= 32) return;
    seen.add(key);
    write();
  };
  contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) seen.clear();
  });
  contents.on("preload-error", (_event, _path, error) => {
    const reason = preloadFailureKind(error);
    record(`preload-failed:${reason}`, () => startupLog.info("preload-failed", { reason }));
  });
  contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame) return;
    const safeCode = Number.isSafeInteger(code) ? code : 0;
    record(`page-load-failed:${safeCode}`, () =>
      startupLog.info("page-load-failed", { code: safeCode }),
    );
  });
  contents.on("render-process-gone", (_event, details) => {
    const reason = [
      "clean-exit",
      "abnormal-exit",
      "killed",
      "crashed",
      "oom",
      "launch-failed",
      "integrity-failure",
    ].includes(details.reason)
      ? details.reason
      : "unknown";
    record(`renderer-gone:${reason}`, () => startupLog.info("renderer-gone", { reason }));
  });
  contents.on("will-prevent-unload", () => {
    record("beforeunload", () => dialogLog.info("renderer-beforeunload-cancelled"));
  });
  contents.on("console-message", ({ frame, message }) => {
    if (frame !== contents.mainFrame) return;
    const event = desktopStartupEventOf(message);
    if (event) record(event, () => startupLog.info(event));
  });
}
