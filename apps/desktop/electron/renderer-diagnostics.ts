import type { WebContents } from "electron";
import { isDesktopStartupMessage } from "@orkestrator/protocol/debug-logging";

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

export function installRendererDiagnostics(
  contents: Pick<WebContents, "on">,
  log: (message: string) => void = (message) => console.info(message),
): void {
  // A broken renderer must not flood the persistent log. Reset on a reload so
  // the recovery attempt has its own trace; keep both count and strings bounded.
  const seen = new Set<string>();
  const record = (message: string) => {
    if (seen.has(message) || seen.size >= 32) return;
    seen.add(message);
    log(message);
  };
  contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) seen.clear();
  });
  contents.on("preload-error", (_event, _path, error) => {
    record(`[DesktopStartup] preload-failed reason=${preloadFailureKind(error)}`);
  });
  contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame)
      record(`[DesktopStartup] page-load-failed code=${Number.isSafeInteger(code) ? code : 0}`);
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
    record(`[DesktopStartup] renderer-gone reason=${reason}`);
  });
  contents.on("console-message", ({ message }) => {
    if (isDesktopStartupMessage(message)) record(message);
  });
}
