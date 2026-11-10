/**
 * Result schemas of the `agent-servers` domain (plan item 7009): bridge
 * start and status answers, model catalogues, skills, plugins and the GitHub
 * CLI setup reads.
 *
 * Model-shaped records are **open structs** ({@link openRecord}): the listed
 * fields are checked and typed, and every other key the backend sends is
 * kept. A domain client decodes results tolerantly, and `Schema.Struct` drops
 * undeclared keys, so a closed struct would strip the optional fields a
 * catalogue entry or a status carries. Values a newer backend may extend
 * (platforms, sources, states) are `Schema.String`. Fields are optional
 * (`Schema.optional`, which also accepts an explicit `undefined` a handler
 * spreads) apart from the ones every handler writes and readers branch on.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { DeepMutable, Mutable } from "effect/Types";
import type { AgentModel } from "../../../native-agent.js";
import { modelRecord, mutableArray, OpenObject, openRecord } from "../../model-schema.js";

const optionalString = Schema.optional(Schema.String);
const optionalBoolean = Schema.optional(Schema.Boolean);
const optionalNumber = Schema.optional(Schema.Finite);
const optionalPort = Schema.optional(Schema.NullOr(Schema.Finite));
const StringArray = Schema.Array(Schema.String);

// --- Bridges --------------------------------------------------------------

/** The six agent bridges a container or a local environment runs. */
export const AGENT_SERVER_KINDS = ["opencode", "claude", "codex", "cursor", "grok", "pi"] as const;
export type AgentServerKind = (typeof AGENT_SERVER_KINDS)[number];

/** `start_<agent>_server`: the container bridge's host port and its per-process token. */
export const ContainerServerStartSchema = openRecord({
  hostPort: Schema.Finite,
  wasRunning: optionalBoolean,
  authToken: optionalString,
});

/**
 * `get_<agent>_server_status`: whether the container bridge answers. The token
 * is present only while it runs; `agentTools` is OpenCode's agent-tools wiring
 * (`pending`, `connected`, `unavailable`).
 */
export const ContainerServerStatusSchema = openRecord({
  running: Schema.Boolean,
  hostPort: optionalPort,
  authToken: optionalString,
  agentTools: optionalString,
});

/** `start_local_<agent>_server_cmd`: the local bridge's port, process and token. */
export const LocalServerStartSchema = openRecord({
  port: Schema.Finite,
  pid: optionalNumber,
  wasRunning: optionalBoolean,
  authToken: optionalString,
});

/** `get_local_<agent>_server_status`: a readiness snapshot of the local bridge. */
export const LocalServerStatusSchema = openRecord({
  running: Schema.Boolean,
  port: optionalPort,
  pid: optionalPort,
  authToken: optionalString,
  agentTools: optionalString,
});

/** `StructuredCommandError` (bridge-readiness.ts). */
export const StructuredCommandErrorSchema = openRecord({
  message: Schema.String,
  retryable: Schema.Boolean,
  retryAfterMs: optionalNumber,
});

/**
 * `AwaitBridgeReadyResult` (bridge-readiness.ts): `ready` with the endpoint,
 * or `failed`/`timed-out` with the error. One open struct keyed by `status`
 * rather than a union, so a newer status still decodes; the renderer's own
 * `isAwaitBridgeReadyResult` keeps deciding validity.
 */
export const AwaitBridgeReadySchema = openRecord({
  status: Schema.String,
  port: optionalNumber,
  authToken: optionalString,
  error: Schema.optional(StructuredCommandErrorSchema),
});

/** `peek_local_agent_bridge`: a running local bridge's endpoint, or `null`. */
export const LocalBridgePeekSchema = Schema.NullOr(
  Schema.Struct({ port: Schema.Finite, authToken: Schema.String }),
);

/** `peek_container_agent_bridge`: a healthy container bridge's endpoint, or `null`. */
export const ContainerBridgePeekSchema = Schema.NullOr(
  Schema.Struct({ hostPort: Schema.Finite, authToken: Schema.String }),
);

// --- Model catalogues -----------------------------------------------------

/**
 * `AgentModel` (native-agent.ts): one provider-neutral composer model, typed
 * as the protocol's interface (its platform, reasoning and parameter types).
 */
export const AgentModelSchema = modelRecord<AgentModel>()({
  platform: Schema.String,
  id: Schema.String,
  label: Schema.String,
  providerLabel: optionalString,
  description: optionalString,
  reasoning: Schema.optional(Schema.Array(OpenObject)),
  defaultReasoningId: optionalString,
  supportsSpeed: optionalBoolean,
  supportsMode: optionalBoolean,
  contextWindow: optionalNumber,
  supportsImageInput: optionalBoolean,
  aliases: Schema.optional(StringArray),
  resolvedModel: optionalString,
  parameters: Schema.optional(Schema.Array(OpenObject)),
  connected: optionalBoolean,
  sessionDefault: optionalBoolean,
});

// The Claude, Codex and OpenCode catalogues are the models themselves (plan
// item 7010): `apps/backend/src/core/models.ts` and the web's types re-export
// the types below. The effort and source vocabularies are literals because
// the backend keeps only the values it knows when it reads a catalogue
// (`commands-containers.ts`, `storage-shared-model-catalogs.ts`,
// `commands-validation.ts`); a new value bumps the domain.

/** `ClaudeEffortLevel`: an effort level a Claude model can run at. */
export const ClaudeEffortLevelSchema = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type ClaudeEffortLevel = typeof ClaudeEffortLevelSchema.Type;

/** Where an environment's Claude catalogue came from. */
export const ClaudeModelCatalogSourceSchema = Schema.Literals([
  "sdk",
  "last-known-good",
  "fallback",
]);
export type ClaudeModelCatalogSource = typeof ClaudeModelCatalogSourceSchema.Type;

/** `ClaudeModelCatalogEntry`: one model of a Claude catalogue. */
export const ClaudeModelCatalogEntrySchema = openRecord({
  id: Schema.String,
  name: Schema.String,
  resolvedModel: optionalString,
  description: optionalString,
  supportsFastMode: optionalBoolean,
  supportsEffort: optionalBoolean,
  supportedEffortLevels: Schema.optional(mutableArray(ClaudeEffortLevelSchema)),
  supportsAdaptiveThinking: optionalBoolean,
  supportsAutoMode: optionalBoolean,
});
export type ClaudeModelCatalogEntry = Mutable<typeof ClaudeModelCatalogEntrySchema.Type>;

/** `ClaudeModelCatalogSnapshot`: an environment's Claude catalogue. */
export const ClaudeModelCatalogSnapshotSchema = openRecord({
  environmentId: Schema.String,
  models: mutableArray(ClaudeModelCatalogEntrySchema),
  source: ClaudeModelCatalogSourceSchema,
  fetchedAt: Schema.String,
  sdkVersion: optionalString,
  cliVersion: optionalString,
  stale: Schema.Boolean,
  error: optionalString,
});
export type ClaudeModelCatalogSnapshot = DeepMutable<typeof ClaudeModelCatalogSnapshotSchema.Type>;

/** `CodexReasoningEffort`: a reasoning effort a Codex model offers. */
export const CodexReasoningEffortSchema = Schema.Literals([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type CodexReasoningEffort = typeof CodexReasoningEffortSchema.Type;

/** `CodexModelCatalogEntry`: one model of the Codex catalogue. */
export const CodexModelCatalogEntrySchema = openRecord({
  id: Schema.String,
  name: Schema.String,
  description: optionalString,
  reasoningEfforts: Schema.optional(mutableArray(CodexReasoningEffortSchema)),
  reasoningOptions: Schema.optional(
    mutableArray(
      openRecord({
        effort: CodexReasoningEffortSchema,
        label: Schema.String,
        description: optionalString,
      }),
    ),
  ),
  defaultReasoningEffort: Schema.optional(CodexReasoningEffortSchema),
});
export type CodexModelCatalogEntry = DeepMutable<typeof CodexModelCatalogEntrySchema.Type>;

/** `PersistedAgentModelCatalog<T>`: one platform's last-known-good catalogue. */
function persistedCatalogOf<S extends Schema.Top>(model: S) {
  return openRecord({ updatedAt: Schema.String, models: mutableArray(model) });
}
export interface PersistedAgentModelCatalog<T> {
  updatedAt: string;
  models: T[];
}

/**
 * `AgentModelCatalogCache`: the host-wide last-known-good catalogues used
 * before any environment bridge has started. Cursor, Grok and Pi persist the
 * provider-neutral models their ACP bridge normalises. OpenCode stays
 * project-scoped ({@link OpenCodeModelCatalogSnapshotSchema}) because its
 * provider list can differ between repositories.
 */
export const AgentModelCatalogCacheSchema = openRecord({
  schemaVersion: Schema.Literal(1),
  claude: Schema.optional(persistedCatalogOf(ClaudeModelCatalogEntrySchema)),
  codex: Schema.optional(persistedCatalogOf(CodexModelCatalogEntrySchema)),
  cursor: Schema.optional(persistedCatalogOf(AgentModelSchema)),
  grok: Schema.optional(persistedCatalogOf(AgentModelSchema)),
  pi: Schema.optional(persistedCatalogOf(AgentModelSchema)),
});
/**
 * The cache's type: the schema's, with each platform's catalogue as
 * {@link PersistedAgentModelCatalog} of its model type (`AgentModel` keeps
 * its own mutable interface).
 */
export type AgentModelCatalogCache = Omit<
  Mutable<typeof AgentModelCatalogCacheSchema.Type>,
  "claude" | "codex" | "cursor" | "grok" | "pi"
> & {
  claude?: PersistedAgentModelCatalog<ClaudeModelCatalogEntry>;
  codex?: PersistedAgentModelCatalog<CodexModelCatalogEntry>;
  cursor?: PersistedAgentModelCatalog<AgentModel>;
  grok?: PersistedAgentModelCatalog<AgentModel>;
  pi?: PersistedAgentModelCatalog<AgentModel>;
};

/**
 * `get_native_agent_model_catalog`: the composer's models, or, when the call
 * named `ensureAgent`, the models with whether that platform's list is
 * `ready`, `empty` or `failed`.
 */
export const NativeAgentModelCatalogSchema = Schema.Union([
  Schema.Array(AgentModelSchema),
  openRecord({ models: Schema.Array(AgentModelSchema), status: Schema.String }),
]);

/** `refresh_host_agent_model_catalog`: which catalogue was refreshed, and its size. */
export const HostModelCatalogRefreshSchema = Schema.Struct({
  agent: Schema.String,
  modelCount: Schema.Finite,
});

/** `OpenCodeModelCatalogEntry`: one model of a project's OpenCode catalogue. */
export const OpenCodeModelCatalogEntrySchema = openRecord({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  variants: Schema.optional(mutableArray(Schema.String)),
  inputCost: optionalNumber,
  outputCost: optionalNumber,
  contextWindow: optionalNumber,
  supportsImageInput: optionalBoolean,
  /** Whether the provider is connected for this login, when OpenCode reported it. */
  connected: optionalBoolean,
});
export type OpenCodeModelCatalogEntry = Mutable<typeof OpenCodeModelCatalogEntrySchema.Type>;

/**
 * `OpenCodeModelCatalogSnapshot`: the last-known-good OpenCode catalogue for
 * one project configuration. `catalogVersion` is a digest of the normalised
 * model data; keeping it separate from `updatedAt` lets the backend skip
 * rewriting the cache when a new OpenCode server reports the same catalogue.
 */
export const OpenCodeModelCatalogSnapshotSchema = openRecord({
  schemaVersion: Schema.Literal(2),
  projectId: Schema.String,
  catalogVersion: Schema.String,
  updatedAt: Schema.String,
  models: mutableArray(OpenCodeModelCatalogEntrySchema),
  /**
   * Providers OpenCode last reported as connected, so a read made before any
   * bridge is running can tell a model this login can serve from one it
   * cannot. Absent when OpenCode never reported connectivity for this project.
   * `models` deliberately stays unfiltered by it: a provider connected later
   * must still be known once the next bridge reports it.
   */
  connectedProviderIds: Schema.optional(mutableArray(Schema.String)),
  /** When `connectedProviderIds` was last observed to change. */
  connectedProvidersCheckedAt: optionalString,
});
export type OpenCodeModelCatalogSnapshot = DeepMutable<
  typeof OpenCodeModelCatalogSnapshotSchema.Type
>;

/** A model OpenCode names: `provider/model`, or `{ providerID, modelID }`. */
export const OpenCodeModelRefSchema = Schema.Union([
  Schema.String,
  openRecord({ providerID: Schema.String, modelID: Schema.String }),
]);

/** OpenCode's own `~/.local/state/opencode/model.json`, as OpenCode writes it. */
export const OpenCodeModelPreferencesSchema = openRecord({
  recent: Schema.optional(Schema.Array(OpenCodeModelRefSchema)),
  favorite: Schema.optional(Schema.Array(OpenCodeModelRefSchema)),
  variant: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

// --- Skills and plugins ---------------------------------------------------

/** `AgentSkillRoot` (agent-skills.ts). */
export const AgentSkillRootSchema = openRecord({
  path: Schema.String,
  label: Schema.String,
  scope: Schema.String,
  plugin: optionalString,
  exists: Schema.Boolean,
  skillCount: Schema.Finite,
  truncated: Schema.Boolean,
});

/** `AgentSkill` (agent-skills.ts). */
export const AgentSkillSchema = openRecord({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  filePath: Schema.String,
  location: Schema.String,
  scope: Schema.String,
  plugin: optionalString,
  shadowed: Schema.Boolean,
});

/**
 * `AgentSkillScan` (agent-skills.ts). An environment's scan is what the
 * in-environment scanner printed, so its lists are optional there too.
 */
export const AgentSkillScanSchema = openRecord({
  provider: Schema.String,
  roots: Schema.Array(AgentSkillRootSchema),
  skills: Schema.Array(AgentSkillSchema),
  errors: Schema.Array(openRecord({ path: Schema.String, message: Schema.String })),
});

/** An environment's `AgentSkillScan`, as its in-environment scanner printed it. */
export const EnvironmentAgentSkillScanSchema = openRecord({
  provider: optionalString,
  roots: Schema.optional(Schema.Array(OpenObject)),
  skills: Schema.optional(Schema.Array(OpenObject)),
  errors: Schema.optional(Schema.Array(OpenObject)),
});

/** `AgentSkillFile` (agent-skills.ts): one SKILL.md, bounded. */
export const AgentSkillFileSchema = openRecord({
  path: Schema.String,
  content: Schema.String,
  truncated: Schema.Boolean,
});

/** An environment's `AgentSkillFile`, as its in-environment scanner printed it. */
export const EnvironmentAgentSkillFileSchema = openRecord({
  path: optionalString,
  content: optionalString,
  truncated: optionalBoolean,
});

/** `ExtensionItem` (extension-discovery.ts). */
export const ExtensionItemSchema = openRecord({
  name: Schema.String,
  status: Schema.String,
  source: optionalString,
});

/** `AgentPluginCatalog` (extension-discovery.ts): the plugins an agent's CLI reports. */
export const AgentPluginCatalogSchema = openRecord({
  agent: Schema.String,
  plugins: Schema.Array(ExtensionItemSchema),
  pluginError: optionalString,
});

// --- Credentials and the GitHub CLI ---------------------------------------

/** `GitHubCliStatus` (github-cli-setup.ts). */
export const GitHubCliStatusSchema = openRecord({
  installed: Schema.Boolean,
  authenticated: Schema.Boolean,
  canSignIn: Schema.Boolean,
  reminderDismissed: Schema.Boolean,
});

/** `GitHubCliLoginProgress` (github-cli-login.ts): the device-flow sign-in's state. */
export const GitHubCliLoginProgressSchema = openRecord({
  state: Schema.String,
  operationId: optionalString,
  url: optionalString,
  userCode: optionalString,
  error: optionalString,
});

/** `get_container_github_credential_status`: the selected source (`host-cli`, `pat`, `none`). */
export const ContainerGitHubCredentialStatusSchema = openRecord({
  source: Schema.String,
  available: Schema.Boolean,
});
