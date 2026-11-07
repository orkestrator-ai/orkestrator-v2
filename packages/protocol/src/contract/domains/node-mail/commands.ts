/**
 * `node-mail` commands (plan item 1010; docs/reports/unified-federation.md
 * §11.2): mail between a command node and its leaves, the leaf outbox the
 * command node collects, and the command node's action requests.
 *
 * Every command here was strict before (`assertOnlyKeys`); the argument
 * schemas declare exactly those keys, and a defined command decodes them
 * tolerantly (unknown keys dropped, §11.4). Values a handler or its service
 * already checks with its own message stay `Unknown` or optional here, so the
 * error a caller sees is unchanged.
 *
 * Results crossing the node link are read by older and newer peers, so their
 * fields are optional: a pre-contract leaf, or a fake in a test, may answer
 * less, and a caller decides what a missing field means (it did before).
 *
 * The lenient neighbours 1010 left as string commands (the mailed images'
 * receiving end and a leaf coordinator's mail up to its command node) were
 * defined on 2026-11-07 (plan item 7009): every key their handlers read is
 * `optionalKey(Unknown)`, so the handlers' own checks (`parseRecipient`,
 * `parseMailAttachmentBatch`, `coordinatorCaller`, `nonBlank`) still give the
 * error text, and nothing accepted before is refused.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { AgentMailAttachment } from "../../../agent-mail.js";
import { defineCommand } from "../../command.js";
import { modelRecord, mutableArray, openRecord } from "../../model-schema.js";
import { nodeMailDomain } from "./domain.js";

const optionalString = Schema.optionalKey(Schema.String);
const optionalBoolean = Schema.optionalKey(Schema.Boolean);
const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/** A non-negative safe integer on the wire (sequence numbers, cursors). */
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Mail from a command node's coordinator, delivered on the leaf. */
export const deliverNodeMailCommand = defineCommand({
  domain: nodeMailDomain,
  name: "deliver_node_mail",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalString,
    coordinatorEnvironmentId: optionalString,
    coordinatorTabId: optionalString,
    requestId: optionalString,
    toEnvironmentId: optionalString,
    toTabId: optionalString,
    subject: optionalString,
    body: optionalString,
    steer: optionalBoolean,
    /** The coordinator's turn was not started by the user (`node-mail-turn-origin`). */
    turnOrigin: optionalString,
    nodeParent: optionalUnknown,
    /** The leaf's project, for mail to its coordinator ("coordinator"). */
    projectId: optionalString,
    /** Images already in this node's spool (`node-mail-attachments`). */
    attachments: optionalUnknown,
  }),
  result: Schema.Struct({
    messageId: optionalString,
    toEnvironmentId: optionalString,
    toTabId: optionalString,
    toEnvironmentName: optionalString,
    toTabName: optionalString,
    placement: optionalString,
    placementReason: optionalString,
    injectedVia: optionalString,
    deliverNow: optionalString,
    deliverNowNote: optionalString,
    attachments: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
  // steer: ignoring it silently does not steer the worker (§11.2).
  // requestId: the leaf's idempotency key; without it a retry delivers twice.
  // nodeParent: carries the hop count that stops two coordinators waking each other.
  // attachments: ignoring it would deliver the mail without its images.
  critical: ["steer", "requestId", "nodeParent", "attachments"],
});

/** Whether a project on the leaf has a coordinator a command node's coordinator can mail. */
export const getNodeProjectCoordinatorCommand = defineCommand({
  domain: nodeMailDomain,
  name: "get_node_project_coordinator",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({ projectId: optionalUnknown }),
  result: Schema.Struct({
    hasCoordinator: optionalBoolean,
    main: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          title: optionalString,
          agent: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
  critical: [],
});

/** Whether coordinator mail to a worker tab has reached a turn yet. */
export const getWorkerRequestStateCommand = defineCommand({
  domain: nodeMailDomain,
  name: "get_worker_request_state",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({ environmentId: optionalUnknown, tabId: optionalUnknown }),
  result: Schema.Struct({
    backgroundWorkPending: optionalBoolean,
    requestPending: optionalBoolean,
  }),
  critical: [],
});

/** Reports from a leaf environment go back to this coordinator conversation. */
export const recordNodeEnvironmentOriginCommand = defineCommand({
  domain: nodeMailDomain,
  name: "record_node_environment_origin",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    environmentId: optionalUnknown,
    controllerId: optionalUnknown,
    coordinatorEnvironmentId: optionalUnknown,
    coordinatorTabId: optionalUnknown,
  }),
  result: Schema.Struct({ recorded: Schema.optionalKey(Schema.Literal(true)) }),
  critical: [],
});

/**
 * The flags a command node sends with `collect_node_outbox` and
 * `ack_node_outbox` to say which kinds of queued mail it takes. A receiver
 * that ignores one keeps that mail queued, which is safe, so none is critical.
 */
const outboxFlags = {
  coordinatorMail: optionalBoolean,
  coordinatorNotices: optionalUnknown,
  attachmentMail: optionalBoolean,
};

/** The leaf's queued mail for one command node, after a sequence number. */
export const collectNodeOutboxCommand = defineCommand({
  domain: nodeMailDomain,
  name: "collect_node_outbox",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ controllerId: optionalUnknown, after: optionalUnknown, ...outboxFlags }),
  result: Schema.Struct({
    // Each item is parsed by the collector, which skips what it cannot read.
    items: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    more: optionalBoolean,
  }),
  critical: [],
});

/** Acknowledges delivered outbox mail: `upTo` contiguously, `sequences` individually. */
export const ackNodeOutboxCommand = defineCommand({
  domain: nodeMailDomain,
  name: "ack_node_outbox",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    upTo: optionalUnknown,
    sequences: optionalUnknown,
    ...outboxFlags,
  }),
  result: Schema.Struct({ remaining: Schema.optionalKey(Sequence) }),
  critical: [],
});

/** Hands one queued item back to the leaf's own coordinator. */
export const returnNodeOutboxMailCommand = defineCommand({
  domain: nodeMailDomain,
  name: "return_node_outbox_mail",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ controllerId: optionalUnknown, seq: optionalUnknown }),
  result: Schema.Struct({ returned: Schema.optionalKey(Schema.Literal(true)) }),
  critical: [],
});

/**
 * An action request as the command node keeps it. Only the fields every
 * kind has are described; the rest (targets, the kind's own fields, the
 * decision) pass through unchanged. Converging the full record with the
 * renderer's model is plan item 7010. An open record (2026-11-07): as a
 * plain struct a version-1 decode dropped every other key, which the
 * window's approvals list (`listNodeActionRequests`) reads.
 */
export const NodeActionRequestSchema = openRecord({
  requestId: Schema.String,
  kind: Schema.String,
  state: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});

/** A coordinator asks; the user decides (command node). */
export const createNodeActionRequestCommand = defineCommand({
  domain: nodeMailDomain,
  name: "create_node_action_request",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    requestId: optionalUnknown,
    kind: optionalUnknown,
    targets: optionalUnknown,
    requestedBy: optionalUnknown,
    reason: optionalUnknown,
    agentsMd: optionalUnknown,
    workerQuestion: optionalUnknown,
    projectHomeMessage: optionalUnknown,
    askedBecause: optionalUnknown,
  }),
  result: NodeActionRequestSchema,
  // requestId: a retried request must replay the first one, not ask twice.
  critical: ["requestId"],
});

export const listNodeActionRequestsCommand = defineCommand({
  domain: nodeMailDomain,
  name: "list_node_action_requests",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({ pendingOnly: optionalUnknown }),
  result: Schema.Array(NodeActionRequestSchema),
  critical: [],
});

export const resolveNodeActionRequestCommand = defineCommand({
  domain: nodeMailDomain,
  name: "resolve_node_action_request",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    requestId: optionalUnknown,
    decision: optionalUnknown,
    approval: optionalUnknown,
  }),
  result: NodeActionRequestSchema,
  critical: [],
});

/**
 * The two receiving-end commands of a coordinator's mailed images: the
 * recipient (`{ environmentId }` or `{ projectId }`, checked by
 * `parseRecipient`) and the batch (`{ batch, files }`, checked by
 * `parseMailAttachmentBatch`), each with its own message.
 */
const mailAttachmentArgs = Schema.Struct({ to: optionalUnknown, attachments: optionalUnknown });

/** One placed image, as the recipient's mail records it. */
export const AgentMailAttachmentSchema = modelRecord<AgentMailAttachment>()({
  name: Schema.String,
  path: Schema.String,
});

/**
 * Which of a batch's images are not at the recipient yet; refuses a recipient
 * that cannot take them before any bytes move. Called here and, over the node
 * link, by a command node pushing images to a leaf.
 */
export const prepareNodeMailAttachmentsCommand = defineCommand({
  domain: nodeMailDomain,
  name: "prepare_node_mail_attachments",
  since: 1,
  access: "internal",
  read: false,
  args: mailAttachmentArgs,
  result: Schema.Struct({ missing: mutableArray(Schema.String) }),
  critical: [],
});

/** Puts a spooled batch where the recipient reads it; answers what the mail records. */
export const placeNodeMailAttachmentsCommand = defineCommand({
  domain: nodeMailDomain,
  name: "place_node_mail_attachments",
  since: 1,
  access: "internal",
  read: false,
  args: mailAttachmentArgs,
  result: Schema.Struct({ attachments: mutableArray(AgentMailAttachmentSchema) }),
  critical: [],
});

/**
 * A leaf's main coordinator writes to its command node's coordinator: queued
 * in the leaf's outbox until the command node collects it. Called in process
 * by the leaf's Control MCP mail tools.
 */
export const sendCoordinatorCommandNodeMailCommand = defineCommand({
  domain: nodeMailDomain,
  name: "send_coordinator_command_node_mail",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    scope: optionalUnknown,
    requestId: optionalUnknown,
    subject: optionalUnknown,
    body: optionalUnknown,
    replyToMessageId: optionalUnknown,
    attachments: optionalUnknown,
  }),
  result: openRecord({
    outboxSeq: Schema.Finite,
    toEnvironmentId: Schema.String,
    placement: Schema.String,
    coordinatorDelegationOpened: Schema.Boolean,
    replyToMessageId: Schema.optional(Schema.String),
    /** The names of the images queued with it. */
    attachments: Schema.optional(mutableArray(Schema.String)),
    coordinator: Schema.optional(Schema.String),
    deliveryHint: Schema.optional(Schema.String),
  }),
  // requestId: the outbox's idempotency key; ignored, a retry queues the mail twice.
  // attachments: ignored, the mail goes up without its images.
  // replyToMessageId: ignored, the reply loses its thread and the request stays in the inbox.
  critical: ["requestId", "attachments", "replyToMessageId"],
});

/** Every `node-mail` command definition, in registration order. */
export const NODE_MAIL_COMMANDS = [
  deliverNodeMailCommand,
  getNodeProjectCoordinatorCommand,
  getWorkerRequestStateCommand,
  recordNodeEnvironmentOriginCommand,
  collectNodeOutboxCommand,
  ackNodeOutboxCommand,
  returnNodeOutboxMailCommand,
  createNodeActionRequestCommand,
  listNodeActionRequestsCommand,
  resolveNodeActionRequestCommand,
  prepareNodeMailAttachmentsCommand,
  placeNodeMailAttachmentsCommand,
  sendCoordinatorCommandNodeMailCommand,
] as const;
