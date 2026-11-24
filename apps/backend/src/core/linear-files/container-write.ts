import { spawn } from "node:child_process";
import { CONTAINER_PINNED_ATTACHMENT_WRITE } from "../commands-files.js";

const STAGED = "LINEAR_FILE_STAGED\n";

/** Authorize publication only after Docker confirms the complete file is staged. */
export function writeContainerLinearFile(
  containerId: string,
  directory: string,
  filename: string,
  contents: Buffer,
  signal: AbortSignal,
  deadline: number,
): Promise<void> {
  signal.throwIfAborted();
  const encoded = contents.toString("base64") + "\n";
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        containerId,
        "node",
        "-e",
        CONTAINER_PINNED_ATTACHMENT_WRITE,
        "/workspace",
        directory,
        filename,
        String(contents.byteLength),
        "",
        "overwrite",
        String(0o644),
        "",
        String(deadline),
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let output = "";
    let authorized = false;
    let spawnError: Error | undefined;
    // The remote helper receives EOF on abort. Keep waiting for its exit.
    // If the transport wedges, it cannot publish after its own deadline.
    const stop = () => child.stdin.destroy();
    const watchdog = setTimeout(
      () => child.kill("SIGKILL"),
      Math.max(0, deadline - Date.now()) + 1_000,
    );
    signal.addEventListener("abort", stop, { once: true });
    child.stdin.on("error", stop);
    child.on("error", (error) => {
      spawnError = error;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (authorized) return;
      if (output.length + chunk.length > STAGED.length) {
        stop();
        return;
      }
      output += chunk.toString("ascii");
      if (output !== STAGED) return;
      if (signal.aborted || Date.now() >= deadline || child.stdin.destroyed) {
        stop();
        return;
      }
      authorized = true;
      child.stdin.end("publish\n");
    });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      signal.removeEventListener("abort", stop);
      if (code === 0 && authorized) resolve();
      else reject(spawnError ?? new Error("The container file writer stopped before publication."));
    });
    child.stdin.write(encoded);
  });
}
