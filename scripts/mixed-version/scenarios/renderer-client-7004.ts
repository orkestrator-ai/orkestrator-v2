/**
 * A current renderer's domain client against one node of the pair, for plan
 * item 7004's modules (previews, transcript artifacts, design). Same shape as
 * 7002's `renderer-client.ts`; kept separate only because that file was not
 * committed when these modules landed. Replace the imports with
 * `./renderer-client.ts` and delete this file once it is.
 */
import {
  createDomainClient,
  type ApiOf,
  type DomainClient,
  type DomainClientDef,
} from "@orkestrator/protocol/contract/client";
import { InvokeError, type PeerNode } from "../harness.ts";

export interface RendererClient<Api> {
  readonly client: DomainClient<Api>;
  /** The adapter the client picked for this node. */
  readonly version: number | null;
  /** Calls made through the client, per adapter version. */
  readonly calls: Map<number, number>;
}

export function rendererClient<D extends DomainClientDef>(
  node: PeerNode,
  def: D,
): RendererClient<ApiOf<D>> {
  const calls = new Map<number, number>();
  const client = createDomainClient(def as DomainClientDef<D["domain"], ApiOf<D>>, {
    call: async (command, args, envelope) => {
      const version = envelope?.version ?? 0;
      calls.set(version, (calls.get(version) ?? 0) + 1);
      const { status, json } = await node.request("/__orkestrator/invoke", {
        body: { command: command.name, args, ...envelope },
      });
      const payload = json as { result?: unknown; error?: unknown } | null;
      if (status !== 200) {
        const message =
          typeof payload?.error === "string" ? payload.error : JSON.stringify(payload ?? null);
        throw new InvokeError(command.name, { status, message: message.slice(0, 500) });
      }
      return payload?.result;
    },
    domains: node.hello.domains ?? null,
    invoke: (command, args) => node.invoke(command, { ...args }),
  });
  return { client, version: client.version(), calls };
}

/** The adapter a renderer should pick for `domain` on `node`: 1 when its hello advertises version 1. */
export function expectedRendererAdapter(node: PeerNode, domain: string): 0 | 1 {
  const range = node.hello.domains?.[domain];
  return range && range.min <= 1 && range.max >= 1 ? 1 : 0;
}

/** Every node of the pair, the release first when there is one. */
export function pairNodes(command: PeerNode, leaf: PeerNode): readonly PeerNode[] {
  return command.build.kind === "current" ? [leaf, command] : [command, leaf];
}
