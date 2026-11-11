import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { COORDINATOR_ACTION_MARK_LIMITS } from "@orkestrator/protocol/coordinator-action-marks";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { StoreApi } from "zustand/vanilla";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { dispatchResourceChange, requestResourceResync } from "@/lib/resource-sync";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  COORDINATOR_ACTION_MARK_RECLAIM_BATCH,
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
    stored(projectId = "p", conversationId = "c1") {
      return row(projectId, conversationId);
    },
  };
}

/** Past the resource feed's 50 ms coalescing window, as the other client-state suites wait. */
const hintDelivered = () => new Promise((resolve) => setTimeout(resolve, 70));
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise the test settles by hand, for answers that arrive out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
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

  test("a save and its recovery read both failing leave nothing unconfirmed behind", async () => {
    await store.getState().hydrate("p", "c1");
    // The node goes away: every command fails.
    backend.client.respond("set_coordinator_action_mark", () => {
      throw new Error("Node disconnected");
    });
    backend.client.respond("get_coordinator_action_marks", () => {
      throw new Error("Node disconnected");
    });
    await expect(store.getState().setMark("p", "c1", "toolu_1", true)).rejects.toThrow(
      "Node disconnected",
    );
    expect(entry()).toEqual({ cardIds: [], revision: 0, status: "ready" });

    // Back again, still at the same revision: a resync agrees, and marking
    // the card again really writes.
    const fresh = fakeBackend(NODE_A);
    backend.client.respond(
      "get_coordinator_action_marks",
      (args: Readonly<Record<string, unknown>>) =>
        fresh.client.invokeRaw("get_coordinator_action_marks", args),
    );
    backend.client.respond(
      "set_coordinator_action_mark",
      (args: Readonly<Record<string, unknown>>) =>
        fresh.client.invokeRaw("set_coordinator_action_mark", args),
    );
    requestResourceResync(scope);
    await settled();
    expect(entry()).toEqual({ cardIds: [], revision: 0, status: "ready" });
    await store.getState().setMark("p", "c1", "toolu_1", true);
    expect(fresh.stored()).toEqual({ revision: 1, cardIds: ["toolu_1"] });
    expect(entry()).toEqual({ cardIds: ["toolu_1"], revision: 1, status: "ready" });
  });

  test("answers arriving out of order keep the newest marks", async () => {
    await store.getState().hydrate("p", "c1");
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const answers = [first, second];
    backend.client.respond("set_coordinator_action_mark", () => answers.shift()!.promise);
    const marking = [
      store.getState().setMark("p", "c1", "a", true),
      store.getState().setMark("p", "c1", "b", true),
    ];
    expect(entry()?.cardIds).toEqual(["a", "b"]);

    // The backend applied a then b; b's answer (revision 2) comes back first.
    second.resolve({ projectId: "p", conversationId: "c1", revision: 2, cardIds: ["a", "b"] });
    await settled();
    expect(entry()).toEqual({ cardIds: ["a", "b"], revision: 2, status: "ready" });
    first.resolve({ projectId: "p", conversationId: "c1", revision: 1, cardIds: ["a"] });
    await Promise.all(marking);
    expect(entry()).toEqual({ cardIds: ["a", "b"], revision: 2, status: "ready" });
  });

  test("another client's change read during a save is kept", async () => {
    await store.getState().hydrate("p", "c1");
    const answer = deferred<unknown>();
    backend.client.respond("set_coordinator_action_mark", () => answer.promise);
    const marking = store.getState().setMark("p", "c1", "mine", true);

    // Another client marks a card while this save is out; its hint is read.
    backend.write("p", "c1", ["theirs"]);
    dispatchResourceChange(
      { resource: "coordinator-action-marks", id: "c1", projectId: "p", revision: 1 },
      scope,
    );
    await until(() => entry()?.revision === 1);
    expect(entry()?.cardIds).toEqual(["theirs", "mine"]);

    answer.resolve({
      projectId: "p",
      conversationId: "c1",
      revision: 2,
      cardIds: ["theirs", "mine"],
    });
    await marking;
    expect(entry()).toEqual({ cardIds: ["theirs", "mine"], revision: 2, status: "ready" });
  });

  test("overlapping saves: the one that fails is dropped, the other is kept", async () => {
    await store.getState().hydrate("p", "c1");
    const failing = deferred<unknown>();
    const passing = deferred<unknown>();
    backend.client.respond(
      "set_coordinator_action_mark",
      (args: Readonly<Record<string, unknown>>) =>
        args.cardId === "a" ? failing.promise : passing.promise,
    );
    const a = store.getState().setMark("p", "c1", "a", true);
    const b = store.getState().setMark("p", "c1", "b", true);
    failing.reject(new Error("Refused"));
    await expect(a).rejects.toThrow("Refused");
    // b is still out: it stays on screen, a does not.
    expect(entry()?.cardIds).toEqual(["b"]);
    passing.resolve({ projectId: "p", conversationId: "c1", revision: 1, cardIds: ["b"] });
    await b;
    expect(entry()).toEqual({ cardIds: ["b"], revision: 1, status: "ready" });
  });

  test("a full conversation clears marks the transcript made redundant, then marks", async () => {
    const limit = COORDINATOR_ACTION_MARK_LIMITS.marksPerConversation;
    const full = Array.from({ length: limit }, (_, index) => `card-${index}`);
    backend.write("p", "c1", full);
    // The fake refuses past the limit, as the backend does.
    backend.client.respond(
      "set_coordinator_action_mark",
      (args: Readonly<Record<string, unknown>>) => {
        const stored = backend.stored();
        if (
          args.done &&
          stored.cardIds.length >= limit &&
          !stored.cardIds.includes(String(args.cardId))
        )
          throw new Error("This conversation has too many actions marked done");
        const next = args.done
          ? [...stored.cardIds, String(args.cardId)]
          : stored.cardIds.filter((id) => id !== args.cardId);
        backend.write("p", "c1", next);
        return { projectId: "p", conversationId: "c1", ...backend.stored() };
      },
    );
    await store.getState().hydrate("p", "c1");

    // Without anything redundant nothing is cleared and the mark is refused.
    await expect(store.getState().setMark("p", "c1", "new", true)).rejects.toThrow(
      "too many actions",
    );
    expect(entry()?.cardIds).toHaveLength(limit);

    // Cards 3, 7 and 9 have since been finished by the transcript.
    await store
      .getState()
      .setMark("p", "c1", "new", true, ["card-9", "card-3", "card-7", "elsewhere"]);
    const stored = backend.stored().cardIds;
    expect(stored).toHaveLength(limit - 2);
    expect(stored).not.toContain("card-3");
    expect(stored).not.toContain("card-7");
    expect(stored).not.toContain("card-9");
    expect(stored.at(-1)).toBe("new");
    // Every mark that still shows something is kept.
    expect(stored).toContain("card-0");
    expect(entry()?.cardIds).toEqual(stored);
  });

  test("reclaiming clears at most one batch of redundant marks", async () => {
    const limit = COORDINATOR_ACTION_MARK_LIMITS.marksPerConversation;
    const full = Array.from({ length: limit }, (_, index) => `card-${index}`);
    backend.write("p", "c1", full);
    await store.getState().hydrate("p", "c1");
    await store.getState().setMark("p", "c1", "new", true, full);
    const cleared = backend.client
      .calls("set_coordinator_action_mark")
      .filter((call) => call.args.done === false)
      .map((call) => call.args.cardId);
    // Oldest first.
    expect(cleared).toEqual(full.slice(0, COORDINATOR_ACTION_MARK_RECLAIM_BATCH));
    expect(backend.stored().cardIds).toHaveLength(
      limit - COORDINATOR_ACTION_MARK_RECLAIM_BATCH + 1,
    );
  });
});
