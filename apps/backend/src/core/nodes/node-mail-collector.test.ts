import { configureLogger, resetLogger, type LogOutput } from "@orkestrator/protocol/logger";
import { describe, expect, test } from "bun:test";
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

describe("a repository with no coordinator on this node", () => {
  const noCoordinator = () =>
    Object.assign(new Error("No open coordinator"), { code: "no-coordinator" });
  function collecting(
    items: OutboxItem[],
    options: { capable?: boolean; deliverError?: () => Error; returnFails?: boolean } = {},
  ) {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const capabilities: Record<string, number> =
      options.capable === false ? {} : { "node-mail-return": 1 };
    let pending = items;
    const collector = new NodeMailCollector({
      retryDelayMs: 1000,
      selfId: async () => "bk_cmd" as never,
      nodeName: async () => "Leaf",
      link: () => ({
        connected: true,
        hello: { capabilities },
        invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "collect_node_outbox") return { items: pending, more: false } as T;
          if (command === "return_node_outbox_mail" && options.returnFails) {
            throw new Error("The environment that sent that mail no longer exists.");
          }
          if (command === "ack_node_outbox") {
            pending = pending.filter((entry) => !(args.sequences as number[]).includes(entry.seq));
          }
          return {} as T;
        },
      }),
      deliver: async () => {
        throw (options.deliverError ?? noCoordinator)();
      },
    });
    return {
      calls,
      collector,
      returned: () =>
        calls.filter((call) => call.command === "return_node_outbox_mail").map((call) => call.args),
      pending: () => pending.map((entry) => entry.seq),
    };
  }

  test("an agent's mail goes back to the leaf and leaves the outbox", async () => {
    const world = collecting([item(1)]);
    expect(await world.collector.collect("bk_leaf" as never)).toBe(true);
    expect(world.returned()).toEqual([{ controllerId: "bk_cmd", seq: 1 }]);
    expect(world.pending()).toEqual([]);
    world.collector.dispose();
  });

  test("stays queued when the leaf has no coordinator to take it either", async () => {
    const world = collecting([item(1)], { returnFails: true });
    expect(await world.collector.collect("bk_leaf" as never)).toBe(false);
    expect(world.pending()).toEqual([1]);
    world.collector.dispose();
  });

  test("a hand-back refusal logs the leaf error and leaves mail queued", async () => {
    const outputs: LogOutput[] = [];
    configureLogger({
      sink: (output) => {
        outputs.push(output);
      },
    });
    const world = collecting([item(92)], { returnFails: true });
    try {
      expect(await world.collector.collect("bk_leaf" as never)).toBe(false);
      expect(world.pending()).toEqual([92]);
      expect(
        outputs.some(
          (output) =>
            output.line.includes("mail.return-deferred") &&
            output.line.includes("no longer exists"),
        ),
      ).toBe(true);
    } finally {
      world.collector.dispose();
      resetLogger();
    }
  });

  test("explicit command-node mail is never handed back or acknowledged", async () => {
    const world = collecting([{ ...item(1), allowLocalFallback: false }]);
    try {
      expect(await world.collector.collect("bk_leaf" as never)).toBe(false);
      expect(world.returned()).toEqual([]);
      expect(world.pending()).toEqual([1]);
    } finally {
      world.collector.dispose();
    }
  });

  test("an older leaf is never asked, and its mail keeps waiting", async () => {
    const world = collecting([item(1)], { capable: false });
    expect(await world.collector.collect("bk_leaf" as never)).toBe(false);
    expect(world.returned()).toEqual([]);
    expect(world.pending()).toEqual([1]);
    world.collector.dispose();
  });

  test("a transient failure is retried here, not handed back", async () => {
    const world = collecting([item(1)], { deliverError: () => new Error("temporary") });
    expect(await world.collector.collect("bk_leaf" as never)).toBe(false);
    expect(world.returned()).toEqual([]);
    world.collector.dispose();
  });

  test("mail for a named conversation and a leaf coordinator's own mail stay queued", async () => {
    const world = collecting([
      { ...item(1), toCoordinator: { environmentId: "coordinator:c:m", tabId: "t" } },
      { ...item(2), fromCoordinator: true },
    ]);
    expect(await world.collector.collect("bk_leaf" as never)).toBe(false);
    expect(world.returned()).toEqual([]);
    expect(world.pending()).toEqual([1, 2]);
    world.collector.dispose();
  });
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

test("coalesced collectors await the follow-up drain and report partial delivery", async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reads = 0;
  const collector = new NodeMailCollector({
    selfId: async () => "bk_cmd" as never,
    nodeName: async () => "Leaf",
    link: () => ({
      connected: true,
      invoke: async <T>() => {
        reads++;
        if (reads === 1) {
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { items: [], more: false } as T;
        }
        return { items: [item(2)], more: false } as T;
      },
    }),
    deliver: async () => {
      throw new Error("unavailable mailbox");
    },
  });
  try {
    const first = collector.collect("bk_leaf" as never);
    await entered;
    const joined = collector.collect("bk_leaf" as never);
    release();
    expect(await first).toBe(false);
    expect(await joined).toBe(false);
    expect(reads).toBe(2);
  } finally {
    collector.dispose();
  }
});

test("a bounded partial drain is not reported as complete", async () => {
  const collector = new NodeMailCollector({
    selfId: async () => "bk_cmd" as never,
    nodeName: async () => "Leaf",
    link: () => ({
      connected: true,
      invoke: async <T>(command: string) =>
        (command === "collect_node_outbox" ? { items: [item(1)], more: true } : {}) as T,
    }),
    deliver: async () => {},
  });
  try {
    expect(await collector.collect("bk_leaf" as never)).toBe(false);
  } finally {
    collector.dispose();
  }
});

test("deferred notice retries retain exponential backoff", async () => {
  let reads = 0;
  const collector = new NodeMailCollector({
    retryDelayMs: 10,
    selfId: async () => "bk_cmd" as never,
    nodeName: async () => "Leaf",
    link: () => ({
      connected: true,
      hello: { capabilities: { "coordinator-notices": 1 } },
      invoke: async <T>() => {
        reads++;
        return {
          items: [{ ...item(1), coordinatorNotice: { kind: "repository", createSession: false } }],
          more: false,
        } as T;
      },
    }),
    deliver: async () => {},
    notices: { repositoryHints: async () => [], deliver: async () => "deferred" },
  });
  try {
    await collector.collect("bk_leaf" as never);
    await until(() => reads >= 3);
    // With a reset delay, there would already be a fourth read after another 25ms.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(reads).toBe(3);
  } finally {
    collector.dispose();
  }
});

describe("node-mail domain client (plan item 1010)", () => {
  async function collectFrom(hello: Record<string, unknown>) {
    const calls: Array<{ command: string; args: Record<string, unknown>; envelope?: unknown }> = [];
    let pending = [item(1)];
    const collector = new NodeMailCollector({
      selfId: async () => "bk_cmd" as never,
      nodeName: async () => "Leaf",
      link: () => ({
        connected: true,
        hello,
        invoke: async <T>(
          command: string,
          args: Record<string, unknown> = {},
          options?: { envelope?: unknown },
        ) => {
          calls.push({
            command,
            args,
            ...(options?.envelope ? { envelope: options.envelope } : {}),
          });
          if (command === "collect_node_outbox") return { items: pending, more: false } as T;
          pending = [];
          return {} as T;
        },
      }),
      deliver: async () => {},
      notices: {
        repositoryHints: async () => ["github.com/acme/site"],
        deliver: async () => "delivered",
      },
    });
    try {
      expect(await collector.collect("bk_leaf" as never)).toBe(true);
    } finally {
      collector.dispose();
    }
    return calls;
  }

  test("a leaf with the domain is sent every outbox flag, with the envelope, without capabilities", async () => {
    const calls = await collectFrom({
      capabilities: {},
      domains: { "node-mail": { min: 1, max: 1 } },
    });
    expect(calls.map((call) => call.command)).toEqual(["collect_node_outbox", "ack_node_outbox"]);
    expect(calls[0]).toMatchObject({
      args: {
        coordinatorMail: true,
        attachmentMail: true,
        coordinatorNotices: { repositoryHints: ["github.com/acme/site"] },
      },
      envelope: { domain: "node-mail", version: 1 },
    });
    expect(calls[1]).toMatchObject({
      args: { upTo: 1, sequences: [1], coordinatorMail: true, attachmentMail: true },
      envelope: { domain: "node-mail", version: 1 },
    });
  });

  test("a pre-contract leaf is sent only the flags its capabilities name, as before", async () => {
    const calls = await collectFrom({ capabilities: { "node-coordinator-mail": 1 } });
    expect(calls[0]!.args).toEqual({ controllerId: "bk_cmd", after: 0, coordinatorMail: true });
    expect(calls[0]).not.toHaveProperty("envelope");
  });
});
