import { describe, expect, test } from "bun:test";
import { NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS } from "@orkestrator/protocol/native-agent-observation";
import { BUILD_PIPELINE_AGENTS } from "@orkestrator/protocol/build-pipeline";
import {
  MAX_OBSERVATION_RECORDS,
  NATIVE_AGENT_OBSERVATION_CAPABILITIES,
  NativeAgentObservationBroker,
  OBSERVATION_FRESHNESS_MS,
  STABLE_IDLE_BACKOFF_MS,
  STABLE_IDLE_READS_BEFORE_BACKOFF,
  nativeAgentObservationGroupKey,
  observationSatisfies,
} from "./native-agent-observation.js";

const GROUP = nativeAgentObservationGroupKey("env-1", "opencode");

function broker(start = 1_000) {
  let clock = start;
  const instance = new NativeAgentObservationBroker(() => clock, { generation: "gen-a" });
  return {
    instance,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("NativeAgentObservationBroker", () => {
  test("records bounded, content-free observations with age and freshness", () => {
    const { instance, advance } = broker();
    const ticket = instance.beginRead(GROUP, ["session-1"]);
    instance.record(ticket, {
      sessionKey: "session-1",
      providerSessionId: "provider-1",
      activity: "waiting",
    });

    const view = instance.view("session-1", "provider-1");
    expect(view.freshness).toBe("fresh");
    expect(view.postDispatch).toBe(true);
    expect(view.record).toEqual({
      sessionKey: "session-1",
      groupKey: GROUP,
      providerSessionId: "provider-1",
      generation: 0,
      observedAt: 1_000,
      activity: "waiting",
      pendingInteraction: true,
      dispatchSequence: 0,
      source: "provider",
    });
    // Only identities and states: no transcript, prompt or provider payload.
    expect(Object.keys(view.record!).sort()).toEqual(
      [
        "activity",
        "dispatchSequence",
        "generation",
        "groupKey",
        "observedAt",
        "pendingInteraction",
        "providerSessionId",
        "sessionKey",
        "source",
      ].sort(),
    );

    advance(OBSERVATION_FRESHNESS_MS + 1);
    expect(instance.view("session-1", "provider-1").freshness).toBe("stale");
    // A rotated provider session is a different conversation: unknown.
    expect(instance.view("session-1", "provider-2")).toEqual({
      freshness: "unknown",
      postDispatch: false,
    });
  });

  test("refuses results read before, or while, a dispatch was in flight", () => {
    const { instance } = broker();
    const before = instance.beginRead(GROUP, ["session-1", "session-2"]);
    const release = instance.beginDispatch("session-1", GROUP);
    const during = instance.beginRead(GROUP, ["session-1"]);
    expect(instance.accepts(before, "session-1")).toBe(false);
    // The sibling had no dispatch: its answer is still good.
    expect(instance.accepts(before, "session-2")).toBe(true);
    expect(instance.accepts(during, "session-1")).toBe(false);

    release();
    release(); // idempotent
    expect(instance.accepts(during, "session-1")).toBe(false);
    const after = instance.beginRead(GROUP, ["session-1"]);
    expect(instance.accepts(after, "session-1")).toBe(true);
    expect(instance.status().fencedResults).toBe(3);
  });

  test("a dispatch-recorded working is never post-dispatch evidence", () => {
    const { instance } = broker();
    const release = instance.beginDispatch("session-1", GROUP);
    instance.recordDispatchAccepted({
      sessionKey: "session-1",
      groupKey: GROUP,
      providerSessionId: "provider-1",
    });
    release();
    const view = instance.view("session-1", "provider-1");
    expect(view.record?.activity).toBe("working");
    expect(view.postDispatch).toBe(false);
    expect(observationSatisfies(view, { requirePostDispatch: true })).toBe(false);
    expect(observationSatisfies(view)).toBe(true);
  });

  test("a replaced provider generation fences every late result", () => {
    const { instance } = broker();
    const ticket = instance.beginRead(GROUP, ["session-1"]);
    instance.replaceGroupGeneration(GROUP);
    expect(instance.accepts(ticket, "session-1")).toBe(false);
    expect(instance.status().generationFencedResults).toBe(1);
    const rebased = instance.withCurrentGeneration(ticket);
    expect(instance.accepts(rebased, "session-1")).toBe(true);
  });

  test("only a qualified, settled-idle group backs off, and any wake makes it due", () => {
    const { instance, advance } = broker();
    for (let read = 0; read < 10; read += 1) {
      instance.noteGroupObserved(GROUP, { settledIdle: true, wakeupQualified: false });
      expect(instance.isGroupDue(GROUP)).toBe(true);
    }
    for (let read = 0; read < 10; read += 1) {
      instance.noteGroupObserved(GROUP, { settledIdle: false, wakeupQualified: true });
      expect(instance.isGroupDue(GROUP)).toBe(true);
    }
    for (let read = 1; read < STABLE_IDLE_READS_BEFORE_BACKOFF; read += 1) {
      instance.noteGroupObserved(GROUP, { settledIdle: true, wakeupQualified: true });
      expect(instance.isGroupDue(GROUP)).toBe(true);
    }
    instance.noteGroupObserved(GROUP, { settledIdle: true, wakeupQualified: true });
    expect(instance.isGroupDue(GROUP)).toBe(false);
    advance(STABLE_IDLE_BACKOFF_MS[0]!);
    expect(instance.isGroupDue(GROUP)).toBe(true);
    // The ladder is capped.
    for (let read = 0; read < 10; read += 1) {
      instance.noteGroupObserved(GROUP, { settledIdle: true, wakeupQualified: true });
    }
    advance(STABLE_IDLE_BACKOFF_MS.at(-1)! - 1);
    expect(instance.isGroupDue(GROUP)).toBe(false);
    advance(1);
    expect(instance.isGroupDue(GROUP)).toBe(true);

    for (const wake of [
      () => instance.wakeGroup(GROUP, "provider-event"),
      () => instance.wakeEnvironment("env-1", "session-mutation"),
      () => instance.wakeEnvironment("env-1", "session-mutation", "opencode"),
      () => instance.beginDispatch("session-1", GROUP)(),
      () => instance.replaceGroupGeneration(GROUP),
    ]) {
      for (let read = 0; read < STABLE_IDLE_READS_BEFORE_BACKOFF; read += 1) {
        instance.noteGroupObserved(GROUP, { settledIdle: true, wakeupQualified: true });
      }
      expect(instance.isGroupDue(GROUP)).toBe(false);
      wake();
      expect(instance.isGroupDue(GROUP)).toBe(true);
    }
    // A different agent's wake leaves this group alone.
    for (let read = 0; read < STABLE_IDLE_READS_BEFORE_BACKOFF; read += 1) {
      instance.noteGroupObserved(GROUP, { settledIdle: true, wakeupQualified: true });
    }
    instance.wakeEnvironment("env-1", "session-mutation", "codex");
    expect(instance.isGroupDue(GROUP)).toBe(false);
  });

  test("a failed group reads as recovering, never as a fresh answer", () => {
    const { instance } = broker();
    const ticket = instance.beginRead(GROUP, ["session-1"]);
    instance.record(ticket, {
      sessionKey: "session-1",
      providerSessionId: "provider-1",
      activity: "idle",
    });
    instance.noteGroupFailed(GROUP);
    const view = instance.view("session-1", "provider-1");
    expect(view.freshness).toBe("recovering");
    expect(observationSatisfies(view, { maxAgeMs: 60_000 })).toBe(false);
    instance.noteGroupObserved(GROUP, { settledIdle: true, wakeupQualified: false });
    expect(instance.view("session-1", "provider-1").freshness).toBe("fresh");
  });

  test("stamps are contiguous within one observer lifetime", () => {
    const { instance } = broker();
    expect(instance.stamp()).toEqual({ generation: "gen-a", revision: 0 });
    expect(instance.nextStamp()).toEqual({ generation: "gen-a", revision: 1 });
    expect(instance.nextStamp()).toEqual({ generation: "gen-a", revision: 2 });
    expect(instance.stamp()).toEqual({ generation: "gen-a", revision: 2 });
    expect(new NativeAgentObservationBroker(() => 0).generation).not.toBe("gen-a");
  });

  test("records and fences stay bounded and prune with their sessions", () => {
    const { instance } = broker();
    const ticket = instance.beginRead(GROUP, []);
    for (let index = 0; index < MAX_OBSERVATION_RECORDS + 10; index += 1) {
      instance.record(ticket, {
        sessionKey: `session-${index}`,
        providerSessionId: `provider-${index}`,
        activity: "idle",
      });
    }
    expect(instance.status().records).toBe(MAX_OBSERVATION_RECORDS);
    expect(instance.view("session-0").freshness).toBe("unknown");

    instance.beginDispatch("session-live", GROUP)();
    instance.retainSessions(new Map([["session-10", "provider-10"]]));
    expect(instance.status().records).toBe(1);
    expect(instance.status().dispatchFences).toBe(0);
    instance.retainGroups(new Set());
    expect(instance.status().groups).toBe(0);
  });
});

describe("observation capability matrix", () => {
  test("covers every native provider and drives policy from two columns only", () => {
    expect(Object.keys(NATIVE_AGENT_OBSERVATION_CAPABILITIES).sort()).toEqual(
      [...BUILD_PIPELINE_AGENTS].sort(),
    );
    for (const [agent, capabilities] of Object.entries(NATIVE_AGENT_OBSERVATION_CAPABILITIES)) {
      expect(capabilities.noTouchActivity).toBe(true);
      // Idle backoff requires a backend-held push path for external starts.
      if (capabilities.idleBackoffWakeup !== null) {
        expect(capabilities.backendTurnEvents).toBe(true);
      }
      expect(capabilities.quietClientBackoff).toBe(
        (NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS as readonly string[]).includes(agent),
      );
    }
    // Only OpenCode's backend-held event stream qualifies idle backoff today.
    expect(
      Object.entries(NATIVE_AGENT_OBSERVATION_CAPABILITIES)
        .filter(([, capabilities]) => capabilities.idleBackoffWakeup !== null)
        .map(([agent]) => agent),
    ).toEqual(["opencode"]);
    // Providers whose idle views change without a transition stay unqualified.
    expect(NATIVE_AGENT_OBSERVATION_CAPABILITIES.claude.quietClientBackoff).toBe(false);
    expect(NATIVE_AGENT_OBSERVATION_CAPABILITIES.codex.quietClientBackoff).toBe(false);
  });
});
