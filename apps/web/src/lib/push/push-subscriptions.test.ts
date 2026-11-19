/**
 * The window's push routing for other nodes (design D10): a leaf scope's
 * client subscribes through the window's command scope with `nodeId`, hears
 * that stream's frames, and acts only on its own node's changes, beside the
 * command scope's own client.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  PUSH_CHANGED_EVENT,
  PUSH_STREAM_STATE_EVENT,
  type PushSetSubscriptionsArgs,
} from "@orkestrator/protocol/push-events";
import { ManualClock, flushMicrotasks } from "@orkestrator/protocol/testing/manual-clock";
import { WindowScope } from "@/lib/node-scope/window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { pushClientFor, pushRouteFor, setPushClientTimersForTests } from "./push-subscriptions";

const COMMAND = "bk_command" as BackendId;
const LEAF = "bk_leaf" as BackendId;
const STREAM = "stream-aaaaaaaaaaaaaaaa";
const TOPIC = "native-session";

function applied(args: Record<string, unknown>) {
  const set = args as unknown as PushSetSubscriptionsArgs;
  return {
    status: "applied",
    setRevision: set.setRevision,
    seqBase: 0,
    subscriptions: set.subscriptions.map((entry) => ({
      ...entry,
      status: "ok",
      generation: "g",
      revision: 1,
    })),
  };
}

let clock: ManualClock;
/** Runs the clients' due timers (the batched set send) and lets the answers settle. */
const settle = () => clock.advanceAsync(0);

let windowScope: WindowScope;
let commandClient: FakeNodeClient;
let leafClient: FakeNodeClient;
let command: NodeScope;
let leaf: NodeScope;

beforeEach(() => {
  clock = new ManualClock();
  setPushClientTimersForTests(clock);
  windowScope = new WindowScope();
  commandClient = new FakeNodeClient({
    nodeId: COMMAND,
    invoke: { push_set_subscriptions: applied },
  });
  leafClient = new FakeNodeClient({ nodeId: LEAF, invoke: { push_set_subscriptions: applied } });
  command = windowScope.open({ role: "command", client: commandClient });
  leaf = windowScope.open({ role: "leaf", client: leafClient });
});

afterEach(() => {
  windowScope.dispose();
  setPushClientTimersForTests(undefined);
});

describe("push routing for another node", () => {
  test("a leaf scope rides the command scope's stream with its node id", () => {
    expect(pushRouteFor(command)).toEqual({ stream: command });
    expect(pushRouteFor(leaf)).toEqual({ stream: command, nodeId: LEAF });
    const lone = new WindowScope();
    try {
      const orphan = lone.open({ role: "leaf", client: new FakeNodeClient({ nodeId: LEAF }) });
      expect(pushRouteFor(orphan)).toEqual({ stream: orphan });
    } finally {
      lone.dispose();
    }
  });

  test("subscribes through the command node and acts only on its node's changes", async () => {
    const heardOnLeaf: string[] = [];
    const heardOnCommand: string[] = [];
    pushClientFor(leaf).subscribe(TOPIC, "env/claude/tab", (change) =>
      heardOnLeaf.push(change.reason),
    );
    pushClientFor(command).subscribe(TOPIC, "env/claude/tab", (change) =>
      heardOnCommand.push(change.reason),
    );
    // The listeners attach once `listenInScope` resolves.
    await flushMicrotasks();
    commandClient.emit(PUSH_STREAM_STATE_EVENT, {
      state: "connected",
      offer: { versions: [1], streamId: STREAM, nodes: true },
    });
    await settle();

    const sets = commandClient.calls("push_set_subscriptions").map((call) => call.args);
    expect(sets).toContainEqual({
      streamId: STREAM,
      setRevision: 1,
      subscriptions: [{ topic: TOPIC, key: "env/claude/tab" }],
      nodeId: LEAF,
    });
    expect(sets).toContainEqual({
      streamId: STREAM,
      setRevision: 1,
      subscriptions: [{ topic: TOPIC, key: "env/claude/tab" }],
    });
    // Nothing goes to the leaf itself.
    expect(leafClient.calls("push_set_subscriptions")).toEqual([]);
    expect(pushClientFor(leaf).isHealthy(TOPIC, "env/claude/tab")).toBe(true);
    expect(heardOnLeaf).toEqual(["subscribed"]);
    expect(heardOnCommand).toEqual(["subscribed"]);

    commandClient.emit(PUSH_CHANGED_EVENT, {
      seq: 1,
      changes: [
        {
          topic: TOPIC,
          key: "env/claude/tab",
          generation: "g",
          revision: 2,
          parts: [],
          nodeId: LEAF,
        },
      ],
    });
    expect(heardOnLeaf).toEqual(["subscribed", "frame"]);
    expect(heardOnCommand).toEqual(["subscribed"]);
    // A frame on the leaf's own stream is not this client's.
    leafClient.emit(PUSH_CHANGED_EVENT, {
      seq: 2,
      changes: [{ topic: TOPIC, key: "env/claude/tab", generation: "g", revision: 3, parts: [] }],
    });
    expect(heardOnLeaf).toEqual(["subscribed", "frame"]);
  });

  test("a command node that does not offer nodes leaves the leaf's keys polling", async () => {
    pushClientFor(leaf).subscribe(TOPIC, "env/claude/tab", () => undefined);
    // The listeners attach once `listenInScope` resolves.
    await flushMicrotasks();
    commandClient.emit(PUSH_STREAM_STATE_EVENT, {
      state: "connected",
      offer: { versions: [1], streamId: STREAM },
    });
    await settle();
    expect(pushClientFor(leaf).state()).toBe("unavailable");
    expect(commandClient.calls("push_set_subscriptions")).toEqual([]);
  });
});
