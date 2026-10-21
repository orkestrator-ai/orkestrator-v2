import { expect, test } from "bun:test";
import { NodeMailCollector } from "./node-mail-collector.js";
import { type OutboxItem } from "./node-mail.js";

const item = (seq: number): OutboxItem => ({
  seq,
  requestId: `r${seq}`,
  createdAt: "",
  fromEnvironmentId: "e",
  fromTabId: "t",
  body: `message ${seq}`,
  bytes: 9,
});

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(condition()).toBe(true);
}

test("an unroutable first item remains available while later mail is delivered and individually acknowledged", async () => {
  let pending = [item(1), item(2)];
  const delivered: string[] = [];
  const collector = new NodeMailCollector({
    retryDelayMs: 1000,
    selfId: async () => "bk_cmd" as never,
    nodeName: async () => "Leaf",
    link: () => ({
      connected: true,
      invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
        if (command === "collect_node_outbox") return { items: pending, more: false } as T;
        pending = pending.filter((entry) => !(args.sequences as number[]).includes(entry.seq));
        return {} as T;
      },
    }),
    deliver: async (input) => {
      if (input.requestId.endsWith(":1")) throw new Error("no-coordinator");
      delivered.push(input.requestId);
    },
  });
  await collector.collect("bk_leaf" as never);
  expect(delivered).toEqual(["node:bk_leaf:2"]);
  expect(pending.map((entry) => entry.seq)).toEqual([1]);
  collector.dispose();
});

for (const failure of ["collect", "deliver", "ack"])
  test(`transient ${failure} failure recovers without new events or reconnect`, async () => {
    let failed = false;
    let pending = [item(1)];
    const delivered = new Set<string>();
    const collector = new NodeMailCollector({
      retryDelayMs: 2,
      selfId: async () => "bk_cmd" as never,
      nodeName: async () => "Leaf",
      link: () => ({
        connected: true,
        invoke: async <T>(command: string) => {
          if (
            !failed &&
            command ===
              (failure === "collect"
                ? "collect_node_outbox"
                : failure === "ack"
                  ? "ack_node_outbox"
                  : "never")
          ) {
            failed = true;
            throw new Error("unreachable");
          }
          if (command === "collect_node_outbox") return { items: pending, more: false } as T;
          pending = [];
          return {} as T;
        },
      }),
      deliver: async (input) => {
        if (!failed && failure === "deliver") {
          failed = true;
          throw new Error("temporary");
        }
        delivered.add(input.requestId);
      },
    });
    collector.handleNodeEvent("node-outbox-ready", { controllerId: "bk_cmd" }, "bk_leaf" as never);
    await until(() => failed && pending.length === 0);
    expect(delivered.size).toBe(1);
    collector.dispose();
  });

test("stream resync reconciles a pending outbox", async () => {
  let delivered = 0;
  const collector = new NodeMailCollector({
    selfId: async () => "bk_cmd" as never,
    nodeName: async () => "Leaf",
    link: () => ({
      connected: true,
      invoke: async <T>(command: string) =>
        (command === "collect_node_outbox" ? { items: [item(3)], more: false } : {}) as T,
    }),
    deliver: async () => {
      delivered++;
    },
  });
  collector.handleNodeEvent("native-event-stream-connected", undefined, "bk_leaf" as never);
  await until(() => delivered === 1);
  collector.dispose();
});

test("legacy leaves still acknowledge a fully delivered batch", async () => {
  let pending = [item(1), item(2)];
  const collector = new NodeMailCollector({
    selfId: async () => "bk_cmd" as never,
    nodeName: async () => "Leaf",
    link: () => ({
      connected: true,
      invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
        if (command === "collect_node_outbox") return { items: pending, more: false } as T;
        // The previous leaf protocol ignores the new per-sequence field.
        pending = pending.filter((entry) => entry.seq > Number(args.upTo));
        return {} as T;
      },
    }),
    deliver: async () => {},
  });
  await collector.collect("bk_leaf" as never);
  expect(pending).toEqual([]);
  collector.dispose();
});
