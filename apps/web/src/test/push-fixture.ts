/**
 * Test helpers for views over the push layer (docs/architecture/push-events.md):
 * a `push_set_subscriptions` answer that accepts every key, a stream offer, and
 * a change frame, all emitted through a {@link FakeNodeClient}.
 */
import { act, waitFor } from "@testing-library/react";
import { expect } from "bun:test";
import {
  PUSH_CHANGED_EVENT,
  PUSH_STREAM_STATE_EVENT,
  type PushSetSubscriptionsArgs,
} from "@orkestrator/protocol/push-events";
import { pushClientFor } from "@/lib/push/push-subscriptions";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { FakeNodeClient } from "./render-in-node-scope";

export const PUSH_FIXTURE_STREAM = "stream-aaaaaaaaaaaaaaaa";

/** A `push_set_subscriptions` handler that accepts every key at revision 0. */
export function acceptPushSets(args: Readonly<Record<string, unknown>>) {
  const set = args as unknown as PushSetSubscriptionsArgs;
  return {
    status: "applied",
    setRevision: set.setRevision,
    seqBase: 0,
    subscriptions: set.subscriptions.map(({ topic, key }) => ({
      topic,
      key,
      status: "ok",
      generation: "g1",
      revision: 0,
    })),
  };
}

/** Offer push on the client's stream and wait until `topic`/`key` is healthy. */
export async function connectPush(
  client: FakeNodeClient,
  scope: NodeScope,
  topic: string,
  key: string,
): Promise<void> {
  await act(async () => {
    client.emit(PUSH_STREAM_STATE_EVENT, {
      state: "connected",
      offer: { versions: [1], streamId: PUSH_FIXTURE_STREAM },
    });
  });
  await waitFor(() => expect(pushClientFor(scope).isHealthy(topic, key)).toBe(true));
}

/** One `push.changed` frame naming `key`, as the gateway sends it. */
export async function emitPushChange(
  client: FakeNodeClient,
  seq: number,
  topic: string,
  key: string,
  parts: readonly string[],
): Promise<void> {
  await act(async () => {
    client.emit(PUSH_CHANGED_EVENT, {
      seq,
      changes: [{ topic, key, generation: "g1", revision: seq, parts }],
    });
  });
}

/** The keys the last `push_set_subscriptions` call subscribed. */
export function subscribedPushKeys(client: FakeNodeClient): string[] {
  const last = client.calls("push_set_subscriptions").at(-1)?.args as
    PushSetSubscriptionsArgs | undefined;
  return (last?.subscriptions ?? []).map(({ topic, key }) => `${topic} ${key}`);
}
