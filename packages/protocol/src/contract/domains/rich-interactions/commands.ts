/**
 * `rich-interactions` commands. Ownership is never an argument the backend
 * trusts for authority: every command names its environment, the backend
 * checks the stored request belongs to it, and a request's destination
 * session is the one stored when it was created. Kind-specific specs and
 * results are validated by the protocol's kind registry
 * (`@orkestrator/protocol/rich-interactions`), so they travel as opaque JSON
 * here and fail closed in the handler with a path.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import {
  RICH_INTERACTION_KINDS,
  RICH_INTERACTION_LIMITS,
  type RichInteractionReceipt,
  type RichInteractionRequest,
} from "../../../rich-interactions/core.js";
import { defineCommand } from "../../command.js";
import { modelRecord, opaqueRecord } from "../../model-schema.js";
import { richInteractionsDomain } from "./domain.js";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Key = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(RICH_INTERACTION_LIMITS.idempotencyKeyChars),
);
const Revision = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER - 1),
);
const LogicalSessionKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));

const RequestRecord = modelRecord<RichInteractionRequest>()({
  interactionId: Schema.String,
  revision: Schema.Finite,
  kind: Schema.String,
  state: Schema.String,
});
const ReceiptRecord = modelRecord<RichInteractionReceipt>()({
  receiptId: Schema.String,
  interactionId: Schema.String,
  delivery: Schema.String,
});

/** One request with its receipts, draft and action availability (`RichInteractionView`). */
export interface RichInteractionViewRecord {
  request: RichInteractionRequest;
  receipts: RichInteractionReceipt[];
  draft: {
    interactionId: string;
    requestRevision: number;
    revision: number;
    value: unknown;
    updatedAt: string;
  } | null;
  actions: Array<
    RichInteractionRequest["actions"][number] & { available: boolean; unavailableReason?: string }
  >;
  open: boolean;
}

const ViewRecord = opaqueRecord<RichInteractionViewRecord>();

export interface RichDeliverableRecord {
  deliverableId: string;
  logicalSessionKey: string;
  artifactId: string;
  pinned: boolean;
  userLabel?: string;
  selectedRevision?: number;
  acceptedRevision?: number;
  group?: string;
  revision: number;
  updatedAt: string;
}

const DeliverableRecord = modelRecord<RichDeliverableRecord>()({
  deliverableId: Schema.String,
  artifactId: Schema.String,
  revision: Schema.Finite,
});

export const richInteractionsListCommand = defineCommand({
  domain: richInteractionsDomain,
  name: "rich_interactions_list",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: Id,
    logicalSessionKey: Schema.optionalKey(LogicalSessionKey),
  }),
  result: Schema.Array(ViewRecord),
  critical: [],
});

export const richInteractionGetCommand = defineCommand({
  domain: richInteractionsDomain,
  name: "rich_interaction_get",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Id, interactionId: Id }),
  result: ViewRecord,
  critical: [],
});

export const richInteractionSaveDraftCommand = defineCommand({
  domain: richInteractionsDomain,
  name: "rich_interaction_save_draft",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    interactionId: Id,
    expectedDraftRevision: Revision,
    requestRevision: Revision,
    value: Schema.Unknown,
  }),
  result: opaqueRecord<NonNullable<RichInteractionViewRecord["draft"]>>(),
  critical: ["expectedDraftRevision"],
});

export const richInteractionClearDraftCommand = defineCommand({
  domain: richInteractionsDomain,
  name: "rich_interaction_clear_draft",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, interactionId: Id }),
  result: Schema.Struct({ ok: Schema.Boolean }),
  critical: [],
});

export const richInteractionSubmitCommand = defineCommand({
  domain: richInteractionsDomain,
  name: "rich_interaction_submit",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    interactionId: Id,
    expectedRevision: Revision,
    expectedDraftRevision: Schema.optionalKey(Revision),
    actionId: Id,
    idempotencyKey: Key,
    result: Schema.Unknown,
  }),
  result: ReceiptRecord,
  critical: ["expectedRevision", "idempotencyKey"],
});

export const richInteractionComposeCommand = defineCommand({
  domain: richInteractionsDomain,
  name: "rich_interaction_compose",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    tabId: Id,
    kind: Schema.Literals(RICH_INTERACTION_KINDS),
    title: Schema.String.check(Schema.isMaxLength(RICH_INTERACTION_LIMITS.titleChars)),
    spec: Schema.Unknown,
    sourceRefs: Schema.optionalKey(Schema.Unknown),
    actionId: Id,
    idempotencyKey: Key,
    result: Schema.Unknown,
  }),
  result: Schema.Struct({ request: RequestRecord, receipt: ReceiptRecord }),
  critical: ["idempotencyKey"],
});

export const richInteractionDismissCommand = defineCommand({
  domain: richInteractionsDomain,
  name: "rich_interaction_dismiss",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, interactionId: Id, expectedRevision: Revision }),
  result: RequestRecord,
  critical: ["expectedRevision"],
});

export const richInteractionRetryDeliveryCommand = defineCommand({
  domain: richInteractionsDomain,
  name: "rich_interaction_retry_delivery",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ environmentId: Id, receiptId: Id }),
  result: ReceiptRecord,
  critical: [],
});

export const richDeliverablesListCommand = defineCommand({
  domain: richInteractionsDomain,
  name: "rich_deliverables_list",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Id, logicalSessionKey: LogicalSessionKey }),
  result: Schema.Array(DeliverableRecord),
  critical: [],
});

export const richDeliverableUpdateCommand = defineCommand({
  domain: richInteractionsDomain,
  name: "rich_deliverable_update",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    environmentId: Id,
    logicalSessionKey: LogicalSessionKey,
    artifactId: Id,
    expectedRevision: Revision,
    pinned: Schema.optionalKey(Schema.Boolean),
    userLabel: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
    selectedRevision: Schema.optionalKey(Schema.NullOr(Revision)),
    group: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)))),
  }),
  result: DeliverableRecord,
  critical: ["expectedRevision"],
});

export const RICH_INTERACTIONS_COMMANDS = [
  richInteractionsListCommand,
  richInteractionGetCommand,
  richInteractionSaveDraftCommand,
  richInteractionClearDraftCommand,
  richInteractionSubmitCommand,
  richInteractionComposeCommand,
  richInteractionDismissCommand,
  richInteractionRetryDeliveryCommand,
  richDeliverablesListCommand,
  richDeliverableUpdateCommand,
] as const;
