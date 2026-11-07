/** `coordinator` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { COORDINATOR_WAKE_ATTENTION_EVENT } from "../../../environment-attention.js";
import { defineEvent } from "../../event.js";
import { coordinatorDomain } from "./domain.js";

/** A coordinator was woken for a worker (`CoordinatorWakeAttentionEvent`). */
export const coordinatorWakeAttentionEvent = defineEvent({
  domain: coordinatorDomain,
  name: COORDINATOR_WAKE_ATTENTION_EVENT,
  payload: Schema.Struct({
    attentionId: Schema.String,
    projectId: Schema.String,
    coordinatorId: Schema.String,
    occurredAt: Schema.String,
  }),
});

export const COORDINATOR_EVENTS = [coordinatorWakeAttentionEvent] as const;
