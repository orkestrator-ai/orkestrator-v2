/** `node-mail` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { defineEvent } from "../../event.js";
import { nodeMailDomain } from "./domain.js";

/** Mail is waiting in this node's outbox for `controllerId`. */
export const nodeOutboxReadyEvent = defineEvent({
  domain: nodeMailDomain,
  name: "node-outbox-ready",
  payload: Schema.Struct({ controllerId: Schema.String }),
});

/** The node action requests changed; `pending` counts the open ones. */
export const nodeActionRequestsChangedEvent = defineEvent({
  domain: nodeMailDomain,
  name: "node-action-requests-changed",
  payload: Schema.Struct({ pending: Schema.Finite }),
});

export const NODE_MAIL_EVENTS = [nodeOutboxReadyEvent, nodeActionRequestsChangedEvent] as const;
