import { spawn } from "node:child_process";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { runIsolatedBrowser } from "./dev/isolated-browser.js";

installFatalRejectionGuard({ label: "[isolated-browser]" });

const args = process.argv.slice(2);
const supervised = args[0] === "--supervised";
if (supervised) args.shift();
if (args.length > 1 || (args.length === 1 && args[0] !== "--design")) {
  throw new Error("Usage: test-agent-browser-isolated.ts [--design]");
}

if (supervised) {
  if (!process.send)
    throw new Error("The isolated browser supervisor requires its owner IPC channel");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("disconnect", cancel);
  process.on("message", (message) => {
    if (message === "cancel") cancel();
  });
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  try {
    process.exitCode = await runIsolatedBrowser({
      design: args[0] === "--design",
      signal: controller.signal,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Isolated browser validation failed");
    process.exitCode = 1;
  } finally {
    process.removeListener("disconnect", cancel);
    if (process.connected) process.disconnect?.();
  }
} else {
  // Review cancellation escalates to killing its process group after one second.
  // An IPC-owned supervisor survives that escalation just long enough to stop
  // the exact profile and reset it; owner death closes IPC and triggers finally.
  const child = spawn(process.execPath, [import.meta.filename, "--supervised", ...args], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const cancel = () => {
    if (child.connected) child.send("cancel", () => {});
  };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  process.exitCode = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
}
