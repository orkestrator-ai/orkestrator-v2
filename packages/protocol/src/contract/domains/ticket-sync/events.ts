/** `ticket-sync` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { TICKET_SYNC_OUTBOX_READY_EVENT, TICKET_SYNC_STATUS_EVENT } from "../../../ticket-sync.js";
import { defineEvent } from "../../event.js";
import { ticketSyncDomain } from "./domain.js";

/** Ticket changes are waiting in this node's outbox for `controllerId`. */
export const ticketSyncOutboxReadyEvent = defineEvent({
  domain: ticketSyncDomain,
  name: TICKET_SYNC_OUTBOX_READY_EVENT,
  payload: Schema.Struct({ controllerId: Schema.String }),
});

/** A node's ticket sync status changed. */
export const ticketSyncStatusChangedEvent = defineEvent({
  domain: ticketSyncDomain,
  name: TICKET_SYNC_STATUS_EVENT,
  payload: Schema.Struct({ nodeId: Schema.String }),
});

export const TICKET_SYNC_EVENTS = [
  ticketSyncOutboxReadyEvent,
  ticketSyncStatusChangedEvent,
] as const;
