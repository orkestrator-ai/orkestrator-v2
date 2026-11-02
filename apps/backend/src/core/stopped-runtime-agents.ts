import type { CommandContext } from "./commands-context.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("environment");

/**
 * Withdraws a stopped runtime's parked agent requests and settles its
 * sessions' turn activity (`NativeAgentService.environmentRuntimeStopped`).
 * Every path that stops a runtime itself calls it once the stop has taken
 * effect: an explicit stop, and the quiesce before a rebuild or a
 * recovery-copy restore. The stop has already happened, so a failure here is
 * logged, not thrown.
 */
export async function settleStoppedRuntimeAgents(
  environmentId: string,
  context: Pick<CommandContext, "nativeAgents">,
): Promise<void> {
  try {
    await context.nativeAgents?.environmentRuntimeStopped(environmentId);
  } catch (error) {
    log.warn("stop.settle-activity-failed", {
      environmentId,
      error: formatLogError(error, { message: false }),
    });
  }
}
