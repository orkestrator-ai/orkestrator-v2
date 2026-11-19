/**
 * The push layer through the real gateway: the offer in `gateway.connected`,
 * `push_set_subscriptions` over `/invoke` checked against the stream's own
 * credential, `push.changed` frames on that stream only (never in the replay
 * ring), cleanup when the stream closes, and the metrics block.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { NativeAgentLiveUpdate } from "@orkestrator/protocol/native-agent";
import {
  PUSH_CHANGED_EVENT,
  formatNativeSessionPushKey,
  parsePushStreamOffer,
  type PushChangedPayload,
  type PushSetSubscriptionsResult,
} from "@orkestrator/protocol/push-events";
import { BackendPush } from "../src/core/push/index.js";
import { registryCommandAccess } from "../src/core/nodes/workspace-grant-test-support.js";
import {
  eventFrames,
  openEventStream,
  readGatewayMetrics,
  requestUrl,
  startGateway,
  waitUntil,
} from "./gateway-test-harness.js";

const KEY = formatNativeSessionPushKey({
  environmentId: "env-1",
  agent: "claude",
  logicalSessionKey: "tab-1",
});

const pushes: BackendPush[] = [];
afterEach(() => {
  for (const push of pushes.splice(0)) push.dispose();
});

function fakePush() {
  const model = { transcript: 1 };
  const push = new BackendPush({
    sessionExists: async () => true,
    nativeAgents: () => ({
      getLiveUpdate: async (input): Promise<NativeAgentLiveUpdate> => {
        const token = `t${model.transcript}`;
        return {
          viewVersion: 1,
          transcript:
            input.transcriptToken === token
              ? { viewVersion: 1, status: "unchanged", token, identity: {} as never }
              : { viewVersion: 1, status: "snapshot", token, value: {} as never },
          state: { viewVersion: 1, status: "unchanged", token: "s", identity: {} as never },
        };
      },
      observePushSession: () => () => undefined,
      forgetPushSettled: () => undefined,
    }),
  });
  pushes.push(push);
  return { push, model };
}

async function setSubscriptions(
  info: { url: string; token: string },
  args: Record<string, unknown>,
): Promise<PushSetSubscriptionsResult> {
  const response = await requestUrl(`${info.url}__orkestrator/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command: "push_set_subscriptions", args }),
  });
  expect(response.status).toBe(200);
  return (response.json() as { result: PushSetSubscriptionsResult }).result;
}

function connectedOffer(received: string) {
  const frame = eventFrames(received, "gateway.connected")[0]!;
  const data = /^data: (.+)$/m.exec(frame)![1]!;
  return parsePushStreamOffer((JSON.parse(data) as { payload: unknown }).payload);
}

describe("gateway push", () => {
  test("offers push on the main stream, delivers frames for the subscription, and cleans up", async () => {
    const { push, model } = fakePush();
    const invoke = mock(async () => null);
    const { gateway, info } = await startGateway({
      backend: { invoke, commandAccess: registryCommandAccess, push },
    });
    const stream = await openEventStream(gateway, info, "?excludeEvents=terminal-output-");
    await waitUntil(() => stream.received().includes("gateway.connected"), "no connected frame");
    const offer = connectedOffer(stream.received());
    expect(offer?.versions).toEqual([1]);

    const result = await setSubscriptions(info, {
      streamId: offer!.streamId,
      setRevision: 1,
      subscriptions: [{ topic: "native-session", key: KEY }],
    });
    expect(result).toMatchObject({
      status: "applied",
      setRevision: 1,
      seqBase: 0,
      subscriptions: [{ topic: "native-session", key: KEY, status: "ok", revision: 0 }],
    });
    // Answered by the gateway, not the registry.
    expect(invoke).not.toHaveBeenCalled();

    // Let the observer take its baseline, then move the transcript.
    await waitUntil(() => push.nativeSessions.metrics().reads >= 1, "no baseline read");
    model.transcript = 2;
    push.nativeSessions.wake({
      environmentId: "env-1",
      agent: "claude",
      logicalSessionKey: "tab-1",
    });
    await waitUntil(
      () => eventFrames(stream.received(), PUSH_CHANGED_EVENT).length > 0,
      "no push.changed frame",
    );
    const frame = eventFrames(stream.received(), PUSH_CHANGED_EVENT)[0]!;
    // Per connection: no replay id.
    expect(frame).not.toMatch(/^id: /m);
    const payload = (
      JSON.parse(/^data: (.+)$/m.exec(frame)![1]!) as { payload: PushChangedPayload }
    ).payload;
    expect(payload).toEqual({
      seq: 1,
      changes: [
        {
          topic: "native-session",
          key: KEY,
          generation: expect.any(String),
          revision: 1,
          parts: ["transcript"],
        },
      ],
    });

    const metrics = (await readGatewayMetrics(info)) as unknown as {
      push: {
        connections: number;
        framesSent: number;
        subscriptionsByTopic: Record<string, number>;
      };
    };
    expect(metrics.push).toMatchObject({
      connections: 1,
      framesSent: 1,
      subscriptionsByTopic: { "native-session": 1 },
    });
    expect(JSON.stringify(metrics.push)).not.toContain("tab-1");

    stream.close();
    await waitUntil(() => push.metrics().connections === 0, "push connection not closed");
    expect(push.metrics().topics["native-session"].observers).toBe(0);
  });

  test("a stream id the caller did not open is refused", async () => {
    const { push } = fakePush();
    const { info } = await startGateway({
      backend: { invoke: mock(async () => null), commandAccess: registryCommandAccess, push },
    });
    expect(
      await setSubscriptions(info, {
        streamId: "not-a-stream-of-this-gateway",
        setRevision: 1,
        subscriptions: [{ topic: "native-session", key: KEY }],
      }),
    ).toEqual({ status: "refused", reason: "stream-unknown" });
    expect(push.metrics().observedKeysByTopic).toEqual({});
  });

  test("terminal-only streams and a backend without push get no offer", async () => {
    const { push } = fakePush();
    const { gateway, info } = await startGateway({
      backend: { invoke: mock(async () => null), commandAccess: registryCommandAccess, push },
    });
    await openEventStream(
      gateway,
      info,
      "?includeEvents=terminal-output-abc&excludeEvents=terminal-output-",
    );
    expect(push.metrics().connections).toBe(0);

    const plain = await startGateway();
    const stream = await openEventStream(
      plain.gateway,
      plain.info,
      "?excludeEvents=terminal-output-",
    );
    await waitUntil(() => stream.received().includes("gateway.connected"), "no connected frame");
    expect(connectedOffer(stream.received())).toBeNull();
  });
});
