/**
 * The public command contract shared by the `orkestrator` client
 * (`packages/cli`) and the backend's `public_action` gateway command.
 *
 * Everything a script can depend on lives here: the action catalogue, the
 * single JSON envelope, stable error codes and their exit classes, request
 * keys and receipts, and the limits every input is validated against. The
 * backend remains the authority for every mutation; this module only fixes
 * the shape of what crosses the wire so the CLI, the backend and the tests
 * cannot drift apart.
 *
 * The contract is deliberately separate from the internal registry commands.
 * `public_action` is the only public entrypoint; the raw registry stays an
 * internal, unstable interface that the CLI never exposes.
 */

export const PUBLIC_API_SCHEMA_VERSION = 1 as const;
export type PublicApiSchemaVersion = typeof PUBLIC_API_SCHEMA_VERSION;

/** The one registry command every public action enters through. */
export const PUBLIC_ACTION_COMMAND = "public_action";

/** Which kinds of state an action can change. Reads change none. */
export type PublicActionEffect =
  | "metadata"
  | "filesystem"
  | "external-repository"
  | "provider-session"
  | "process";

/**
 * How the outcome of an action can be observed.
 *
 * - `immediate`: the response is the final result.
 * - `receipt`: the response is an admitted operation; its terminal state is
 *   read later through `run.get`.
 * - `run`: like `receipt`, plus request-specific provider execution state.
 */
export type PublicActionObservation = "immediate" | "receipt" | "run";

export type PublicMilestone = "A" | "B" | "C" | "D";

export interface PublicActionDescriptor {
  version: number;
  mutation: boolean;
  effects: readonly PublicActionEffect[];
  observation: PublicActionObservation;
  milestone: PublicMilestone;
  /** Conditions the client may wait for after this action. */
  waitConditions?: readonly string[];
  summary: string;
}

/**
 * The complete public action catalogue.
 *
 * Adding an entry here is not enough to expose an action: the backend
 * advertises an action only when a handler with the same version is
 * registered, and the CLI refuses mutations the selected backend does not
 * advertise (see `isPublicActionAvailable`).
 */
export const PUBLIC_ACTIONS = {
  capabilities: {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "Backend identity, supported actions, limits and request-key namespace.",
  },
  "project.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "List project summaries.",
  },
  "project.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "Read one project summary by ID or unique name.",
  },
  "project.add": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem"],
    observation: "receipt",
    milestone: "B",
    summary: "Register a remote, attach a backend-local checkout, or clone into a backend path.",
  },
  "project.create": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem", "external-repository"],
    observation: "receipt",
    milestone: "B",
    summary:
      "Initialize Git at a backend path, create a PRIVATE GitHub repository, and push the initial commit.",
  },
  "project.update": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "B",
    summary: "Edit stored project metadata; never moves checkouts or rewrites .git/config.",
  },
  "project.remove": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "B",
    summary: "Remove an empty project registration; never deletes checkouts or remotes.",
  },
  "project.config.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "B",
    summary: "Read repository settings with effective values and their source tier.",
  },
  "project.config.set": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "B",
    summary: "Atomically set/unset repository settings under a revision check.",
  },
  "environment.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "List environment summaries from the authoritative snapshot.",
  },
  "environment.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "Read one environment summary.",
  },
  "environment.create": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "B",
    summary: "Record a new environment; does not start it or launch an agent.",
  },
  "environment.start": {
    version: 1,
    mutation: true,
    effects: ["filesystem", "process"],
    observation: "receipt",
    milestone: "B",
    waitConditions: ["running", "ready"],
    summary: "Admit a backend-owned start; setup continues after the response.",
  },
  "environment.stop": {
    version: 1,
    mutation: true,
    effects: ["process"],
    observation: "receipt",
    milestone: "B",
    waitConditions: ["stopped"],
    summary: "Stop the environment's processes and container.",
  },
  "environment.recreate": {
    version: 1,
    mutation: true,
    effects: ["filesystem", "process"],
    observation: "receipt",
    milestone: "B",
    waitConditions: ["running", "ready"],
    summary: "Destroy and recreate the environment's container (container environments only).",
  },
  "environment.delete": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem", "process"],
    observation: "receipt",
    milestone: "B",
    waitConditions: ["deleted"],
    summary: "Stop and delete the environment, its worktree or container, and its record.",
  },
  "environment.fork": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem"],
    observation: "receipt",
    milestone: "B",
    summary: "Create a new environment from an existing environment's state.",
  },
  "environment.rename": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem"],
    observation: "receipt",
    milestone: "B",
    summary: "Rename an environment and its branch.",
  },
  "environment.config.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "B",
    summary: "Read environment settings with effective values and application timing.",
  },
  "environment.config.set": {
    version: 1,
    mutation: true,
    effects: ["metadata"],
    observation: "receipt",
    milestone: "B",
    summary: "Atomically set/unset environment settings under a revision check.",
  },
  "environment.launch": {
    version: 1,
    mutation: true,
    effects: ["metadata", "filesystem", "process", "provider-session"],
    observation: "run",
    milestone: "C",
    waitConditions: ["ready"],
    summary: "Create and start an environment whose backend-owned startup sends one first prompt.",
  },
  "environment.exec": {
    version: 1,
    mutation: true,
    effects: ["filesystem", "process"],
    observation: "run",
    milestone: "D",
    summary: "Run one argv-preserving, non-PTY command inside the environment workspace.",
  },
  "agent.options": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "Enabled agents, model catalogue provenance and supported session controls.",
  },
  "session.list": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "List native-agent sessions of one environment without reading transcripts.",
  },
  "session.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "A",
    summary: "Read one native-agent session summary without reading its transcript.",
  },
  "session.start": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "run",
    milestone: "C",
    summary: "Start an independent native conversation and dispatch its first prompt.",
  },
  "session.prompt": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "run",
    milestone: "C",
    summary: "Send a follow-up prompt to one explicit idle conversation.",
  },
  "session.stop": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Stop the current turn of one session, optionally bound to an expected run.",
  },
  "session.steer": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Steer the active turn where the provider supports it.",
  },
  "session.config.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "C",
    summary: "Read the live session's effective controls.",
  },
  "session.config.set": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Change live session controls (model, reasoning, speed, mode).",
  },
  "session.history": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "C",
    summary: "List provider conversations this session can resume.",
  },
  "session.resume": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Rebind the session to an earlier provider conversation without deleting history.",
  },
  "session.fork": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Fork the conversation into a new public session.",
  },
  "session.interactions": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "C",
    summary: "List pending questions and approvals with their permitted answers.",
  },
  "session.interaction.resolve": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Answer one exact pending interaction at an expected revision.",
  },
  "session.transcript": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "C",
    summary: "Read one bounded, ordered transcript page with a continuation cursor.",
  },
  "run.get": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "B",
    summary: "Read an operation by ID or by its original request key.",
  },
  "run.retry": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "run",
    milestone: "C",
    summary: "Retry the exact parked prompt/steer of an unknown dispatch under the same key.",
  },
  "run.discard": {
    version: 1,
    mutation: true,
    effects: ["provider-session"],
    observation: "receipt",
    milestone: "C",
    summary: "Clear the recovery state of an unknown dispatch; does not undo an executed turn.",
  },
  "run.cancel": {
    version: 1,
    mutation: true,
    effects: ["process"],
    observation: "receipt",
    milestone: "D",
    summary: "Cancel one running exec operation's exact worker.",
  },
  "run.output": {
    version: 1,
    mutation: false,
    effects: [],
    observation: "immediate",
    milestone: "D",
    summary: "Read a bounded stdout/stderr window of an exec operation.",
  },
} as const satisfies Record<string, PublicActionDescriptor>;

export type PublicActionName = keyof typeof PUBLIC_ACTIONS;

export const PUBLIC_ACTION_NAMES = Object.freeze(Object.keys(PUBLIC_ACTIONS) as PublicActionName[]);

export function isPublicActionName(value: unknown): value is PublicActionName {
  return typeof value === "string" && Object.hasOwn(PUBLIC_ACTIONS, value);
}

export function isPublicMutation(action: PublicActionName): boolean {
  return PUBLIC_ACTIONS[action].mutation;
}

// ---------------------------------------------------------------------------
// Exit codes and error codes

/**
 * Process exit classes. JSON output always carries the precise error code;
 * the exit status only groups codes into classes a shell can branch on.
 */
export const PUBLIC_EXIT = Object.freeze({
  success: 0,
  failed: 1,
  invalidInput: 2,
  notFound: 3,
  connection: 4,
  deadline: 5,
  interactionRequired: 6,
  unknownDispatch: 7,
  conflict: 8,
});

/** Exit status after SIGINT/SIGTERM stopped an observer: 128 + signal. */
export const PUBLIC_SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

export const PUBLIC_ERROR_EXIT = {
  // 1 — the requested operation ran and did not succeed.
  "operation-failed": PUBLIC_EXIT.failed,
  "partial-failure": PUBLIC_EXIT.failed,
  "setup-failed": PUBLIC_EXIT.failed,
  "run-failed": PUBLIC_EXIT.failed,
  "run-cancelled": PUBLIC_EXIT.failed,
  "run-interrupted": PUBLIC_EXIT.failed,
  "exec-failed": PUBLIC_EXIT.failed,
  "store-capacity": PUBLIC_EXIT.failed,
  "internal-error": PUBLIC_EXIT.failed,
  // 2 — the caller's input was rejected before any admission.
  "invalid-input": PUBLIC_EXIT.invalidInput,
  "input-too-large": PUBLIC_EXIT.invalidInput,
  "empty-input": PUBLIC_EXIT.invalidInput,
  "unknown-command": PUBLIC_EXIT.invalidInput,
  "unknown-option": PUBLIC_EXIT.invalidInput,
  // 3 — the target does not exist, is ambiguous, or its history expired.
  "not-found": PUBLIC_EXIT.notFound,
  "ambiguous-target": PUBLIC_EXIT.notFound,
  "history-expired": PUBLIC_EXIT.notFound,
  // 4 — the client could not reach or authenticate to the selected backend.
  "connection-failed": PUBLIC_EXIT.connection,
  "connection-not-configured": PUBLIC_EXIT.connection,
  "profile-unavailable": PUBLIC_EXIT.connection,
  "auth-failed": PUBLIC_EXIT.connection,
  "identity-mismatch": PUBLIC_EXIT.connection,
  "response-invalid": PUBLIC_EXIT.connection,
  "transport-uncertain": PUBLIC_EXIT.connection,
  // 5 — an observer's own deadline passed; the operation may still be running.
  "deadline-exceeded": PUBLIC_EXIT.deadline,
  // 130/143 — SIGINT/SIGTERM stopped the observer (see PUBLIC_SIGNAL_EXIT); the
  // table records SIGINT, and SIGTERM envelopes carry 143.
  "observation-interrupted": PUBLIC_SIGNAL_EXIT.SIGINT,
  // 6 — a pending question/approval needs an answer.
  "interaction-required": PUBLIC_EXIT.interactionRequired,
  // 7 — the provider may or may not have received the work.
  "dispatch-unknown": PUBLIC_EXIT.unknownDispatch,
  "run-unknown": PUBLIC_EXIT.unknownDispatch,
  // 8 — conflicts, unsupported capabilities, and refused state transitions.
  conflict: PUBLIC_EXIT.conflict,
  "request-conflict": PUBLIC_EXIT.conflict,
  "revision-conflict": PUBLIC_EXIT.conflict,
  "namespace-expired": PUBLIC_EXIT.conflict,
  "namespace-closed": PUBLIC_EXIT.conflict,
  "cursor-expired": PUBLIC_EXIT.conflict,
  unsupported: PUBLIC_EXIT.conflict,
  "capability-unavailable": PUBLIC_EXIT.conflict,
  "backend-incompatible": PUBLIC_EXIT.conflict,
  busy: PUBLIC_EXIT.conflict,
  "not-ready": PUBLIC_EXIT.conflict,
  "not-empty": PUBLIC_EXIT.conflict,
  "target-mismatch": PUBLIC_EXIT.conflict,
  "session-idle": PUBLIC_EXIT.conflict,
  "interaction-stale": PUBLIC_EXIT.conflict,
  "dispatch-parked": PUBLIC_EXIT.conflict,
} as const;

export type PublicErrorCode = keyof typeof PUBLIC_ERROR_EXIT;

export function isPublicErrorCode(value: unknown): value is PublicErrorCode {
  return typeof value === "string" && Object.hasOwn(PUBLIC_ERROR_EXIT, value);
}

export function exitCodeForError(code: PublicErrorCode): number {
  return PUBLIC_ERROR_EXIT[code];
}

export interface PublicError {
  code: PublicErrorCode;
  /** Human-readable, bounded, and free of credentials, prompts and file contents. */
  message: string;
  /** True when repeating the identical request (same key) is safe and useful. */
  retryable?: boolean;
  /** Bounded, content-free structured details (IDs, stages, conflicting fields). */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Limits

export const PUBLIC_API_LIMITS = Object.freeze({
  requestIdMaxChars: 200,
  namespaceMaxChars: 64,
  idMaxChars: 200,
  nameMaxChars: 200,
  titleMaxChars: 200,
  pathMaxChars: 4096,
  gitUrlMaxChars: 2048,
  promptMaxChars: 100_000,
  promptMaxBytes: 400_000,
  steerMaxBytes: 64 * 1024,
  patchMaxBytes: 64 * 1024,
  patchMaxFields: 64,
  pageDefaultItems: 50,
  pageMaxItems: 200,
  transcriptDefaultMessages: 30,
  transcriptMaxMessages: 100,
  transcriptMaxBytes: 1024 * 1024,
  transcriptTextMaxChars: 20_000,
  interactionsMax: 32,
  historyMaxEntries: 100,
  /** Largest decoded response the client accepts from the gateway. */
  responseMaxBytes: 8 * 1024 * 1024,
  /** Largest request body the client sends. */
  requestMaxBytes: 1024 * 1024,
  execArgvMaxItems: 256,
  execArgvMaxBytes: 256 * 1024,
  execEnvMaxEntries: 64,
  execStdinMaxBytes: 1024 * 1024,
  execOutputMaxBytes: 16 * 1024 * 1024,
  execOutputPageMaxBytes: 256 * 1024,
  execTimeoutDefaultMs: 30 * 60 * 1000,
  execTimeoutMaxMs: 6 * 60 * 60 * 1000,
  execConcurrencyPerEnvironment: 4,
  waitMaxMs: 24 * 60 * 60 * 1000,
});

// ---------------------------------------------------------------------------
// Request keys and operation receipts

/**
 * A caller's idempotency key. `requestId` is chosen by the caller (or
 * generated by the CLI and saved before sending); `namespace` binds it to one
 * bounded admission window, so a key whose history has been collected can
 * never be mistaken for a new one.
 */
export interface PublicRequestKey {
  requestId: string;
  /** Omitted: the backend's current namespace. */
  namespace?: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/;
const NAMESPACE_PATTERN = /^ns-[0-9]{13}-[a-f0-9]{8}$/;

export function isPublicRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PUBLIC_API_LIMITS.requestIdMaxChars &&
    REQUEST_ID_PATTERN.test(value)
  );
}

export function isPublicNamespace(value: unknown): value is string {
  return typeof value === "string" && NAMESPACE_PATTERN.test(value);
}

/** The creation time encoded in a namespace ID, or null when malformed. */
export function publicNamespaceCreatedAt(namespace: string): number | null {
  if (!isPublicNamespace(namespace)) return null;
  const value = Number(namespace.slice(3, 16));
  return Number.isSafeInteger(value) ? value : null;
}

export function formatPublicNamespace(createdAt: number, random: string): string {
  return `ns-${String(Math.max(0, Math.trunc(createdAt))).padStart(13, "0")}-${random}`;
}

/**
 * Retention contract, published in `capabilities`. A namespace admits new
 * keys for `admissionWindowMs`; every record admitted in it is retained until
 * its fence (`createdAt + admissionWindowMs + retentionMs`), and longer while
 * any of its operations is still active. Past the fence the namespace is
 * retired and every key in it is refused with `namespace-expired`.
 */
export const PUBLIC_OPERATION_RETENTION = Object.freeze({
  admissionWindowMs: 7 * 24 * 60 * 60 * 1000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  maxOperationsPerNamespace: 5_000,
  maxRecordBytes: 8 * 1024,
  maxNamespaceBytes: 16 * 1024 * 1024,
  collectionIntervalMs: 60 * 60 * 1000,
});

export type PublicOperationState =
  | "admitted"
  | "running"
  | "succeeded"
  | "failed"
  | "partial"
  | "unknown"
  | "interrupted"
  | "cancelled";

/** States that still describe work the backend may perform or must reconcile. */
export const ACTIVE_PUBLIC_OPERATION_STATES: readonly PublicOperationState[] = Object.freeze([
  "admitted",
  "running",
  "unknown",
]);

export function isTerminalPublicOperationState(state: PublicOperationState): boolean {
  return !ACTIVE_PUBLIC_OPERATION_STATES.includes(state);
}

export interface PublicOperationResources {
  projectId?: string;
  environmentId?: string;
  sessionId?: string;
  tabId?: string;
  /** Provider dispatch request ID for prompt runs (distinct from the public key). */
  dispatchRequestId?: string;
  interactionId?: string;
  path?: string;
  remote?: string;
  forkedFromEnvironmentId?: string;
}

/** Provider admission of one prompt — separate from its execution. */
export interface PublicDispatchState {
  state: "not-sent" | "pending" | "accepted" | "rejected" | "unknown";
  origin?: "provider" | "transport";
  /** True when `run.retry`/`run.discard` can act on the parked dispatch. */
  recoverable?: boolean;
  error?: string;
}

export type PublicExecutionPhase =
  | "pending"
  | "running"
  | "waiting-for-input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown"
  | "unsupported";

export const TERMINAL_EXECUTION_PHASES: readonly PublicExecutionPhase[] = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface PublicInteractionRef {
  id: string;
  kind: string;
  revision: number;
  blocking: boolean;
  expiresAt?: number;
}

/** What happened to the work itself, with the evidence the claim rests on. */
export interface PublicExecutionState {
  state: PublicExecutionPhase;
  /** Where a terminal claim came from; absent while non-terminal. */
  evidence?:
    | "observed-turn-end"
    | "turn-outcome-record"
    | "provider-status"
    | "process-exit"
    | "lifecycle-state"
    | "none";
  error?: string;
  reason?: string;
  interactions?: PublicInteractionRef[];
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  outputLimited?: boolean;
  startedAt?: string;
  finishedAt?: string;
  observedAt?: string;
}

export interface PublicReceipt {
  operationId: string;
  namespace: string;
  requestId: string;
  action: PublicActionName;
  state: PublicOperationState;
  /** Last stage reached, e.g. `admitted`, `creating`, `starting`, `dispatching`. */
  stage: string;
  /** True when this response returned an earlier admission of the same key. */
  replayed: boolean;
  resources: PublicOperationResources;
  dispatch?: PublicDispatchState;
  execution?: PublicExecutionState;
  error?: { code: PublicErrorCode; message: string };
  /** Recorded without a payload fingerprint; changed intent cannot be detected. */
  legacyRecovery?: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** When this record stops being queryable (unless still active). */
  retainedUntil: string;
}

// ---------------------------------------------------------------------------
// Envelopes

export interface PublicConnectionIdentity {
  /** Connection or profile name as the caller selected it. */
  name: string;
  kind: "profile" | "connection";
  /** Scheme://host:port only; never credentials or query strings. */
  endpoint: string;
  installationId?: string;
  generation?: string;
}

/** Identity of the backend that produced a response; checked on every call. */
export interface PublicBackendIdentity {
  installationId: string;
  generation: string;
}

export interface PublicSuccessEnvelope<T = unknown> {
  schemaVersion: PublicApiSchemaVersion;
  action: string;
  ok: true;
  connection?: PublicConnectionIdentity;
  backend?: PublicBackendIdentity;
  result: T;
  receipt?: PublicReceipt;
  warnings?: string[];
}

export interface PublicErrorEnvelope {
  schemaVersion: PublicApiSchemaVersion;
  action: string;
  ok: false;
  connection?: PublicConnectionIdentity;
  backend?: PublicBackendIdentity;
  error: PublicError & { exitCode: number };
  /** Present whenever admission may have happened, so the caller can recover. */
  receipt?: PublicReceipt;
}

export type PublicEnvelope<T = unknown> = PublicSuccessEnvelope<T> | PublicErrorEnvelope;

/** Request body of the `public_action` registry command. */
export interface PublicActionRequest {
  schemaVersion: PublicApiSchemaVersion;
  action: PublicActionName;
  /** The action version the caller was built against. */
  actionVersion: number;
  input: Record<string, unknown>;
  request?: PublicRequestKey;
}

/**
 * Result of `public_action`, carried inside the legacy `{result}` gateway
 * wrapper with HTTP 200. Domain rejections are structured here; only
 * transport-level failures use the legacy `{error}` wrapper.
 */
export type PublicActionResponse<T = unknown> =
  | Omit<PublicSuccessEnvelope<T>, "connection">
  | Omit<PublicErrorEnvelope, "connection">;

export function publicErrorEnvelope(
  action: string,
  error: PublicError,
  receipt?: PublicReceipt,
): Omit<PublicErrorEnvelope, "connection"> {
  return {
    schemaVersion: PUBLIC_API_SCHEMA_VERSION,
    action,
    ok: false,
    error: { ...error, exitCode: exitCodeForError(error.code) },
    ...(receipt ? { receipt } : {}),
  };
}

export function publicSuccessEnvelope<T>(
  action: string,
  result: T,
  receipt?: PublicReceipt,
  warnings?: string[],
): Omit<PublicSuccessEnvelope<T>, "connection"> {
  return {
    schemaVersion: PUBLIC_API_SCHEMA_VERSION,
    action,
    ok: true,
    result,
    ...(receipt ? { receipt } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// Capabilities

export type PublicCompletionSupport = "qualified" | "unqualified";

export interface PublicProviderCapabilities {
  completion: PublicCompletionSupport;
  completionNote?: string;
  steer: boolean;
  stop: boolean;
  resume: boolean;
  fork: boolean;
  queue: boolean;
  interactions: boolean;
  controls: {
    model: boolean;
    reasoning: boolean;
    speed: boolean;
    mode: boolean;
  };
}

export interface PublicCapabilities {
  schemaVersion: PublicApiSchemaVersion;
  backend: {
    installationId: string;
    generation: string;
    version: string;
    startedAt: string;
  };
  actions: Record<string, { version: number; available: boolean; reason?: string }>;
  limits: typeof PUBLIC_API_LIMITS;
  requestKeys: {
    currentNamespace: string;
    admissionWindowMs: number;
    retentionMs: number;
    retainedNamespaces: string[];
  };
  providers: Record<string, PublicProviderCapabilities>;
  features: {
    transcriptFollow: "poll" | "unavailable";
    exec: { local: boolean; container: boolean; reason?: string };
    projectCascadeRemove: false;
    localProjectInit: false;
    promptAttachments: false;
    selectedSlashCommands: false;
    enqueue: false;
  };
}

/** Whether the selected backend advertises `action` at the caller's version. */
export function isPublicActionAvailable(
  capabilities: Pick<PublicCapabilities, "actions">,
  action: PublicActionName,
): boolean {
  const entry = capabilities.actions[action];
  return entry?.available === true && entry.version === PUBLIC_ACTIONS[action].version;
}

// ---------------------------------------------------------------------------
// Validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const OPERATION_STATES: readonly PublicOperationState[] = [
  "admitted",
  "running",
  "succeeded",
  "failed",
  "partial",
  "unknown",
  "interrupted",
  "cancelled",
];

export function isPublicReceipt(value: unknown): value is PublicReceipt {
  if (!isRecord(value)) return false;
  return (
    typeof value.operationId === "string" &&
    value.operationId.length > 0 &&
    typeof value.namespace === "string" &&
    isPublicRequestId(value.requestId) &&
    isPublicActionName(value.action) &&
    OPERATION_STATES.includes(value.state as PublicOperationState) &&
    typeof value.stage === "string" &&
    typeof value.replayed === "boolean" &&
    isRecord(value.resources) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.retainedUntil === "string" &&
    (value.dispatch === undefined || isRecord(value.dispatch)) &&
    (value.execution === undefined || isRecord(value.execution))
  );
}

function isEnvelopeError(value: unknown): value is PublicError & { exitCode: number } {
  return (
    isRecord(value) &&
    isPublicErrorCode(value.code) &&
    typeof value.message === "string" &&
    typeof value.exitCode === "number" &&
    (value.exitCode === exitCodeForError(value.code) ||
      (value.code === "observation-interrupted" &&
        value.exitCode === PUBLIC_SIGNAL_EXIT.SIGTERM)) &&
    (value.details === undefined || isRecord(value.details))
  );
}

/**
 * Structural validation of a `public_action` response. Unknown schema
 * versions and contradictory envelopes (ok with an error, error without a
 * code) are rejected rather than guessed at.
 */
export function isPublicActionResponse(value: unknown): value is PublicActionResponse {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== PUBLIC_API_SCHEMA_VERSION) return false;
  if (typeof value.action !== "string") return false;
  if (value.receipt !== undefined && !isPublicReceipt(value.receipt)) return false;
  if (
    value.backend !== undefined &&
    !(
      isRecord(value.backend) &&
      typeof value.backend.installationId === "string" &&
      typeof value.backend.generation === "string"
    )
  ) {
    return false;
  }
  if (value.ok === true) {
    return (
      Object.hasOwn(value, "result") &&
      value.error === undefined &&
      (value.warnings === undefined ||
        (Array.isArray(value.warnings) && value.warnings.every((w) => typeof w === "string")))
    );
  }
  if (value.ok === false) {
    return value.result === undefined && isEnvelopeError(value.error);
  }
  return false;
}

export function isPublicCapabilities(value: unknown): value is PublicCapabilities {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== PUBLIC_API_SCHEMA_VERSION) return false;
  const backend = value.backend;
  const keys = value.requestKeys;
  return (
    isRecord(backend) &&
    typeof backend.installationId === "string" &&
    backend.installationId.length > 0 &&
    typeof backend.generation === "string" &&
    backend.generation.length > 0 &&
    typeof backend.version === "string" &&
    isRecord(value.actions) &&
    Object.values(value.actions).every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.version === "number" &&
        typeof entry.available === "boolean",
    ) &&
    isRecord(value.limits) &&
    isRecord(keys) &&
    isPublicNamespace(keys.currentNamespace) &&
    typeof keys.admissionWindowMs === "number" &&
    typeof keys.retentionMs === "number" &&
    Array.isArray(keys.retainedNamespaces) &&
    isRecord(value.providers) &&
    isRecord(value.features)
  );
}

// ---------------------------------------------------------------------------
// Canonical intent

/**
 * Deterministic JSON for fingerprinting: object keys sorted, `undefined`
 * dropped, arrays kept in order. Two requests with the same canonical form
 * express the same intent.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Canonical JSON cannot encode a non-finite number");
    }
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Durations and wait conditions (shared by the CLI parser and the backend)

/** Parses `500ms`, `30s`, `5m`, `2h`, or bare seconds. Null when invalid. */
export function parsePublicDuration(value: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const ms = Math.round(amount * factor);
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

export type PublicEnvironmentWaitCondition = "running" | "ready" | "stopped" | "deleted";
