/**
 * `graphs` commands of the template library (item 109) and template sharing
 * (item 405). Registered by the backend's `commands-registry-graphs.ts` and
 * `commands-registry-graph-sharing.ts`.
 *
 * Argument rules: every key a handler reads is declared, since a defined
 * command drops undeclared keys before the handler runs. The handlers keep
 * their own validators, which throw a coded `GraphTemplateError`
 * (`invalid-request`) with their own text, so those keys are
 * `optionalKey(Unknown)` and every code and message is unchanged. The
 * handlers no longer refuse unknown keys (a defined command is tolerant).
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { graphsDomain } from "./domain.js";
import {
  GraphProjectCeilingSchema,
  GraphProjectTemplateReviewDecisionSchema,
  GraphProjectTemplateReviewSchema,
  GraphSharingKeysSchema,
  GraphTemplateCompileResponseSchema,
  GraphTemplateDeleteResultSchema,
  GraphTemplateDetailSchema,
  GraphTemplateExportSchema,
  GraphTemplateImportResultSchema,
  GraphTemplatesListResultSchema,
  GraphTemplateShareExportSchema,
  GraphTemplateShareImportResultSchema,
  GraphTemplateTrustResultSchema,
} from "./schemas.js";

/** A key the handler validates itself, with its own coded error. */
const checked = Schema.optionalKey(Schema.Unknown);

export const graphTemplatesListCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_templates_list",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: checked }),
  result: GraphTemplatesListResultSchema,
  critical: [],
});

export const graphTemplateGetCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_template_get",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ ref: checked, projectId: checked }),
  result: GraphTemplateDetailSchema,
  critical: [],
});

export const graphTemplateSaveCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_template_save",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ template: checked, expectedRevision: checked, projectId: checked }),
  result: GraphTemplateDetailSchema,
  critical: ["expectedRevision"],
});

export const graphTemplateDeleteCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_template_delete",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ id: checked, expectedRevision: checked }),
  result: GraphTemplateDeleteResultSchema,
  critical: ["expectedRevision"],
});

export const graphTemplateDuplicateCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_template_duplicate",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    ref: checked,
    id: checked,
    name: checked,
    digest: checked,
    projectId: checked,
  }),
  result: GraphTemplateDetailSchema,
  critical: ["digest"],
});

export const graphTemplateCompileCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_template_compile",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    ref: checked,
    template: checked,
    projectId: checked,
    includePlan: checked,
    forLaunch: checked,
  }),
  result: GraphTemplateCompileResponseSchema,
  critical: [],
});

export const graphTemplateImportCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_template_import",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ text: checked, projectId: checked }),
  result: GraphTemplateImportResultSchema,
  critical: [],
});

export const graphTemplateExportCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_template_export",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ ref: checked }),
  result: GraphTemplateExportSchema,
  critical: [],
});

export const graphTemplateTrustCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_template_trust",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: checked, path: checked, action: checked, digest: checked }),
  result: GraphTemplateTrustResultSchema,
  critical: [],
});

export const graphCapabilityCeilingGetCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_capability_ceiling_get",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: checked }),
  result: GraphProjectCeilingSchema,
  critical: [],
});

/**
 * `admin`: the machine's ceiling on what graph runs may do, which a workspace
 * grant has always been refused (plan item 7012).
 */
export const graphCapabilityCeilingSetCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_capability_ceiling_set",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ projectId: checked, ceiling: checked, expectedRevision: checked }),
  result: GraphProjectCeilingSchema,
  critical: ["expectedRevision"],
});

// --------------------------------------------------------------- sharing (item 405)

export const graphTemplateShareExportCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_template_share_export",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ ref: checked, sign: checked, author: checked }),
  result: GraphTemplateShareExportSchema,
  critical: [],
});

export const graphTemplateShareImportCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_template_share_import",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ text: checked, projectId: checked, confirmDigest: checked }),
  result: GraphTemplateShareImportResultSchema,
  critical: [],
});

/** `create: true` makes the installation's key, so this is not a read. */
export const graphSharingKeysCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_sharing_keys",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ create: checked }),
  result: GraphSharingKeysSchema,
  critical: [],
});

export const graphSharingKeyTrustCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_sharing_key_trust",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ action: checked, publicKey: checked, label: checked }),
  result: GraphSharingKeysSchema,
  critical: [],
});

export const graphProjectTemplateReviewCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_project_template_review",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: checked, path: checked }),
  result: GraphProjectTemplateReviewSchema,
  critical: [],
});

export const graphProjectTemplateReviewDecideCommand = defineCommand({
  domain: graphsDomain,
  name: "graph_project_template_review_decide",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ projectId: checked, path: checked, digest: checked, decision: checked }),
  result: GraphProjectTemplateReviewDecisionSchema,
  critical: [],
});

export const GRAPH_TEMPLATE_COMMANDS = [
  graphTemplatesListCommand,
  graphTemplateGetCommand,
  graphTemplateSaveCommand,
  graphTemplateDeleteCommand,
  graphTemplateDuplicateCommand,
  graphTemplateCompileCommand,
  graphTemplateImportCommand,
  graphTemplateExportCommand,
  graphTemplateTrustCommand,
  graphCapabilityCeilingGetCommand,
  graphCapabilityCeilingSetCommand,
  graphTemplateShareExportCommand,
  graphTemplateShareImportCommand,
  graphSharingKeysCommand,
  graphSharingKeyTrustCommand,
  graphProjectTemplateReviewCommand,
  graphProjectTemplateReviewDecideCommand,
] as const;
