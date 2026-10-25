import { describe, expect, test } from "bun:test";

import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { RouteId } from "@orkestrator/protocol/federation";
import { NODE_SUMMARY_CHANGED_EVENT } from "@orkestrator/protocol/node-summaries";

import { NodeEventStream } from "./node-event-stream.js";
import { NodeReadModel } from "./node-read-model.js";
import { settle, TestNodeNetwork, type TestNode } from "./node-network-test-support.js";

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function httpsRoute(node: TestNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.origin };
}

describe("a node event stream that goes silent", () => {
  test("is dropped and reopened, so consumers re-read", async () => {
    let connections = 0;
    // Each connection opens and then never sends a byte, as a half-open route does.
    const fetchImpl = (async () => {
      connections += 1;
      const body = new ReadableStream<Uint8Array>({ start() {} });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    let opens = 0;
    const stream = new NodeEventStream({
      transport: () => ({ baseUrl: "https://leaf.test", headers: {} }),
      prefixes: ["resource-changed"],
      onEvent: () => undefined,
      onOpen: () => opens++,
      fetchImpl,
      idleMs: 30,
    });
    stream.start();
    // The first reconnect waits for the 1 s backoff floor.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    stream.stop();
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(opens).toBeGreaterThanOrEqual(2);
  });

  test("keepalives hold a quiet connection open", async () => {
    let connections = 0;
    const encoder = new TextEncoder();
    const fetchImpl = (async () => {
      connections += 1;
      let timer: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 10);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const stream = new NodeEventStream({
      transport: () => ({ baseUrl: "https://leaf.test", headers: {} }),
      prefixes: ["resource-changed"],
      onEvent: () => undefined,
      fetchImpl,
      idleMs: 40,
    });
    stream.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    stream.stop();
    expect(connections).toBe(1);
  });
});

describe("the portal read model's periodic re-read", () => {
  test("picks up a change the node never announced, and stays quiet when nothing changed", async () => {
    const network = new TestNodeNetwork();
    const command = await network.add("command", { forceRegistration: true });
    const leaf = await network.add("leaf");
    const environment = { id: "e1", name: "feature", agentActivityState: "idle" };
    leaf.commands.set("get_projects", () => [{ id: "p1", name: "Website", order: 0 }]);
    leaf.commands.set("get_environment_snapshots", () => [
      { ...environment, projectId: "p1", status: "running" },
    ]);
    await command.service.addNode({ routes: [httpsRoute(leaf)], token: leaf.token });
    await settle(40);

    const emitted: Array<{ event: string; payload: unknown }> = [];
    const readModel = new NodeReadModel({
      nodes: command.service,
      emit: (event, payload) => emitted.push({ event, payload }),
      fetchImpl: network.fetch,
      reconcileMs: 40,
    });
    await readModel.start();
    const node = async () => (await readModel.summaries()).nodes[0];
    const announced = () => emitted.filter((e) => e.event === NODE_SUMMARY_CHANGED_EVENT).length;
    await waitFor(async () => (await node())?.freshness === "current");
    expect((await node())?.environments[0]?.activity).toBe("idle");
    // Let the start-up reads finish announcing.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Nothing changed: several re-reads run but announce nothing.
    const announcedBefore = announced();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(announced()).toBe(announcedBefore);

    // The agent starts working and no event arrives.
    environment.agentActivityState = "working";
    await waitFor(async () => (await node())?.environments[0]?.activity === "working");
    await waitFor(() => announced() > announcedBefore);
    readModel.stop();
  });
});
