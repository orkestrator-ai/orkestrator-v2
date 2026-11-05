import { CommandFailedError, runCommand } from "./command-capture.js";

/**
 * Generous for the largest payload through `docker exec`, and short of what a
 * caller would rather wait than be told the write's outcome is unknown.
 */
export const CONTAINER_WRITE_TIMEOUT_MS = 120_000;

/**
 * Pipes `payload` to a command in a container (`docker exec -i <id> ...`) and
 * waits for it to exit. A wedged exec fails at the deadline: the write may or may
 * not have landed, and the caller is told it did not succeed.
 */
export async function runContainerWrite(
  containerId: string,
  command: string[],
  payload: string,
  options: {
    timeoutMs?: number;
    /** A specific error for an exit status the command gives a meaning. */
    errorForExit?: (code: number | null) => Error | undefined;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? CONTAINER_WRITE_TIMEOUT_MS;
  try {
    await runCommand("docker", ["exec", "-i", containerId, ...command], {
      stdin: payload,
      timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof CommandFailedError)) throw error;
    if (error.timedOut) throw new Error(`docker exec timed out after ${timeoutMs} ms`);
    throw (
      options.errorForExit?.(error.exitCode) ??
      new Error(`docker exec exited with ${error.exitCode}`)
    );
  }
}
