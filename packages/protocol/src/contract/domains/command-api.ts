/**
 * A domain API keyed by command name (plan item 7002): `api.terminal_write(
 * { sessionId, data })` is `call(terminalWriteCommand, { sessionId, data })`,
 * typed by the definition. Used by domain clients whose adapters call the
 * same commands at every version (terminals, files, claude-tmux), so the API
 * is exactly the domain's command list and needs no hand-written method per
 * command.
 *
 * - {@link commandApi} is a current adapter: `call` sends the envelope and
 *   decodes the result with the command's schema.
 * - {@link legacyCommandApi} is the version-0 adapter for a pre-contract
 *   node: today's untyped `invoke(command, args)`, answered as sent. Such a
 *   node's results are the shapes its callers already normalise; decoding
 *   them would refuse an older node's variations the callers accept.
 *
 * Browser-safe.
 */
import type { CommandCall, DomainAdapterContext } from "../client.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "../command.js";

/** One function per command of `Commands`, keyed by the command's name. */
export type CommandApi<Commands extends readonly AnyCommandDef[]> = {
  readonly [C in Commands[number] as C["name"]]: (args: ArgsOf<C>) => Promise<ResultOf<C>>;
};

/** Builds a {@link CommandApi} over an adapter's `call`. */
export function commandApi<const Commands extends readonly AnyCommandDef[]>(
  call: CommandCall,
  commands: Commands,
): CommandApi<Commands> {
  const api: Record<string, (args: unknown) => Promise<unknown>> = {};
  for (const command of commands) {
    api[command.name] = (args) => call(command, args as ArgsOf<typeof command>);
  }
  return Object.freeze(api) as CommandApi<Commands>;
}

/**
 * The version-0 {@link CommandApi}: each command by name through the
 * context's untyped `invoke`, without an envelope, its answer as sent (typed
 * as the definition's result, which the current shapes describe).
 */
export function legacyCommandApi<const Commands extends readonly AnyCommandDef[]>(
  context: DomainAdapterContext,
  commands: Commands,
): CommandApi<Commands> {
  const api: Record<string, (args: unknown) => Promise<unknown>> = {};
  for (const command of commands) {
    api[command.name] = (args) =>
      context.invoke(command.name, args as Readonly<Record<string, unknown>> | undefined);
  }
  return Object.freeze(api) as CommandApi<Commands>;
}
