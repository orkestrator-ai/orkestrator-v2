/**
 * `docker` events: container lifecycle and host reachability snapshots.
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { CONTAINER_HOST_REACHABILITY_CHANGED_EVENT } from "../../../container-host-reachability.js";
import { CONTAINER_LIFECYCLE_EVENT } from "../../../container-lifecycle.js";
import { defineEvent } from "../../event.js";
import { dockerDomain } from "./domain.js";

/** One environment's container lifecycle snapshot (`ContainerLifecycleEvent`). */
export const containerLifecycleUpdatedEvent = defineEvent({
  domain: dockerDomain,
  name: CONTAINER_LIFECYCLE_EVENT,
  payload: Schema.Struct({
    environmentId: Schema.String,
    snapshot: Schema.ObjectKeyword,
  }),
});

/** The whole reachability snapshot (`ContainerHostReachability`). */
export const containerHostReachabilityChangedEvent = defineEvent({
  domain: dockerDomain,
  name: CONTAINER_HOST_REACHABILITY_CHANGED_EVENT,
  payload: Schema.ObjectKeyword,
});

export const DOCKER_EVENTS = [
  containerLifecycleUpdatedEvent,
  containerHostReachabilityChangedEvent,
] as const;
