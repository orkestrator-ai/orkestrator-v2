/** `pull-requests` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { PR_MONITOR_CHANGED_EVENT } from "../../../pr-monitor.js";
import { defineEvent } from "../../event.js";
import { pullRequestsDomain } from "./domain.js";

/**
 * One environment's PR monitor state, or its removal (`PrMonitorEvent`).
 * `generation`/`revision` are absent on older backends.
 */
export const prMonitorChangedEvent = defineEvent({
  domain: pullRequestsDomain,
  name: PR_MONITOR_CHANGED_EVENT,
  payload: Schema.Struct({
    environmentId: Schema.String,
    generation: Schema.optional(Schema.String),
    revision: Schema.optional(Schema.Finite),
    state: Schema.optional(Schema.ObjectKeyword),
    transition: Schema.optional(Schema.ObjectKeyword),
    removed: Schema.optional(Schema.Boolean),
  }),
});

export const PULL_REQUESTS_EVENTS = [prMonitorChangedEvent] as const;
