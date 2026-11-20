/**
 * The sidebar's attention reads over the `environment` push topic
 * (docs/architecture/push-events.md): while the subscription is healthy a row
 * reads when a frame names `attention` or `sessions`, ignores raw events, and
 * re-reads a waiting tab's request on the 30 s recovery poll; when push is
 * unavailable or the stream drops it keeps its events and 15 s cadence.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import type {
  AgentRegistryEntry,
  AgentRegistrySnapshot,
} from "@orkestrator/protocol/agent-registry";
import {
  ENVIRONMENT_PUSH_TOPIC,
  PUSH_CHANGED_EVENT,
  PUSH_RECOVERY_POLL_MS,
  PUSH_STREAM_STATE_EVENT,
  type PushSetSubscriptionsArgs,
} from "@orkestrator/protocol/push-events";
import { WindowScope } from "@/lib/node-scope/window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { pushClientFor, pushDiagnostics } from "@/lib/push/push-subscriptions";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../../tests/helpers/controlled-timeout";
import type { AgentSummarySource } from "./EnvironmentAgentSummary";
import {
  PENDING_REFRESH_MS,
  useAgentRegistryRead,
  type RegistryRead,
} from "./useAgentRegistryRead";

const STREAM = "stream-environment-aaaa";
const controlled: ControlledTimeout[] = [];

afterEach(() => {
  cleanupNodeScopes();
  for (const time of controlled.splice(0)) time.restore();
});

function waitingEntry(label: string): AgentRegistryEntry {
  return {
    projectId: "p1",
    environmentId: "env-1",
    environmentName: "feature",
    tabId: "tab-1",
    ownerKind: "environment",
    kind: "native",
    agent: "claude",
    displayName: "tab-1",
    tabOrdinal: 1,
    state: "waiting",
    pending: {
      interactionId: "request-1",
      kind: "command-approval",
      label,
      since: 1_000,
      count: 1,
    },
  };
}

function setup() {
  const pending = installControlledTimeout(PENDING_REFRESH_MS, { label: "pending refresh" });
  const recovery = installControlledTimeout(PUSH_RECOVERY_POLL_MS, { label: "recovery poll" });
  controlled.push(pending, recovery);
  const client = new FakeNodeClient({
    invoke: {
      push_set_subscriptions: (args: PushSetSubscriptionsArgs) => ({
        status: "applied",
        setRevision: args.setRevision,
        seqBase: 0,
        subscriptions: args.subscriptions.map(({ topic, key }) => ({
          topic,
          key,
          status: "ok",
          generation: "g1",
          revision: 0,
        })),
      }),
    },
  });
  const windowScope = new WindowScope();
  const scope: NodeScope = windowScope.open({ role: "command", client });
  const model = { label: "Needs approval" };
  const read = mock(async (): Promise<AgentRegistrySnapshot> => ({
    generatedAt: "now",
    entries: [waitingEntry(model.label)],
    environments: [],
  }));
  const events: Array<(immediate?: boolean) => void> = [];
  const source: AgentSummarySource = {
    read,
    subscribe: (_environmentId, refresh) => {
      events.push(refresh);
      return () => {
        events.splice(events.indexOf(refresh), 1);
      };
    },
    pushScope: () => scope,
  };
  const latest: { value: RegistryRead | null } = { value: null };
  function Probe() {
    const value = useAgentRegistryRead("env-1", true, source, { includePending: true });
    useLayoutEffect(() => {
      latest.value = value;
    }, [value]);
    return null;
  }
  renderInNodeScope(<Probe />, { client, windowScope });
  const connect = async (offer: unknown = { versions: [1], streamId: STREAM }) => {
    await waitFor(() => expect(client.listenerCount(PUSH_STREAM_STATE_EVENT)).toBeGreaterThan(0));
    await act(async () => {
      client.emit(PUSH_STREAM_STATE_EVENT, { state: "connected", offer });
    });
  };
  let seq = 0;
  const frame = async (parts: string[]) => {
    seq += 1;
    await act(async () => {
      client.emit(PUSH_CHANGED_EVENT, {
        seq,
        changes: [
          { topic: ENVIRONMENT_PUSH_TOPIC, key: "env-1", generation: "g1", revision: seq, parts },
        ],
      });
    });
  };
  const healthy = () => pushClientFor(scope).isHealthy(ENVIRONMENT_PUSH_TOPIC, "env-1");
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  return {
    client,
    scope,
    model,
    read,
    events,
    latest,
    connect,
    frame,
    healthy,
    settle,
    pending,
    recovery,
  };
}

describe("useAgentRegistryRead over push", () => {
  test("while healthy it reads on frames, ignores raw events and re-reads on the recovery poll", async () => {
    const h = setup();
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    await h.connect();
    await waitFor(() => expect(h.healthy()).toBe(true));
    await h.settle();

    // A frame naming attention reads at once.
    const beforeFrame = h.read.mock.calls.length;
    await h.frame(["attention"]);
    await waitFor(() => expect(h.read.mock.calls.length).toBe(beforeFrame + 1));
    await h.settle();
    // The waiting tab's request is now on the 30 s recovery poll, not 15 s.
    expect(h.recovery.pendingCount()).toBe(1);
    expect(h.pending.pendingCount()).toBe(0);

    // Raw events and lifecycle-only frames do not read while healthy.
    const beforeEvents = h.read.mock.calls.length;
    act(() => {
      for (const refresh of h.events) refresh();
    });
    await h.frame(["lifecycle"]);
    await h.settle();
    expect(h.read.mock.calls.length).toBe(beforeEvents);

    // A change no frame announced is found by the recovery poll and counted.
    h.model.label = "Needs input";
    await act(async () => {
      h.recovery.advance();
    });
    await waitFor(() => expect(h.latest.value?.entries[0]?.pending?.label).toBe("Needs input"));
    expect(pushDiagnostics(h.scope)?.recoveryFoundChange[ENVIRONMENT_PUSH_TOPIC]).toBe(1);
    expect(h.recovery.pendingCount()).toBe(1);
  });

  test("when the stream drops it reads once and returns to events and the 15 s cadence", async () => {
    const h = setup();
    await h.connect();
    await waitFor(() => expect(h.healthy()).toBe(true));
    await h.frame(["attention"]);
    await h.settle();
    expect(h.recovery.pendingCount()).toBe(1);

    const beforeDrop = h.read.mock.calls.length;
    await act(async () => {
      h.client.emit(PUSH_STREAM_STATE_EVENT, { state: "disconnected" });
    });
    await waitFor(() => expect(h.read.mock.calls.length).toBe(beforeDrop + 1));
    await h.settle();
    expect(h.pending.pendingCount()).toBe(1);
    expect(h.recovery.pendingCount()).toBe(0);

    const beforeEvent = h.read.mock.calls.length;
    act(() => {
      for (const refresh of h.events) refresh();
    });
    await waitFor(() => expect(h.read.mock.calls.length).toBe(beforeEvent + 1));
  });

  test("a node that offers no push keeps its events and 15 s cadence", async () => {
    const h = setup();
    await h.connect(null);
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    await h.settle();
    expect(h.healthy()).toBe(false);
    expect(h.client.calls("push_set_subscriptions")).toHaveLength(0);
    expect(h.pending.pendingCount()).toBe(1);
    act(() => {
      for (const refresh of h.events) refresh();
    });
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  });
});
