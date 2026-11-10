/**
 * `ticket-sync` commands (plan item 1010; docs/architecture/tickets.md,
 * "Sync across machines").
 *
 * Leaf side, called by an attached command node over its link only:
 * `apply_ticket_sync`, `get_ticket_sync_cursor`, `collect_ticket_sync_outbox`
 * and `ack_ticket_sync_outbox`. Command node side: `get_ticket_sync_status`
 * for the board and `sync_node_tickets` to sync now.
 *
 * Every command here was strict before (`assertOnlyKeys`); the argument
 * schemas declare exactly those keys and decode tolerantly (§11.4). The
 * handlers keep their own checks (`parseTicketSyncItem`, the batch and
 * sequence bounds), so those arguments stay `Unknown` and their error text is
 * unchanged. Results crossing the node link have optional fields.
 *
 * `coordinator_node_ticket` (a command node coordinator's ticket tools with a
 * `nodeId`), the lenient neighbour 1010 left as a string command, was defined
 * on 2026-11-07 (plan item 7009): its four keys are `optionalKey(Unknown)`, so
 * the handler's own checks give the error text and nothing accepted before is
 * refused.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { openRecord } from "../../model-schema.js";
import { KanbanTaskListSchema, KanbanTaskSchema } from "../kanban/schemas.js";
import { ticketSyncDomain } from "./domain.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const optionalSequence = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

/** A batch of the command node's board changes, applied on the leaf. */
export const applyTicketSyncCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "apply_ticket_sync",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    projectId: optionalUnknown,
    sourceProjectId: optionalUnknown,
    epoch: optionalUnknown,
    items: optionalUnknown,
    cursor: optionalUnknown,
    reset: optionalUnknown,
    liveIds: optionalUnknown,
  }),
  result: Schema.Struct({ cursor: optionalSequence }),
  // reset with liveIds: the leaf drops every replica the command node no
  // longer has. A receiver ignoring them would keep tickets deleted at the
  // source, so a full resync would silently not converge.
  critical: ["reset", "liveIds"],
});

/** How far the leaf has applied the command node's changes for one project. */
export const getTicketSyncCursorCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "get_ticket_sync_cursor",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({ controllerId: optionalUnknown, projectId: optionalUnknown }),
  result: Schema.Struct({
    cursor: optionalSequence,
    epoch: Schema.optionalKey(Schema.String),
    pending: optionalSequence,
  }),
  critical: [],
});

/** The leaf's queued board changes for one command node, after a sequence number. */
export const collectTicketSyncOutboxCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "collect_ticket_sync_outbox",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    after: optionalUnknown,
    // What the command node can apply (`TICKET_SYNC_FEATURES`). A leaf that
    // ignores it never queues a change the command node cannot read.
    features: optionalUnknown,
  }),
  result: Schema.Struct({
    epoch: Schema.optionalKey(Schema.NullOr(Schema.String)),
    // Each item is parsed by the command node (`parseTicketSyncOutboxItem`).
    items: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    more: Schema.optionalKey(Schema.Boolean),
    // Images a board here shows whose bytes the command node delivers (`put_ticket_image`).
    wantedImages: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  critical: [],
});

export const ackTicketSyncOutboxCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "ack_ticket_sync_outbox",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    epoch: optionalUnknown,
    upTo: optionalUnknown,
  }),
  result: Schema.Struct({ remaining: optionalSequence }),
  critical: [],
});

/**
 * Where each leaf with a copy of the project stands (command node, for the
 * board). `workspace` (plan item 7012): the Kanban board's sync strip reads
 * it, through a workspace grant too, and the old deny-lists always let it
 * through.
 */
export const getTicketSyncStatusCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "get_ticket_sync_status",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: optionalUnknown }),
  result: Schema.Struct({
    projectId: Schema.String,
    // `TicketSyncNodeState` and `TicketSyncConflict` from `ticket-sync.ts`.
    nodes: Schema.Array(Schema.Unknown),
    conflicts: Schema.Array(Schema.Unknown),
    conflictCount: optionalSequence,
  }),
  critical: [],
});

/**
 * An image's bytes, read by the command node from the leaf that holds them
 * (leaf side, over the link only). No `data` when the leaf does not have them
 * or the image is not on a board that command node syncs.
 */
export const readTicketImageCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "read_ticket_image",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({ controllerId: optionalUnknown, imageId: optionalUnknown }),
  result: Schema.Struct({ data: Schema.optionalKey(Schema.String) }),
  critical: [],
});

/**
 * An image the leaf asked for (`wantedImages`), delivered by the command node
 * (leaf side, over the link only). No `data`: the image is unavailable.
 */
export const putTicketImageCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "put_ticket_image",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    imageId: optionalUnknown,
    data: optionalUnknown,
  }),
  result: Schema.Struct({ stored: Schema.Boolean }),
  critical: [],
});

/**
 * A leaf board's sync line (`TicketSyncLeafStatus`): the command nodes it
 * holds copies from, the tickets Share would send, and the copy of the
 * repository that syncs when this one does not. `workspace`: the board reads
 * it through a workspace grant too.
 */
export const getTicketSyncLeafStatusCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "get_ticket_sync_leaf_status",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: optionalUnknown }),
  result: Schema.Struct({
    projectId: Schema.String,
    controllers: Schema.Array(Schema.Unknown),
    unshared: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    syncedCopy: Schema.optionalKey(Schema.Unknown),
  }),
  critical: [],
});

/**
 * Leaf: sends tickets made here before sync began to the command node
 * (`taskIds`, or every one). Only the user's explicit action calls it.
 */
export const shareTicketsWithCommandNodeCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "share_tickets_with_command_node",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: optionalUnknown, taskIds: optionalUnknown }),
  result: Schema.Struct({ shared: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  critical: [],
});

/** Command node: removes conflicts from a board's list (`ids`, or all); their ticket comments stay. */
export const dismissTicketSyncConflictsCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "dismiss_ticket_sync_conflicts",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: optionalUnknown, ids: optionalUnknown }),
  result: Schema.Struct({
    dismissed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    remaining: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  critical: [],
});

/** Sync one node, or every node, now (command node). */
export const syncNodeTicketsCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "sync_node_tickets",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ nodeId: optionalUnknown }),
  result: Schema.Struct({ nodes: Schema.Array(Schema.Unknown) }),
  critical: [],
});

/**
 * A coordinator's ticket action on another node's copy of its project
 * (command node; called in process by the Control MCP ticket tools). `scope`
 * is the coordinator's, `action` one of create, list, get, update, comment,
 * and `input` the action's fields (the handler reads and checks each).
 */
export const coordinatorNodeTicketCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "coordinator_node_ticket",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    nodeId: optionalUnknown,
    action: optionalUnknown,
    input: optionalUnknown,
  }),
  // `{ self: true }` for this node; otherwise the ticket or tickets, where
  // they are, and whether (and how far) the leaf has this board's copy.
  result: openRecord({
    self: Schema.optional(Schema.Boolean),
    ticket: Schema.optional(KanbanTaskSchema),
    tickets: Schema.optional(KanbanTaskListSchema),
    nodeId: Schema.optional(Schema.String),
    node: Schema.optional(Schema.String),
    synced: Schema.optional(Schema.Boolean),
    // `TicketSyncNodeState`'s `state` and `message`.
    sync: Schema.optional(
      openRecord({ state: Schema.String, message: Schema.optional(Schema.String) }),
    ),
    note: Schema.optional(Schema.String),
  }),
  critical: [],
});

/** Every `ticket-sync` command definition, in registration order. */
export const TICKET_SYNC_COMMANDS = [
  applyTicketSyncCommand,
  getTicketSyncCursorCommand,
  collectTicketSyncOutboxCommand,
  ackTicketSyncOutboxCommand,
  getTicketSyncStatusCommand,
  syncNodeTicketsCommand,
  coordinatorNodeTicketCommand,
  readTicketImageCommand,
  putTicketImageCommand,
  getTicketSyncLeafStatusCommand,
  shareTicketsWithCommandNodeCommand,
  dismissTicketSyncConflictsCommand,
] as const;
