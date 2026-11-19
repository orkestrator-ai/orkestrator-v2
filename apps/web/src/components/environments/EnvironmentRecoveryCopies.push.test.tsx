/**
 * The recovery copies list over the `environment` push topic
 * (docs/architecture/push-events.md): while the subscription is healthy the
 * lifecycle record is checked when a frame names `lifecycle` and otherwise on
 * the 30 s recovery poll; without push it is checked every 3 s.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, waitFor } from "@testing-library/react";
import type { RecoveryCopyList } from "@orkestrator/protocol/container-recovery";
import {
  ENVIRONMENT_PUSH_TOPIC,
  PUSH_CHANGED_EVENT,
  PUSH_RECOVERY_POLL_MS,
  PUSH_STREAM_STATE_EVENT,
  type PushSetSubscriptionsArgs,
} from "@orkestrator/protocol/push-events";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import { pushClientFor } from "@/lib/push/push-subscriptions";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import type { Environment } from "@/types";
import { EnvironmentRecoveryCopies, RECORD_CHECK_MS } from "./EnvironmentRecoveryCopies";

const STREAM = "stream-environment-bbbb";
const environment = {
  id: "env-copies",
  environmentType: "containerized",
  containerId: "current",
} as unknown as Environment;
const emptyList: RecoveryCopyList = {
  environmentId: "env-copies",
  revision: 1,
  limit: 16,
  copies: [],
};

afterEach(() => {
  cleanupNodeScopes();
  resetReadCoordinatorForTests();
});

function setup() {
  const { clock } = installFakeReadCoordinator();
  const record = { revision: 1 };
  const client = new FakeNodeClient({
    invoke: {
      list_recovery_copies: () => emptyList,
      get_container_lifecycle_snapshot: () => ({ revision: record.revision }),
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
  const view = renderInNodeScope(
    <EnvironmentRecoveryCopies
      environment={environment}
      dockerAvailable
      onUpdate={() => undefined}
      onClose={() => undefined}
    />,
    { client },
  );
  const checks = () => client.calls("get_container_lifecycle_snapshot").length;
  const lists = () => client.calls("list_recovery_copies").length;
  const connect = async (offer: unknown) => {
    await waitFor(() => expect(client.listenerCount(PUSH_STREAM_STATE_EVENT)).toBeGreaterThan(0));
    await act(async () => {
      client.emit(PUSH_STREAM_STATE_EVENT, { state: "connected", offer });
    });
  };
  const advance = (ms: number) =>
    act(async () => {
      await clock.advance(ms);
    });
  return { client, scope: view.scope, record, checks, lists, connect, advance };
}

describe("environment recovery copies over push", () => {
  test("while healthy the record is checked on lifecycle frames and every 30 s", async () => {
    const h = setup();
    await h.connect({ versions: [1], streamId: STREAM });
    await waitFor(() =>
      expect(pushClientFor(h.scope).isHealthy(ENVIRONMENT_PUSH_TOPIC, "env-copies")).toBe(true),
    );
    await waitFor(() => expect(h.checks()).toBeGreaterThan(0));
    await h.advance(0);
    const settled = h.checks();

    await h.advance(RECORD_CHECK_MS * 3);
    expect(h.checks()).toBe(settled);

    // A rebuild elsewhere commits: the frame reads the record, and the list follows.
    h.record.revision = 2;
    const listsBefore = h.lists();
    await act(async () => {
      h.client.emit(PUSH_CHANGED_EVENT, {
        seq: 1,
        changes: [
          {
            topic: ENVIRONMENT_PUSH_TOPIC,
            key: "env-copies",
            generation: "g1",
            revision: 1,
            parts: ["lifecycle"],
          },
        ],
      });
    });
    await waitFor(() => expect(h.checks()).toBe(settled + 1));
    await waitFor(() => expect(h.lists()).toBe(listsBefore + 1));

    // The recovery poll still runs.
    await h.advance(PUSH_RECOVERY_POLL_MS);
    expect(h.checks()).toBe(settled + 2);
  });

  test("without push, and again after the stream drops, the record is checked every 3 s", async () => {
    const h = setup();
    await h.connect(null);
    await waitFor(() => expect(h.checks()).toBeGreaterThan(0));
    await h.advance(0);
    const start = h.checks();
    await h.advance(RECORD_CHECK_MS);
    expect(h.checks()).toBe(start + 1);

    await h.connect({ versions: [1], streamId: STREAM });
    await waitFor(() =>
      expect(pushClientFor(h.scope).isHealthy(ENVIRONMENT_PUSH_TOPIC, "env-copies")).toBe(true),
    );
    await h.advance(0);
    const healthy = h.checks();
    await h.advance(RECORD_CHECK_MS);
    expect(h.checks()).toBe(healthy);

    await act(async () => {
      h.client.emit(PUSH_STREAM_STATE_EVENT, { state: "disconnected" });
    });
    await h.advance(0);
    const dropped = h.checks();
    await h.advance(RECORD_CHECK_MS);
    expect(h.checks()).toBe(dropped + 1);
  });
});
