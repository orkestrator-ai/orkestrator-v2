/** `capabilities` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { CAPABILITY_MANAGEMENT_CHANGED_EVENT } from "../../../capability-resources.js";
import { defineEvent } from "../../event.js";
import { capabilitiesDomain } from "./domain.js";

/**
 * Capability packages, setups or operations changed. Opaque ids and a
 * revision only: never content, paths or secrets. A client re-reads what it
 * shows; a missed event is caught by the revision gap on the next read.
 */
export const capabilityManagementChangedEvent = defineEvent({
  domain: capabilitiesDomain,
  name: CAPABILITY_MANAGEMENT_CHANGED_EVENT,
  payload: Schema.Struct({
    revision: Schema.Finite,
    packageIds: Schema.Array(Schema.String),
    setupIds: Schema.Array(Schema.String),
    operationIds: Schema.Array(Schema.String),
  }),
});

/**
 * A leaf asks its command node to resolve a native session launch. The name
 * starts with `node-` so the command node's event stream from the leaf
 * carries it (`NODE_SUMMARY_EVENT_PREFIXES`). Opaque ids and digests only:
 * the target, the permission ceiling's denials, and the leaf's managed
 * deliveries (component, location, digest). The command node answers with
 * `answer_capability_node_launch`.
 */
export const CAPABILITY_LAUNCH_REQUESTED_EVENT = "node-capability-launch-requested";

export const capabilityLaunchRequestedEvent = defineEvent({
  domain: capabilitiesDomain,
  name: CAPABILITY_LAUNCH_REQUESTED_EVENT,
  payload: Schema.Struct({
    requestId: Schema.String,
    request: Schema.Unknown,
  }),
});

/**
 * A leaf asks its command node for what only the command node knows
 * (`environment-authority.ts`), on the same stream as launches: `kind`
 * `container-staging` (the manifest for a container it is creating: the
 * environment and project ids, the staged providers and stage names) or
 * `environment-delivery` (an environment card: the environment's ids and
 * type, and its container's staged record). Opaque ids and digests only.
 * The command node answers with `answer_capability_node_request`.
 */
export const CAPABILITY_LEAF_REQUESTED_EVENT = "node-capability-leaf-requested";

export const capabilityLeafRequestedEvent = defineEvent({
  domain: capabilitiesDomain,
  name: CAPABILITY_LEAF_REQUESTED_EVENT,
  payload: Schema.Struct({
    requestId: Schema.String,
    kind: Schema.String,
    request: Schema.Unknown,
  }),
});

export const CAPABILITIES_EVENTS = [
  capabilityManagementChangedEvent,
  capabilityLaunchRequestedEvent,
  capabilityLeafRequestedEvent,
] as const;
