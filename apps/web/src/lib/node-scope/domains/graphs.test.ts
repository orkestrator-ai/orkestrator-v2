/**
 * The `graphs` domain client over a `lib/backend` factory client (plan item
 * 7007), against fake nodes: version 0 for a client without negotiation or a
 * pre-contract node (today's exact calls, answered as sent), version 1 for a
 * node that advertises the domain (envelope with its critical keys, decoded
 * results), and the machine-aimed client, which carries no range.
 */
import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { createSignal } from "@/lib/node-scope/signal";
import { graphs } from "./graphs";

const GRAPHS_V1: NegotiatedDomains = { graphs: { min: 1, max: 1 } };

function fakeClient(answer: (command: string) => unknown, domains?: NegotiatedDomains | null) {
  const invokeRaw = mock(async (command: string, ..._rest: unknown[]) => answer(command));
  const client: BackendClient = {
    invokeRaw: invokeRaw as unknown as BackendClient["invokeRaw"],
    ...(domains === undefined
      ? {}
      : {
          domains: createSignal<NegotiatedDomains | null>(domains),
          capabilities: createSignal<ReadonlySet<string> | null>(null),
        }),
  };
  return { client, invokeRaw };
}

const unchanged = { status: "unchanged", revision: 4 };

describe("graphs domain client over a lib/backend client", () => {
  test("a client without negotiation sends today's calls and gets the answers as sent", async () => {
    const legacy = { status: "unchanged", revision: 4, older: true };
    const { client, invokeRaw } = fakeClient(() => legacy);
    await expect(graphs(client).graph_run_get({ runId: "r1", knownRevision: 4 })).resolves.toBe(
      legacy as never,
    );
    expect(invokeRaw.mock.calls).toEqual([
      ["graph_run_get", { runId: "r1", knownRevision: 4 }],
    ] as never);
  });

  test("a pre-contract node (no domains) takes version 0 too", async () => {
    const { client, invokeRaw } = fakeClient(() => ({ deleted: true }), null);
    await expect(graphs(client).graph_template_delete({ id: "mine" })).resolves.toEqual({
      deleted: true,
    });
    expect(invokeRaw.mock.calls).toEqual([["graph_template_delete", { id: "mine" }]] as never);
  });

  test("a node with the domain gets the envelope, critical keys and decoded results", async () => {
    const { client, invokeRaw } = fakeClient(
      (command) => (command === "graph_template_delete" ? { deleted: true } : unchanged),
      GRAPHS_V1,
    );
    await graphs(client).graph_template_delete({ id: "mine", expectedRevision: 2 });
    expect(invokeRaw.mock.calls[0]).toEqual([
      "graph_template_delete",
      { id: "mine", expectedRevision: 2 },
      { envelope: { domain: "graphs", version: 1, critical: ["expectedRevision"] } },
    ] as never);
    await expect(graphs(client).graph_run_get({ runId: "r1" })).resolves.toEqual(
      unchanged as never,
    );
    expect(invokeRaw.mock.calls[1]?.[2]).toEqual({
      envelope: { domain: "graphs", version: 1 },
    });
  });

  test("a version-1 answer that does not match its schema is refused", async () => {
    const { client } = fakeClient(() => ({ status: "changed", run: { id: "r1" } }), GRAPHS_V1);
    await expect(graphs(client).graph_run_get({ runId: "r1" })).rejects.toThrow(
      "Invalid result from graph_run_get",
    );
  });
});
