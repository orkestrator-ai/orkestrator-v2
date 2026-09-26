import { describe, expect, test } from "bun:test";
import {
  createNativeObservationEvents,
  nativeObservationInvalidationMatches,
  type NativeObservationInvalidation,
} from "./native-observation-events";

function harness() {
  let handler: ((event: { payload: unknown }) => unknown) | undefined;
  let listens = 0;
  let unlistens = 0;
  const events = createNativeObservationEvents(async (event, next) => {
    expect(event).toBe("native-agent-session-activity");
    listens += 1;
    handler = next as (event: { payload: unknown }) => unknown;
    return () => {
      unlistens += 1;
    };
  });
  const received: NativeObservationInvalidation[] = [];
  return {
    events,
    received,
    subscribe: () => events.subscribe((invalidation) => received.push(invalidation)),
    emit: (payload: unknown) => handler?.({ payload }),
    listens: () => listens,
    unlistens: () => unlistens,
  };
}

const stamped = (revision: number, generation = "observer-1") => ({
  environment_id: "env-1",
  agent: "pi",
  logical_session_key: "env-env-1:tab-1",
  state: "working",
  generation,
  revision,
});

describe("native observation invalidations", () => {
  test("one transport listener serves every subscriber", async () => {
    const h = harness();
    h.subscribe();
    h.subscribe();
    h.events.subscribe(() => undefined);
    await Promise.resolve();
    expect(h.listens()).toBe(1);
    h.emit(stamped(1));
    expect(h.received).toHaveLength(2);
    h.events.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.unlistens()).toBe(1);
  });

  test("names one session, or a whole environment for an older backend", async () => {
    const h = harness();
    h.subscribe();
    await Promise.resolve();
    h.emit(stamped(1));
    h.emit({ environment_id: "env-2", state: "idle" });
    expect(h.received).toEqual([
      {
        kind: "session",
        environmentId: "env-1",
        agent: "pi",
        logicalSessionKey: "env-env-1:tab-1",
      },
      { kind: "session", environmentId: "env-2" },
    ]);
  });

  test("a gap or a new observer lifetime invalidates every view; duplicates are ignored", async () => {
    const h = harness();
    h.subscribe();
    await Promise.resolve();
    h.emit(stamped(4));
    h.emit(stamped(5));
    h.emit(stamped(5));
    h.emit(stamped(3));
    h.emit(stamped(7));
    h.emit(stamped(1, "observer-2"));
    expect(h.received.map((invalidation) => invalidation.kind)).toEqual([
      "session",
      "session",
      "all",
      "all",
    ]);
    expect(h.received.slice(2)).toEqual([
      { kind: "all", reason: "gap" },
      { kind: "all", reason: "reset" },
    ]);
    expect(h.events.lastStamp()).toEqual({ generation: "observer-2", revision: 1 });
  });

  test("malformed announcements are dropped, never widened", async () => {
    const h = harness();
    h.subscribe();
    await Promise.resolve();
    h.emit(null);
    h.emit({ state: "idle" });
    h.emit({ environment_id: "env-1", state: "idle", generation: "observer-1" });
    expect(h.received).toEqual([]);
  });

  test("a throwing subscriber does not starve the others", async () => {
    const h = harness();
    const error = console.error;
    console.error = () => undefined;
    try {
      h.events.subscribe(() => {
        throw new Error("boom");
      });
      h.subscribe();
      await Promise.resolve();
      h.emit(stamped(1));
      expect(h.received).toHaveLength(1);
    } finally {
      console.error = error;
    }
  });

  test("matches views by environment, agent and logical session", () => {
    const view = { environmentId: "env-1", agent: "pi", logicalSessionKey: "env-env-1:tab-1" };
    expect(nativeObservationInvalidationMatches({ kind: "all", reason: "gap" }, view)).toBe(true);
    expect(
      nativeObservationInvalidationMatches({ kind: "session", environmentId: "env-1" }, view),
    ).toBe(true);
    expect(
      nativeObservationInvalidationMatches(
        {
          kind: "session",
          environmentId: "env-1",
          agent: "pi",
          logicalSessionKey: "env-env-1:tab-1",
        },
        view,
      ),
    ).toBe(true);
    for (const invalidation of [
      { kind: "session", environmentId: "env-2" },
      { kind: "session", environmentId: "env-1", agent: "codex" },
      {
        kind: "session",
        environmentId: "env-1",
        agent: "pi",
        logicalSessionKey: "env-env-1:tab-2",
      },
    ] as NativeObservationInvalidation[]) {
      expect(nativeObservationInvalidationMatches(invalidation, view)).toBe(false);
    }
  });
});
