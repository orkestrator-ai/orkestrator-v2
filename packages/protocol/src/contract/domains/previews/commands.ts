/**
 * `previews` commands (plan item 7004): the backend's preview service
 * registry, scoped access (desktop tunnel, browser bootstrap, iOS handoff),
 * publication, diagnostics and the operator's preview settings.
 *
 * The handlers were lenient (they read named keys and ignored the rest) and
 * validate their arguments themselves, answering a `PreviewError` whose
 * message carries the `PreviewError:` marker the clients parse into a
 * category. So each argument a handler checks is `optionalKey(Unknown)` here:
 * a schema refusal would lose that marker and refuse values the handler
 * accepts today (§11.4). The argument keys are exactly the ones the handlers
 * read; decoding drops any other key, which they ignored before.
 *
 * Results are the registry's and the access service's records. Preview
 * services keep their own response-level versioning (`protocolVersion`,
 * per-surface availability, the backend epoch and registry revision), which
 * the schemas declare; the snapshot records are {@link modelRecord}s that
 * validate their identity and state fields and pass the rest through.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { PreviewAttachmentDescriptor } from "../../../preview-access.js";
import {
  PREVIEW_ENDPOINT_STATES,
  PREVIEW_PROVENANCE_KINDS,
  PREVIEW_SCHEMES,
  PREVIEW_TARGET_KINDS,
  type PreviewCapabilities,
  type PreviewRegistrySnapshot,
  type PreviewServiceDefinition,
  type PreviewServiceSnapshot,
} from "../../../preview-services.js";
import { defineCommand } from "../../command.js";
import { modelRecord } from "../../model-schema.js";
import { previewsDomain } from "./domain.js";

const checked = Schema.optionalKey(Schema.Unknown);
const Scheme = Schema.Literals(PREVIEW_SCHEMES);
const TargetKind = Schema.Literals(PREVIEW_TARGET_KINDS);
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Finite;

/** A service definition: its identity, revision and the fields clients branch on. */
export const PreviewServiceDefinitionSchema = modelRecord<PreviewServiceDefinition>()({
  serviceId: Schema.String,
  environmentId: Schema.String,
  label: Schema.String,
  targetKind: TargetKind,
  applicationPort: Count,
  scheme: Scheme,
  provenance: Schema.Literals(PREVIEW_PROVENANCE_KINDS),
  userOverride: Schema.Boolean,
  entry: Schema.Boolean,
  enabled: Schema.Boolean,
  definitionRevision: Revision,
});

/** A service: its definition and its endpoint's state. */
export const PreviewServiceSnapshotSchema = modelRecord<PreviewServiceSnapshot>()({
  definition: PreviewServiceDefinitionSchema,
  endpoint: modelRecord<PreviewServiceSnapshot["endpoint"]>()({
    backendEpoch: Schema.String,
    endpointGeneration: Count,
    state: Schema.Literals(PREVIEW_ENDPOINT_STATES),
  }),
});

const SurfaceCapability = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});

/** Response-level versioning and per-surface availability (kept from before the contract). */
export const PreviewCapabilitiesSchema = modelRecord<PreviewCapabilities>()({
  protocolVersion: Count,
  backendInstanceId: Schema.String,
  backendEpoch: Schema.String,
  registry: SurfaceCapability,
  targets: Schema.Array(TargetKind),
  access: SurfaceCapability,
  surfaces: Schema.Struct({
    desktopTunnel: Schema.Struct({
      available: Schema.Boolean,
      reason: Schema.optional(Schema.String),
      upstreamSchemes: Schema.Array(Scheme),
    }),
    browserTopLevel: Schema.Struct({
      available: Schema.Boolean,
      reason: Schema.optional(Schema.String),
      upstreamSchemes: Schema.Array(Scheme),
    }),
    browserEmbedded: Schema.Struct({
      available: Schema.Boolean,
      reason: Schema.optional(Schema.String),
      platforms: Schema.Array(Schema.String),
    }),
    legacyPath: SurfaceCapability,
  }),
  relay: SurfaceCapability,
  limits: Schema.Record(Schema.String, Count),
});

/** One registry read: a full snapshot, or `notModified` when the caller's revision is current. */
export const PreviewRegistrySnapshotSchema = modelRecord<PreviewRegistrySnapshot>()({
  backendInstanceId: Schema.String,
  backendEpoch: Schema.String,
  registryRevision: Revision,
  environmentId: Schema.NullOr(Schema.String),
  notModified: Schema.Boolean,
  services: Schema.Array(PreviewServiceSnapshotSchema),
  tombstones: Schema.Array(
    Schema.Struct({
      serviceId: Schema.String,
      environmentId: Schema.String,
      registryRevision: Revision,
    }),
  ),
  tombstoneFloor: Revision,
  entryServiceId: Schema.optional(Schema.NullOr(Schema.String)),
});

/** A register, update or remove: the stored definition, or the removed id; `replayed` for a repeated operation id. */
export const PreviewMutationResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("definition"),
    definition: PreviewServiceDefinitionSchema,
    replayed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("removed"),
    serviceId: Schema.String,
    replayed: Schema.Boolean,
  }),
]);
export type PreviewMutationResult = typeof PreviewMutationResultSchema.Type;

/** What a service reference or a URL intent resolves to; never a guess. */
export const PreviewTargetResolutionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("service"),
    service: PreviewServiceSnapshotSchema,
    path: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("choose"),
    candidates: Schema.Array(PreviewServiceSnapshotSchema),
    path: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unregistered"),
    path: Schema.String,
    suggestion: Schema.Struct({
      targetKind: TargetKind,
      applicationPort: Count,
      scheme: Scheme,
    }),
    bindHint: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("manual"),
    path: Schema.String,
    scheme: Scheme,
    hostPort: Count,
  }),
]);
export type PreviewTargetResolution = typeof PreviewTargetResolutionSchema.Type;

/** A scoped attachment: lease times and either a tunnel or a bootstrap descriptor. */
export const PreviewAttachmentDescriptorSchema = modelRecord<PreviewAttachmentDescriptor>()({
  attachmentId: Schema.String,
  serviceId: Schema.String,
  environmentId: Schema.String,
  backendInstanceId: Schema.String,
  backendEpoch: Schema.String,
  endpointGeneration: Count,
  surface: Schema.Literals(["desktop-tunnel", "browser-top-level", "browser-embedded"]),
  applicationPort: Count,
  scheme: Scheme,
  expiresAt: Schema.String,
  idleExpiresAt: Schema.String,
});

/** The operator's preview settings (stored, or effective after environment overrides). */
export const PreviewSettingsShapeSchema = Schema.Struct({
  version: Schema.Literal(1),
  transport: Schema.Boolean,
  relay: Schema.Boolean,
  publication: Schema.Struct({
    enabled: Schema.Boolean,
    domain: Schema.NullOr(Schema.String),
    certFile: Schema.NullOr(Schema.String),
    keyFile: Schema.NullOr(Schema.String),
    upstreamCaFile: Schema.NullOr(Schema.String),
    listenAddress: Schema.NullOr(Schema.String),
    port: Schema.NullOr(Count),
    publicPort: Schema.NullOr(Count),
  }),
});
export type PreviewSettingsShape = typeof PreviewSettingsShapeSchema.Type;

export const PreviewSettingsResponseSchema = Schema.Struct({
  stored: PreviewSettingsShapeSchema,
  effective: PreviewSettingsShapeSchema,
});
export type PreviewSettingsResponse = typeof PreviewSettingsResponseSchema.Type;

/** The private publication's operator detail; `null` while publication is not set up. */
export const PreviewPublicationDetailSchema = Schema.Struct({
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  /** The preview domain shares a site with the app (absent from older backends). */
  warning: Schema.optional(Schema.String),
  domain: Schema.NullOr(Schema.String),
  listening: Schema.NullOr(Schema.Struct({ address: Schema.String, port: Count })),
  certificate: Schema.NullOr(
    Schema.Struct({ validTo: Schema.String, coversHosts: Schema.Boolean }),
  ),
});
export type PreviewPublicationDetail = typeof PreviewPublicationDetailSchema.Type;

const Counters = Schema.Record(Schema.String, Count);

/** Safe operator diagnostics: counts and bounded categories only. */
export const PreviewDiagnosticsSnapshotSchema = Schema.Struct({
  registry: Schema.Record(Schema.String, Schema.Union([Count, Schema.String])),
  access: Counters,
  resolver: Counters,
  readiness: Counters,
  metrics: Schema.Struct({
    counters: Counters,
    histograms: Schema.Record(
      Schema.String,
      Schema.Struct({ count: Count, p50: Count, p95: Count, max: Count }),
    ),
    gauges: Counters,
  }),
  settings: Schema.Struct({
    transport: Schema.Boolean,
    relay: Schema.Boolean,
    publicationEnabled: Schema.Boolean,
  }),
  publication: Schema.NullOr(PreviewPublicationDetailSchema),
  relay: Schema.StructWithRest(
    Schema.Struct({ available: Schema.Boolean, reason: Schema.optional(Schema.String) }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
});
export type PreviewDiagnosticsSnapshot = typeof PreviewDiagnosticsSnapshotSchema.Type;

export const getPreviewCapabilitiesCommand = defineCommand({
  domain: previewsDomain,
  name: "get_preview_capabilities",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: PreviewCapabilitiesSchema,
  critical: [],
});

export const getPreviewServicesCommand = defineCommand({
  domain: previewsDomain,
  name: "get_preview_services",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: checked, knownEpoch: checked, knownRevision: checked }),
  result: PreviewRegistrySnapshotSchema,
  critical: [],
});

export const registerPreviewServiceCommand = defineCommand({
  domain: previewsDomain,
  name: "register_preview_service",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ service: checked, operationId: checked }),
  result: PreviewMutationResultSchema,
  // operationId: the idempotency key; a receiver ignoring it would register a retry twice.
  critical: ["operationId"],
});

export const updatePreviewServiceCommand = defineCommand({
  domain: previewsDomain,
  name: "update_preview_service",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    serviceId: checked,
    expectedRevision: checked,
    patch: checked,
    operationId: checked,
  }),
  result: PreviewMutationResultSchema,
  // operationId: the idempotency key (a retried update must replay, not apply twice).
  critical: ["operationId"],
});

export const removePreviewServiceCommand = defineCommand({
  domain: previewsDomain,
  name: "remove_preview_service",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ serviceId: checked, expectedRevision: checked, operationId: checked }),
  result: PreviewMutationResultSchema,
  // expectedRevision: compare-and-set; ignoring it would delete a definition someone else changed.
  // operationId: the idempotency key.
  critical: ["expectedRevision", "operationId"],
});

export const resolvePreviewTargetCommand = defineCommand({
  domain: previewsDomain,
  name: "resolve_preview_target",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ serviceRef: checked, intent: checked }),
  result: PreviewTargetResolutionSchema,
  critical: [],
});

export const probePreviewServiceCommand = defineCommand({
  domain: previewsDomain,
  name: "probe_preview_service",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ serviceId: checked }),
  result: PreviewServiceSnapshotSchema,
  critical: [],
});

export const createPreviewAttachmentCommand = defineCommand({
  domain: previewsDomain,
  name: "create_preview_attachment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ serviceId: checked, surface: checked, clientKey: checked, path: checked }),
  result: PreviewAttachmentDescriptorSchema,
  critical: [],
});

export const renewPreviewAttachmentCommand = defineCommand({
  domain: previewsDomain,
  name: "renew_preview_attachment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ attachmentId: checked }),
  result: Schema.Struct({ idleExpiresAt: Schema.String, expiresAt: Schema.String }),
  critical: [],
});

export const releasePreviewAttachmentCommand = defineCommand({
  domain: previewsDomain,
  name: "release_preview_attachment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ attachmentId: checked }),
  result: Schema.Struct({ released: Schema.Boolean }),
  critical: [],
});

export const createPreviewHandoffUrlCommand = defineCommand({
  domain: previewsDomain,
  name: "create_preview_handoff_url",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ serviceId: checked, clientKey: checked, path: checked }),
  result: Schema.Struct({
    attachmentId: Schema.String,
    url: Schema.String,
    expiresAt: Schema.String,
  }),
  critical: [],
});

export const getPreviewPublicOriginCommand = defineCommand({
  domain: previewsDomain,
  name: "get_preview_public_origin",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ serviceId: checked }),
  result: Schema.Struct({ origin: Schema.NullOr(Schema.String) }),
  critical: [],
});

export const revokePreviewAccessCommand = defineCommand({
  domain: previewsDomain,
  name: "revoke_preview_access",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ serviceId: checked }),
  result: Schema.Struct({ revoked: Count }),
  // serviceId: without it every service's access is closed; ignoring it would widen a
  // one-service revocation to all of them.
  critical: ["serviceId"],
});

export const getPreviewDiagnosticsCommand = defineCommand({
  domain: previewsDomain,
  name: "get_preview_diagnostics",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: PreviewDiagnosticsSnapshotSchema,
  critical: [],
});

export const recordPreviewClientMetricsCommand = defineCommand({
  domain: previewsDomain,
  name: "record_preview_client_metrics",
  since: 1,
  access: "workspace",
  read: false,
  // `parsePreviewClientMetricsReport` checks the report and refuses it whole.
  args: Schema.Struct({ report: checked }),
  result: Schema.Struct({ recorded: Schema.Boolean }),
  critical: [],
});

export const getPreviewSettingsCommand = defineCommand({
  domain: previewsDomain,
  name: "get_preview_settings",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: PreviewSettingsResponseSchema,
  critical: [],
});

export const updatePreviewSettingsCommand = defineCommand({
  domain: previewsDomain,
  name: "update_preview_settings",
  since: 1,
  // The machine's preview publication: never through a workspace grant.
  access: "admin",
  read: false,
  args: Schema.Struct({ settings: checked }),
  result: PreviewSettingsResponseSchema,
  critical: [],
});

/** Every `previews` command, in registration order. */
export const PREVIEWS_COMMANDS = [
  getPreviewCapabilitiesCommand,
  getPreviewServicesCommand,
  registerPreviewServiceCommand,
  updatePreviewServiceCommand,
  removePreviewServiceCommand,
  resolvePreviewTargetCommand,
  probePreviewServiceCommand,
  createPreviewAttachmentCommand,
  renewPreviewAttachmentCommand,
  releasePreviewAttachmentCommand,
  createPreviewHandoffUrlCommand,
  getPreviewPublicOriginCommand,
  revokePreviewAccessCommand,
  getPreviewDiagnosticsCommand,
  recordPreviewClientMetricsCommand,
  getPreviewSettingsCommand,
  updatePreviewSettingsCommand,
] as const;
