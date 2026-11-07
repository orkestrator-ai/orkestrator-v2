/**
 * A renderer's domain client against one node of the pair (plan item 7002).
 *
 * The terminals, files and claude-tmux commands are called by the renderer,
 * not backend to backend, so their scenario modules qualify what a current
 * renderer does with each node: `createDomainClient` over the node's HTTP
 * invoke, picking its adapter from the node's hello `domains` (version 1 for
 * a node that advertises the domain, the legacy version 0 otherwise), with
 * the envelope in the body as the web gateway client sends it. The calls
 * are counted per adapter version here, since a renderer's counters live in
 * its window, not in the backend the runner reads.
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
