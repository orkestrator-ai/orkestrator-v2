import { spawn } from "node:child_process";

/** Marks the re-run of an entrypoint as its own supervisor. */
export const SUPERVISED_FLAG = "--supervised";

/**
 * Owner side: re-run `script` as a detached supervisor that holds an IPC
 * channel to this process, and resolve with its exit status.
 *
 * Review cancellation escalates to killing its process group after one second,
 * and an owner may be SIGKILLed outright. A detached supervisor survives both
 * long enough to stop and reset the exact profile it owns: owner death closes
 * the IPC channel, which aborts {@link ownerAbortSignal} in the supervisor.
 */
export async function runUnderSupervisor(
  script: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const child = spawn(process.execPath, [script, SUPERVISED_FLAG, ...args], {
    detached: true,
    env: options.env ?? process.env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const cancel = () => {
    if (child.connected) child.send("cancel", () => {});
  };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  try {
    return await new Promise<number>((resolve) => {
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}

/**
 * Supervisor side: aborted when the owner asks to cancel, disconnects or dies,
 * or this process is sent SIGINT or SIGTERM. `release` lets the supervisor
 * exit once its work, including cleanup, is done.
 */
export function ownerAbortSignal(): { signal: AbortSignal; release: () => void } {
  if (!process.send) throw new Error("A supervised run requires its owner IPC channel");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const message = (value: unknown) => {
    if (value === "cancel") cancel();
  };
  process.on("disconnect", cancel);
  process.on("message", message);
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  // An owner that died before the listener was attached is already gone.
  if (!process.connected) cancel();
  return {
    signal: controller.signal,
    release() {
      process.removeListener("disconnect", cancel);
      process.removeListener("message", message);
      if (process.connected) process.disconnect?.();
    },
  };
}
