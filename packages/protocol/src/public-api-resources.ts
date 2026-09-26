/**
 * Public resource summaries for the `orkestrator` client.
 *
 * These are allowlisted projections. They never carry initial prompts,
 * attachments, provider session IDs, credentials, raw configuration documents,
 * or transcript content (transcripts are an explicit, bounded read). IDs are
 * opaque and stable: a public session ID survives provider resumes because it
 * is derived from the environment and tab, never from the provider's own ID.
 */
import type { AgentPlatform } from "./agent-platforms.js";
import type { PublicCompletionSupport, PublicInteractionRef } from "./public-api.js";

// ---------------------------------------------------------------------------
// Session handles

const SESSION_PREFIX = "ses_";

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const TAB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Stable public session handle for the native tab `tabId` of `environmentId`. */
export function encodePublicSessionId(environmentId: string, tabId: string): string {
  if (!ENVIRONMENT_ID_PATTERN.test(environmentId) || !TAB_ID_PATTERN.test(tabId)) {
    throw new Error("Session identity is invalid");
  }
  return `${SESSION_PREFIX}${toBase64Url(`${environmentId}\n${tabId}`)}`;
}

export function decodePublicSessionId(
  sessionId: unknown,
): { environmentId: string; tabId: string } | null {
  if (typeof sessionId !== "string" || !sessionId.startsWith(SESSION_PREFIX)) return null;
  if (sessionId.length > 700) return null;
  const decoded = fromBase64Url(sessionId.slice(SESSION_PREFIX.length));
  if (decoded === null) return null;
  const separator = decoded.indexOf("\n");
  if (separator < 0 || decoded.indexOf("\n", separator + 1) >= 0) return null;
  const environmentId = decoded.slice(0, separator);
  const tabId = decoded.slice(separator + 1);
  if (!ENVIRONMENT_ID_PATTERN.test(environmentId) || !TAB_ID_PATTERN.test(tabId)) return null;
  // Reject non-canonical encodings so one session has exactly one handle.
  if (encodePublicSessionId(environmentId, tabId) !== sessionId) return null;
  return { environmentId, tabId };
}

/** The logical session key every native tab uses (`env-<environment>:<tab>`). */
export function nativeTabLogicalSessionKey(environmentId: string, tabId: string): string {
  return `env-${environmentId}:${tabId}`;
}

// ---------------------------------------------------------------------------
// Pagination

export interface PublicPage<T> {
  items: T[];
  total: number;
  /** Opaque continuation; absent on the last page. */
  nextCursor?: string;
}

interface PageCursor {
  v: 1;
  offset: number;
  /** Fingerprint of the collection the cursor was issued against. */
  fp: string;
}

export function encodePublicPageCursor(offset: number, fingerprint: string): string {
  return toBase64Url(JSON.stringify({ v: 1, offset, fp: fingerprint } satisfies PageCursor));
}

/**
 * Decodes a page cursor. `expired` means the collection changed since the
 * cursor was issued; the caller must restart from the first page rather than
 * risk skipping or repeating items.
 */
export function decodePublicPageCursor(
  cursor: string,
  fingerprint: string,
): { offset: number } | "invalid" | "expired" {
  if (cursor.length > 512) return "invalid";
  const decoded = fromBase64Url(cursor);
  if (decoded === null) return "invalid";
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return "invalid";
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as PageCursor).v !== 1 ||
    !Number.isSafeInteger((parsed as PageCursor).offset) ||
    (parsed as PageCursor).offset < 0 ||
    typeof (parsed as PageCursor).fp !== "string"
  ) {
    return "invalid";
  }
  if ((parsed as PageCursor).fp !== fingerprint) return "expired";
  return { offset: (parsed as PageCursor).offset };
}

// ---------------------------------------------------------------------------
// Summaries

export interface PublicProjectSummary {
  id: string;
  name: string;
  /** Credential-free remote URL. */
  gitUrl: string;
  /** Backend filesystem path of the checkout, when one is attached. */
  localPath: string | null;
  folder: string | null;
  addedAt: string;
  order: number;
  /** Content revision of the project record; pass it back as `expectedRevision`. */
  revision: string;
  environmentCount: number;
}

export type PublicEnvironmentType = "local" | "container";

export interface PublicEnvironmentSummary {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  environmentType: PublicEnvironmentType;
  status: "running" | "stopped" | "error" | "creating" | "stopping";
  /** Running and setup complete (or explicitly overridden). */
  ready: boolean;
  setup: {
    phase: "pending" | "running" | "ready" | "failed";
    complete: boolean;
    overridden: boolean;
    startedAt?: string;
    completedAt?: string;
  };
  lifecycle: {
    operation: "deleting" | "merging" | null;
    error: string | null;
    deletionRequested: boolean;
  };
  activity: {
    state: string | null;
    hasUnreadWork: boolean;
  };
  pendingAgentLaunch: boolean;
  startupSession: {
    sessionId: string;
    agent: string;
    status: "starting" | "running" | "error";
    error?: string;
  } | null;
  /** Backend path of a local worktree; null for container environments. */
  workspacePath: string | null;
  base: { branch: string | null; commit: string | null };
  pr: { url: string | null; state: string | null };
  createdAt: string;
  lastActivityAt: string | null;
  /** Content revision of the environment settings; used by `environment.config.set`. */
  settingsRevision: string;
}

export type PublicSessionActivity = "idle" | "working" | "waiting" | "unknown";

export interface PublicSessionSummary {
  id: string;
  environmentId: string;
  tabId: string;
  agent: AgentPlatform;
  title: string | null;
  /** Whether a provider conversation has been attached to the tab. */
  hasProviderSession: boolean;
  /** In-memory observation only; `unknown` after a backend restart until observed. */
  activity: PublicSessionActivity;
  latestRequestId: string | null;
  recoverableDispatch: {
    requestId: string;
    kind: "prompt" | "steer";
    status: "reconciling" | "action-required";
  } | null;
  pendingInteractionCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Agent options

export type PublicCatalogueState = "ready" | "empty" | "stale" | "unavailable";

export interface PublicModelOption {
  id: string;
  label: string;
  reasoning: string[];
  defaultReasoningId: string | null;
  supportsSpeed: boolean;
  supportsMode: boolean;
}

export interface PublicAgentOption {
  agent: AgentPlatform;
  enabled: boolean;
  completion: PublicCompletionSupport;
  controls: { model: boolean; reasoning: boolean; speed: boolean; mode: boolean };
  steer: boolean;
  resume: boolean;
  fork: boolean;
  catalogue: {
    state: PublicCatalogueState;
    source: "live" | "cache" | "none";
    error?: string;
    models: PublicModelOption[];
  };
  defaults: { model: string | null; reasoningEffort: string | null; fastMode: boolean | null };
}

export interface PublicAgentOptions {
  projectId: string;
  environmentId: string | null;
  defaultAgent: AgentPlatform;
  agents: PublicAgentOption[];
}

// ---------------------------------------------------------------------------
// Interactions

export interface PublicInteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface PublicInteractionQuestion {
  id: string;
  prompt: string;
  required: boolean;
  multiple: boolean;
  secret: boolean;
  allowFreeText: boolean;
  options: PublicInteractionOption[];
}

export interface PublicInteraction extends PublicInteractionRef {
  sessionId: string;
  state: string;
  title: string;
  body?: string;
  questions: PublicInteractionQuestion[];
  /** Actions this interaction accepts. */
  actions: Array<"answer" | "approve-for-session" | "decline" | "deny" | "cancel">;
  createdAt: number;
}

export interface PublicInteractionAnswerInput {
  questionId: string;
  optionIds?: string[];
  freeText?: string;
}

// ---------------------------------------------------------------------------
// Transcripts

export interface PublicTranscriptPart {
  type: string;
  toolName?: string;
  status?: string;
  title?: string;
  /** Tool input/output bodies are never inlined; they are only counted. */
  detailOmitted?: boolean;
}

export interface PublicTranscriptMessage {
  id: string;
  role: string;
  createdAt: string | null;
  text: string;
  textTruncated: boolean;
  parts: PublicTranscriptPart[];
}

export interface PublicTranscriptPage {
  sessionId: string;
  /** Always oldest first within a page. */
  order: "oldest-first";
  messages: PublicTranscriptMessage[];
  /** Cursor for the page of older messages; absent when history is complete. */
  olderCursor?: string;
  complete: boolean;
  truncated: boolean;
  truncation?: { reason: string; omittedMessages?: number };
  /** Opaque token for change detection when polling. */
  token: string | null;
  historyEpoch: string | null;
  freshness: "current" | "cached" | "empty";
}

// ---------------------------------------------------------------------------
// Settings

export type PublicSettingScope = "project" | "environment";

export type PublicSettingType =
  | "string"
  | "port"
  | "boolean"
  | "string-list"
  | "domain-list"
  | "port-mappings"
  | "agent"
  | "agent-mode";

/**
 * When a changed setting takes effect.
 *
 * - `next-environment`: environments created afterwards.
 * - `next-start`: the next start/recreate of this environment.
 * - `next-session`: native sessions started afterwards; live sessions keep
 *   their controls (change those with `session.config.set`).
 * - `applied`: the running environment adopts it immediately.
 */
export type PublicSettingApplication =
  | "next-environment"
  | "next-start"
  | "next-session"
  | "applied";

export interface PublicSettingDescriptor {
  key: string;
  scope: PublicSettingScope;
  type: PublicSettingType;
  /** Whether unsetting restores an inherited value (vs. a fixed default). */
  inherits: boolean;
  environmentTypes?: readonly PublicEnvironmentType[];
  application: PublicSettingApplication;
  description: string;
}

const AGENT_PLATFORM_KEYS = ["claude", "codex", "cursor", "grok", "opencode", "pi"] as const;

function agentSettingDescriptors(scope: PublicSettingScope): PublicSettingDescriptor[] {
  const application: PublicSettingApplication = "next-session";
  return [
    {
      key: "agent.defaultAgent",
      scope,
      type: "agent",
      inherits: true,
      application,
      description: "Agent platform used when a launch does not name one.",
    },
    ...AGENT_PLATFORM_KEYS.flatMap((platform): PublicSettingDescriptor[] => [
      {
        key: `agent.${platform}.mode`,
        scope,
        type: "agent-mode",
        inherits: true,
        application,
        description: `Launch mode (native or terminal) for ${platform}.`,
      },
      {
        key: `agent.${platform}.model`,
        scope,
        type: "string",
        inherits: true,
        application,
        description: `Default model for new ${platform} sessions.`,
      },
      {
        key: `agent.${platform}.reasoningEffort`,
        scope,
        type: "string",
        inherits: true,
        application,
        description: `Default reasoning level for new ${platform} sessions.`,
      },
      {
        key: `agent.${platform}.fastMode`,
        scope,
        type: "boolean",
        inherits: true,
        application,
        description: `Default speed for new ${platform} sessions (true is Fast).`,
      },
    ]),
  ];
}

export const PUBLIC_PROJECT_SETTINGS: readonly PublicSettingDescriptor[] = Object.freeze([
  {
    key: "defaultBranch",
    scope: "project",
    type: "string",
    inherits: false,
    application: "next-environment",
    description: "Branch new environments are created from.",
  },
  {
    key: "prBaseBranch",
    scope: "project",
    type: "string",
    inherits: false,
    application: "applied",
    description: "Base branch for pull requests and diff baselines.",
  },
  {
    key: "defaultPortMappings",
    scope: "project",
    type: "port-mappings",
    inherits: false,
    environmentTypes: ["container"],
    application: "next-environment",
    description: "Port mappings copied into new container environments.",
  },
  {
    key: "filesToCopy",
    scope: "project",
    type: "string-list",
    inherits: false,
    application: "next-environment",
    description: "Untracked files copied into new environments.",
  },
  {
    key: "entryPort",
    scope: "project",
    type: "port",
    inherits: false,
    application: "next-environment",
    description: "Default preview entry port for new environments.",
  },
  ...agentSettingDescriptors("project"),
]);

export const PUBLIC_ENVIRONMENT_SETTINGS: readonly PublicSettingDescriptor[] = Object.freeze([
  {
    key: "portMappings",
    scope: "environment",
    type: "port-mappings",
    inherits: false,
    environmentTypes: ["container"],
    application: "next-start",
    description: "Container port mappings; a running container adopts them on recreate.",
  },
  {
    key: "allowedDomains",
    scope: "environment",
    type: "domain-list",
    inherits: true,
    environmentTypes: ["container"],
    application: "next-start",
    description: "Restricted-network allowlist; unset inherits the global list.",
  },
  ...agentSettingDescriptors("environment"),
]);

export function publicSettingDescriptor(
  scope: PublicSettingScope,
  key: string,
): PublicSettingDescriptor | undefined {
  return (scope === "project" ? PUBLIC_PROJECT_SETTINGS : PUBLIC_ENVIRONMENT_SETTINGS).find(
    (descriptor) => descriptor.key === key,
  );
}

export interface PublicSettingValue {
  key: string;
  /** Value stored at this scope; null when this scope does not decide. */
  value: unknown;
  /** Value in force after inheritance. */
  effective: unknown;
  source: "environment" | "repository" | "global" | "default" | "unset";
  application: PublicSettingApplication;
}

export interface PublicSettingsSnapshot {
  scope: PublicSettingScope;
  targetId: string;
  revision: string;
  settings: PublicSettingValue[];
}

export interface PublicSettingsPatch {
  set?: Record<string, unknown>;
  unset?: string[];
  expectedRevision?: string;
}

export interface PublicSettingsChange {
  key: string;
  change: "set" | "unset";
  application: PublicSettingApplication;
}

// ---------------------------------------------------------------------------
// Exec

export interface PublicExecOutputWindow {
  stream: "stdout" | "stderr";
  /** UTF-8 decoded with replacement; `base64` carries the exact bytes. */
  text: string;
  base64: string;
  offset: number;
  totalBytes: number;
  truncatedHead: boolean;
  complete: boolean;
}
