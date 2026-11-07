/**
 * Registration option for a defined command whose handler is `async` (plan
 * item 7002).
 *
 * The registry decodes a definition's arguments before the handler runs, and
 * a decode failure is thrown synchronously. An `async` handler used to report
 * the same bad argument (its own `asString` check) as a rejected promise, and
 * callers and suites that call the handler directly rely on that. With this
 * option the decode failure is delivered the way the handler would have
 * delivered it: as a rejection. The message is unchanged.
 */
import type { CommandHandler } from "./commands-context.js";
import type { DefinedCommandOptions } from "./commands-registry-types.js";

function rejectDecodeFailures(run: CommandHandler): CommandHandler {
  return (args, context, invocation) => {
    try {
      return run(args, context, invocation);
    } catch (error) {
      return Promise.reject(error);
    }
  };
}

/** Pass as `register(def, asyncHandler, ASYNC_HANDLER)`. */
export const ASYNC_HANDLER: DefinedCommandOptions = Object.freeze({
  beforeDecode: rejectDecodeFailures,
});
