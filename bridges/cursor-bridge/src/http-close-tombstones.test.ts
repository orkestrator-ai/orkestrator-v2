/**
 * INC-02: a close a previous bridge process recorded but never published.
 *
 * The tombstone is finished at startup, shared by every caller that needs it
 * finished, and always before the same conversation can be adopted again — so
 * its "cancel every surviving run" step can never reach a run the new owner
 * started.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { useCursorAgentForTests } from "./agent-session.js";
import { loadPersistedState } from "./persistence.js";
import { finishRestoredTombstones } from "./session-close.js";
import { closingTombstones, sessions } from "./state.js";
import { fakeAgent } from "./testing/fake-agent.js";
import {
  defaultPolicy,
  deferred,
  holdPublication,
  startRouterHarness,
  stubAttach,
  waitFor,
  type RouterHarness,
} from "./testing/router-harness.js";

let harness: RouterHarness;

beforeEach(async () => {
  harness = await startRouterHarness();
});

afterEach(async () => {
  await harness.close();
});

/** Restart into a state file whose only record is an unfinished close. */
async function restartWithTombstones(
  tombstones: Array<{ id: string; agentId?: string }>,
): Promise<void> {
  await writeFile(
    harness.stateFile,
    JSON.stringify({
      version: 1,
      provider: "cursor",
      closing: tombstones.map((tombstone) => ({ ...tombstone, since: 1 })),
      sessions: [],
    }),
  );
  await loadPersistedState();
}

interface SurvivingRun {
  id: string;
  readonly status: string;
  readonly cancels: number;
}

/** A provider run still executing after the process that owned it died. */
function survivingRun(id: string): SurvivingRun {
  let status = "running";
  let cancels = 0;
  return {
    id,
    createdAt: 1,
    get status() {
      return status;
    },
    get cancels() {
      return cancels;
    },
    supports: () => false,
    unsupportedReason: () => undefined,
    cancel: async () => {
      cancels += 1;
      status = "cancelled";
    },
    onDidChangeStatus: () => () => undefined,
  } as unknown as SurvivingRun;
}

function useRuns(
  list: (agentId: string) => Promise<{ items: unknown[] }>,
  resume?: () => Promise<unknown>,
): () => void {
  return useCursorAgentForTests({
    listRuns: list,
    resume: resume ?? (async () => fakeAgent()),
    create: async () => {
      throw new Error("this test does not create agents");
    },
  } as unknown as Parameters<typeof useCursorAgentForTests>[0]);
}

describe("restored closes", () => {
  test("startup finishes them: a surviving run is cancelled and the removal published", async () => {
    await restartWithTombstones([{ id: "closing-1", agentId: "agent-x" }, { id: "closing-2" }]);
    const run = survivingRun("run-old");
    const listed: string[] = [];
    const restore = useRuns(async (agentId) => {
      listed.push(agentId);
      return { items: [run] };
    });
    try {
      expect(await finishRestoredTombstones()).toEqual({ closed: 2, pending: 0, failed: 0 });
      expect(listed).toEqual(["agent-x"]);
      expect(run.cancels).toBe(1);
      expect(closingTombstones.size).toBe(0);
      const file = (await harness.readPublished()) as { closing?: unknown[] };
      expect(file.closing ?? []).toEqual([]);
      // A retried close from the backend is answered in band.
      expect(
        await (await harness.call("/session/closing-1/close", { method: "POST" })).json(),
      ).toEqual({ closed: true, missing: true });
    } finally {
      restore();
    }
  });

  test("a resume of the same conversation waits for the close, which never cancels its run", async () => {
    await restartWithTombstones([{ id: "closing-1", agentId: "agent-x" }]);
    const old = survivingRun("run-old");
    const runs: SurvivingRun[] = [old];
    const restoreAttach = stubAttach({ resume: async () => fakeAgent() });
    const restoreRuns = useRuns(async () => ({ items: runs.slice() }));
    try {
      // No close request and no startup sweep has reached the tombstone yet:
      // the resume itself has to finish it before adopting anything.
      const resumed = await harness.call("/session/resume", {
        method: "POST",
        body: JSON.stringify({ sessionId: "agent-x", policy: defaultPolicy }),
      });
      expect(resumed.status).toBe(201);
      // The closed session's run was stopped before the adoption, so it was
      // not recovered into the new session.
      expect(old.cancels).toBe(1);
      expect(closingTombstones.has("closing-1")).toBe(false);
      const { sessionId } = (await resumed.json()) as { sessionId: string };
      expect(sessions.get(sessionId)?.activeRun).toBeUndefined();

      // The resumed conversation starts a run of its own. Nothing left over
      // from the old close may reach it.
      const fresh = survivingRun("run-new");
      runs.push(fresh);
      await finishRestoredTombstones();
      await harness.call("/session/closing-1/close", { method: "POST" });
      await harness.call("/session/closing-1", { method: "DELETE" });
      expect(fresh.cancels).toBe(0);
    } finally {
      restoreRuns();
      restoreAttach();
    }
  });

  test("concurrent closes of one tombstone share one finish, and a failed publication fails both", async () => {
    await restartWithTombstones([{ id: "closing-1", agentId: "agent-x" }]);
    const listing = deferred<{ items: unknown[] }>();
    let lists = 0;
    const restore = useRuns(async () => {
      lists += 1;
      return listing.promise;
    });
    const hold = holdPublication();
    try {
      const first = harness.call("/session/closing-1", { method: "DELETE" });
      await waitFor(() => lists === 1);
      const second = harness.call("/session/closing-1/close", { method: "POST" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The second request joined; it did not start its own lookup.
      expect(lists).toBe(1);

      hold.failWith(new Error("disk full"));
      hold.release();
      listing.resolve({ items: [] });
      const [a, b] = await Promise.all([first, second]);
      // Neither was told "closed" while the file still held the tombstone.
      expect(a.status).toBe(503);
      expect(b.status).toBe(503);
      expect(await b.json()).toMatchObject({ kind: "persistence-unavailable" });
      expect(closingTombstones.has("closing-1")).toBe(true);

      hold.failWith(undefined);
      const [c, d] = await Promise.all([
        harness.call("/session/closing-1", { method: "DELETE" }),
        harness.call("/session/closing-1/close", { method: "POST" }),
      ]);
      expect(c.status).toBe(200);
      expect(d.status).toBe(200);
      expect(closingTombstones.has("closing-1")).toBe(false);
      const file = (await harness.readPublished()) as { closing?: unknown[] };
      expect(file.closing ?? []).toEqual([]);
    } finally {
      hold.restore();
      restore();
    }
  });
});
