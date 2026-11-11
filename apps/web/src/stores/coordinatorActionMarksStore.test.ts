import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { StoreApi } from "zustand/vanilla";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { dispatchResourceChange, requestResourceResync } from "@/lib/resource-sync";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  coordinatorActionMarksKey,
  coordinatorActionMarksStore,
  type CoordinatorActionMarksState,
} from "./coordinatorActionMarksStore";

const NODE_A = "bk_action-marks-a" as BackendId;
const NODE_B = "bk_action-marks-b" as BackendId;

/** A backend's marks, per `project\0conversation`, answering both commands. */
function fakeBackend(nodeId: BackendId) {
  const rows = new Map<string, { revision: number; cardIds: string[] }>();
  let refuse: string | null = null;
  const row = (projectId: string, conversationId: string) =>
    rows.get(coordinatorActionMarksKey(projectId, conversationId)) ?? { revision: 0, cardIds: [] };
  const answer = (projectId: string, conversationId: string) => ({
    projectId,
    conversationId,
    ...row(projectId, conversationId),
  });
  const client = new FakeNodeClient({
    nodeId,
    invoke: {
      get_coordinator_action_marks: (args: Readonly<Record<string, unknown>>) =>
        answer(String(args.projectId), String(args.conversationId)),
      set_coordinator_action_mark: (args: Readonly<Record<string, unknown>>) => {
        if (refuse) throw new Error(refuse);
        const projectId = String(args.projectId);
        const conversationId = String(args.conversationId);
        const current = row(projectId, conversationId);
        const cardId = String(args.cardId);
        const has = current.cardIds.includes(cardId);
        if (has !== args.done) {
          rows.set(coordinatorActionMarksKey(projectId, conversationId), {
            revision: current.revision + 1,
            cardIds: args.done
              ? [...current.cardIds, cardId]
              : current.cardIds.filter((id) => id !== cardId),
          });
        }
        return answer(projectId, conversationId);
      },
    },
  });
  return {
    client,
    /** Another client's change, written straight into the backend. */
    write(projectId: string, conversationId: string, cardIds: string[]) {
      const current = row(projectId, conversationId);
      rows.set(coordinatorActionMarksKey(projectId, conversationId), {
        revision: current.revision + 1,
        cardIds,
      });
    },
    refuseWrites(message: string | null) {
      refuse = message;
    },
  };
}

/** Past the resource feed's 50 ms coalescing window, as the other client-state suites wait. */
const hintDelivered = () => new Promise((resolve) => setTimeout(resolve, 70));
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Waits for an observable change rather than for a fixed time. */
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

let windowScope: WindowScope;
let backend: ReturnType<typeof fakeBackend>;
let scope: NodeScope;
let store: StoreApi<CoordinatorActionMarksState>;
const entry = (conversationId = "c1", projectId = "p") =>
  store.getState().entries[coordinatorActionMarksKey(projectId, conversationId)];

beforeEach(() => {
  windowScope = new WindowScope();
  backend = fakeBackend(NODE_A);
  scope = windowScope.open({ role: "command", client: backend.client });
  store = scope.store(coordinatorActionMarksStore);
});

afterEach(() => {
  windowScope.dispose();
});

describe("coordinatorActionMarksStore", () => {
  test("reads a conversation's stored marks once per mount burst", async () => {
    backend.write("p", "c1", ["toolu_1"]);
    await Promise.all([store.getState().hydrate("p", "c1"), store.getState().hydrate("p", "c1")]);
    expect(entry()).toEqual({ cardIds: ["toolu_1"], revision: 1, status: "ready" });
    expect(backend.client.calls("get_coordinator_action_marks")).toHaveLength(1);
    expect(entry("c2")).toBeUndefined();
  });

  test("a mark applies at once, is saved, and the answer's revision is kept", async () => {
    await store.getState().hydrate("p", "c1");
    const saving = store.getState().setMark("p", "c1", "toolu_1", true);
    expect(entry()?.cardIds).toEqual(["toolu_1"]);
    await saving;
    expect(entry()).toEqual({ cardIds: ["toolu_1"], revision: 1, status: "ready" });
    expect(backend.client.calls("set_coordinator_action_mark").at(-1)?.args).toEqual({
      projectId: "p",
      conversationId: "c1",
      cardId: "toolu_1",
      done: true,
    });

    await store.getState().setMark("p", "c1", "toolu_1", false);
    expect(entry()).toEqual({ cardIds: [], revision: 2, status: "ready" });
  });

  test("a refused mark is undone from what the backend holds and rejects", async () => {
    await store.getState().hydrate("p", "c1");
    backend.refuseWrites("This conversation has too many actions marked done");
    await expect(store.getState().setMark("p", "c1", "toolu_1", true)).rejects.toThrow(
      "too many actions",
    );
    expect(entry()).toEqual({ cardIds: [], revision: 0, status: "ready" });
  });

  test("another client's change arrives through its hint and through a resync", async () => {
    await store.getState().hydrate("p", "c1");
    backend.write("p", "c1", ["from-elsewhere"]);
    dispatchResourceChange(
      { resource: "coordinator-action-marks", id: "c1", projectId: "p", revision: 5 },
      scope,
    );
    await hintDelivered();
    expect(entry()?.cardIds).toEqual(["from-elsewhere"]);

    // A hint for a conversation this store never read reads nothing: sent
    // first, it is delivered before the next hint for c1, whose answer is awaited.
    backend.write("p", "c1", ["second"]);
    dispatchResourceChange(
      { resource: "coordinator-action-marks", id: "c9", projectId: "p", revision: 6 },
      scope,
    );
    dispatchResourceChange(
      { resource: "coordinator-action-marks", id: "c1", projectId: "p", revision: 7 },
      scope,
    );
    await until(() => entry()?.cardIds[0] === "second");
    expect(
      backend.client
        .calls("get_coordinator_action_marks")
        .some((call) => call.args.conversationId === "c9"),
    ).toBe(false);

    backend.write("p", "c1", ["after-gap"]);
    requestResourceResync(scope);
    await settled();
    expect(entry()?.cardIds).toEqual(["after-gap"]);
  });

  test("an older backend without the commands leaves marks unavailable", async () => {
    const older = new FakeNodeClient({ nodeId: NODE_B });
    const olderStore = windowScope
      .open({ role: "leaf", client: older })
      .store(coordinatorActionMarksStore);
    await olderStore.getState().hydrate("p", "c1");
    expect(olderStore.getState().entries[coordinatorActionMarksKey("p", "c1")]?.status).toBe(
      "unavailable",
    );
    await expect(olderStore.getState().setMark("p", "c1", "x", true)).rejects.toThrow(
      "not available",
    );
  });

  test("two nodes keep separate marks", async () => {
    const other = fakeBackend(NODE_B);
    const otherStore = windowScope
      .open({ role: "leaf", client: other.client })
      .store(coordinatorActionMarksStore);
    backend.write("p", "c1", ["on-a"]);
    other.write("p", "c1", ["on-b"]);
    await store.getState().hydrate("p", "c1");
    await otherStore.getState().hydrate("p", "c1");
    expect(entry()?.cardIds).toEqual(["on-a"]);
    expect(otherStore.getState().entries[coordinatorActionMarksKey("p", "c1")]?.cardIds).toEqual([
      "on-b",
    ]);
  });
});
