/**
 * The push event layer's commands (docs/architecture/push-events.md).
 *
 * `push_set_subscriptions` replaces one event-stream connection's whole
 * subscription set. It is answered by the gateway that holds the stream,
 * which checks that the caller's credential opened it; a caller with no
 * stream (an in-process or IPC caller) is answered `refused`. It is
 * `workspace`, like the reads its subscriptions replace: each subscription is
 * resolved with the same lookup the read uses. With `nodeId` the set is for
 * that node's keys, held by this command node's subscription controller
 * (design D10); only a stream whose offer says `nodes: true` takes one.
 *
 * `get_push_metrics` reports the layer's content-free counters (no keys, ids
 * or revisions), as `/__orkestrator/metrics` does.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { PushSetSubscriptionsResult } from "../../../push-events.js";
import { defineCommand } from "../../command.js";
import { ownedObject } from "../../model-schema.js";
import { systemDomain } from "./domain.js";

const PushSubscriptionRequestSchema = Schema.Struct({
  topic: Schema.String,
  key: Schema.String,
});

export const pushSetSubscriptionsCommand = defineCommand({
  domain: systemDomain,
  name: "push_set_subscriptions",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    streamId: Schema.String,
    setRevision: Schema.Finite,
    subscriptions: Schema.Array(PushSubscriptionRequestSchema),
    // A node this command node relays (design D10); absent for its own keys.
    // `null` is accepted and means absent: 2.39.9-beta published this field
    // as `anyOf [string, null]` (the export of `Schema.optional`), so a client
    // built against that schema may send it.
    nodeId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  result: ownedObject<PushSetSubscriptionsResult>(),
  critical: [],
});

/** Content-free push counters: connections, subscriptions by topic, frames, resyncs. */
export const getPushMetricsCommand = defineCommand({
  domain: systemDomain,
  name: "get_push_metrics",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: ownedObject<Record<string, unknown>>(),
  critical: [],
});
