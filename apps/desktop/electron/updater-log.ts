import {
  createLogger,
  formatLogError,
  type Logger,
  type LogEventOf,
} from "@orkestrator/protocol/logger";
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";

/** electron-updater's `Logger` interface. */
export interface UpdaterLibraryLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug?(message: string): void;
}

type UpdaterLog = Logger<LogEventOf<"updater">>;

/** The library hands over strings or errors. Anything else has no safe form. */
function libraryFields(message: unknown) {
  if (message instanceof Error) return { error: formatLogError(message) };
  // Download URLs can carry signed query parameters.
  return { message: typeof message === "string" ? redactSecrets(message) : "[non-text]" };
}

/**
 * electron-updater defaults to `console`, and its debug output includes the
 * differential download plan: thousands of lines, most of a sampled day's log.
 * Its levels are kept, so that plan sits at `debug`, off by default; turn it on
 * with `ORKESTRATOR_LOG_LEVEL=updater=debug`.
 *
 * `debug` reads as absent while the level is off because the library checks for
 * the method before it serializes the plan, so an unused plan is never built.
 */
export function createUpdaterLibraryLogger(
  log: UpdaterLog = createLogger("updater"),
): UpdaterLibraryLogger {
  const debug = (message: string) => log.debug("library.message", () => libraryFields(message));
  return {
    info: (message) => log.info("library.message", libraryFields(message)),
    warn: (message) => log.warn("library.message", libraryFields(message)),
    error: (message) => log.error("library.message", libraryFields(message)),
    get debug() {
      return log.isEnabled("debug") ? debug : undefined;
    },
  };
}
