/**
 * `native-sessions` events: the activity observer's announcements and async
 * question attention. Browser-safe.
 */
import * as Schema from "effect/Schema";
import { NATIVE_AGENT_ACTIVITY_EVENT } from "../../../native-agent-observation.js";
import { defineEvent } from "../../event.js";
import { nativeSessionsDomain } from "./domain.js";

/**
 * A native session's activity changed (`cause: "transition"`) or an idle
 * view's content changed (`reason: "content"`). `agent`, the session key and
 * the observer's stamp are absent on older backends.
 */
export const nativeAgentSessionActivityEvent = defineEvent({
  domain: nativeSessionsDomain,
  name: NATIVE_AGENT_ACTIVITY_EVENT,
  payload: Schema.Struct({
    environment_id: Schema.String,
    previous_state: Schema.optional(Schema.String),
    state: Schema.String,
    reason: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    logical_session_key: Schema.optional(Schema.String),
    generation: Schema.optional(Schema.String),
    revision: Schema.optional(Schema.Finite),
  }),
});

/** A session asked a question while no turn was waiting on it. */
export const nativeAgentAsyncQuestionEvent = defineEvent({
  domain: nativeSessionsDomain,
  name: "native-agent-async-question",
  payload: Schema.Struct({
    environment_id: Schema.String,
    session_key: Schema.String,
  }),
});

export const NATIVE_SESSIONS_EVENTS = [
  nativeAgentSessionActivityEvent,
  nativeAgentAsyncQuestionEvent,
] as const;
