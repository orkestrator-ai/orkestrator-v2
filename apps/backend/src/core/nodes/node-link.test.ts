import { afterEach, expect, test } from "bun:test";
import type { NodeRecord } from "@orkestrator/protocol/command-nodes";
import {
  UnsupportedVersionError,
  incompatibility,
  toWire,
  unsupportedVersion,
} from "@orkestrator/protocol/contract/errors";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { defineCommand } from "@orkestrator/protocol/contract/command";
import { defineDomain } from "@orkestrator/protocol/contract/domain";
import * as Schema from "effect/Schema";
import { nodeMailClient } from "@orkestrator/protocol/contract/domains/node-mail";
import { contractEnvelopeFor, NodeLink } from "./node-link.js";
import { linkDomainApi } from "./node-domain-clients.js";
import { NodeOutcomeLedger, routeToNode } from "./node-routing.js";
import { stopTestNodeNetworks, TestNodeNetwork, settle } from "./node-network-test-support.js";

// Stop every node a test left running; see `stopTestNodeNetworks`.
afterEach(stopTestNodeNetworks);

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

test("a write that returns nothing is a success, not an unknown outcome", async () => {
  const { leaf, link } = await setup();
  let dispatches = 0;
  leaf.commands.set("mutate", async () => {
    dispatches++;
  });
  await link.start();
  const outcomes = new NodeOutcomeLedger();
  const result = await routeToNode({
    nodeId: "bk_leaf" as never,
    link,
    command: "mutate",
    args: {},
    outcomes,
  });
  expect(result).toEqual({ outcome: "ok", result: undefined });
  expect(dispatches).toBe(1);
  expect(outcomes.list()).toHaveLength(0);
  link.stop();
});

for (const body of ["null", "[]", '{"status":"ok"}', '{"error":"failed"}'])
  test(`a successful status with an unexpected body stays unknown (${body})`, async () => {
    const { link } = await setup(async (_input, init) =>
      init?.body && JSON.parse(String(init.body)).command === "mutate"
        ? new Response(body, { status: 200 })
        : null,
    );
    await link.start();
    const outcomes = new NodeOutcomeLedger();
    const result = await routeToNode({
      nodeId: "bk_leaf" as never,
      link,
      command: "mutate",
      args: {},
      outcomes,
    });
    expect(result.outcome).toBe("unknown");
    expect(outcomes.list()).toHaveLength(1);
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

// A throwaway definition in a domain no node command is in.
const probeSystem = defineDomain({ name: "system", version: 2, min: 1 });
const probeMutate = defineCommand({
  domain: probeSystem,
  name: "mutate",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ value: Schema.String, steer: Schema.optionalKey(Schema.Boolean) }),
  result: Schema.Struct({}),
  critical: ["steer"],
});

for (const [label, domains, expected] of [
  [
    "advertises the domain",
    { system: { min: 1, max: 2 } },
    { domain: "system", version: 2, critical: ["steer"] },
  ],
  ["is contract-aware without the domain", {}, undefined],
  ["is pre-contract", undefined, undefined],
] as const)
  test(`a defined command's invoke carries the envelope only when the node ${label}`, async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { leaf, link } = await setup(async (_input, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (body?.command === "mutate") bodies.push(body);
      return null;
    });
    if (domains) leaf.helloOverrides = { domains };
    leaf.commands.set("mutate", async () => ({}));
    await link.start();
    expect(link.hello?.domains).toEqual(domains);
    await link.invokeCommand(probeMutate, { value: "x", steer: true });
    expect(bodies).toEqual([{ command: "mutate", args: { value: "x", steer: true }, ...expected }]);
    // A critical field the call does not carry is not listed.
    expect(contractEnvelopeFor(link.hello, probeMutate, { value: "x" })).toEqual(
      expected ? { domain: "system", version: 2 } : undefined,
    );
    // The untyped path is unchanged.
    await link.invoke("mutate", { value: "y" });
    expect(bodies[1]).toEqual({ command: "mutate", args: { value: "y" } });
    link.stop();
  });

test("a domain client's picked envelope is the one sent, and none is today's body (plan item 1010)", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const { leaf, link } = await setup(async (_input, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    if (body && typeof body.command === "string" && body.command !== "attach_controller") {
      bodies.push(body);
    }
    return null;
  });
  leaf.helloOverrides = {
    domains: { system: { min: 1, max: 2 }, "node-mail": { min: 1, max: 1 } },
  };
  leaf.commands.set("mutate", async () => ({}));
  leaf.commands.set("return_node_outbox_mail", async () => ({ returned: true }));
  await link.start();
  // The negotiated version, not the definition's own (2).
  await link.invokeCommand(
    probeMutate,
    { value: "x" },
    { envelope: { domain: "system", version: 1 } },
  );
  // The legacy adapter passes none: a pre-contract body.
  await link.invokeCommand(probeMutate, { value: "y" }, { envelope: undefined });
  // Through the node-mail client over this link: version 1, picked from the hello.
  await linkDomainApi(link, nodeMailClient).returnOutboxMail({ controllerId: "bk_cmd", seq: 1 });
  expect(bodies).toEqual([
    { command: "mutate", args: { value: "x" }, domain: "system", version: 1 },
    { command: "mutate", args: { value: "y" } },
    {
      command: "return_node_outbox_mail",
      args: { controllerId: "bk_cmd", seq: 1 },
      domain: "node-mail",
      version: 1,
    },
  ]);
  link.stop();
});

test("a typed incompatibility keeps its code and details through the link (plan item 1005)", async () => {
  const body = toWire(
    unsupportedVersion({ domain: "node-mail", range: { min: 2, max: 3 }, command: "deliver" }),
  );
  const { link } = await setup(async (_input, init) =>
    init?.body && JSON.parse(String(init.body)).command === "deliver"
      ? new Response(JSON.stringify(body), { status: 500 })
      : null,
  );
  await link.start();
  const failure = await link.invoke("deliver", {}).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(UnsupportedVersionError);
  expect((failure as Error).message).toBe(body.error);
  expect(incompatibility(failure, "deliver")).toEqual({
    code: "unsupported-version",
    domain: "node-mail",
    range: { min: 2, max: 3 },
    command: "deliver",
  });
  // A node without the command answers it coded; the legacy text is unchanged.
  const unknown = await link.invoke("not_registered", {}).catch((error: unknown) => error);
  expect((unknown as { code?: string }).code).toBe("unknown-command");
  expect((unknown as Error).message).toBe(unknownBackendCommandMessage("not_registered"));
  expect(incompatibility(unknown, "not_registered")?.command).toBe("not_registered");
  link.stop();
});
