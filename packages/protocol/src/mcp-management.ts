/**
 * MCP server configuration management contract.
 *
 * This is deliberately separate from the runtime-only `NativeAgentMcpServer`
 * inventory in `native-agent.ts`. Runtime rows describe what a live session is
 * connected to; the objects here describe *saved* provider-native definitions,
 * where they live, who owns them and whether a runtime has adopted a revision.
 *
 * The backend is authoritative. Every identifier here is opaque: the renderer
 * never supplies a filesystem path, never receives a secret value and never
 * receives raw provider configuration. Snapshots are rehydrated on mount and on
 * the `mcp-management-changed` invalidation, which carries no definitions.
 */

import { AGENT_PLATFORMS, type AgentPlatform, isAgentPlatform } from "./agent-platforms.js";

/** Bumped when a wire shape in this module changes incompatibly. */
export const MCP_MANAGEMENT_PROTOCOL_VERSION = 1;

/** Compact invalidation. Payload is {@link McpManagementChangedEvent}. */
export const MCP_MANAGEMENT_CHANGED_EVENT = "mcp-management-changed";

export interface McpManagementChangedEvent {
  /** Monotonic per backend process; a gap means "re-read every open snapshot". */
  revision: number;
  /** Targets whose catalog may have changed. Empty means "all targets". */
  targetIds: string[];
  /** Operations whose state changed. */
  operationIds: string[];
}

/**
 * Admission budgets from the implementation plan (step 02). Byte limits are
 * UTF-8 byte counts, not string lengths.
 */
export const MCP_MANAGEMENT_LIMITS = {
  mutationBodyMaxBytes: 256 * 1024,
  subtreeMaxBytes: 1024 * 1024,
  sourceFileMaxBytes: 8 * 1024 * 1024,
  definitionsPerSource: 64,
  nameMaxBytes: 128,
  argsMax: 128,
  argMaxBytes: 4 * 1024,
  commandMaxBytes: 4 * 1024,
  mapEntriesMax: 64,
  mapKeyMaxBytes: 256,
  mapValueMaxBytes: 8 * 1024,
  urlMaxBytes: 4 * 1024,
  errorMaxBytes: 2 * 1024,
  catalogRowsMax: 100,
  catalogMaxBytes: 256 * 1024,
  requestIdMaxBytes: 128,
  opaqueIdMaxBytes: 1024,
  advancedFieldsMax: 32,
  advancedStringMaxBytes: 4 * 1024,
  advancedListMax: 128,
  retainedOperations: 128,
  operationRetentionMs: 7 * 24 * 60 * 60_000,
  operationStoreMaxBytes: 4 * 1024 * 1024,
  runtimesPerOperation: 64,
  activeAppliesPerTarget: 1,
  concurrentApplyJobs: 2,
  queuedApplyTargets: 32,
} as const;

// ---------------------------------------------------------------------------
// Targets, scopes and sources
// ---------------------------------------------------------------------------

export const MCP_MANAGEMENT_SCOPES = [
  "backend-user",
  "claude-local",
  "project",
  "environment-private",
] as const;
export type McpManagementScope = (typeof MCP_MANAGEMENT_SCOPES)[number];

export const MCP_SCOPE_LABELS: Readonly<Record<McpManagementScope, string>> = Object.freeze({
  "backend-user": "Backend user",
  "claude-local": "Private local (this worktree)",
  project: "Project (this worktree)",
  "environment-private": "This environment",
});

/** Who owns a source. Only native owners are ever writable. */
export type McpSourceOwner =
  | "native-user"
  | "native-local"
  | "native-project"
  /** Another provider's file this provider imports (Grok reads Claude/Cursor). */
  | "compatibility"
  | "plugin"
  | "managed-policy"
  /** Trusted connections injected at launch; never persisted. */
  | "orkestrator"
  | "environment-overlay";

export type McpSourceFormat = "json" | "jsonc" | "toml" | "runtime";

export type McpSourceState =
  | "ok"
  /** File does not exist yet; a first add creates it. */
  | "absent"
  | "invalid"
  | "oversized"
  | "permission-denied"
  | "unsupported-layout"
  | "offline";

export type McpTransport = "stdio" | "http" | "sse";
export const MCP_TRANSPORTS: readonly McpTransport[] = ["stdio", "http", "sse"];

export type McpExecutionLocation = "backend-host" | "local-worktree" | "container";

export interface McpTargetContext {
  kind: "backend" | "environment";
  environmentId?: string;
  environmentName?: string;
  projectId?: string;
  projectName?: string;
  /** Where commands resolve and stdio processes run. */
  location: McpExecutionLocation;
  /** Human label, e.g. "This computer" or "Container of env-a". */
  locationLabel: string;
}

export interface McpCapabilityFlag {
  supported: boolean;
  /** Required when unsupported: a specific, user-facing reason. */
  reason?: string;
}

export type McpApplyStrategy =
  /** Claude: MCP config is re-resolved for every query. */
  | "next-query"
  /** Codex: one app-server per environment reloads MCP config process-wide. */
  | "process-reload"
  /** OpenCode: a server per directory; applies at the next server start. */
  | "directory-restart"
  /** Cursor: SDK agent reattaches between turns with fresh settings. */
  | "idle-reattach"
  /** Grok: next ACP session load reads native config. */
  | "next-load"
  /** Pi: bridge rebuilds its MCP client/tool generation between turns. */
  | "generation-rebuild"
  | "none";

export type McpApplyImpact = "session" | "environment-process" | "directory" | "backend-user";

export type McpFieldType = "string" | "number" | "boolean" | "string-list";

/** A provider-specific field the basic form can edit. */
export interface McpAdvancedFieldSchema {
  id: string;
  label: string;
  type: McpFieldType;
  transports: McpTransport[];
  description?: string;
  min?: number;
  max?: number;
}

export interface McpTargetCapabilities {
  /** Whether this backend can manage the provider at all for this context. */
  management: McpCapabilityFlag;
  transports: Record<McpTransport, McpCapabilityFlag>;
  operations: {
    add: McpCapabilityFlag;
    update: McpCapabilityFlag;
    rename: McpCapabilityFlag;
    remove: McpCapabilityFlag;
    setEnabled: McpCapabilityFlag;
  };
  fields: {
    env: McpCapabilityFlag;
    headers: McpCapabilityFlag;
    cwd: McpCapabilityFlag;
    advanced: McpAdvancedFieldSchema[];
  };
  /** Authentication the saved definition can carry. Runtime OAuth is separate. */
  authentication: {
    staticHeaders: boolean;
    envReferences: boolean;
    runtimeSignIn: McpCapabilityFlag;
  };
  apply: {
    strategy: McpApplyStrategy;
    impact: McpApplyImpact;
    description: string;
  };
  terminal: {
    /** Whether a terminal-mode CLI reads the same native files. */
    readsNativeConfig: boolean;
    guidance: string;
  };
  /** Name grammar the backend enforces; UI mirrors it for early feedback. */
  nameRule: { pattern: string; description: string; maxBytes: number };
}

export interface McpManagementTarget {
  targetId: string;
  backendId: string;
  provider: AgentPlatform;
  providerLabel: string;
  context: McpTargetContext;
  /** Scope a new definition goes to unless the user picks another. */
  defaultSourceId: string | null;
  capabilities: McpTargetCapabilities;
  /** Set when the whole target is read-only (offline container, old backend). */
  readOnlyReason?: string;
}

export interface McpConfigSource {
  sourceId: string;
  scope: McpManagementScope | "plugin" | "managed" | "injected" | "compatibility";
  owner: McpSourceOwner;
  format: McpSourceFormat;
  label: string;
  /** Display-only location. Never accepted back from a client. */
  displayPath: string;
  /** Higher wins for a same-name entry. */
  precedence: number;
  state: McpSourceState;
  /** Bounded, redacted diagnostic for non-ok states. */
  error?: string;
  writable: boolean;
  readOnlyReason?: string;
  /** Opaque; covers every byte a write could overwrite. `null` when unreadable. */
  revision: string | null;
  /** Other providers whose runtime reads this same backing file. */
  sharedWith: AgentPlatform[];
  /** Project execution policy, when the source is project-controlled. */
  trust?: "allowed" | "excluded" | "unknown";
  trustReason?: string;
}

export type McpDefinitionStatus =
  | "effective"
  | "shadowed"
  | "disabled"
  | "policy-excluded"
  | "invalid"
  | "unsupported"
  | "protected";

/** A value the renderer may see verbatim, or only know exists. */
export type McpVisibleValue =
  | { kind: "visible"; value: string }
  | { kind: "redacted"; display: string };

export interface McpMapEntrySummary {
  key: string;
  /**
   * `reference` values are provider-resolved (`${VAR}`, `$VAR`, `env:VAR`) and
   * shown verbatim; `literal` values are only reported present.
   */
  presence: "literal" | "reference";
  reference?: string;
}

export interface McpDefinitionSummary {
  entryId: string;
  sourceId: string;
  name: string;
  transport: McpTransport | "unknown";
  /** `null` when the provider has no persisted enable flag. */
  enabled: boolean | null;
  status: McpDefinitionStatus;
  statusReason?: string;
  /** Entry that wins over this one, when shadowed. */
  shadowedBy?: string;
  /** Entries this one hides; removing it reveals the highest of these. */
  shadows: string[];
  command?: McpVisibleValue;
  argCount?: number;
  url?: McpVisibleValue;
  readOnlyReason?: string;
  /** What the editor may do with this row; each disabled action carries a reason. */
  actions: {
    edit: McpCapabilityFlag;
    rename: McpCapabilityFlag;
    remove: McpCapabilityFlag;
    setEnabled: McpCapabilityFlag;
  };
  /** Names of provider fields the basic form does not edit; values retained. */
  preservedFields: string[];
  secretCount: number;
}

export interface McpEditableArg {
  index: number;
  value: McpVisibleValue;
}

export interface McpEditableDefinition {
  entryId: string;
  sourceId: string;
  sourceRevision: string;
  name: string;
  transport: McpTransport | "unknown";
  enabled: boolean | null;
  command?: McpVisibleValue;
  args: McpEditableArg[];
  cwd?: string;
  url?: McpVisibleValue;
  env: McpMapEntrySummary[];
  headers: McpMapEntrySummary[];
  advanced: Record<string, string | number | boolean | string[]>;
  preservedFields: string[];
  readOnlyReason?: string;
}

export type McpCatalogFreshness = "fresh" | "stale" | "incomplete";

export interface McpManagementSnapshot {
  protocolVersion: number;
  target: McpManagementTarget;
  sources: McpConfigSource[];
  definitions: McpDefinitionSummary[];
  /** Exact native name -> winning entry id. */
  effective: Record<string, string>;
  operations: McpOperationSnapshot[];
  /** Monotonic backend catalog revision this snapshot reflects. */
  catalogRevision: number;
  freshness: McpCatalogFreshness;
  /** Rows omitted because the catalog exceeded its budget. */
  truncated: number;
  generatedAt: string;
}

export interface McpTargetList {
  protocolVersion: number;
  backendId: string;
  targets: McpManagementTarget[];
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** A value the backend already holds, by identity. Never a masked string. */
export type McpSecretEdit =
  | { kind: "keep"; fromKey?: string }
  | { kind: "set"; value: string }
  | { kind: "clear" };

export interface McpMapEdit {
  key: string;
  edit: McpSecretEdit;
}

/** Build the new argument list. `keep` copies argument `index` of the saved revision. */
export type McpArgEdit = { kind: "keep"; index: number } | { kind: "set"; value: string };

export type McpRetainedEdit = { kind: "keep" } | { kind: "set"; value: string };

export type McpAdvancedValue = string | number | boolean | string[];

export interface McpDefinitionInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Array<{ key: string; value: string }>;
  headers?: Array<{ key: string; value: string }>;
  enabled?: boolean;
  advanced?: Record<string, McpAdvancedValue>;
}

export interface McpDefinitionPatch {
  /** Deliberate transport switch; `discard` lists fields the switch drops. */
  transport?: { to: McpTransport; discard: string[] };
  command?: McpRetainedEdit;
  /** Complete desired argument list, expressed as keep/set edits. */
  args?: McpArgEdit[];
  cwd?: { kind: "set"; value: string } | { kind: "clear" };
  url?: McpRetainedEdit;
  /** Keys not mentioned are retained. */
  env?: McpMapEdit[];
  headers?: McpMapEdit[];
  advanced?: { set?: Record<string, McpAdvancedValue>; remove?: string[] };
}

export type McpMutationOperation =
  | {
      kind: "add";
      sourceId: string;
      expectedRevision: string | null;
      definition: McpDefinitionInput;
    }
  | { kind: "update"; entryId: string; expectedRevision: string; patch: McpDefinitionPatch }
  | { kind: "rename"; entryId: string; expectedRevision: string; newName: string }
  | { kind: "remove"; entryId: string; expectedRevision: string }
  | { kind: "set-enabled"; entryId: string; expectedRevision: string; enabled: boolean };

export type McpApplyIntent = "save" | "save-and-apply";

export interface McpMutation {
  requestId: string;
  targetId: string;
  applyIntent: McpApplyIntent;
  operation: McpMutationOperation;
}

export interface McpImpactPreview {
  sourceId: string;
  sourceLabel: string;
  displayPath: string;
  scope: McpConfigSource["scope"];
  /** Human-readable field names that change; never values. */
  changedFields: string[];
  /** Same-name entry that will become effective after this change, if any. */
  revealsEntryId?: string;
  revealsSourceLabel?: string;
  /** Same-name entry this change will hide, if any. */
  shadowsEntryId?: string;
  shadowsSourceLabel?: string;
  /** Environments whose runtime reads the changed file, as far as known. */
  affectedEnvironments: Array<{ environmentId: string; name: string; activeSessions: number }>;
  sharedWith: AgentPlatform[];
  apply: McpTargetCapabilities["apply"];
  warnings: string[];
}

export type McpSavePhase = "pending" | "saved" | "conflict" | "rejected" | "failed" | "reconciling";

export const MCP_APPLY_STATES = [
  "not-requested",
  "queued",
  "applying",
  "applied",
  "pending-next-turn",
  "pending-reattach",
  "restart-required",
  "blocked-policy",
  "failed",
  "reconciling",
  "cancelled",
] as const;
export type McpApplyState = (typeof MCP_APPLY_STATES)[number];

export interface McpRuntimeApplyEntry {
  runtimeId: string;
  environmentId: string | null;
  label: string;
  state: McpApplyState;
  reason?: string;
  updatedAt: string;
}

export interface McpOperationSnapshot {
  operationId: string;
  requestId: string;
  targetId: string;
  provider: AgentPlatform;
  kind: McpMutationOperation["kind"] | "apply";
  /** Non-secret display name of the affected definition. */
  entryName: string;
  sourceId: string;
  phase: McpSavePhase;
  savedRevision?: string;
  resultEntryId?: string;
  errorCode?: McpManagementErrorCode;
  message?: string;
  applyIntent: McpApplyIntent;
  apply: {
    state: McpApplyState;
    runtimes: McpRuntimeApplyEntry[];
    /** Runtimes not listed because fan-out exceeded the per-operation page. */
    omitted: number;
    terminalGuidance?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface McpMutationResult {
  operation: McpOperationSnapshot;
  /** True when this request id was already processed; nothing was re-applied. */
  replayed: boolean;
  savedRevision: string;
  entryId: string | null;
}

export interface McpValidationResult {
  valid: boolean;
  fieldErrors: Array<{ field: string; message: string }>;
  preview: McpImpactPreview | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const MCP_MANAGEMENT_ERROR_CODES = [
  "revision-conflict",
  "duplicate-name",
  "invalid-definition",
  "protected-entry",
  "read-only-source",
  "unsupported-operation",
  "unsupported-transport",
  "unknown-target",
  "unknown-source",
  "unknown-entry",
  "unknown-operation",
  "target-offline",
  "policy-blocked",
  "malformed-source",
  "oversized-source",
  "ambiguous-source",
  "apply-failed",
  "request-conflict",
  "busy",
  "invalid-request",
  "internal",
] as const;
export type McpManagementErrorCode = (typeof MCP_MANAGEMENT_ERROR_CODES)[number];

export interface McpManagementError {
  code: McpManagementErrorCode;
  message: string;
  retryable: boolean;
  /** Re-read the snapshot before retrying. */
  reload: boolean;
  field?: string;
  correlationId?: string;
}

/** Marker so an error can survive the IPC/HTTP `Error.message` flattening. */
export const MCP_MANAGEMENT_ERROR_MARKER = "McpManagementError:";

const ERROR_DEFAULTS: Record<
  McpManagementErrorCode,
  { message: string; retryable: boolean; reload: boolean }
> = {
  "revision-conflict": {
    message: "The configuration changed since it was loaded. Reload and try again.",
    retryable: false,
    reload: true,
  },
  "duplicate-name": {
    message: "A server with this name already exists in this source.",
    retryable: false,
    reload: false,
  },
  "invalid-definition": {
    message: "The server definition is invalid.",
    retryable: false,
    reload: false,
  },
  "protected-entry": {
    message: "This server is managed by Orkestrator and cannot be edited here.",
    retryable: false,
    reload: false,
  },
  "read-only-source": {
    message: "This configuration source is read-only.",
    retryable: false,
    reload: false,
  },
  "unsupported-operation": {
    message: "This provider does not support that change.",
    retryable: false,
    reload: false,
  },
  "unsupported-transport": {
    message: "This provider does not support that transport.",
    retryable: false,
    reload: false,
  },
  "unknown-target": {
    message: "The configuration target no longer exists. Reload the list.",
    retryable: false,
    reload: true,
  },
  "unknown-source": {
    message: "The configuration source no longer exists. Reload the list.",
    retryable: false,
    reload: true,
  },
  "unknown-entry": {
    message: "The server definition no longer exists. Reload the list.",
    retryable: false,
    reload: true,
  },
  "unknown-operation": {
    message: "The operation is no longer tracked.",
    retryable: false,
    reload: true,
  },
  "target-offline": {
    message: "The execution target is offline.",
    retryable: true,
    reload: true,
  },
  "policy-blocked": {
    message: "The execution policy does not allow this change.",
    retryable: false,
    reload: false,
  },
  "malformed-source": {
    message: "The configuration file could not be parsed and was left unchanged.",
    retryable: false,
    reload: true,
  },
  "oversized-source": {
    message: "The configuration file is too large to edit safely.",
    retryable: false,
    reload: false,
  },
  "ambiguous-source": {
    message: "The server is defined in a layout that cannot be edited safely.",
    retryable: false,
    reload: false,
  },
  "apply-failed": {
    message: "The saved configuration could not be applied to the runtime.",
    retryable: true,
    reload: true,
  },
  "request-conflict": {
    message: "This request id was already used for a different change.",
    retryable: false,
    reload: false,
  },
  busy: {
    message: "Configuration work is at capacity. Retry shortly.",
    retryable: true,
    reload: false,
  },
  "invalid-request": {
    message: "The request is invalid.",
    retryable: false,
    reload: false,
  },
  internal: {
    message: "The configuration change failed unexpectedly.",
    retryable: true,
    reload: true,
  },
};

export function isMcpManagementErrorCode(value: unknown): value is McpManagementErrorCode {
  return (
    typeof value === "string" && (MCP_MANAGEMENT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Build a safe error. `message` overrides must never carry values or raw provider text. */
export function mcpManagementError(
  code: McpManagementErrorCode,
  overrides: Partial<Omit<McpManagementError, "code">> = {},
): McpManagementError {
  const message =
    overrides.message === undefined
      ? ERROR_DEFAULTS[code].message
      : truncateUtf8(overrides.message, MCP_MANAGEMENT_LIMITS.errorMaxBytes);
  return { code, ...ERROR_DEFAULTS[code], ...overrides, message };
}

/** An `Error` whose message round-trips the code through string-only transports. */
export class McpManagementFailure extends Error {
  // Declared explicitly: parameter properties do not survive Node's strip-only TypeScript loader.
  readonly detail: McpManagementError;

  constructor(detail: McpManagementError) {
    super(`${MCP_MANAGEMENT_ERROR_MARKER}${detail.code}: ${detail.message}`);
    this.detail = detail;
    this.name = "McpManagementFailure";
  }
}

export function mcpFailure(
  code: McpManagementErrorCode,
  overrides: Partial<Omit<McpManagementError, "code">> = {},
): McpManagementFailure {
  return new McpManagementFailure(mcpManagementError(code, overrides));
}

/** Recover a code from any thrown value, including flattened transport errors. */
export function mcpManagementErrorFromUnknown(error: unknown): McpManagementError | null {
  if (error instanceof McpManagementFailure) return error.detail;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const index = message.indexOf(MCP_MANAGEMENT_ERROR_MARKER);
  if (index < 0) return null;
  const rest = message.slice(index + MCP_MANAGEMENT_ERROR_MARKER.length);
  const separator = rest.indexOf(":");
  const code = separator < 0 ? rest : rest.slice(0, separator);
  if (!isMcpManagementErrorCode(code)) return null;
  const detail = separator < 0 ? "" : rest.slice(separator + 1).trim();
  return mcpManagementError(code, detail ? { message: detail } : {});
}

/** A *specifically unsupported* command from an older backend. */
export function isUnknownMcpManagementCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Unknown (?:backend )?command:?\s*(?:list_mcp_management_targets|get_mcp_management_snapshot|get_mcp_definition|validate_mcp_mutation|mutate_mcp_definition|apply_mcp_configuration|get_mcp_operation|cancel_mcp_apply)/i.test(
    message,
  );
}

// ---------------------------------------------------------------------------
// Protected names
// ---------------------------------------------------------------------------

/**
 * Server names Orkestrator injects at launch. A user definition may never claim
 * one of these, in any provider or scope, because the injected connection would
 * then either be shadowed or leak its bearer into saved configuration.
 */
export const PROTECTED_MCP_SERVER_NAMES: readonly string[] = Object.freeze([
  "orkestrator",
  "orkestrator-design",
  "orkestrator_workflow_result",
]);

export function isProtectedMcpServerName(name: string): boolean {
  const folded = name.trim().toLowerCase();
  return PROTECTED_MCP_SERVER_NAMES.some(
    (protectedName) =>
      folded === protectedName ||
      folded.replace(/[-_]/g, "") === protectedName.replace(/[-_]/g, ""),
  );
}

/**
 * Environment variables that hold Orkestrator's own bridge/control credentials.
 * A definition may not reference them: doing so would hand an internal bearer to
 * an arbitrary user-configured server.
 */
export const INTERNAL_CREDENTIAL_ENV_PATTERN =
  /^(ORKESTRATOR_[A-Z0-9_]*(TOKEN|SECRET|KEY|BEARER|CREDENTIAL)[A-Z0-9_]*|[A-Z0-9_]*_BRIDGE_(AUTH_)?TOKEN)$/;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && utf8ByteLength(value.slice(0, end)) > maxBytes - 3) end -= 1;
  return `${value.slice(0, end)}...`;
}

const FORBIDDEN_MAP_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isForbiddenMapKey(key: string): boolean {
  return FORBIDDEN_MAP_KEYS.has(key);
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// RFC 7230 token characters.
const HEADER_KEY_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Provider-resolved references. The editor shows these verbatim because they
 * name a variable rather than carrying its value.
 */
const REFERENCE_PATTERNS = [
  /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-)?\}$/,
  /^\$[A-Za-z_][A-Za-z0-9_]*$/,
  /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/,
  /^env:[A-Za-z_][A-Za-z0-9_]*$/,
  /^Bearer \$\{[A-Za-z_][A-Za-z0-9_]*\}$/,
  /^Bearer \{env:[A-Za-z_][A-Za-z0-9_]*\}$/,
];

export function isEnvReference(value: string): boolean {
  return REFERENCE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Variable names a reference value names, for the internal-credential check. */
export function referencedVariables(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)|env:([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.push(name);
  }
  return names;
}

const SENSITIVE_WORD =
  /(token|secret|passw(or)?d|pwd|api[-_]?key|apikey|auth|bearer|credential|private[-_]?key|access[-_]?key|session|cookie|signature|sig)/i;
const LITERAL_ENV_FALLBACK = /\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]+\}/;

/**
 * Whether an argument could carry a credential. Deliberately broad: a false
 * positive costs one "retained value" control, a false negative leaks.
 */
export function isSensitiveArg(arg: string, previous?: string): boolean {
  if (LITERAL_ENV_FALLBACK.test(arg)) return true;
  if (
    previous &&
    /^--?[A-Za-z]/.test(previous) &&
    SENSITIVE_WORD.test(previous) &&
    !previous.includes("=")
  ) {
    return true;
  }
  if (previous === "-H" || previous === "--header") return true;
  const equals = arg.indexOf("=");
  if (equals > 0 && SENSITIVE_WORD.test(arg.slice(0, equals))) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(arg)) return isSensitiveUrl(arg);
  if (/^(sk|pk|ghp|gho|ghu|ghs|github_pat|xox[abpr]|glpat|AKIA)[-_A-Za-z0-9]{8,}/.test(arg))
    return true;
  // Long opaque tokens: base64/hex-ish, no path separators or spaces.
  if (
    arg.length >= 32 &&
    /^[A-Za-z0-9+/_=.-]+$/.test(arg) &&
    !arg.includes("/") &&
    /\d/.test(arg) &&
    /[A-Za-z]/.test(arg)
  ) {
    return true;
  }
  return false;
}

/** URLs with userinfo, credential-looking paths or query parameters are never shown verbatim. */
export function isSensitiveUrl(value: string): boolean {
  if (LITERAL_ENV_FALLBACK.test(value)) return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return true;
  }
  if (parsed.username || parsed.password) return true;
  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponentSafe);
  if (
    segments.some(
      (segment, index) =>
        SENSITIVE_WORD.test(segment) ||
        /^(key|code|k)$/i.test(segment) ||
        isSensitiveArg(segment, index ? segments[index - 1] : undefined) ||
        (segment.length >= 24 && /^[A-Za-z0-9_-]+$/.test(segment)),
    )
  )
    return true;
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_WORD.test(key) || /^(key|code|k)$/i.test(key)) return true;
  }
  return false;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A display form that never includes query values, userinfo or a sensitive path. */
export function redactUrlForDisplay(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return "(retained URL)";
  }
}

export function visibleUrl(value: string): McpVisibleValue {
  return isSensitiveUrl(value)
    ? { kind: "redacted", display: redactUrlForDisplay(value) }
    : { kind: "visible", value };
}

export function visibleArgs(args: readonly string[]): McpEditableArg[] {
  return args.map((arg, index) => ({
    index,
    value: isSensitiveArg(arg, args[index - 1])
      ? { kind: "redacted", display: "(retained value)" }
      : { kind: "visible", value: arg },
  }));
}

export function visibleCommand(command: string): McpVisibleValue {
  return isSensitiveArg(command)
    ? { kind: "redacted", display: "(retained command)" }
    : { kind: "visible", value: command };
}

export interface McpFieldError {
  field: string;
  message: string;
}

function checkString(
  errors: McpFieldError[],
  field: string,
  value: unknown,
  maxBytes: number,
  options: { required?: boolean; allowEmpty?: boolean } = {},
): value is string {
  if (value === undefined) {
    if (options.required) errors.push({ field, message: "Required." });
    return false;
  }
  if (typeof value !== "string") {
    errors.push({ field, message: "Must be text." });
    return false;
  }
  if (!options.allowEmpty && value.trim() === "") {
    errors.push({ field, message: "Must not be empty." });
    return false;
  }
  if (value.includes("\u0000")) {
    errors.push({ field, message: "Must not contain NUL characters." });
    return false;
  }
  if (utf8ByteLength(value) > maxBytes) {
    errors.push({ field, message: `Must be at most ${maxBytes} bytes.` });
    return false;
  }
  return true;
}

/** Provider-agnostic name check; adapters add their own grammar on top. */
export function validateMcpServerName(
  name: unknown,
  errors: McpFieldError[],
  field = "name",
): void {
  if (!checkString(errors, field, name, MCP_MANAGEMENT_LIMITS.nameMaxBytes, { required: true }))
    return;
  const text = name as string;
  if (text !== text.trim()) errors.push({ field, message: "Must not start or end with spaces." });
  if (/[\u0000-\u001f\u007f]/.test(text))
    errors.push({ field, message: "Must not contain control characters." });
  if (isForbiddenMapKey(text)) errors.push({ field, message: "This name is reserved." });
  if (isProtectedMcpServerName(text)) {
    errors.push({ field, message: "This name is reserved for Orkestrator's own connection." });
  }
}

export function validateMcpUrl(value: unknown, errors: McpFieldError[], field = "url"): void {
  if (!checkString(errors, field, value, MCP_MANAGEMENT_LIMITS.urlMaxBytes, { required: true }))
    return;
  let parsed: URL;
  try {
    parsed = new URL(value as string);
  } catch {
    errors.push({ field, message: "Must be an absolute http(s) URL." });
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push({ field, message: "Must use http or https." });
  }
  if (parsed.username || parsed.password) {
    errors.push({
      field,
      message: "Must not embed a user name or password; use a header instead.",
    });
  }
  if (!parsed.hostname) errors.push({ field, message: "Must include a host." });
}

export function validateMcpCommand(
  value: unknown,
  errors: McpFieldError[],
  field = "command",
): void {
  if (!checkString(errors, field, value, MCP_MANAGEMENT_LIMITS.commandMaxBytes, { required: true }))
    return;
  if (/[\r\n]/.test(value as string)) errors.push({ field, message: "Must be a single line." });
}

export function validateMcpArgs(value: unknown, errors: McpFieldError[], field = "args"): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ field, message: "Must be a list." });
    return;
  }
  if (value.length > MCP_MANAGEMENT_LIMITS.argsMax) {
    errors.push({ field, message: `At most ${MCP_MANAGEMENT_LIMITS.argsMax} arguments.` });
    return;
  }
  value.forEach((arg, index) =>
    checkString(errors, `${field}.${index}`, arg, MCP_MANAGEMENT_LIMITS.argMaxBytes, {
      allowEmpty: true,
    }),
  );
}

export function validateMcpMapKey(
  kind: "env" | "headers",
  key: unknown,
  errors: McpFieldError[],
  field: string,
): void {
  if (!checkString(errors, field, key, MCP_MANAGEMENT_LIMITS.mapKeyMaxBytes, { required: true }))
    return;
  const text = key as string;
  if (isForbiddenMapKey(text)) errors.push({ field, message: "This key is reserved." });
  else if (kind === "env" && !ENV_KEY_PATTERN.test(text)) {
    errors.push({
      field,
      message: "Use letters, digits and underscores; do not start with a digit.",
    });
  } else if (kind === "headers" && !HEADER_KEY_PATTERN.test(text)) {
    errors.push({ field, message: "Not a valid HTTP header name." });
  }
  if (kind === "env" && INTERNAL_CREDENTIAL_ENV_PATTERN.test(text)) {
    errors.push({ field, message: "This variable is reserved for Orkestrator's own credentials." });
  }
}

export function validateMcpMapValue(value: unknown, errors: McpFieldError[], field: string): void {
  if (
    !checkString(errors, field, value, MCP_MANAGEMENT_LIMITS.mapValueMaxBytes, {
      required: true,
      allowEmpty: true,
    })
  ) {
    return;
  }
  if (/[\r\n]/.test(value as string)) errors.push({ field, message: "Must be a single line." });
  for (const name of referencedVariables(value as string)) {
    if (INTERNAL_CREDENTIAL_ENV_PATTERN.test(name)) {
      errors.push({ field, message: "References one of Orkestrator's own credentials." });
    }
  }
}

/** Detect duplicate keys after the provider's own folding (headers are case-insensitive). */
export function duplicateMapKeys(kind: "env" | "headers", keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const key of keys) {
    const folded = kind === "headers" ? key.toLowerCase() : key;
    if (seen.has(folded)) duplicates.push(key);
    seen.add(folded);
  }
  return duplicates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSecretEdit(value: unknown, errors: McpFieldError[], field: string): void {
  if (!isRecord(value)) {
    errors.push({ field, message: "Invalid edit." });
    return;
  }
  if (value.kind === "keep") {
    if (value.fromKey !== undefined && typeof value.fromKey !== "string") {
      errors.push({ field, message: "Invalid source key." });
    }
  } else if (value.kind === "set") {
    validateMcpMapValue(value.value, errors, `${field}.value`);
  } else if (value.kind !== "clear") {
    errors.push({ field, message: "Edit must be keep, set or clear." });
  }
}

function validateMapEdits(kind: "env" | "headers", value: unknown, errors: McpFieldError[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MCP_MANAGEMENT_LIMITS.mapEntriesMax * 2) {
    errors.push({ field: kind, message: "Invalid list of edits." });
    return;
  }
  const keys: string[] = [];
  value.forEach((entry, index) => {
    const field = `${kind}.${index}`;
    if (!isRecord(entry)) {
      errors.push({ field, message: "Invalid edit." });
      return;
    }
    validateMcpMapKey(kind, entry.key, errors, `${field}.key`);
    if (typeof entry.key === "string") keys.push(entry.key);
    validateSecretEdit(entry.edit, errors, `${field}.edit`);
  });
  for (const duplicate of duplicateMapKeys(kind, keys)) {
    errors.push({ field: kind, message: `Duplicate key ${duplicate}.` });
  }
}

function validateMapInput(kind: "env" | "headers", value: unknown, errors: McpFieldError[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MCP_MANAGEMENT_LIMITS.mapEntriesMax) {
    errors.push({
      field: kind,
      message: `At most ${MCP_MANAGEMENT_LIMITS.mapEntriesMax} entries.`,
    });
    return;
  }
  const keys: string[] = [];
  value.forEach((entry, index) => {
    const field = `${kind}.${index}`;
    if (!isRecord(entry)) {
      errors.push({ field, message: "Invalid entry." });
      return;
    }
    validateMcpMapKey(kind, entry.key, errors, `${field}.key`);
    if (typeof entry.key === "string") keys.push(entry.key);
    validateMcpMapValue(entry.value, errors, `${field}.value`);
  });
  for (const duplicate of duplicateMapKeys(kind, keys)) {
    errors.push({ field: kind, message: `Duplicate key ${duplicate}.` });
  }
}

function validateAdvanced(value: unknown, errors: McpFieldError[], field: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ field, message: "Invalid advanced fields." });
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > MCP_MANAGEMENT_LIMITS.advancedFieldsMax) {
    errors.push({ field, message: "Too many advanced fields." });
  }
  for (const key of keys) {
    if (isForbiddenMapKey(key) || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      errors.push({ field: `${field}.${key}`, message: "Unknown field." });
      continue;
    }
    const entry = value[key];
    if (typeof entry === "string") {
      checkString(errors, `${field}.${key}`, entry, MCP_MANAGEMENT_LIMITS.advancedStringMaxBytes, {
        allowEmpty: true,
      });
    } else if (typeof entry === "number") {
      if (!Number.isFinite(entry))
        errors.push({ field: `${field}.${key}`, message: "Must be a finite number." });
    } else if (Array.isArray(entry)) {
      if (entry.length > MCP_MANAGEMENT_LIMITS.advancedListMax) {
        errors.push({ field: `${field}.${key}`, message: "Too many values." });
      }
      entry.forEach((item, index) =>
        checkString(
          errors,
          `${field}.${key}.${index}`,
          item,
          MCP_MANAGEMENT_LIMITS.advancedStringMaxBytes,
        ),
      );
    } else if (typeof entry !== "boolean") {
      errors.push({ field: `${field}.${key}`, message: "Unsupported value." });
    }
  }
}

function isTransport(value: unknown): value is McpTransport {
  return value === "stdio" || value === "http" || value === "sse";
}

/** Structural validation of a complete new definition. Adapters check provider rules. */
export function validateMcpDefinitionInput(input: unknown): McpFieldError[] {
  const errors: McpFieldError[] = [];
  if (!isRecord(input)) return [{ field: "definition", message: "Must be an object." }];
  validateMcpServerName(input.name, errors);
  if (!isTransport(input.transport)) {
    errors.push({ field: "transport", message: "Choose stdio, HTTP or SSE." });
    return errors;
  }
  if (input.transport === "stdio") {
    validateMcpCommand(input.command, errors);
    validateMcpArgs(input.args, errors);
    if (input.cwd !== undefined)
      checkString(errors, "cwd", input.cwd, MCP_MANAGEMENT_LIMITS.commandMaxBytes);
    if (input.url !== undefined)
      errors.push({ field: "url", message: "A stdio server has no URL." });
    if (input.headers !== undefined && (input.headers as unknown[]).length) {
      errors.push({ field: "headers", message: "A stdio server has no headers." });
    }
  } else {
    validateMcpUrl(input.url, errors);
    if (input.command !== undefined)
      errors.push({ field: "command", message: "A remote server has no command." });
    if (input.args !== undefined && (input.args as unknown[]).length) {
      errors.push({ field: "args", message: "A remote server has no arguments." });
    }
  }
  validateMapInput("env", input.env, errors);
  validateMapInput("headers", input.headers, errors);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    errors.push({ field: "enabled", message: "Must be true or false." });
  }
  validateAdvanced(input.advanced, errors, "advanced");
  return errors;
}

function validateRetainedEdit(
  value: unknown,
  errors: McpFieldError[],
  field: string,
  check: (text: unknown, errors: McpFieldError[], field: string) => void,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ field, message: "Invalid edit." });
  } else if (value.kind === "set") {
    check(value.value, errors, field);
  } else if (value.kind !== "keep") {
    errors.push({ field, message: "Edit must be keep or set." });
  }
}

export function validateMcpDefinitionPatch(patch: unknown): McpFieldError[] {
  const errors: McpFieldError[] = [];
  if (!isRecord(patch)) return [{ field: "patch", message: "Must be an object." }];
  if (patch.transport !== undefined) {
    const transport = patch.transport;
    if (!isRecord(transport) || !isTransport(transport.to) || !Array.isArray(transport.discard)) {
      errors.push({
        field: "transport",
        message: "A transport switch must name the fields it discards.",
      });
    }
  }
  validateRetainedEdit(patch.command, errors, "command", validateMcpCommand);
  validateRetainedEdit(patch.url, errors, "url", validateMcpUrl);
  if (patch.args !== undefined) {
    if (!Array.isArray(patch.args) || patch.args.length > MCP_MANAGEMENT_LIMITS.argsMax) {
      errors.push({
        field: "args",
        message: `At most ${MCP_MANAGEMENT_LIMITS.argsMax} arguments.`,
      });
    } else {
      patch.args.forEach((edit, index) => {
        const field = `args.${index}`;
        if (!isRecord(edit)) errors.push({ field, message: "Invalid argument edit." });
        else if (edit.kind === "keep") {
          if (!Number.isSafeInteger(edit.index) || (edit.index as number) < 0) {
            errors.push({ field, message: "Invalid argument reference." });
          }
        } else if (edit.kind === "set") {
          checkString(errors, field, edit.value, MCP_MANAGEMENT_LIMITS.argMaxBytes, {
            allowEmpty: true,
          });
        } else errors.push({ field, message: "Edit must be keep or set." });
      });
    }
  }
  if (patch.cwd !== undefined) {
    const cwd = patch.cwd;
    if (!isRecord(cwd) || (cwd.kind !== "clear" && cwd.kind !== "set")) {
      errors.push({ field: "cwd", message: "Invalid edit." });
    } else if (cwd.kind === "set") {
      checkString(errors, "cwd", cwd.value, MCP_MANAGEMENT_LIMITS.commandMaxBytes);
    }
  }
  validateMapEdits("env", patch.env, errors);
  validateMapEdits("headers", patch.headers, errors);
  if (patch.advanced !== undefined) {
    const advanced = patch.advanced;
    if (!isRecord(advanced)) errors.push({ field: "advanced", message: "Invalid advanced edit." });
    else {
      validateAdvanced(advanced.set, errors, "advanced");
      if (advanced.remove !== undefined) {
        if (
          !Array.isArray(advanced.remove) ||
          advanced.remove.some((key) => typeof key !== "string")
        ) {
          errors.push({ field: "advanced", message: "Invalid removal list." });
        }
      }
    }
  }
  return errors;
}

function checkOpaque(
  value: unknown,
  field: string,
  errors: McpFieldError[],
  nullable = false,
): void {
  if (nullable && value === null) return;
  checkString(errors, field, value, MCP_MANAGEMENT_LIMITS.opaqueIdMaxBytes, { required: true });
}

/**
 * Parse an untrusted mutation request. Throws `invalid-request` for shape
 * errors; field errors for the definition are returned for the form.
 */
export function parseMcpMutation(value: unknown): {
  mutation: McpMutation;
  fieldErrors: McpFieldError[];
} {
  const bytes = safeJsonBytes(value);
  if (bytes === null || bytes > MCP_MANAGEMENT_LIMITS.mutationBodyMaxBytes) {
    throw mcpFailure("invalid-request", { message: "The request is too large." });
  }
  if (!isRecord(value))
    throw mcpFailure("invalid-request", { message: "The request must be an object." });
  const errors: McpFieldError[] = [];
  checkString(errors, "requestId", value.requestId, MCP_MANAGEMENT_LIMITS.requestIdMaxBytes, {
    required: true,
  });
  checkOpaque(value.targetId, "targetId", errors);
  if (value.applyIntent !== "save" && value.applyIntent !== "save-and-apply") {
    errors.push({ field: "applyIntent", message: "Choose save or save-and-apply." });
  }
  const operation = value.operation;
  const fieldErrors: McpFieldError[] = [];
  if (!isRecord(operation)) {
    errors.push({ field: "operation", message: "Missing operation." });
  } else {
    switch (operation.kind) {
      case "add":
        checkOpaque(operation.sourceId, "sourceId", errors);
        checkOpaque(operation.expectedRevision, "expectedRevision", errors, true);
        fieldErrors.push(...validateMcpDefinitionInput(operation.definition));
        break;
      case "update":
        checkOpaque(operation.entryId, "entryId", errors);
        checkOpaque(operation.expectedRevision, "expectedRevision", errors);
        fieldErrors.push(...validateMcpDefinitionPatch(operation.patch));
        break;
      case "rename":
        checkOpaque(operation.entryId, "entryId", errors);
        checkOpaque(operation.expectedRevision, "expectedRevision", errors);
        validateMcpServerName(operation.newName, fieldErrors, "name");
        break;
      case "remove":
        checkOpaque(operation.entryId, "entryId", errors);
        checkOpaque(operation.expectedRevision, "expectedRevision", errors);
        break;
      case "set-enabled":
        checkOpaque(operation.entryId, "entryId", errors);
        checkOpaque(operation.expectedRevision, "expectedRevision", errors);
        if (typeof operation.enabled !== "boolean")
          errors.push({ field: "enabled", message: "Must be a boolean." });
        break;
      default:
        errors.push({ field: "operation.kind", message: "Unknown operation." });
    }
  }
  if (errors.length) {
    throw mcpFailure("invalid-request", {
      message: errors.map((error) => `${error.field}: ${error.message}`).join(" "),
    });
  }
  return { mutation: value as unknown as McpMutation, fieldErrors };
}

function safeJsonBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : utf8ByteLength(text);
  } catch {
    return null;
  }
}

export function isMcpManagementProvider(value: unknown): value is AgentPlatform {
  return isAgentPlatform(value);
}

export const MCP_MANAGEMENT_PROVIDERS: readonly AgentPlatform[] = AGENT_PLATFORMS;

/** Whether a state is final for a runtime (no further automatic progress). */
export function isTerminalApplyState(state: McpApplyState): boolean {
  return (
    state === "applied" ||
    state === "not-requested" ||
    state === "failed" ||
    state === "blocked-policy" ||
    state === "cancelled" ||
    state === "restart-required" ||
    state === "pending-next-turn"
  );
}

/** Roll per-runtime states up to one display state. */
export function aggregateApplyState(states: readonly McpApplyState[]): McpApplyState {
  if (!states.length) return "not-requested";
  const order: McpApplyState[] = [
    "reconciling",
    "applying",
    "queued",
    "failed",
    "pending-reattach",
    "restart-required",
    "pending-next-turn",
    "blocked-policy",
    "cancelled",
    "applied",
    "not-requested",
  ];
  for (const state of order) if (states.includes(state)) return state;
  return states[0]!;
}
