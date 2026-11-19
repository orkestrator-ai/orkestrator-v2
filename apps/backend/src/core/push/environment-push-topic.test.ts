import { describe, expect, test } from "bun:test";
import type {
  AgentPendingInteractionSummary,
  AgentRegistryEntry,
  AgentRegistrySnapshot,
} from "@orkestrator/protocol/agent-registry";
import { summarizeAgentRegistry } from "@orkestrator/protocol/agent-registry";
import { CONTAINER_LIFECYCLE_EVENT } from "@orkestrator/protocol/container-lifecycle";
import { NATIVE_AGENT_ACTIVITY_EVENT } from "@orkestrator/protocol/native-agent-observation";
import {
  ENVIRONMENT_PUSH_TOPIC,
  NATIVE_SESSION_PUSH_TOPIC,
  PUSH_CHANGED_EVENT,
  PUSH_KEY_THROTTLE_MS,
  type PushChangedPayload,
  type PushStamp,
} from "@orkestrator/protocol/push-events";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { ManualClock, flushMicrotasks } from "@orkestrator/protocol/testing/manual-clock";
import {
  ENVIRONMENT_OBSERVE_COALESCE_MS,
  ENVIRONMENT_OBSERVE_ERROR_MS,
  ENVIRONMENT_OBSERVE_PARTIAL_LADDER_MS,
  ENVIRONMENT_OBSERVE_PENDING_MS,
  EnvironmentPushTopic,
} from "./environment-push-topic.js";
import { BackendPush } from "./index.js";
import { PushHub, type PushResolveAnswer, type PushTopicProvider } from "./push-hub.js";

interface EnvironmentModel {
  record: Record<string, unknown> | null;
  tabs: Array<{ tabId: string; state: AgentRegistryEntry["state"]; pending?: boolean }>;
  pendingLabel: string;
  failNext: boolean;
}

function registryFor(environmentId: string, model: EnvironmentModel): AgentRegistrySnapshot {
  const entries: AgentRegistryEntry[] = model.tabs.map((tab, index) => ({
    projectId: "p1",
    environmentId,
    environmentName: "feature",
    tabId: tab.tabId,
    ownerKind: "environment",
    kind: "native",
    agent: "claude",
    displayName: tab.tabId,
    tabOrdinal: index + 1,
    state: tab.state,
    ...(tab.pending
      ? {
          pending: {
            interactionId: `${tab.tabId}-request`,
            kind: "command-approval",
            label: model.pendingLabel,
            since: 1_000,
            count: 1,
          } satisfies AgentPendingInteractionSummary,
        }
      : {}),
  }));
  return { generatedAt: "now", entries, environments: summarizeAgentRegistry(entries) };
}

function harness(model?: Partial<EnvironmentModel>) {
  const clock = new ManualClock();
  const state: EnvironmentModel = {
    record: { id: "env-1", status: "running", containerId: "c1", hasUnreadWork: false },
    tabs: [{ tabId: "tab-1", state: "idle" }],
    pendingLabel: "Needs approval",
    failNext: false,
    ...model,
  };
  const reads = { record: 0, registry: 0 };
  const published: Array<{ key: string; stamp: PushStamp; parts: readonly string[] }> = [];
  const topic = new EnvironmentPushTopic({
    timers: clock,
    now: () => clock.now(),
    readEnvironment: async (environmentId) => {
      reads.record += 1;
      if (state.failNext) {
        state.failNext = false;
        throw new Error("storage is busy");
      }
      return environmentId === "env-1" ? state.record : null;
    },
    readRegistry: async (environmentId) => {
      reads.registry += 1;
      return registryFor(environmentId, state);
    },
    publish: (key, stamp, parts) => published.push({ key, stamp, parts }),
  });
  const advance = async (ms: number) => {
    await clock.advanceAsync(ms);
    await flushMicrotasks();
  };
  const retained = async () => {
    topic.retain("env-1");
    await advance(0);
  };
  return { clock, topic, state, reads, published, advance, retained };
}

const environmentChanged = (id = "env-1") => ({
  resource: "environment",
  id,
  revision: 1,
});

describe("EnvironmentPushTopic", () => {
  test("keys are environment ids", () => {
    const { topic } = harness();
    expect(topic.validKey("env-1")).toBe(true);
    expect(topic.validKey("1f0c7e0a-2b8a-4c55-9d1f-0a0b0c0d0e0f")).toBe(true);
    expect(topic.validKey("")).toBe(false);
    expect(topic.validKey("env/1")).toBe(false);
    expect(topic.validKey("x".repeat(129))).toBe(false);
  });

  test("the first read publishes every part; resolve answers its stamp", async () => {
    const h = harness();
    await h.retained();
    expect(h.published).toHaveLength(1);
    expect([...h.published[0]!.parts].sort()).toEqual(["attention", "lifecycle", "sessions"]);
    expect(await h.topic.resolve("env-1")).toMatchObject({ status: "ok", revision: 1 });
    h.topic.dispose();
  });

  test("a missing environment is answered missing, like get_environment", async () => {
    const h = harness();
    expect(await h.topic.resolve("env-2")).toEqual({ status: "missing" });
    expect(await h.topic.resolve("bad/key")).toEqual({ status: "denied" });
  });

  test("does no work while nothing waits and no event names the environment", async () => {
    const h = harness();
    await h.retained();
    const before = { ...h.reads };
    h.topic.observeEvent(RESOURCE_CHANGED_EVENT, environmentChanged("env-other"));
    h.topic.observeEvent(NATIVE_AGENT_ACTIVITY_EVENT, {
      environment_id: "env-other",
      state: "waiting",
      agent: "claude",
      logical_session_key: "env-env-other:tab",
    });
    await h.advance(120_000);
    expect(h.reads).toEqual(before);
    expect(h.clock.pendingCount()).toBe(0);
    h.topic.dispose();
  });

  test("an event that moves the lifecycle announces only lifecycle", async () => {
    const h = harness();
    await h.retained();
    h.state.record = { ...h.state.record, status: "stopped" };
    h.topic.observeEvent(CONTAINER_LIFECYCLE_EVENT, { environmentId: "env-1", snapshot: {} });
    await h.advance(ENVIRONMENT_OBSERVE_COALESCE_MS);
    expect(h.published.at(-1)).toMatchObject({ parts: ["lifecycle"], stamp: { revision: 2 } });
    // Lifecycle alone does not read the registry.
    expect(h.reads.registry).toBe(1);
    h.topic.dispose();
  });

  test("an event that changes nothing visible is read but not announced", async () => {
    const h = harness();
    await h.retained();
    h.state.record = { ...h.state.record, name: "renamed" };
    h.topic.observeEvent(RESOURCE_CHANGED_EVENT, environmentChanged());
    await h.advance(ENVIRONMENT_OBSERVE_COALESCE_MS);
    expect(h.reads.record).toBe(2);
    expect(h.published).toHaveLength(1);
    h.topic.dispose();
  });

  test("a burst of events shares one read and a tab starting to wait is attention", async () => {
    const h = harness();
    await h.retained();
    h.state.tabs = [{ tabId: "tab-1", state: "waiting", pending: true }];
    for (let index = 0; index < 20; index += 1) {
      h.topic.observeEvent(NATIVE_AGENT_ACTIVITY_EVENT, {
        environment_id: "env-1",
        state: "waiting",
        agent: "claude",
        logical_session_key: "env-env-1:tab-1",
      });
      await h.advance(4);
    }
    await h.advance(ENVIRONMENT_OBSERVE_COALESCE_MS);
    expect(h.reads.registry).toBe(2);
    expect([...h.published.at(-1)!.parts].sort()).toEqual(["attention", "sessions"]);
    h.topic.dispose();
  });

  test("a waiting tab's request is reconciled every 15 s while it waits, and no longer", async () => {
    const h = harness({ tabs: [{ tabId: "tab-1", state: "waiting", pending: true }] });
    await h.retained();
    // A provider changed the request without an event.
    h.state.pendingLabel = "Needs input";
    await h.advance(ENVIRONMENT_OBSERVE_PENDING_MS);
    expect(h.published.at(-1)?.parts).toEqual(["attention"]);
    expect(h.topic.metrics().reconciles).toBe(1);
    h.state.tabs = [{ tabId: "tab-1", state: "idle" }];
    await h.advance(ENVIRONMENT_OBSERVE_PENDING_MS);
    expect(h.clock.pendingCount()).toBe(0);
    h.topic.dispose();
  });

  test("a lifecycle wake preserves the waiting tab's existing reconcile deadline", async () => {
    const h = harness({ tabs: [{ tabId: "tab-1", state: "waiting", pending: true }] });
    await h.retained();
    try {
      h.state.record = { ...h.state.record, containerId: "c2" };
      h.topic.observeEvent(CONTAINER_LIFECYCLE_EVENT, { environmentId: "env-1", snapshot: {} });
      await h.advance(ENVIRONMENT_OBSERVE_COALESCE_MS);
      expect(h.reads.registry).toBe(1);
      expect(h.published.at(-1)?.parts).toEqual(["lifecycle"]);

      h.state.pendingLabel = "Another request";
      await h.advance(ENVIRONMENT_OBSERVE_PENDING_MS - ENVIRONMENT_OBSERVE_COALESCE_MS);
      expect(h.topic.metrics().reconciles).toBe(1);
      expect(h.published.at(-1)?.parts).toEqual(["attention"]);
    } finally {
      h.topic.dispose();
    }
  });

  test("a waiting tab the registry could not read in time is retried through the ladder", async () => {
    const h = harness({ tabs: [{ tabId: "tab-1", state: "waiting", pending: false }] });
    await h.retained();
    expect(h.clock.pendingDelays()).toEqual([ENVIRONMENT_OBSERVE_PARTIAL_LADDER_MS[0]!]);
    h.state.tabs = [{ tabId: "tab-1", state: "waiting", pending: true }];
    await h.advance(ENVIRONMENT_OBSERVE_PARTIAL_LADDER_MS[0]!);
    expect(h.published.at(-1)?.parts).toEqual(["attention"]);
    expect(h.clock.pendingDelays()).toEqual([ENVIRONMENT_OBSERVE_PENDING_MS]);
    h.topic.dispose();
  });

  test("a deleted environment announces every part once and stops", async () => {
    const h = harness();
    await h.retained();
    h.state.record = null;
    h.topic.observeEvent(RESOURCE_CHANGED_EVENT, environmentChanged());
    await h.advance(ENVIRONMENT_OBSERVE_COALESCE_MS);
    expect([...h.published.at(-1)!.parts].sort()).toEqual(["attention", "lifecycle", "sessions"]);
    expect(h.clock.pendingCount()).toBe(0);
    expect(await h.topic.resolve("env-1")).toEqual({ status: "missing" });
    h.topic.dispose();
  });

  test("a failed read is retried with the parts it owed", async () => {
    const h = harness();
    await h.retained();
    h.state.failNext = true;
    h.state.record = { ...h.state.record, status: "stopped" };
    h.topic.observeEvent(RESOURCE_CHANGED_EVENT, environmentChanged());
    await h.advance(ENVIRONMENT_OBSERVE_COALESCE_MS);
    expect(h.published).toHaveLength(1);
    expect(h.topic.metrics().readFailures).toBe(1);
    await h.advance(ENVIRONMENT_OBSERVE_ERROR_MS);
    expect(h.published.at(-1)?.parts).toContain("lifecycle");
    h.topic.dispose();
  });

  test("release stops the observer: no timers, and events no longer read", async () => {
    const h = harness({ tabs: [{ tabId: "tab-1", state: "waiting", pending: true }] });
    await h.retained();
    expect(h.clock.pendingCount()).toBe(1);
    h.topic.release("env-1");
    expect(h.clock.pendingCount()).toBe(0);
    const before = { ...h.reads };
    h.topic.observeEvent(RESOURCE_CHANGED_EVENT, environmentChanged());
    await h.advance(ENVIRONMENT_OBSERVE_PENDING_MS * 2);
    expect(h.reads).toEqual(before);
    expect(h.topic.metrics().observers).toBe(0);
  });

  test("a release before the first read cancels it", async () => {
    const h = harness();
    h.topic.retain("env-1");
    h.topic.release("env-1");
    await h.advance(ENVIRONMENT_OBSERVE_PENDING_MS);
    expect(h.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

class FloodTopic implements PushTopicProvider {
  readonly topic = NATIVE_SESSION_PUSH_TOPIC;
  validKey(): boolean {
    return true;
  }
  async resolve(): Promise<PushResolveAnswer> {
    return { status: "ok", generation: "g", revision: 0 };
  }
  retain(): void {}
  release(): void {}
}

function hubHarness() {
  const clock = new ManualClock();
  const hub = new PushHub({ timers: clock, now: () => clock.now() });
  const environments = new EnvironmentPushTopic({
    timers: clock,
    now: () => clock.now(),
    readEnvironment: async () => ({ status: "running" }),
    readRegistry: async (environmentId) => registryFor(environmentId, model),
    publish: (key, stamp, parts) => hub.publish(ENVIRONMENT_PUSH_TOPIC, key, stamp, parts),
  });
  const model: EnvironmentModel = {
    record: null,
    tabs: [{ tabId: "tab-1", state: "idle" }],
    pendingLabel: "Needs approval",
    failNext: false,
  };
  hub.registerTopic(new FloodTopic());
  hub.registerTopic(environments);
  const written: PushChangedPayload[] = [];
  const streamId = hub.openConnection("owner", {
    write: (event, payload) => {
      if (event === PUSH_CHANGED_EVENT) written.push(payload as PushChangedPayload);
      return true;
    },
    backpressured: () => false,
  });
  const changes = () => written.flatMap((frame) => frame.changes);
  const advance = async (ms: number) => {
    await clock.advanceAsync(ms);
    await flushMicrotasks();
  };
  return { clock, hub, environments, model, streamId, changes, advance };
}

describe("environment attention over the hub", () => {
  test("an approval in one environment is announced at once while another session floods", async () => {
    const h = hubHarness();
    await h.hub.setSubscriptions("owner", {
      streamId: h.streamId,
      setRevision: 1,
      subscriptions: [
        { topic: NATIVE_SESSION_PUSH_TOPIC, key: "env-2/claude/flood" },
        { topic: ENVIRONMENT_PUSH_TOPIC, key: "env-1" },
      ],
    });
    await h.advance(100);
    const baseline = h.changes().filter((change) => change.topic === ENVIRONMENT_PUSH_TOPIC);
    expect(baseline).toHaveLength(1);

    let revision = 0;
    let approvalAt: number | null = null;
    let announcedAt: number | null = null;
    for (let tick = 0; tick < 200; tick += 1) {
      revision += 1;
      h.hub.publish(
        NATIVE_SESSION_PUSH_TOPIC,
        "env-2/claude/flood",
        { generation: "g", revision },
        ["transcript"],
      );
      if (tick === 120) {
        h.model.tabs = [{ tabId: "tab-1", state: "waiting", pending: true }];
        h.environments.observeEvent(NATIVE_AGENT_ACTIVITY_EVENT, {
          environment_id: "env-1",
          state: "waiting",
          agent: "claude",
          logical_session_key: "env-env-1:tab-1",
        });
        approvalAt = h.clock.now();
      }
      await h.advance(10);
      if (
        announcedAt === null &&
        h
          .changes()
          .some(
            (change) =>
              change.topic === ENVIRONMENT_PUSH_TOPIC && change.parts.includes("attention"),
          ) &&
        h.changes().filter((change) => change.topic === ENVIRONMENT_PUSH_TOPIC).length > 1
      ) {
        announcedAt = h.clock.now();
      }
    }
    expect(approvalAt).not.toBeNull();
    expect(announcedAt).not.toBeNull();
    // One coalesced read plus the hub's coalescing window, not the flood's throttle.
    expect(announcedAt! - approvalAt!).toBeLessThanOrEqual(ENVIRONMENT_OBSERVE_COALESCE_MS + 60);
    const floods = h.changes().filter((change) => change.topic === NATIVE_SESSION_PUSH_TOPIC);
    expect(floods.length).toBeLessThanOrEqual(Math.ceil(h.clock.now() / PUSH_KEY_THROTTLE_MS) + 1);
    h.environments.dispose();
    h.hub.dispose();
  });

  test("attention does not wait behind its own key's throttle; lifecycle does", async () => {
    const h = hubHarness();
    await h.hub.setSubscriptions("owner", {
      streamId: h.streamId,
      setRevision: 1,
      subscriptions: [{ topic: ENVIRONMENT_PUSH_TOPIC, key: "env-1" }],
    });
    h.environments.dispose();
    const sent = () => h.changes().filter((change) => change.key === "env-1");
    h.hub.publish(ENVIRONMENT_PUSH_TOPIC, "env-1", { generation: "g", revision: 1 }, ["lifecycle"]);
    await h.advance(50);
    expect(sent()).toHaveLength(1);
    h.hub.publish(ENVIRONMENT_PUSH_TOPIC, "env-1", { generation: "g", revision: 2 }, ["attention"]);
    await h.advance(50);
    expect(sent()).toHaveLength(2);
    h.hub.publish(ENVIRONMENT_PUSH_TOPIC, "env-1", { generation: "g", revision: 3 }, ["lifecycle"]);
    await h.advance(50);
    // The first lifecycle frame started the throttle; this one waits for it.
    expect(sent()).toHaveLength(2);
    await h.advance(400);
    expect(sent()).toHaveLength(3);
    h.hub.dispose();
  });
});

describe("BackendPush environment topic", () => {
  test("is offered only with its reads, and a subscribed environment wakes on the backend's events", async () => {
    const clock = new ManualClock();
    const status = { value: "running" };
    const push = new BackendPush({
      nativeAgents: () => undefined,
      sessionExists: async () => false,
      environments: {
        readEnvironment: async (id) => (id === "env-1" ? { status: status.value } : null),
        readRegistry: async (id) => ({
          generatedAt: "now",
          entries: [],
          environments: [
            { environmentId: id, tabs: 0, working: 0, waiting: 0, idle: 0, stopped: 0, unknown: 0 },
          ],
        }),
      },
      hub: { timers: clock, now: () => clock.now() },
    });
    const written: PushChangedPayload[] = [];
    const streamId = push.openConnection("owner", {
      write: (event, payload) => {
        if (event === PUSH_CHANGED_EVENT) written.push(payload as PushChangedPayload);
        return true;
      },
      backpressured: () => false,
    });
    const answer = await push.setSubscriptions("owner", {
      streamId,
      setRevision: 1,
      subscriptions: [
        { topic: ENVIRONMENT_PUSH_TOPIC, key: "env-1" },
        { topic: ENVIRONMENT_PUSH_TOPIC, key: "env-gone" },
      ],
    });
    expect(answer).toMatchObject({
      status: "applied",
      subscriptions: [
        { key: "env-1", status: "ok" },
        { key: "env-gone", status: "missing" },
      ],
    });
    await clock.advanceAsync(600);
    await flushMicrotasks();
    status.value = "stopped";
    push.observeEvent(RESOURCE_CHANGED_EVENT, environmentChanged());
    await clock.advanceAsync(ENVIRONMENT_OBSERVE_COALESCE_MS + 600);
    await flushMicrotasks();
    const changes = written.flatMap((frame) => frame.changes);
    expect(changes.at(-1)).toMatchObject({ topic: "environment", key: "env-1" });
    expect(changes.at(-1)!.parts).toContain("lifecycle");
    expect(push.metrics().topics.environment).toMatchObject({ observers: 1 });
    expect(push.metrics().observedKeysByTopic).toEqual({ environment: 1 });
    push.dispose();

    const without = new BackendPush({
      nativeAgents: () => undefined,
      sessionExists: async () => false,
    });
    expect(without.environments).toBeNull();
    expect(without.metrics().topics.environment).toBeUndefined();
    without.dispose();
  });
});
