import { eventSink } from "../backend-emit.js";
import { compatibilityPathUsage } from "../compatibility-path-usage.js";
import { describe, expect, test } from "bun:test";

import type { BackendId } from "@orkestrator/protocol/federation";

import {
  coordinatorContactKey,
  emptyNodeMailState,
  LeafNodeMail,
  NODE_OUTBOX_READY_EVENT,
  type NodeMailState,
  type LocalCoordinatorContact,
  type NodeMailStore,
} from "./node-mail.js";
import {
  describeNodeAction,
  NodeActionRequests,
  type NodeActionRequest,
} from "./node-action-requests.js";

function memoryStore(): NodeMailStore & { state: NodeMailState } {
  const holder = {
    state: emptyNodeMailState(),
    async load() {
      return structuredClone(holder.state);
    },
    async mutate<T>(mutate: (state: NodeMailState) => { next: NodeMailState | null; result: T }) {
      const { next, result } = mutate(structuredClone(holder.state));
      if (next) holder.state = structuredClone(next);
      return result;
    },
  };
  return holder;
}

function leaf(
  controllers: string[],
  recent?: string,
  local?: Record<string, LocalCoordinatorContact>,
) {
  const store = memoryStore();
  const events: Array<{ event: string; payload: unknown }> = [];
  const attached = controllers.map((id) => ({ controllerId: id as BackendId, displayName: id }));
  let now = Date.parse("2026-10-26T13:00:00.000Z");
  const mail = new LeafNodeMail(
    store,
    {
      attachedControllers: () => attached,
      mostRecentControllerId: () => recent as BackendId | undefined,
      ...(local
        ? {
            localCoordinatorContact: async (environmentId: string) => local[environmentId] ?? {},
          }
        : {}),
    },
    eventSink((event, payload) => events.push({ event, payload })),
    () => now,
  );
  const at = (iso: string) => {
    now = Date.parse(iso);
  };
  return { mail, store, events, attached, at };
}

const coordinatorOf = (controllerId: string) => ({
  controllerId: controllerId as BackendId,
  coordinatorEnvironmentId: `coordinator:c-${controllerId}:main`,
  coordinatorTabId: "coordinator-tab",
});

describe("UP-02/UP-03 routing a leaf agent's mail", () => {
  test("with no command node attached, mail stays local", async () => {
    const { mail } = leaf([]);
    expect(
      await mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "coordinator" }),
    ).toBeNull();
  });

  test("the explicit local address overrides a command-node reply thread", async () => {
    const { mail } = leaf(["bk_a"]);
    await mail.recordThread("remote", coordinatorOf("bk_a"));
    expect(
      await mail.route({
        fromEnvironmentId: "e1",
        toEnvironmentId: "local-coordinator",
        replyToMessageId: "remote",
      }),
    ).toBeNull();
  });

  test("an environment launched by a command node reports to that command node", async () => {
    const { mail } = leaf(["bk_a", "bk_b"], "bk_b");
    await mail.recordOrigin("e1", coordinatorOf("bk_a"));
    expect(
      await mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "coordinator" }),
    ).toMatchObject({ controllerId: "bk_a", coordinatorTabId: "coordinator-tab" });
  });

  test("a reply on a coordinator's thread goes back to that coordinator", async () => {
    const { mail } = leaf(["bk_a", "bk_b"], "bk_b");
    await mail.recordThread("m-1", coordinatorOf("bk_a"));
    expect(
      await mail.route({
        fromEnvironmentId: "e9",
        toEnvironmentId: "e-other",
        replyToMessageId: "m-1",
      }),
    ).toMatchObject({ controllerId: "bk_a" });
  });

  test("with no origin, mail to the coordinator goes to the most recent command node", async () => {
    const { mail } = leaf(["bk_a", "bk_b"], "bk_b");
    expect(
      await mail.route({ fromEnvironmentId: "e2", toEnvironmentId: "coordinator" }),
    ).toMatchObject({ controllerId: "bk_b" });
    // Ordinary peer mail is never diverted.
    expect(await mail.route({ fromEnvironmentId: "e2", toEnvironmentId: "e3" })).toBeNull();
  });

  test("an origin whose command node detached falls back to the most recent attached one", async () => {
    const { mail } = leaf(["bk_b"], "bk_b");
    await mail.recordOrigin("e1", coordinatorOf("bk_gone"));
    expect(
      await mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "coordinator" }),
    ).toMatchObject({ controllerId: "bk_b" });
  });

  // Regression (2026-10-26): a leaf attached to a command node sent every
  // report from a local coordinator's workers to that command node's outbox,
  // because the command node had contacted this leaf most recently.
  test("a worker a local coordinator launched reports locally, not to the most recent command node", async () => {
    const { mail } = leaf(["bk_mini"], "bk_mini", {
      worker: { at: "2026-10-26T13:21:50.000Z" },
    });
    expect(
      await mail.route({
        fromEnvironmentId: "worker",
        fromTabId: "startup-agent",
        toEnvironmentId: "coordinator",
      }),
    ).toBeNull();
  });

  // A user told an agent on a leaf to tell "the coordinator". It reached the
  // leaf's own, which cannot act across nodes, and stranded there.
  test("with no coordinator contact, mail reaches the command node's coordinator", async () => {
    const { mail } = leaf(["bk_mini"], "bk_mini", { other: {} });
    expect(await mail.route({ fromEnvironmentId: "own", toEnvironmentId: "coordinator" })).toEqual({
      controllerId: "bk_mini" as BackendId,
      controllerName: "bk_mini",
    });
  });

  test("an attached command node is found even before it has contacted this node", async () => {
    const { mail } = leaf(["bk_a"], undefined);
    expect(
      await mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "coordinator" }),
    ).toMatchObject({ controllerId: "bk_a" });
  });

  test("the local address never goes up; it is not a route", async () => {
    const { mail } = leaf(["bk_mini"], "bk_mini");
    await mail.recordOrigin("e1", coordinatorOf("bk_mini"));
    expect(
      await mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "local-coordinator" }),
    ).toBeNull();
  });

  test("the command node's address goes up even from a local coordinator's worker", async () => {
    const { mail } = leaf(["bk_a", "bk_b"], "bk_b", {
      worker: { at: "2026-10-26T13:21:50.000Z" },
    });
    const route = () =>
      mail.route({ fromEnvironmentId: "worker", toEnvironmentId: "command-node-coordinator" });
    expect(await route()).toMatchObject({ controllerId: "bk_b" });
    // To the coordinator it already works with, when one has contacted it.
    await mail.recordOrigin("worker", coordinatorOf("bk_a"));
    expect(await route()).toMatchObject({
      controllerId: "bk_a",
      coordinatorTabId: "coordinator-tab",
    });
    // A reply to something local does not keep it down here.
    expect(
      await mail.route({
        fromEnvironmentId: "worker",
        toEnvironmentId: "command-node-coordinator",
        replyToMessageId: "local-msg",
      }),
    ).toMatchObject({ controllerId: "bk_a" });
  });

  test("the command node's address is refused, by name, with no command node attached", async () => {
    const { mail } = leaf([]);
    await expect(
      mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "command-node-coordinator" }),
    ).rejects.toThrow("This node is not controlled by a command node");
  });

  test("the coordinator that contacted the environment last is primary, local or remote", async () => {
    const local: Record<string, LocalCoordinatorContact> = {
      worker: { at: "2026-10-26T13:00:00.000Z" },
    };
    const { mail, at } = leaf(["bk_cmd"], "bk_cmd", local);
    const route = () => mail.route({ fromEnvironmentId: "worker", toEnvironmentId: "coordinator" });
    // Launched by the local coordinator: local.
    expect(await route()).toBeNull();
    // The command node's coordinator contacts it later: that one is primary now.
    at("2026-10-26T13:10:00.000Z");
    await mail.recordOrigin("worker", coordinatorOf("bk_cmd"), { keepOrigin: true });
    expect(await route()).toMatchObject({
      controllerId: "bk_cmd",
      coordinatorTabId: "coordinator-tab",
    });
    // The local coordinator delegates again afterwards: back to local.
    local.worker = { at: "2026-10-26T13:20:00.000Z" };
    expect(await route()).toBeNull();
    // And the command node again.
    at("2026-10-26T13:30:00.000Z");
    await mail.recordOrigin("worker", coordinatorOf("bk_cmd"), { keepOrigin: true });
    expect(await route()).toMatchObject({ controllerId: "bk_cmd" });
  });

  test("an environment a command node launched reports there until a local coordinator contacts it", async () => {
    const local: Record<string, LocalCoordinatorContact> = { e1: {} };
    const { mail } = leaf(["bk_cmd"], "bk_cmd", local);
    await mail.recordOrigin("e1", coordinatorOf("bk_cmd"));
    const route = () => mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "coordinator" });
    expect(await route()).toMatchObject({ controllerId: "bk_cmd" });
    local.e1 = { at: "2026-10-26T14:00:00.000Z" };
    expect(await route()).toBeNull();
  });

  test("an origin recorded before contact times is older than any local contact", async () => {
    const { mail, store } = leaf(["bk_cmd"], "bk_cmd", {
      e1: { at: "2026-10-01T00:00:00.000Z" },
    });
    store.state = { ...store.state, origins: { e1: coordinatorOf("bk_cmd") } };
    expect(
      await mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "coordinator" }),
    ).toBeNull();
  });

  test("a reply goes back to the sender of the message it answers", async () => {
    const { mail, at } = leaf(["bk_cmd"], "bk_cmd", {
      worker: { at: "2026-10-26T13:20:00.000Z" },
    });
    at("2026-10-26T13:10:00.000Z");
    await mail.recordThread("remote-msg", coordinatorOf("bk_cmd"));
    await mail.recordOrigin("worker", coordinatorOf("bk_cmd"), { keepOrigin: true });
    // The local coordinator contacted it last, but a reply to the command
    // node's message still goes to the command node...
    expect(
      await mail.route({
        fromEnvironmentId: "worker",
        toEnvironmentId: "",
        replyToMessageId: "remote-msg",
      }),
    ).toMatchObject({ controllerId: "bk_cmd" });
    // ...and a reply to a local message stays local, even addressed to
    // "coordinator" while the command node is primary.
    at("2026-10-26T13:30:00.000Z");
    await mail.recordOrigin("worker", coordinatorOf("bk_cmd"), { keepOrigin: true });
    expect(
      await mail.route({
        fromEnvironmentId: "worker",
        toEnvironmentId: "coordinator",
        replyToMessageId: "local-msg",
      }),
    ).toBeNull();
  });

  test("keepOrigin keeps the first origin but always updates the latest contact", async () => {
    const { mail, store } = leaf(["bk_a", "bk_b"], "bk_a");
    await mail.recordOrigin("e1", coordinatorOf("bk_a"));
    await mail.recordOrigin("e1", coordinatorOf("bk_b"), { keepOrigin: true });
    expect(store.state.origins.e1?.controllerId).toBe("bk_a" as BackendId);
    expect(store.state.contacts?.e1?.controllerId).toBe("bk_b" as BackendId);
    expect(
      await mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "coordinator" }),
    ).toMatchObject({ controllerId: "bk_b" });
  });
});

describe("routing a leaf coordinator's mail to a command node's coordinator", () => {
  const key = coordinatorContactKey("p1");

  test("refuses when no command node controls this node", async () => {
    const { mail } = leaf([]);
    await expect(mail.routeCoordinator({ contactKey: key })).rejects.toThrow(
      "This node is not controlled by a command node",
    );
  });

  test("a new message goes to the command node that last mailed this project's coordinator", async () => {
    const { mail } = leaf(["bk_a", "bk_b"], "bk_b");
    expect(await mail.routeCoordinator({ contactKey: key })).toEqual({
      controllerId: "bk_b" as BackendId,
      controllerName: "bk_b",
    });
    await mail.recordContact(key, coordinatorOf("bk_a"));
    // The repository's main there, not one conversation: no mailbox.
    expect(await mail.routeCoordinator({ contactKey: key })).toEqual({
      controllerId: "bk_a" as BackendId,
      controllerName: "bk_a",
    });
    // Another project's contact does not count.
    expect(await mail.routeCoordinator({ contactKey: coordinatorContactKey("p2") })).toEqual({
      controllerId: "bk_b" as BackendId,
      controllerName: "bk_b",
    });
  });

  test("a reply goes to the conversation that sent the message, and only while attached", async () => {
    const { mail, attached } = leaf(["bk_a", "bk_b"], "bk_b");
    await mail.recordThread("m1", coordinatorOf("bk_a"));
    expect(await mail.routeCoordinator({ contactKey: key, replyToMessageId: "m1" })).toEqual(
      coordinatorOf("bk_a"),
    );
    await expect(
      mail.routeCoordinator({ contactKey: key, replyToMessageId: "unknown" }),
    ).rejects.toThrow("did not come from a command node's coordinator");
    attached.splice(0, 1);
    await expect(
      mail.routeCoordinator({ contactKey: key, replyToMessageId: "m1" }),
    ).rejects.toThrow("no longer controls this node");
  });

  // docs/architecture/coordinator.md "Older nodes"; version-compatibility.md register.
  test("an older command node (no coordinatorMail) is not offered the coordinator's mail; it is held and counted", async () => {
    const held = () =>
      compatibilityPathUsage.snapshot().paths["node-coordinator-mail.older-command-node"]?.count ??
      0;
    const { mail } = leaf(["bk_old"], "bk_old");
    await mail.enqueue("bk_old" as BackendId, {
      requestId: "worker-1",
      fromEnvironmentId: "e1",
      fromTabId: "t1",
      body: "a worker's report",
    });
    const before = held();
    // Nothing from the coordinator queued yet: an older collect counts nothing.
    await mail.collect("bk_old" as BackendId, 0);
    expect(held()).toBe(before);
    const coordinatorMail = await mail.enqueue("bk_old" as BackendId, {
      requestId: "coordinator-1",
      fromEnvironmentId: "coordinator-runtime",
      fromTabId: "main",
      body: "from the leaf coordinator",
      fromCoordinator: true,
      allowLocalFallback: false,
    });
    const older = await mail.collect("bk_old" as BackendId, 0);
    expect(older.items.map((item) => item.body)).toEqual(["a worker's report"]);
    expect(held()).toBe(before + 1);
    // An older command node's ack (everything up to the latest seq) keeps it.
    expect(await mail.ack("bk_old" as BackendId, coordinatorMail.seq)).toEqual({ remaining: 1 });
    expect(await mail.queued("bk_old" as BackendId, coordinatorMail.seq)).toBeDefined();
    // Once updated, the same command node collects it.
    const updated = await mail.collect("bk_old" as BackendId, 0, true);
    expect(updated.items.map((item) => item.body)).toEqual(["from the leaf coordinator"]);
    expect(held()).toBe(before + 1);
  });
});

describe("UP-04 the leaf outbox", () => {
  test("queues per command node, collects in order, and drops only what was acknowledged", async () => {
    const { mail, events } = leaf(["bk_a"], "bk_a");
    const first = await mail.enqueue("bk_a" as BackendId, {
      requestId: "r1",
      fromEnvironmentId: "e1",
      fromTabId: "t1",
      body: "done",
    });
    await mail.enqueue("bk_a" as BackendId, {
      requestId: "r2",
      fromEnvironmentId: "e1",
      fromTabId: "t1",
      body: "second",
    });
    // A retried request is not queued twice.
    await mail.enqueue("bk_a" as BackendId, {
      requestId: "r1",
      fromEnvironmentId: "e1",
      fromTabId: "t1",
      body: "done",
    });
    expect(events.filter((entry) => entry.event === NODE_OUTBOX_READY_EVENT)).toHaveLength(3);
    const collected = await mail.collect("bk_a" as BackendId, 0);
    expect(collected.items.map((item) => item.body)).toEqual(["done", "second"]);
    // Collecting again without an ack returns the same items: nothing is lost.
    expect((await mail.collect("bk_a" as BackendId, 0)).items).toHaveLength(2);
    expect(await mail.ack("bk_a" as BackendId, first.seq)).toEqual({ remaining: 1 });
    expect((await mail.collect("bk_a" as BackendId, 0)).items.map((item) => item.body)).toEqual([
      "second",
    ]);
    // Another command node's queue is separate.
    expect((await mail.collect("bk_other" as BackendId, 0)).items).toEqual([]);
  });

  test("a full outbox refuses new mail instead of dropping old mail", async () => {
    const { mail } = leaf(["bk_a"], "bk_a");
    const big = "x".repeat(9 * 1024 * 1024);
    await mail.enqueue("bk_a" as BackendId, {
      requestId: "big-1",
      fromEnvironmentId: "e1",
      fromTabId: "t1",
      body: big,
    });
    await expect(
      mail.enqueue("bk_a" as BackendId, {
        requestId: "big-2",
        fromEnvironmentId: "e1",
        fromTabId: "t1",
        body: big,
      }),
    ).rejects.toThrow("outbox for that command node is full");
    expect(await mail.pending("bk_a" as BackendId)).toBe(1);
  });
});

describe("CO-04 action requests", () => {
  function requests(executor = async () => ({ code: "deleted", message: "Deleted." })) {
    let saved: NodeActionRequest[] = [];
    const notified: NodeActionRequest[] = [];
    let now = 1_000_000;
    const service = new NodeActionRequests({
      load: async () => saved,
      save: async (value) => {
        saved = structuredClone(value);
      },
      emit: () => undefined,
      executors: { "delete-environment": executor },
      notify: async (request) => {
        notified.push(request);
      },
      now: () => now,
    });
    return { service, notified, advance: (ms: number) => (now += ms) };
  }

  const target = {
    nodeId: "bk_leaf",
    nodeName: "Build box",
    environmentId: "e1",
    environmentName: "feature-a",
  };
  const requestedBy = {
    coordinatorEnvironmentId: "coordinator:c:main",
    coordinatorTabId: "tab",
    projectId: "p1",
  };

  test("a deletion runs only after the user approves it, and the coordinator is told", async () => {
    let ran = 0;
    const { service, notified } = requests(async () => {
      ran += 1;
      return { code: "deleted", message: "Deleted feature-a on Build box." };
    });
    const request = await service.create({
      kind: "delete-environment",
      targets: [target],
      requestedBy,
    });
    expect(request.state).toBe("pending");
    expect(describeNodeAction(request)).toBe("Delete “feature-a” on Build box");
    expect(ran).toBe(0);
    const resolved = await service.resolve(request.requestId, "approve");
    expect(resolved.state).toBe("executed");
    expect(ran).toBe(1);
    expect(notified.map((entry) => entry.state)).toEqual(["executed"]);
    await expect(service.resolve(request.requestId, "approve")).rejects.toThrow("already executed");
    expect(ran).toBe(1);
  });

  test("a rejection or an expiry never executes", async () => {
    let ran = 0;
    const { service, advance } = requests(async () => {
      ran += 1;
      return { code: "deleted", message: "" };
    });
    const rejected = await service.create({
      kind: "delete-environment",
      targets: [target],
      requestedBy,
    });
    expect((await service.resolve(rejected.requestId, "reject")).state).toBe("rejected");
    const stale = await service.create({
      kind: "delete-environment",
      targets: [target],
      requestedBy,
    });
    advance(25 * 60 * 60_000);
    await expect(service.resolve(stale.requestId, "approve")).rejects.toThrow("already expired");
    expect(ran).toBe(0);
  });

  test("a failed execution is reported, not retried", async () => {
    const { service } = requests(async () => {
      throw Object.assign(new Error("node unavailable"), { code: "node-unavailable" });
    });
    const request = await service.create({
      kind: "delete-environment",
      targets: [target],
      requestedBy,
    });
    const resolved = await service.resolve(request.requestId, "approve");
    expect(resolved.state).toBe("failed");
    expect(resolved.result).toEqual({ code: "node-unavailable", message: "node unavailable" });
  });
});

test("outbox dedupe is scoped to sender and rejects conflicting request reuse", async () => {
  const { mail } = leaf(["bk_cmd"]);
  const item = { requestId: "same", fromEnvironmentId: "e1", fromTabId: "t1", body: "one" };
  const first = await mail.enqueue("bk_cmd" as never, item);
  expect((await mail.enqueue("bk_cmd" as never, item)).seq).toBe(first.seq);
  expect((await mail.enqueue("bk_cmd" as never, { ...item, fromTabId: "t2" })).seq).not.toBe(
    first.seq,
  );
  await expect(mail.enqueue("bk_cmd" as never, { ...item, body: "different" })).rejects.toThrow(
    "Conflicting",
  );
  await mail.ack("bk_cmd" as never, 0, [first.seq + 1]);
  expect((await mail.collect("bk_cmd" as never, 0)).items.map((entry) => entry.seq)).toEqual([
    first.seq,
  ]);
});
