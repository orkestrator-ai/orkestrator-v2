/**
 * The typed `NodeClient.invoke(def, args)` (plan item 2011) over a client's
 * untyped `invokeRaw`, shared by every client implementation, and the
 * `DomainCall` a domain client sends through (`scope.domain(def)`).
 *
 * Both send the invoke envelope's contract fields beside `command` and
 * `args` (`contractEnvelopeFields`: `domain`, `version`, and the critical keys
 * the arguments carry), never the arguments inside the envelope, and decode
 * the result with the definition's schema. Command schemas are JSON-shaped
 * (the decoded and wire forms coincide, plan item 1001), so arguments go as
 * they are.
 */
import {
  contractEnvelopeFields,
  type ContractEnvelopeFields,
  type DomainCall,
} from "@orkestrator/protocol/contract/client";
import {
  decodeCommandResult,
  type AnyCommandDef,
  type ArgsOf,
  type EncodedArgsOf,
  type ResultOf,
} from "@orkestrator/protocol/contract/command";
import type { NodeClient, NodeInvokeOptions } from "@orkestrator/protocol/node-client";
import * as Result from "effect/Result";

/** A client's untyped call, as `typedInvoke` uses it. */
export type RawInvoke = (
  command: string,
  args?: Readonly<Record<string, unknown>>,
  options?: NodeInvokeOptions,
) => Promise<unknown>;

/**
 * `invoke` for a client whose untyped call is `invokeRaw`: the envelope is for
 * this build's version of the command's domain.
 */
export function typedInvoke(invokeRaw: RawInvoke): NodeClient["invoke"] {
  return async <C extends AnyCommandDef>(def: C, args: ArgsOf<C>): Promise<ResultOf<C>> => {
    const wire = args as EncodedArgsOf<C>;
    const envelope = contractEnvelopeFields(def, wire, def.domain.version);
    const raw = await invokeRaw(def.name, wire as Readonly<Record<string, unknown>>, {
      envelope,
    });
    const decoded = decodeCommandResult(def, raw);
    if (Result.isFailure(decoded)) throw decoded.failure;
    return decoded.success;
  };
}

/**
 * A domain client's transport over a node client: the wire arguments, the
 * picked adapter's envelope (none for the legacy adapter), the wire result.
 * The domain client decodes it.
 */
export function nodeDomainCall(client: Pick<NodeClient, "invokeRaw">): DomainCall {
  return (def, args, envelope: ContractEnvelopeFields | undefined) =>
    client.invokeRaw<unknown>(
      def.name,
      args as Readonly<Record<string, unknown>> | undefined,
      envelope ? { envelope } : undefined,
    );
}
