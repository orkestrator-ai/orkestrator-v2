import { randomUUID } from "node:crypto";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { assertContainerNotDraining } from "./container-readiness.js";
import { CONTAINER_TERMINAL_CLOSE_SCRIPT, containerTerminalUserArgs } from "./container-scripts.js";
import { runCommand } from "./shell.js";

/**
 * The container side of a container terminal.
 *
 * A container terminal is a host `docker exec -it` client, and Docker does not
 * end an exec when its client goes away: killing the PTY leaves the shell, and
 * whatever it runs (a closed Claude CLI tab's `claude`), alive in the
 * container. So every shell is started with a random per-PTY token in
 * `ORKESTRATOR_TERMINAL_SESSION` and records its PID under that token
 * (`CONTAINER_TERMINAL_PID_RECORD_COMMAND`); when the PTY goes away the
 * backend runs `CONTAINER_TERMINAL_CLOSE_SCRIPT` in the container, which sends
 * HUP, what a closed terminal sends, to that shell and its processes.
 *
 * The token is per PTY lifetime, not per tab, so a late close of one shell can
 * never signal the replacement a stable tab starts afterwards.
 */

const log = createLogger("terminal");

/** Bound on one close exec; a stopped or wedged container must not hold it. */
export const CONTAINER_TERMINAL_CLOSE_TIMEOUT_MS = 15_000;

export type ContainerTerminalShell = {
  containerId: string;
  user?: string;
  token: string;
};

/** One process owns every token it issues; a new backend can identify orphans. */
const backendInstanceId = randomUUID();

/** A per-instance prefix and per-shell suffix; hexadecimal and dashes only. */
export function newContainerTerminalToken(): string {
  return `${backendInstanceId}--${randomUUID()}`;
}

/** The `docker exec` arguments that close one container terminal's shell. */
export function containerTerminalCloseArgs(shell: ContainerTerminalShell): string[] {
  return [
    "exec",
    ...containerTerminalUserArgs(shell.user),
    shell.containerId,
    "sh",
    "-c",
    CONTAINER_TERMINAL_CLOSE_SCRIPT,
    "orkestrator-terminal-close",
    shell.token,
  ];
}

/**
 * Ends one container terminal's shell and its processes, as the terminal's
 * own user. Best effort: a stopped or removed container has nothing left to
 * signal, and the next shell start sweeps the record it leaves behind. A
 * container an explicit stop is draining gets no new exec; the drain hangs up
 * terminal shells itself.
 */
export async function closeContainerTerminalShell(
  shell: ContainerTerminalShell,
  signal: AbortSignal,
  execute: typeof runCommand = runCommand,
): Promise<void> {
  try {
    assertContainerNotDraining(shell.containerId);
  } catch {
    return;
  }
  try {
    await execute("docker", containerTerminalCloseArgs(shell), {
      timeoutMs: CONTAINER_TERMINAL_CLOSE_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    log.debug("container-shell.close-failed", { error: formatLogError(error) });
  }
}
