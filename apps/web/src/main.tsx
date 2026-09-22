import "./index.css";
import { desktopStartupMessage } from "@orkestrator/protocol/debug-logging";
import { startDesktopRenderer } from "./lib/desktop-startup";

// Keep this entry independent of App and its stores. A late preload must be
// ready before modules choose a transport or capture the desktop APIs.
window.addEventListener("error", (event) => {
  console.error(desktopStartupMessage("renderer-error"));
  console.error("[WindowError] Unhandled error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  });
});
window.addEventListener("unhandledrejection", (event) => {
  console.error(desktopStartupMessage("unhandled-rejection"));
  console.error("[WindowError] Unhandled promise rejection", {
    reason: event.reason,
    stack: event.reason instanceof Error ? event.reason.stack : undefined,
  });
});

void startDesktopRenderer({
  start: async () => {
    const { startRenderer } = await import("./renderer-entry");
    await startRenderer();
  },
});
