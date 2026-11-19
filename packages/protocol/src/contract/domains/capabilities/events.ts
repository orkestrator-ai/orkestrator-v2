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

export const CAPABILITIES_EVENTS = [capabilityManagementChangedEvent] as const;
