/**
 * `git` commands of the changes ledger (plan item 7006;
 * docs/architecture/change-tracking.md#client-contract): change projections,
 * file pages, tool and turn presentations, diff bodies, refresh fences,
 * handoff text and restore.
 *
 * Argument schemas declare every key the handler reads and decode tolerantly
 * (§11.4). The handlers bound every identifier with their own text
 * (`resourceKey must be a non-empty string`); a required key is a
 * `Schema.String` carrying that text as its `message`, so a missing or
 * non-string value reads exactly as before, and the handler still checks
 * emptiness and length. An optional key (which also accepts `null`), a list
 * and the nested `display` stay `optionalKey(Unknown)` and keep the
 * handler's own checks and text.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { gitDomain } from "./domain.js";
import {
  ChangesApplyRestoreResultSchema,
  ChangesGetDiffResultSchema,
  ChangesGetFilesResultSchema,
  ChangesGetHandoffResultSchema,
  ChangesGetHistoryResultSchema,
  ChangesPrepareRestoreResultSchema,
  ChangesRefreshResultSchema,
  ChangesResolveLiveDetailResultSchema,
  ChangeThreadResourceSchema,
  ChangeTrackingCapabilitiesSchema,
  ChangeTrackingDiagnosticsSchema,
  ChangeViewResultSchema,
  LegacyPayloadSummarySchema,
  ToolChangePresentationsSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/** A required identifier, with the handler's own text when it is missing or not a string. */
function text(field: string) {
  return Schema.String.annotate({ message: `${field} must be a non-empty string` });
}

export const changesGetViewCommand = defineCommand({
  domain: gitDomain,
  name: "changes_get_view",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    resourceKey: text("resourceKey"),
    knownGeneration: optionalUnknown,
    knownRevision: optionalUnknown,
    pageSize: optionalUnknown,
  }),
  result: ChangeViewResultSchema,
  critical: [],
});

export const changesGetFilesCommand = defineCommand({
  domain: gitDomain,
  name: "changes_get_files",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    resourceKey: text("resourceKey"),
    snapshotToken: text("snapshotToken"),
    cursor: optionalUnknown,
    pageSize: optionalUnknown,
  }),
  result: ChangesGetFilesResultSchema,
  critical: [],
});

export const changesGetToolPresentationsCommand = defineCommand({
  domain: gitDomain,
  name: "changes_get_tool_presentations",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: text("environmentId"),
    provider: text("provider"),
    conversationId: text("conversationId"),
    // A bounded list with its own text ("callIds must be a list").
    callIds: optionalUnknown,
  }),
  result: ToolChangePresentationsSchema,
  critical: [],
});

export const changesGetHistoryCommand = defineCommand({
  domain: gitDomain,
  name: "changes_get_history",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: text("environmentId"),
    logicalSessionKey: text("logicalSessionKey"),
    cursor: optionalUnknown,
    pageSize: optionalUnknown,
  }),
  result: ChangesGetHistoryResultSchema,
  critical: [],
});

export const changesGetThreadCommand = defineCommand({
  domain: gitDomain,
  name: "changes_get_thread",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    environmentId: text("environmentId"),
    logicalSessionKey: text("logicalSessionKey"),
  }),
  result: ChangeThreadResourceSchema,
  critical: [],
});

export const changesResolveLiveDetailCommand = defineCommand({
  domain: gitDomain,
  name: "changes_resolve_live_detail",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    resourceKey: text("resourceKey"),
    revision: optionalUnknown,
    rowId: optionalUnknown,
    pathId: optionalUnknown,
    path: optionalUnknown,
  }),
  result: ChangesResolveLiveDetailResultSchema,
  critical: [],
});

export const changesGetDiffCommand = defineCommand({
  domain: gitDomain,
  name: "changes_get_diff",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    diffIdentityId: text("diffIdentityId"),
    cursor: optionalUnknown,
    // `{ whitespace?, contextLines? }`, read leniently (an unknown whitespace mode preserves).
    display: optionalUnknown,
  }),
  result: ChangesGetDiffResultSchema,
  critical: [],
});

export const changesRefreshCommand = defineCommand({
  domain: gitDomain,
  name: "changes_refresh",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ resourceKey: text("resourceKey") }),
  result: ChangesRefreshResultSchema,
  critical: [],
});

export const changesGetHandoffCommand = defineCommand({
  domain: gitDomain,
  name: "changes_get_handoff",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ measurementIds: optionalUnknown, maxCharacters: optionalUnknown }),
  result: ChangesGetHandoffResultSchema,
  critical: [],
});

export const changesPrepareRestoreCommand = defineCommand({
  domain: gitDomain,
  name: "changes_prepare_restore",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ measurementId: text("measurementId"), pathIds: optionalUnknown }),
  result: ChangesPrepareRestoreResultSchema,
  critical: ["pathIds"],
});

export const changesApplyRestoreCommand = defineCommand({
  domain: gitDomain,
  name: "changes_apply_restore",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    actionToken: text("actionToken"),
    idempotencyKey: text("idempotencyKey"),
  }),
  result: ChangesApplyRestoreResultSchema,
  critical: [],
});

export const changesGetDiagnosticsCommand = defineCommand({
  domain: gitDomain,
  name: "changes_get_diagnostics",
  since: 1,
  // Machine-wide operator counters; no client calls it.
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: ChangeTrackingDiagnosticsSchema,
  critical: [],
});

/**
 * What change tracking offers on this backend. The protocol fields
 * (`capability`, `history`, `gitScopes`, `operationVolume`) are implied by
 * `git` version 1; `restore`, `strictCheckpoints` and `policyVersion` are the
 * backend's policy, so the version-1 client still asks for them.
 */
export const changesGetCapabilitiesCommand = defineCommand({
  domain: gitDomain,
  name: "changes_get_capabilities",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: ChangeTrackingCapabilitiesSchema,
  critical: [],
});

/** Measures a transcript tool payload recorded before canonical evidence (not persisted). */
export const changesMeasureLegacyPayloadCommand = defineCommand({
  domain: gitDomain,
  name: "changes_measure_legacy_payload",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    toolName: optionalUnknown,
    filePath: optionalUnknown,
    // Sides may be empty strings (an empty file); bounded by the handler.
    before: optionalUnknown,
    after: optionalUnknown,
    diff: optionalUnknown,
    additions: optionalUnknown,
    deletions: optionalUnknown,
  }),
  result: LegacyPayloadSummarySchema,
  critical: [],
});

export const CHANGES_COMMANDS = [
  changesGetViewCommand,
  changesGetFilesCommand,
  changesGetToolPresentationsCommand,
  changesGetHistoryCommand,
  changesGetThreadCommand,
  changesResolveLiveDetailCommand,
  changesGetDiffCommand,
  changesRefreshCommand,
  changesGetHandoffCommand,
  changesPrepareRestoreCommand,
  changesApplyRestoreCommand,
  changesGetDiagnosticsCommand,
  changesGetCapabilitiesCommand,
  changesMeasureLegacyPayloadCommand,
] as const;
