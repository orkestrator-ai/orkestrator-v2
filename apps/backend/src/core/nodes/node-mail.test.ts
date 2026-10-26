import { describe, expect, test } from "bun:test";

import type { BackendId } from "@orkestrator/protocol/federation";

import {
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
            localCoordinatorContact: async (environmentId: string) =>
              local[environmentId] ?? { hasCoordinator: false },
          }
        : {}),
    },
    (event, payload) => events.push({ event, payload }),
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
      worker: { at: "2026-10-26T13:21:50.000Z", hasCoordinator: true },
    });
    expect(
      await mail.route({
        fromEnvironmentId: "worker",
        fromTabId: "startup-agent",
        toEnvironmentId: "coordinator",
      }),
    ).toBeNull();
  });

  test("with no coordinator contact, a project with a local coordinator keeps mail local", async () => {
    const { mail } = leaf(["bk_mini"], "bk_mini", { own: { hasCoordinator: true } });
    expect(
      await mail.route({ fromEnvironmentId: "own", toEnvironmentId: "coordinator" }),
    ).toBeNull();
    // A project with no coordinator on this node still reaches the command node.
    expect(
      await mail.route({ fromEnvironmentId: "other", toEnvironmentId: "coordinator" }),
    ).toMatchObject({ controllerId: "bk_mini" });
  });

  test("the coordinator that contacted the environment last is primary, local or remote", async () => {
    const local: Record<string, LocalCoordinatorContact> = {
      worker: { at: "2026-10-26T13:00:00.000Z", hasCoordinator: true },
    };
    const { mail, at } = leaf(["bk_cmd"], "bk_cmd", local);
    const route = () => mail.route({ fromEnvironmentId: "worker", toEnvironmentId: "coordinator" });
    // Launched by the local coordinator: local.
    expect(await route()).toBeNull();
    // The command node's coordinator contacts it later: that one is primary now.
    at("2026-10-26T13:10:00.000Z");
    await mail.recordOrigin("worker", coordinatorOf("bk_cmd"), { keepOrigin: true });
    expect(await route()).toMatchObject({ controllerId: "bk_cmd", coordinatorTabId: "coordinator-tab" });
    // The local coordinator delegates again afterwards: back to local.
    local.worker = { at: "2026-10-26T13:20:00.000Z", hasCoordinator: true };
    expect(await route()).toBeNull();
    // And the command node again.
    at("2026-10-26T13:30:00.000Z");
    await mail.recordOrigin("worker", coordinatorOf("bk_cmd"), { keepOrigin: true });
    expect(await route()).toMatchObject({ controllerId: "bk_cmd" });
  });

  test("an environment a command node launched reports there until a local coordinator contacts it", async () => {
    const local: Record<string, LocalCoordinatorContact> = { e1: { hasCoordinator: true } };
    const { mail } = leaf(["bk_cmd"], "bk_cmd", local);
    await mail.recordOrigin("e1", coordinatorOf("bk_cmd"));
    const route = () => mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "coordinator" });
    expect(await route()).toMatchObject({ controllerId: "bk_cmd" });
    local.e1 = { at: "2026-10-26T14:00:00.000Z", hasCoordinator: true };
    expect(await route()).toBeNull();
  });

  test("an origin recorded before contact times is older than any local contact", async () => {
    const { mail, store } = leaf(["bk_cmd"], "bk_cmd", {
      e1: { at: "2026-10-01T00:00:00.000Z", hasCoordinator: true },
    });
    store.state = { ...store.state, origins: { e1: coordinatorOf("bk_cmd") } };
    expect(
      await mail.route({ fromEnvironmentId: "e1", toEnvironmentId: "coordinator" }),
    ).toBeNull();
  });

  test("a reply goes back to the sender of the message it answers", async () => {
    const { mail, at } = leaf(["bk_cmd"], "bk_cmd", {
      worker: { at: "2026-10-26T13:20:00.000Z", hasCoordinator: true },
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
