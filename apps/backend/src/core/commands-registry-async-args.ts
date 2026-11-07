/**
 * Registers every `async` handler of a registrar with `ASYNC_HANDLER` (plan
 * item 7003), so its argument failures stay rejections once it is registered
 * with its definition (`commands-registry-async-decode.ts`, plan item 7002).
 *
 * The environments registrars convert about sixty handlers, all of which
 * rely on this: in-process callers (`commands.get(name)?.(args)` followed by
 * `.catch`) and the lifecycle commands, which are `async` exactly so a caller
 * reaching the registry directly sees a rejection. Deciding by the handler's
 * own kind keeps the rule exact: an `async` function rejected before its
 * definition and still does; a synchronous one threw and still does.
 */
import type { CommandHandler } from "./commands-context.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type { CommandRegistrar, CommandTarget } from "./commands-registry-types.js";

function isAsyncFunction(handler: unknown): boolean {
  return typeof handler === "function" && handler.constructor.name === "AsyncFunction";
}

/** `register`, with every definition whose handler is an `async` function registered with `ASYNC_HANDLER`. */
export function withAsyncArgumentFailures(register: CommandRegistrar): CommandRegistrar {
  const wrapped = (target: CommandTarget, handler: CommandHandler): void => {
    if (typeof target === "string") register(target, handler);
    else if (isAsyncFunction(handler)) register(target, handler as never, ASYNC_HANDLER);
    else register(target, handler as never);
  };
  return wrapped as CommandRegistrar;
}
