import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.pane-layout");

/**
 * Handle a rejected native `teardown_tab` call. The backend keeps the close
 * pending and retries it, so a failure only needs a debug log.
 */
export function reportNativeTabTeardownFailure(
  environmentId: string,
  label: string,
  error: unknown,
): void {
  log.debug("teardown.pending", () => ({
    environmentId,
    source: label,
    error: formatLogError(error),
  }));
}
