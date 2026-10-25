import { expect, test } from "bun:test";
import type { NodeRecord } from "@orkestrator/protocol/command-nodes";
import { NodeLink } from "./node-link.js";
import { NodeOutcomeLedger, routeToNode } from "./node-routing.js";
import { TestNodeNetwork, settle } from "./node-network-test-support.js";

async function setup(
  fetchOverride?: (input: string | URL | Request, init?: RequestInit) => Promise<Response | null>,
) {
  const network = new TestNodeNetwork();
  const leaf = await network.add("leaf");
  const record: NodeRecord = {
    nodeId: "bk_leaf" as never,
    enabled: true,
    fallbackName: "Leaf",
    routes: [{ id: "a" as never, kind: "https", enabled: true, origin: leaf.origin }],
    routeOrder: ["a" as never],
    credential: { token: leaf.token } as never,
    addedAt: "",
    attachment: { status: "attached" },
    source: "portal",
  };
  const link = new NodeLink(record, {
    selfId: "bk_cmd" as never,
    ssh: null,
    timers: network.timers,
    onChange: () => {},
    onVerified: () => {},
    attachInfo: async () => ({ displayName: "Command", portalOrigins: [] }),
    fetchImpl: (async (input, init) =>
      (await fetchOverride?.(input, init)) ?? network.fetch(input, init)) as typeof fetch,
  });
  return { network, leaf, record, link };
}

for (const invalidate of ["update", "reconnect"])
  test(`pending hello survives ${invalidate} with a fresh attempt`, async () => {
    let release!: () => void;
    let held = false;
    const origins: string[] = [];
    const { network, leaf, record, link } = await setup(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("hello")) {
        origins.push(url.origin);
        if (!held) {
          held = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      }
      return null;
    });
    const first = link.start();
    await settle();
    let next: Promise<void> | undefined;
    if (invalidate === "update") {
      const origin = "https://alternate.test";
      network.nodes.set("alternate", { ...leaf, origin });
      link.update({ ...record, routes: [{ ...record.routes[0]!, origin } as never] });
    } else {
      link.stop();
      next = link.start({ interactive: true });
    }
    release();
    await first;
    await next;
    await settle();
    expect(origins).toHaveLength(2);
    expect(origins[1]).toBe(invalidate === "update" ? "https://alternate.test" : leaf.origin);
    expect(link.connected).toBe(true);
    link.stop();
  });

for (const malformed of [false, true])
  test(`lost successful response records durable unknown (malformed=${malformed})`, async () => {
    let dispatches = 0;
    const { link } = await setup(async (_input, init) => {
      if (init?.body && JSON.parse(String(init.body)).command === "mutate") {
        dispatches++;
        if (malformed) return new Response('{"result":', { status: 200 });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"result":'));
              setTimeout(() => controller.error(new Error("reset")), 0);
            },
          }),
          { status: 200 },
        );
      }
      return null;
    });
    await link.start();
    let durable: unknown = null;
    const outcomes = new NodeOutcomeLedger({
      load: async () => [],
      save: async (records) => {
        durable = structuredClone(records);
      },
    });
    const result = await routeToNode({
      nodeId: "bk_leaf" as never,
      link,
      command: "mutate",
      args: {},
      outcomes,
    });
    expect(result.outcome).toBe("unknown");
    expect(dispatches).toBe(1);
    expect(durable).toEqual(outcomes.list());
    expect(outcomes.list()).toHaveLength(1);
    link.stop();
  });
