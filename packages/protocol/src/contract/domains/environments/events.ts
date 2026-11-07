/**
 * `environments` events: attention edges, setup progress, renames and
 * recorded activity. Wire keys are the long-standing snake_case ones.
 *
 * Model-shaped parts (`environment`) stay `ObjectKeyword` until the
 * environment model converges on a protocol schema (7010). Browser-safe.
 */
import * as Schema from "effect/Schema";
import {
  ENVIRONMENT_ATTENTION_EVENT,
  ENVIRONMENT_ATTENTION_REASONS,
} from "../../../environment-attention.js";
import { defineEvent } from "../../event.js";
import { environmentsDomain } from "./domain.js";

/** An environment's unread badge lit on its own (`EnvironmentAttentionEvent`). */
export const environmentAttentionEvent = defineEvent({
  domain: environmentsDomain,
  name: ENVIRONMENT_ATTENTION_EVENT,
  payload: Schema.Struct({
    attentionId: Schema.String,
    environmentId: Schema.String,
    projectId: Schema.String,
    reason: Schema.Literals(ENVIRONMENT_ATTENTION_REASONS),
    occurredAt: Schema.String,
  }),
});

/** A setup session started for an environment. */
export const environmentSetupStartedEvent = defineEvent({
  domain: environmentsDomain,
  name: "environment-setup-started",
  payload: Schema.Struct({
    environment_id: Schema.String,
    session_id: Schema.String,
    environment: Schema.ObjectKeyword,
  }),
});

/** Setup finished, failed, was refused or was overridden by the user. */
export const environmentSetupCompleteEvent = defineEvent({
  domain: environmentsDomain,
  name: "environment-setup-complete",
  payload: Schema.Struct({
    environment_id: Schema.String,
    success: Schema.Boolean,
    error: Schema.optional(Schema.String),
    overridden: Schema.optional(Schema.Boolean),
    environment: Schema.optional(Schema.ObjectKeyword),
  }),
});

/** An environment's name and branch changed. */
export const environmentRenamedEvent = defineEvent({
  domain: environmentsDomain,
  name: "environment-renamed",
  payload: Schema.Struct({
    environment_id: Schema.String,
    new_name: Schema.String,
    new_branch: Schema.String,
  }),
});

/** Terminal activity was persisted (`activity_kind`: `completed` or `prompt`). */
export const environmentActivityRecordedEvent = defineEvent({
  domain: environmentsDomain,
  name: "environment-activity-recorded",
  payload: Schema.Struct({
    environment_id: Schema.String,
    occurred_at: Schema.String,
    activity_kind: Schema.String,
  }),
});

export const ENVIRONMENTS_EVENTS = [
  environmentAttentionEvent,
  environmentSetupStartedEvent,
  environmentSetupCompleteEvent,
  environmentRenamedEvent,
  environmentActivityRecordedEvent,
] as const;
