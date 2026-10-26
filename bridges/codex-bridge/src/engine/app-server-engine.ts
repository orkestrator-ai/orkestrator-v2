/**
 * `CodexEngine` over a persistent `codex app-server --stdio` child.
 *
 * Ties together the supervisor (process lifecycle + generations), the JSONL RPC
 * client (transport), the event reducer (protocol → engine events) and the
 * server-request router (never leave app-server waiting).
 *
 * Three properties are load-bearing:
 *
 *  1. **Notifications never block the transport.** The supervisor hands them to a
 *     per-thread serial queue; reduction and fan-out happen there, so a slow
 *     consumer on one thread cannot stall app-server's bounded outbound queue and
 *     take down every other thread in the environment.
 *
 *  2. **Interrupt is a lifecycle, not a boolean.** `turn/interrupt` only *asks*.
 *     The turn is not over until a terminal `turn/completed` arrives, so the
 *     engine exposes an explicit waiter with escalation instead of pretending the
 *     response means "stopped".
 *
 *  3. **Dispatch is at-most-once.** The browser's request id is forwarded as
 *     `clientUserMessageId`; after an ambiguous failure the engine reconciles
 *     against persisted turns rather than retrying blind.
 */
import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import {
  ARTIFACT_TOOL_NAMES,
  ORKESTRATOR_ARTIFACT_MCP_PATH,
  ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
} from "@orkestrator/protocol/transcript-artifacts";
import {
  NATIVE_AGENT_PENDING_SIGN_IN_TTL_MS,
  normalizePendingSignIn,
  type NativeAgentPendingSignIn,
} from "@orkestrator/protocol/native-agent";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  AppServerSupervisor,
  type AppServerHealth,
  type AppServerSupervisorOptions,
} from "../app-server/process-supervisor.js";
import {
  ServerRequestRouter,
  type ParkedHoldOutcome,
} from "../app-server/server-request-router.js";
import type {
  ApprovalDecision,
  ApprovalResolvedDecision,
  ApprovalRequest,
  ApprovalResolution,
} from "../app-server/approvals.js";
import type {
  InteractionAnswer,
  InteractionRequest,
  InteractionResolution,
} from "../app-server/interactions.js";
import { reduceHistoricalTurns, reduceNotification } from "../app-server/event-reducer.js";
import type { SkillsListParams, UserInput } from "../app-server/generated/typescript/v2/index.js";
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";
import {
  AppServerRpcError,
  JSON_RPC_METHOD_NOT_FOUND,
  classifyDispatchFailure,
  isPaginatedHistoryUnsupportedError,
  isSafeToRetryImmediately,
  isUnmaterializedThreadError,
  toEngineError,
} from "../app-server/errors.js";
import {
  reconcileFromThreadTurns,
  type ReconciliationOutcome,
} from "../sessions/dispatch-journal.js";
import {
  codexHostedNetworkLockGaps,
  codexNetworkDeniedConfig,
  codexNetworkDeniedSearchMode,
  codexProjectSkillsConfig,
  codexProjectTrustConfig,
  codexRequestUserInputConfig,
  codexToolHistoryGaps,
} from "../codex-config.js";
import { findTranscriptPath, listTranscriptPaths } from "../history/rollout.js";
import {
  threadToolHistoryVerdict,
  type ToolHistoryVerdict,
} from "../sessions/tool-history-guard.js";
import { type McpToolAvailability, waitForMcpToolAvailability } from "./mcp-tool-availability.js";
import {
  APP_SERVER_CAPABILITIES,
  type CodexEngine,
  type EngineCapabilities,
  type EngineAccountUsageWindow,
  type EngineError,
  type EngineEvent,
  type EngineEventListener,
  type EngineGeneration,
  type EngineInfo,
  type EngineModel,
  type EngineRateLimitWindow,
  type EngineThread,
  type EngineThreadTurn,
  type EngineTurn,
  type EngineTurnConfig,
  type EngineUserInput,
  type ListThreadsOptions,
  type ListThreadsResult,
  type ReadThreadOptions,
  type ResumeThreadOptions,
  type StartThreadOptions,
  type StartTurnOptions,
} from "./types.js";

/**
 * Per-tool MCP approval for Orkestrator's mail and transcript-artifact tools
 * (keyed by the raw tool name). Always approved: mail only writes to
 * Orkestrator's message store and is how a worker reports back; artifact tools
 * only write to Orkestrator's bounded artifact store and never the workspace.
 */
const AGENT_MAIL_TOOL_APPROVALS = Object.fromEntries(
  [...AGENT_MAIL_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES].map((name) => [
    name,
    { approval_mode: "approve" },
  ]),
);

/**
 * Root source kinds Orkestrator threads can have.
 *
 * `thread/list` defaults to *interactive* kinds when `sourceKinds` is omitted,
 * which hides both legacy `exec` threads (created by the SDK engine) and new
 * `appServer` ones — silently emptying the resume dialog. Verified live in
 * `app-server/live-contract.test.ts`.
 *
 * Sub-agent kinds are excluded on purpose: they are children, not conversations
 * the user picks from history.
 */
export const ROOT_THREAD_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"] as const;

/** Runtime notice shown when Codex's own connector is refused the account token. */
export const CODEX_SIGN_IN_EXPIRED_NOTICE = "Codex sign-in expired. Sign in again to continue.";
/** Prompt-admission message once app-server confirms the account is signed out. */
export const CODEX_SIGN_IN_REQUIRED_MESSAGE =
  "You've been signed out of Codex. Sign in again to keep working.";

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalPublicString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? redactSecrets(value).slice(0, 1_000)
    : undefined;
}

function allowlistToolInventory(value: unknown): Record<string, unknown> {
  const source = objectRecord(value);
  const tools: Record<string, unknown> = {};
  for (const [name, candidate] of Object.entries(source)) {
    const tool = objectRecord(candidate);
    tools[name] = {
      ...(optionalPublicString(tool.description)
        ? { description: optionalPublicString(tool.description) }
        : {}),
      ...(optionalPublicString(tool.title) ? { title: optionalPublicString(tool.title) } : {}),
    };
  }
  return tools;
}

function allowlistRuntimeInventory(
  value: unknown,
  kind: "mcp" | "skills" | "hooks",
): { data: Record<string, unknown>[] } | { error: string } {
  const root = objectRecord(value);
  if (typeof root.error === "string") return { error: "Unavailable" };
  const data = Array.isArray(root.data) ? root.data : [];
  const allowed: Record<string, unknown>[] = [];
  for (const candidate of data) {
    const entry = objectRecord(candidate);
    if (kind === "mcp") {
      const name = optionalPublicString(entry.name);
      if (!name) continue;
      const serverInfo = objectRecord(entry.serverInfo);
      const toolsError = optionalPublicString(entry.toolsError);
      allowed.push({
        name,
        ...(optionalPublicString(entry.status)
          ? { status: optionalPublicString(entry.status) }
          : {}),
        ...(Object.keys(serverInfo).length > 0
          ? {
              serverInfo: {
                ...(optionalPublicString(serverInfo.name)
                  ? { name: optionalPublicString(serverInfo.name) }
                  : {}),
                ...(optionalPublicString(serverInfo.version)
                  ? { version: optionalPublicString(serverInfo.version) }
                  : {}),
              },
            }
          : {}),
        ...(entry.tools && typeof entry.tools === "object"
          ? { tools: allowlistToolInventory(entry.tools) }
          : {}),
        ...(toolsError ? { toolsError } : {}),
      });
      continue;
    }

    if (kind === "skills") {
      const skills = Array.isArray(entry.skills) ? entry.skills : [];
      allowed.push({
        skills: skills.flatMap((candidateSkill) => {
          const skill = objectRecord(candidateSkill);
          const name = optionalPublicString(skill.name);
          if (!name) return [];
          const skillInterface = objectRecord(skill.interface);
          return [
            {
              name,
              ...(optionalPublicString(skill.description)
                ? { description: optionalPublicString(skill.description) }
                : {}),
              ...(optionalPublicString(skill.shortDescription)
                ? { shortDescription: optionalPublicString(skill.shortDescription) }
                : {}),
              ...(Object.keys(skillInterface).length > 0
                ? {
                    interface: {
                      ...(optionalPublicString(skillInterface.displayName)
                        ? { displayName: optionalPublicString(skillInterface.displayName) }
                        : {}),
                      ...(optionalPublicString(skillInterface.shortDescription)
                        ? {
                            shortDescription: optionalPublicString(skillInterface.shortDescription),
                          }
                        : {}),
                      ...(optionalPublicString(skillInterface.brandColor)
                        ? { brandColor: optionalPublicString(skillInterface.brandColor) }
                        : {}),
                    },
                  }
                : {}),
              ...(optionalPublicString(skill.scope)
                ? { scope: optionalPublicString(skill.scope) }
                : {}),
              ...(typeof skill.enabled === "boolean" ? { enabled: skill.enabled } : {}),
            },
          ];
        }),
      });
      continue;
    }

    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    allowed.push({
      hooks: hooks.flatMap((candidateHook) => {
        const hook = objectRecord(candidateHook);
        const key = optionalPublicString(hook.key);
        const eventName = optionalPublicString(hook.eventName);
        if (!key || !eventName) return [];
        return [
          {
            key,
            eventName,
            ...(optionalPublicString(hook.handlerType)
              ? { handlerType: optionalPublicString(hook.handlerType) }
              : {}),
            ...(optionalPublicString(hook.source)
              ? { source: optionalPublicString(hook.source) }
              : {}),
            ...(optionalPublicString(hook.pluginId)
              ? { pluginId: optionalPublicString(hook.pluginId) }
              : {}),
            ...(typeof hook.enabled === "boolean" ? { enabled: hook.enabled } : {}),
            ...(typeof hook.isManaged === "boolean" ? { isManaged: hook.isManaged } : {}),
            ...(optionalPublicString(hook.trustStatus)
              ? { trustStatus: optionalPublicString(hook.trustStatus) }
              : {}),
          },
        ];
      }),
    });
  }
  return {
    data: allowed,
  };
}

function allowlistRateLimitSnapshot(value: unknown): Record<string, unknown> {
  const raw = objectRecord(value);
  const rateLimits: Record<string, unknown> = {};
  const limitName = optionalPublicString(raw.limitName);
  if (limitName) rateLimits.limitName = limitName;
  const normalModelSlug = optionalPublicString(raw.normalModelSlug);
  if (normalModelSlug) rateLimits.normalModelSlug = normalModelSlug;
  for (const key of ["primary", "secondary"] as const) {
    const window = objectRecord(raw[key]);
    const allowed: Record<string, number> = {};
    if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
      allowed.usedPercent = Math.max(0, Math.min(100, window.usedPercent));
    }
    if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
      allowed.resetsAt = window.resetsAt;
    }
    if (
      typeof window.windowDurationMins === "number" &&
      Number.isFinite(window.windowDurationMins) &&
      window.windowDurationMins >= 0
    ) {
      allowed.windowDurationMins = window.windowDurationMins;
    }
    if (Object.keys(allowed).length > 0) rateLimits[key] = allowed;
  }
  return rateLimits;
}

function allowlistRateLimits(value: unknown): Record<string, unknown> | { error: string } {
  const response = objectRecord(value);
  if (typeof response.error === "string") return { error: "Unavailable" };
  const rateLimits = allowlistRateLimitSnapshot(response.rateLimits);
  const rawByLimitId = objectRecord(response.rateLimitsByLimitId);
  const rateLimitsByLimitId = Object.fromEntries(
    Object.entries(rawByLimitId)
      .slice(0, 16)
      .flatMap(([limitId, snapshot]) => {
        const safeLimitId = optionalPublicString(limitId)?.slice(0, 128);
        if (!safeLimitId) return [];
        const allowed = allowlistRateLimitSnapshot(snapshot);
        return Object.keys(allowed).length > 0 ? [[safeLimitId, allowed]] : [];
      }),
  );
  return {
    rateLimits,
    ...(typeof response.ordinaryUsageAllowed === "boolean"
      ? { ordinaryUsageAllowed: response.ordinaryUsageAllowed }
      : {}),
    ...(Object.keys(rateLimitsByLimitId).length > 0 ? { rateLimitsByLimitId } : {}),
  };
}

/**
 * ECMAScript `Date` only represents ±8.64e15 ms around the epoch. A provider
 * reset timestamp outside that range yields an Invalid Date whose
 * `toISOString()` throws, so it is dropped rather than aborting the read.
 */
const MAX_DATE_MS = 8.64e15;

/**
 * Map an `account/rateLimits/read` response onto the engine's window shape.
 *
 * The on-demand read answers the same snapshot an `account/rateLimits/updated`
 * notification carries, but without a thread to attribute it to. Reusing the
 * allowlist here keeps the on-demand path from being a second, narrower
 * interpretation of the provider's payload.
 */
export function rateLimitWindowsFromRead(value: unknown): EngineRateLimitWindow[] {
  const response = objectRecord(value);
  const snapshot = allowlistRateLimitSnapshot(response.rateLimits);
  const planLabel = optionalPublicString(snapshot.limitName);
  const normalModelSlug = optionalPublicString(snapshot.normalModelSlug);
  const windows: EngineRateLimitWindow[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    if (!Object.hasOwn(snapshot, slot)) continue;
    const window = objectRecord(snapshot[slot]);
    if (!window) continue;
    const usedPercent = typeof window.usedPercent === "number" ? window.usedPercent : undefined;
    const windowMinutes =
      typeof window.windowDurationMins === "number" ? window.windowDurationMins : undefined;
    const resetsAtSeconds = typeof window.resetsAt === "number" ? window.resetsAt : undefined;
    // `Date` only spans ±8.64e15 ms; a larger provider value would make
    // `toISOString()` throw and abort the whole usage read.
    const resetsAtMs =
      resetsAtSeconds !== undefined && Math.abs(resetsAtSeconds * 1_000) <= MAX_DATE_MS
        ? resetsAtSeconds * 1_000
        : undefined;
    const resetsAt = resetsAtMs !== undefined ? new Date(resetsAtMs).toISOString() : undefined;
    windows.push({
      slot,
      label: slot === "primary" ? (planLabel ?? normalModelSlug ?? "Primary") : "Secondary",
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    });
  }
  return windows;
}

function safeUsageCount(value: unknown): number | undefined {
  let parsed: number;
  if (typeof value === "bigint") parsed = Number(value);
  else if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && /^\d+$/.test(value)) parsed = Number(value);
  else return undefined;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Allowlist the non-sensitive account token activity returned by app-server. */
export function accountUsageWindows(value: unknown): EngineAccountUsageWindow[] {
  const response = objectRecord(value);
  const summary = objectRecord(response.summary);
  const windows: EngineAccountUsageWindow[] = [];
  const lifetimeTokens = safeUsageCount(summary.lifetimeTokens);
  if (lifetimeTokens !== undefined) {
    windows.push({ window: "lifetime", label: "Lifetime", tokens: lifetimeTokens });
  }
  const peakDailyTokens = safeUsageCount(summary.peakDailyTokens);
  if (peakDailyTokens !== undefined) {
    windows.push({ window: "peak-daily", label: "Peak day", tokens: peakDailyTokens });
  }
  if (Array.isArray(response.dailyUsageBuckets)) {
    for (const candidate of response.dailyUsageBuckets.slice(-90)) {
      const bucket = objectRecord(candidate);
      const startDate = optionalPublicString(bucket.startDate);
      const tokens = safeUsageCount(bucket.tokens);
      if (!startDate || tokens === undefined) continue;
      windows.push({ window: `daily:${startDate}`, label: startDate, tokens });
    }
  }
  return windows;
}

export interface AppServerEngineOptions {
  codexPath: string;
  cwd: string;
  codexHome: string;
  clientInfo: { name: string; title: string; version: string };
  configOverrides?: Record<string, string>;
  /** Escalation budget for a turn that will not stop. */
  interruptTimeoutMs?: number;
  /** How long a human has to answer an approval before it auto-denies. */
  approvalTimeoutMs?: number;
  now?: () => number;
  /**
   * Whether a thread's inherited history still declares tools
   * (`sessions/tool-history-guard.ts`). Defaults to reading its rollout and
   * fork ancestors; scripted-child tests replace it.
   */
  toolHistoryVerdict?: (threadId: string) => Promise<ToolHistoryVerdict>;
  /**
   * Supervisor overrides forwarded verbatim.
   *
   * Deliberately *not* an injectable supervisor instance: the engine must always
   * own the `onNotification` / `onServerRequest` wiring, or a supplied supervisor
   * would silently disable event fan-out and server-request answering — which
   * would look like a hung turn rather than a wiring mistake.
   */
  supervisorOverrides?: Partial<
    Pick<
      AppServerSupervisorOptions,
      | "spawnProcess"
      | "refreshEnvironment"
      | "pidFileEnabled"
      | "backoffScheduleMs"
      | "shutdownGraceMs"
      | "circuitBreakerThreshold"
      | "circuitWindowMs"
    >
  >;
}

interface ThreadBinding {
  handle: string;
  threadId: string;
  config: EngineTurnConfig;
  generation: EngineGeneration;
}

interface TerminalWaiter {
  resolve: (status: "completed" | "interrupted" | "failed") => void;
  turnId: string;
}

interface RuntimeNotice {
  global: boolean;
  method: string;
  severity: "info" | "warning" | "error";
  id?: string;
  subject?: string;
  detail?: string;
  receivedAt: string;
  threadId?: string;
}

interface RuntimeHealthNotice {
  method: string;
  message: string;
  severity: "info" | "warning" | "error";
  id?: string;
  subject?: string;
  detail?: string;
  receivedAt: string;
}

function runtimeNoticeSeverity(
  method: string,
  params: Record<string, unknown>,
): RuntimeNotice["severity"] {
  if (method === "mcpServer/startupStatus/updated") {
    const hasFailureDetail = [params.error, params.failureReason].some(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    if (params.status === "failed" || hasFailureDetail) return "error";
    // Only known non-failure lifecycle states are inventory. An unfamiliar or
    // malformed shape stays visible so a protocol change cannot hide a real
    // startup failure.
    if (
      params.status === "starting" ||
      params.status === "ready" ||
      params.status === "cancelled"
    ) {
      return "info";
    }
    return "warning";
  }
  return "warning";
}

function redactRuntimeNoticeDetail(value: string): string {
  return redactSecrets(value)
    .replace(/\bfile:\/\/[^\s"'`),;]+/gi, "[path redacted]")
    .replace(/\\\\[^\\\s"'`),;]+\\[^\s"'`),;]*/g, "[path redacted]")
    .replace(/\b[A-Z]:[\\/][^\s"'`),;]*/gi, "[path redacted]")
    .replace(/(^|[\s("'`=])~\/[^\s"'`),;]*/g, "$1[path redacted]")
    .replace(/(^|[\s("'`=])\/(?:[^\s"'`),;]+\/)+[^\s"'`),;]*/g, "$1[path redacted]")
    .replace(
      /(^|[\s("'`=])\/(?:dev|etc|home|opt|private|proc|run|srv|tmp|usr|var)(?=$|[\s"'`),;])/g,
      "$1[path redacted]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[identity redacted]")
    .slice(0, 1_000);
}

function runtimeNoticeDetail(method: string, params: Record<string, unknown>): string | undefined {
  const strings = (...values: unknown[]) =>
    values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  let parts: string[];
  if (method === "mcpServer/startupStatus/updated") {
    const status = strings(params.name, params.status).join(": ");
    parts = [status, ...strings(params.error, params.failureReason)];
  } else if (method === "configWarning" || method === "deprecationNotice") {
    parts = strings(params.summary, params.details);
  } else if (method === "model/rerouted") {
    const route = strings(params.fromModel, params.toModel).join(" → ");
    parts = [route, ...strings(params.reason)];
  } else {
    parts = strings(params.message, params.reason, params.error, params.status);
  }

  const detail = parts.filter(Boolean).join("\n");
  return detail ? redactRuntimeNoticeDetail(detail) : undefined;
}

function mcpRuntimeStatus(value: unknown): Map<string, string | null> | undefined {
  const root = objectRecord(value);
  if (typeof root.error === "string" || !Array.isArray(root.data)) return undefined;
  const statuses = new Map<string, string | null>();
  for (const candidate of root.data) {
    const entry = objectRecord(candidate);
    const name = optionalPublicString(entry.name);
    const status = optionalPublicString(entry.runtimeStatus);
    if (name) statuses.set(name, status ?? null);
  }
  return statuses;
}

const SETTLED_MCP_RUNTIME_STATUSES = new Set([
  "notStarted",
  "starting",
  "connected",
  "cancelled",
  "disabled",
]);

function mcpStatusKeepsFailure(status: string | null | undefined): boolean {
  return status === null || status === undefined || !SETTLED_MCP_RUNTIME_STATUSES.has(status);
}

function mcpFailureReason(notice: RuntimeNotice): string | undefined {
  if (!notice.detail) return undefined;
  const lines = notice.detail.split("\n");
  const reason = lines.length > 1 ? lines.slice(1).join("\n") : notice.detail;
  return reason || undefined;
}

/** Most skill load failures one health snapshot reports. */
const MAX_SKILL_LOAD_NOTICES = 16;

/** Servers per `mcpServerStatus/list` page, and the most pages one read follows. */
const MCP_STATUS_PAGE_SIZE = 100;
const MCP_STATUS_MAX_PAGES = 10;

/** Stable, path-free identity for skills sharing a directory name. */
function skillPathFingerprint(path: string): string {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash = Math.imul(hash ^ path.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Skill load failures from a `skills/list` response, as runtime notices.
 *
 * The response is authoritative for the moment it was read, so these are
 * derived per snapshot rather than retained: a skill that has since been fixed
 * simply stops appearing. Named `skill/load` to match Pi's `extension/load` and
 * Claude's `plugin/load`. The subject is the skill's directory name (the file
 * is always `SKILL.md`); the full path stays out, as it does for every notice.
 */
function skillLoadNotices(response: unknown, receivedAt: string): RuntimeHealthNotice[] {
  const data = objectRecord(response).data;
  if (!Array.isArray(data)) return [];
  const notices: RuntimeHealthNotice[] = [];
  const seen = new Set<string>();
  for (const candidate of data) {
    const errors = objectRecord(candidate).errors;
    if (!Array.isArray(errors)) continue;
    for (const candidateError of errors) {
      if (notices.length >= MAX_SKILL_LOAD_NOTICES) return notices;
      const error = objectRecord(candidateError);
      const path = typeof error.path === "string" ? error.path : "";
      const segments = path.split(/[\\/]/).filter(Boolean);
      const file = segments.at(-1);
      const subject = (/^skill\.md$/i.test(file ?? "") ? segments.at(-2) : file)?.slice(0, 128);
      const id = path
        ? `skill:${subject ?? "unknown"}:${skillPathFingerprint(path)}`
        : `skill:${notices.length}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const detail =
        typeof error.message === "string" && error.message.trim()
          ? redactRuntimeNoticeDetail(error.message)
          : undefined;
      notices.push({
        method: "skill/load",
        message: subject ? `Codex skill ${subject} failed to load` : "A Codex skill failed to load",
        severity: "error",
        id,
        ...(subject ? { subject } : {}),
        ...(detail ? { detail } : {}),
        receivedAt,
      });
    }
  }
  return notices;
}

/**
 * Codex's built-in ChatGPT connector. It authenticates with the Codex account's
 * own token rather than a credential the user configured for it.
 */
const CODEX_ACCOUNT_MCP_SERVER = "codex_apps";

/**
 * Whether a startup failure is the Codex account's sign-in lapsing.
 *
 * A 401 from `codex_apps` warrants an account check. The account may still be
 * signed in after its token refreshes. Other servers have their own credentials.
 */
function isCodexAccountAuthFailure(notice: RuntimeNotice): boolean {
  return (
    notice.method === "mcpServer/startupStatus/updated" &&
    notice.subject === CODEX_ACCOUNT_MCP_SERVER &&
    notice.severity === "error" &&
    /\bHTTP 401\b|\b401 Unauthorized\b|"token_expired"/.test(notice.detail ?? "")
  );
}

/**
 * `account/read` failing because the server rejected the access token, read as
 * the signed-out answer it stands for.
 *
 * Codex 0.162 answers with an RPC error ("workspace routing discovery
 * unauthorized (401)") rather than `{ account: null }` once its token is
 * refused and cannot be refreshed: an access-only copy in a container past its
 * expiry, checked live on 2026-10-21. Read as an error, it left the sign-out
 * unconfirmed, so status showed "temporarily unavailable" and a login pushed
 * into `CODEX_HOME` was never reloaded.
 */
function signedOutAccountRead(error: unknown): { account: null; requiresOpenaiAuth: true } {
  if (
    error instanceof AppServerRpcError &&
    /\bunauthorized \(401\)|\bHTTP 401\b|\b401 Unauthorized\b/i.test(error.message)
  ) {
    return { account: null, requiresOpenaiAuth: true };
  }
  throw error;
}

/**
 * A fingerprint of the login stored in `CODEX_HOME`, or undefined when there is
 * none worth reloading.
 *
 * Several Codex processes share one `auth.json` and refresh tokens rotate, so
 * another process can replace the login while this app-server keeps a token the
 * server has already retired. Only a digest of usable credential fields leaves
 * this function; file rewrites and metadata changes keep the same identity.
 */
async function readStoredLoginFingerprint(codexHome: string): Promise<string | undefined> {
  try {
    const file = await open(join(codexHome, "auth.json"), "r");
    let raw: string;
    try {
      // Read a bounded snapshot, including one byte to detect overflow.
      const bytes = Buffer.alloc(65_537);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 65_536) return undefined;
      raw = bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
    const root = objectRecord(JSON.parse(raw));
    const tokens = objectRecord(root.tokens);
    const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
    const apiKey = typeof root.OPENAI_API_KEY === "string" ? root.OPENAI_API_KEY : "";
    if (!refreshToken && !apiKey) return undefined;
    // Only credential identity matters; rewriting formatting, timestamps or
    // account metadata must not start another replacement child. Never log it.
    return createHash("sha256")
      .update(JSON.stringify([refreshToken, apiKey]))
      .digest("hex");
  } catch {
    return undefined;
  }
}

function mcpRuntimeNoticeMessage(
  notice: RuntimeNotice,
  inventoryStatus: string | null | undefined,
  accountSignInRequired: boolean,
): string {
  if (!notice.subject) return `Codex reported ${notice.method.replaceAll("/", " ")}`;
  if (accountSignInRequired && isCodexAccountAuthFailure(notice))
    return CODEX_SIGN_IN_EXPIRED_NOTICE;
  if (
    inventoryStatus === "authenticationRequired" ||
    notice.detail?.split("\n").includes("reauthenticationRequired")
  ) {
    return `${notice.subject} MCP authentication required`;
  }
  return notice.severity === "error"
    ? `${notice.subject} MCP failed to start`
    : `${notice.subject} MCP reported a startup warning`;
}

/**
 * Events only a model that accepted the account's credentials can produce:
 * streamed output or a turn that completed. Tool events include local shell
 * polls, and token accounting can arrive long after a turn stopped serving.
 */
function isModelResponseEvent(event: EngineEvent): boolean {
  switch (event.kind) {
    case "item.text.delta":
    case "item.reasoning.delta":
      return true;
    case "turn.completed":
      return event.status === "completed" && !event.error;
    default:
      return false;
  }
}

const DEFAULT_INTERRUPT_TIMEOUT_MS = 15_000;
/** Distinct unrecognised notification method names retained. */
const MAX_UNKNOWN_METHODS = 16;
/** Longest retained method name. Protocol methods are far shorter than this. */
const MAX_UNKNOWN_METHOD_LENGTH = 128;
/** Bounded metadata only; overflow conservatively stops proving serving. */
const MAX_ACCOUNT_PROOF_TURNS = 1024;
const MAX_ACCOUNT_PROOF_ID_LENGTH = 256;

/** Whether a thread's turns run with hosted web search off (`disabled`, not `cached`). */
function deniesHostedSearch(config: EngineTurnConfig): boolean {
  return (
    Object.keys(codexNetworkDeniedConfig(config.policy)).length > 0 &&
    codexNetworkDeniedSearchMode(config.policy) === "disabled"
  );
}

export class AppServerEngine implements CodexEngine {
  readonly kind = "app-server" as const;
  readonly capabilities: EngineCapabilities = APP_SERVER_CAPABILITIES;

  private readonly supervisor: AppServerSupervisor;
  private readonly router: ServerRequestRouter;
  private readonly listeners = new Set<EngineEventListener>();
  /** handle → binding. For app-server the handle *is* the thread id. */
  private readonly bindings = new Map<string, ThreadBinding>();
  /** Thread id → the rollout file app-server reported for it, while bound. */
  private readonly rolloutPaths = new Map<string, string>();
  private readonly terminalWaiters = new Map<string, TerminalWaiter[]>();
  private readonly interruptTimeoutMs: number;
  private unknownNotificationCount = 0;
  /**
   * The most recent method names the reducer did not recognise.
   *
   * Names only, and bounded: a count alone tells an operator that the pinned
   * protocol moved but not *what* moved, which is the first thing they need
   * after a Codex bump. Insertion-ordered so eviction is oldest-first, and
   * re-inserted on a repeat so the retained window follows recency.
   */
  private readonly unknownNotificationMethods = new Set<string>();
  private unsupportedItemCount = 0;
  private readonly runtimeNotices: RuntimeNotice[] = [];
  /**
   * Set only once `account/read` confirms the account needs signing in again.
   * An auth failure alone is a reason to ask, not proof: a connector can start
   * with a stale token that the normal refresh would have replaced.
   */
  private accountSignInRequired = false;
  // One live login per app-server account, independent of any renderer or tab.
  private pendingSignIn: { loginId: string; display: NativeAgentPendingSignIn } | null = null;
  private pendingSignInTimer: ReturnType<typeof setTimeout> | undefined;
  private completedLoginId: string | null = null;
  /**
   * The login this bridge started and app-server has not finished, browser or
   * device code, so an abandoned sign-in can be cancelled. Never logged.
   */
  private activeLoginId: string | null = null;
  private loginSequence = 0;
  private loginStart: Promise<{ result: unknown; generation: EngineGeneration }> | undefined;
  /**
   * The generation whose model has answered since its last refused turn or
   * account change. Once a forced refresh is rejected, app-server reports no
   * account for the rest of its life even while the access token still serves
   * turns, so a signed-out `account/read` cannot outweigh a model that is
   * answering. Only a refused turn (or an account change) retires the proof.
   */
  private accountServingGeneration?: EngineGeneration;
  private notificationSequence = 0;
  private accountProofInvalidatedSequence = 0;
  /** One active turn per thread, with its transport arrival order. */
  private readonly accountProofTurns = new Map<string, { turnId: string; sequence: number }>();
  /**
   * The generation whose effective configuration was read back with hosted
   * web search off. Checked again after every restart: a toolchain update can
   * swap the binary underneath the same overrides.
   */
  private hostedNetworkLockVerifiedGeneration: EngineGeneration | null = null;
  /** The generation whose `config/read` confirmed tool declarations stay out of history. */
  private toolHistoryLockVerifiedGeneration: EngineGeneration | null = null;
  /**
   * The stored login successfully loaded by a replacement child. A confirmed sign-out
   * that persists after the reload must not trigger another one, so a login that
   * is genuinely dead costs one restart rather than a loop.
   */
  private accountReloadFingerprint?: string;
  private pendingAccountReloadFingerprint?: string;
  /** Orders overlapping account reads by request and successful response. */
  private accountCheckSequence = 0;
  private accountAppliedSequence = 0;
  /** The generation whose `codex_apps` failure already got one automatic retry. */
  private accountConnectorRetryGeneration?: EngineGeneration;
  private accountConnectorRetrySequence?: number;
  private approvalHandler?: (request: ApprovalRequest) => boolean;
  private approvalResolvedHandler?: (
    request: ApprovalRequest,
    decision: ApprovalResolvedDecision,
    resolution: ApprovalResolution,
  ) => void;
  private interactionHandler?: (request: InteractionRequest) => boolean;
  private interactionResolvedHandler?: (
    request: InteractionRequest,
    answer: InteractionAnswer,
    resolution: InteractionResolution,
  ) => void;

  constructor(private readonly options: AppServerEngineOptions) {
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;

    this.supervisor = new AppServerSupervisor({
      codexPath: options.codexPath,
      cwd: options.cwd,
      codexHome: options.codexHome,
      clientInfo: options.clientInfo,
      configOverrides: options.configOverrides,
      now: options.now,
      ...options.supervisorOverrides,
      // Listed after the overrides so they can never be replaced: losing these
      // would mean silently dropping every event and hanging every turn.
      onNotification: (notification, threadId, generation) => {
        // Enqueue only — reduction happens on the per-thread drain so this
        // returns immediately and the transport never back-pressures.
        const key = threadId ?? "connection";
        const sequence = ++this.notificationSequence;
        this.supervisor.notificationQueue.run(key, () => {
          this.processNotification(notification, generation, sequence);
        });
      },
      onServerRequest: (request, generation) => this.router.handle(request, generation),
      onStateChange: (state, detail) =>
        this.emit({
          kind: "engine.state",
          state,
          detail,
          engineGeneration: this.supervisor.getGeneration(),
        }),
      onGenerationReady: (generation, previous) =>
        this.handleGenerationChange(generation, previous),
      onGenerationExit: (generation) => {
        this.forgetSignIn();
        this.loginSequence++;
        this.hostedNetworkLockVerifiedGeneration = null;
        this.toolHistoryLockVerifiedGeneration = null;
        this.rejectAllWaiters();
        this.router.abandonGeneration(generation);
      },
    });

    this.router = new ServerRequestRouter({
      respond: (generation, id, result) =>
        this.supervisor.respondToServerRequest(generation, id, result),
      respondWithError: (generation, id, code, message) =>
        this.supervisor.respondToServerRequestWithError(generation, id, code, message),
      reportToTranscript: ({ threadId, turnId, message }) => {
        // Surfaced as a non-fatal error event so the user sees why an action was
        // refused instead of watching the turn stall silently.
        this.emit({
          kind: "error",
          threadId,
          turnId: turnId ?? undefined,
          error: { message, code: "server-request-declined" },
          willRetry: false,
          engineGeneration: this.supervisor.getGeneration(),
        });
      },
      onInvariantViolation: () => this.supervisor.recordUnknownServerRequest(),
      onUnknownRequest: () => this.supervisor.recordUnknownServerRequest(),
      ...(options.approvalTimeoutMs === undefined
        ? {}
        : { approvalTimeoutMs: options.approvalTimeoutMs }),
      /**
       * Only claims the approval when a handler is installed *and* it accepts.
       * With no handler the router falls through to its auto-decline, which is the
       * pre-approval behaviour — so attaching a UI is purely additive.
       */
      presentApproval: (request) => this.approvalHandler?.(request) === true,
      onApprovalResolved: (request, decision, resolution) =>
        this.approvalResolvedHandler?.(request, decision, resolution),
      presentInteraction: (request) => this.interactionHandler?.(request) === true,
      onInteractionResolved: (request, answer, resolution) =>
        this.interactionResolvedHandler?.(request, answer, resolution),
      // A replaced generation's requests are forgotten by app-server; holding
      // one would extend a card nobody can answer.
      isGenerationLive: (generation) => generation === this.supervisor.getGeneration(),
    });
  }

  /**
   * Installs the approval surface.
   *
   * Kept as a setter rather than a constructor option because the runtime that
   * owns thread→session mapping is built *after* the engine, and it is the only
   * layer that can turn a threadId into something the UI can address.
   */
  setApprovalHandlers(handlers: {
    present: (request: ApprovalRequest) => boolean;
    resolved: (
      request: ApprovalRequest,
      decision: ApprovalResolvedDecision,
      resolution: ApprovalResolution,
    ) => void;
  }): void {
    this.approvalHandler = handlers.present;
    this.approvalResolvedHandler = handlers.resolved;
  }

  setInteractionHandlers(handlers: {
    present: (request: InteractionRequest) => boolean;
    resolved: (
      request: InteractionRequest,
      answer: InteractionAnswer,
      resolution: InteractionResolution,
    ) => void;
  }): void {
    this.interactionHandler = handlers.present;
    this.interactionResolvedHandler = handlers.resolved;
  }

  /** Applies a user's answer. False when the approval is already gone. */
  resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    amendmentIndex?: number,
  ): boolean {
    return this.router.resolveApproval(approvalId, decision, amendmentIndex);
  }

  getParkedApprovals(): readonly ApprovalRequest[] {
    return this.router.getParkedApprovals();
  }

  /**
   * Withdraw a parked card whose request another client already answered.
   *
   * Never answers: app-server has the answer, and a second response would be
   * replying to a question it has stopped asking.
   */
  withdrawResolvedServerRequest(requestId: string | number): boolean {
    return this.router.withdrawResolved(requestId);
  }

  resolveInteraction(interactionId: string, answer: InteractionAnswer): boolean {
    return this.router.resolveInteraction(interactionId, answer);
  }

  /** Pauses or resumes a parked approval's deadline. Never answers it. */
  holdApproval(approvalId: string, held: boolean): ParkedHoldOutcome {
    return this.router.holdApproval(approvalId, held);
  }

  /** Pauses or resumes a parked interaction's deadline. Never answers it. */
  holdInteraction(interactionId: string, held: boolean): ParkedHoldOutcome {
    return this.router.holdInteraction(interactionId, held);
  }

  getParkedInteractions(): readonly InteractionRequest[] {
    return this.router.getParkedInteractions();
  }

  /** Drops approvals for a thread that is being closed. */
  abandonThreadApprovals(threadId: string): void {
    this.router.abandonThread(threadId);
  }

  async start(): Promise<EngineInfo> {
    await this.supervisor.ensureReady();
    return this.info();
  }

  async stop(): Promise<void> {
    this.forgetSignIn();
    await this.supervisor.stop();
    this.bindings.clear();
    this.rejectAllWaiters();
  }

  info(): EngineInfo {
    const health = this.supervisor.getHealth();
    return {
      kind: this.kind,
      capabilities: this.capabilities,
      generation: health.generation,
      codexVersion: health.codexVersion,
      codexHome: health.codexHome,
      pid: health.pid ?? undefined,
    };
  }

  getHealth(): AppServerHealth & {
    unknownNotifications: number;
    unknownMethods: string[];
    unsupportedItems: number;
    serverRequests: ReturnType<ServerRequestRouter["getMetrics"]>;
  } {
    return {
      ...this.supervisor.getHealth(),
      unknownNotifications: this.unknownNotificationCount,
      unknownMethods: [...this.unknownNotificationMethods],
      unsupportedItems: this.unsupportedItemCount,
      serverRequests: this.router.getMetrics(),
    };
  }

  getSupervisor(): AppServerSupervisor {
    return this.supervisor;
  }

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[codex-bridge] app-server engine listener failed:", error);
      }
    }
  }

  /** Runs on the per-thread queue, off the transport's read loop. */
  private processNotification(
    notification: Parameters<typeof reduceNotification>[0],
    generation: EngineGeneration,
    sequence: number,
  ): void {
    // Anything from a replaced process describes state that no longer exists.
    if (generation !== this.supervisor.getGeneration()) return;

    if (
      notification.method === "warning" ||
      notification.method === "guardianWarning" ||
      notification.method === "deprecationNotice" ||
      notification.method === "configWarning" ||
      notification.method === "model/rerouted" ||
      notification.method === "mcpServer/startupStatus/updated"
    ) {
      const params =
        notification.params &&
        typeof notification.params === "object" &&
        !Array.isArray(notification.params)
          ? (notification.params as Record<string, unknown>)
          : {};
      const detail = runtimeNoticeDetail(notification.method, params);
      const threadId =
        typeof params.threadId === "string" && params.threadId.length > 0
          ? params.threadId
          : undefined;
      const severity = runtimeNoticeSeverity(notification.method, params);
      const mcpName =
        notification.method === "mcpServer/startupStatus/updated"
          ? optionalPublicString(params.name)
          : undefined;

      // Lifecycle events describe inventory, not user-facing advisories. A
      // successful or cancelled attempt also retires any failure retained from
      // an earlier attempt for this server.
      if (
        notification.method === "mcpServer/startupStatus/updated" &&
        mcpName &&
        (params.status === "ready" || params.status === "cancelled")
      ) {
        this.removeMcpRuntimeNotices(mcpName, threadId);
      }

      if (notification.method !== "mcpServer/startupStatus/updated" || severity !== "info") {
        const runtimeNotice: RuntimeNotice = {
          global:
            notification.method === "configWarning" ||
            notification.method === "deprecationNotice" ||
            (notification.method === "mcpServer/startupStatus/updated" && !threadId),
          method: notification.method,
          severity,
          ...(mcpName
            ? {
                id: `mcp:${threadId ?? "global"}:${mcpName}`,
                subject: mcpName,
              }
            : {}),
          // Redacted at *capture*, not on the way out: MCP-server startup errors
          // are the likeliest place for a real token or a credentialed URL to
          // appear. Truncate afterwards so redaction sees whole tokens.
          ...(detail ? { detail } : {}),
          receivedAt: new Date().toISOString(),
          ...(threadId ? { threadId } : {}),
        };
        if (runtimeNotice.id) {
          const previousIndex = this.runtimeNotices.findIndex(
            (notice) => notice.id === runtimeNotice.id,
          );
          if (previousIndex >= 0) this.runtimeNotices.splice(previousIndex, 1);
        }
        this.runtimeNotices.push(runtimeNotice);
        if (this.runtimeNotices.length > 100) this.runtimeNotices.shift();
        if (isCodexAccountAuthFailure(runtimeNotice)) this.checkAccountSignIn(false);
      }
    }

    if (notification.method === "account/login/completed") {
      const loginId = objectRecord(notification.params).loginId;
      if (typeof loginId === "string" && loginId.length <= 512) {
        this.completedLoginId = loginId;
        if (this.pendingSignIn?.loginId === loginId) this.clearPendingSignIn();
        if (this.activeLoginId === loginId) this.activeLoginId = null;
      }
    }

    // Signing in (here or through another client of this app-server) replaces
    // the token the account connector was refused with.
    if (
      (notification.method === "account/login/completed" &&
        objectRecord(notification.params).success === true) ||
      notification.method === "account/updated"
    ) {
      // A sign-out through another client is a new account state: answers the
      // model gave the previous one prove nothing about it.
      this.invalidateAccountServing(sequence);
      this.checkAccountSignIn(true);
    }
    if (
      notification.method === "account/login/completed" &&
      objectRecord(notification.params).success === true
    ) {
      this.emit({ kind: "account.signedIn", engineGeneration: generation });
    }

    const result = reduceNotification(notification, generation);
    if (result.unknownMethod) {
      this.unknownNotificationCount += 1;
      const method = result.unknownMethod.slice(0, MAX_UNKNOWN_METHOD_LENGTH);
      this.unknownNotificationMethods.delete(method);
      this.unknownNotificationMethods.add(method);
      while (this.unknownNotificationMethods.size > MAX_UNKNOWN_METHODS) {
        const oldest = this.unknownNotificationMethods.values().next().value;
        if (oldest === undefined) break;
        this.unknownNotificationMethods.delete(oldest);
      }
      this.supervisor.recordUnknownNotification();
    }
    if (result.unsupportedItemType) this.unsupportedItemCount += 1;

    for (const event of result.events) {
      if (
        event.kind === "turn.started" &&
        event.threadId &&
        event.threadId.length <= MAX_ACCOUNT_PROOF_ID_LENGTH &&
        event.turnId.length <= MAX_ACCOUNT_PROOF_ID_LENGTH &&
        this.accountProofTurns.get(event.threadId)?.turnId !== event.turnId
      ) {
        this.accountProofTurns.delete(event.threadId);
        this.accountProofTurns.set(event.threadId, { turnId: event.turnId, sequence });
        if (this.accountProofTurns.size > MAX_ACCOUNT_PROOF_TURNS) {
          const oldest = this.accountProofTurns.keys().next().value;
          if (oldest !== undefined) this.accountProofTurns.delete(oldest);
        }
      }
      if (event.kind === "turn.completed") {
        this.resolveTerminalWaiters(event.threadId, event.turnId, event.status);
      }
      if (
        (event.kind === "turn.completed" || (event.kind === "error" && !event.willRetry)) &&
        event.error?.code === "unauthorized"
      ) {
        this.invalidateAccountServing(sequence);
        this.checkAccountSignIn(false, true);
      } else if (isModelResponseEvent(event) && "turnId" in event && event.threadId) {
        const started = this.accountProofTurns.get(event.threadId);
        if (
          started &&
          started.turnId === event.turnId &&
          started.sequence > this.accountProofInvalidatedSequence
        ) {
          this.recordAccountServing(generation);
        }
      }
      if (
        event.kind === "turn.completed" &&
        event.threadId &&
        this.accountProofTurns.get(event.threadId)?.turnId === event.turnId
      ) {
        this.accountProofTurns.delete(event.threadId);
      }
      this.emit(event);
    }
  }

  /** Whether app-server confirmed the account must be signed in again. */
  isAccountSignInRequired(): boolean {
    return this.accountSignInRequired;
  }

  private invalidateAccountServing(sequence: number): void {
    this.accountServingGeneration = undefined;
    // Connection and thread queues can drain out of order. A delayed start
    // must keep its original arrival order rather than acquire fresh proof.
    this.accountProofInvalidatedSequence = Math.max(this.accountProofInvalidatedSequence, sequence);
  }

  /**
   * The model answered, so the account is serving turns whatever `account/read`
   * last said. Retire a confirmed sign-out rather than keep asking the user to
   * sign in to an account that is visibly working.
   */
  private recordAccountServing(generation: EngineGeneration): void {
    this.accountServingGeneration = generation;
    this.accountSignInRequired = false;
  }

  /**
   * Ask app-server whether the account is still signed in.
   *
   * A signed-in answer means any `codex_apps` failure was a stale token, so the
   * connector is reloaded to pick up the fresh one. A successful reload happens
   * at most once per generation for an unprompted failure; a rejected reload
   * remains eligible on the next failure. An account change always retries.
   *
   * `refreshToken` forces an OAuth refresh first. Reserve it for a turn the
   * model already refused: once a forced refresh is rejected, app-server reports
   * no account for the rest of its life even while the access token still
   * serves turns, and every forced refresh rotates the refresh token shared
   * through `$CODEX_HOME/auth.json` with other Codex clients.
   */
  private checkAccountSignIn(accountChanged: boolean, refreshToken = false): void {
    const sequence = ++this.accountCheckSequence;
    const generation = this.supervisor.getGeneration();
    void this.supervisor
      .request("account/read", { refreshToken })
      .catch(signedOutAccountRead)
      .then((response) => this.applyAccountRead(response, sequence, generation, accountChanged))
      .catch((error: unknown) => {
        // Unconfirmed either way: leave admission alone. The notice still says
        // what Codex reported.
        console.warn(
          "[codex-bridge] Account sign-in check failed:",
          redactSecrets(error instanceof Error ? error.message : String(error)),
        );
      });
  }

  private async applyAccountRead(
    response: unknown,
    sequence: number,
    generation: EngineGeneration,
    accountChanged: boolean,
  ): Promise<void> {
    if (sequence < this.accountAppliedSequence || generation !== this.supervisor.getGeneration())
      return;
    this.accountAppliedSequence = sequence;
    const signedIn = this.recordAccount(response);
    if (!signedIn) {
      await this.requestAccountReloadFromStoredLogin(sequence, generation);
      return;
    }
    if (!this.runtimeNotices.some(isCodexAccountAuthFailure)) return;
    if (!accountChanged && this.accountConnectorRetryGeneration === generation) return;
    this.accountConnectorRetryGeneration = generation;
    this.accountConnectorRetrySequence = sequence;
    try {
      await this.reconnectMcpServers();
    } catch (error) {
      // A rejected reload did not repair the connector. Allow the next failure
      // in this generation to retry without letting an older attempt erase a
      // newer retry's marker.
      if (this.accountConnectorRetrySequence === sequence) {
        this.accountConnectorRetryGeneration = undefined;
        this.accountConnectorRetrySequence = undefined;
      }
      throw error;
    }
  }

  /**
   * The app-server says signed out while `auth.json` still holds a login: its
   * in-memory token was retired by another process and it will not re-read the
   * file on its own. Ask the runtime to replace the child between turns so it
   * loads the stored login.
   */
  private async requestAccountReloadFromStoredLogin(
    sequence: number,
    generation: EngineGeneration,
  ): Promise<void> {
    if (!this.accountSignInRequired) return;
    const fingerprint = await readStoredLoginFingerprint(this.options.codexHome);
    if (
      !fingerprint ||
      fingerprint === this.accountReloadFingerprint ||
      this.pendingAccountReloadFingerprint !== undefined ||
      sequence < this.accountAppliedSequence ||
      generation !== this.supervisor.getGeneration()
    ) {
      return;
    }
    this.pendingAccountReloadFingerprint = fingerprint;
    this.emit({ kind: "account.reload.requested", engineGeneration: generation });
  }

  /**
   * Replace the child so it reads the login stored in `CODEX_HOME`. The
   * replacement re-checks the account itself (`handleGenerationChange`), which
   * clears the sign-out when the stored login is good.
   */
  async reloadAccountFromStoredLogin(gate: {
    hasActiveTurns: () => boolean;
    waitForIdle: () => Promise<void>;
  }): Promise<void> {
    const fingerprint = this.pendingAccountReloadFingerprint;
    try {
      await this.supervisor.restartWhenIdle("stored account login changed", gate);
      if (this.supervisor.isReady()) this.accountReloadFingerprint = fingerprint;
    } finally {
      this.cancelStoredAccountReload();
    }
  }

  /** A failed or shutdown-abandoned reload remains eligible for the same login. */
  cancelStoredAccountReload(): void {
    this.pendingAccountReloadFingerprint = undefined;
  }

  /** Record an `account/read` answer; true when an account is signed in. */
  private recordAccount(response: unknown): boolean {
    const root = objectRecord(response);
    const signedIn = Boolean(root.account);
    this.accountSignInRequired =
      !signedIn &&
      root.requiresOpenaiAuth === true &&
      this.accountServingGeneration !== this.supervisor.getGeneration();
    return signedIn;
  }

  /**
   * A restart replaced the child. Every loaded thread must be re-resumed against
   * the new generation before it can accept turns; callers are told through
   * `engine.state` so they can mark sessions recovering rather than idle.
   */
  private handleGenerationChange(generation: EngineGeneration, previous: EngineGeneration): void {
    this.accountProofTurns.clear();
    // Waiters belong to the dead process; nothing will ever answer them.
    this.rejectAllWaiters();
    // Same for approvals: the old child has forgotten the request, so the card on
    // screen is stale and must be withdrawn rather than left to time out.
    this.router.abandonGeneration(previous);
    // Thread-scoped and MCP notices describe the replaced child. Global config
    // and deprecation warnings remain actionable across a restart and have no
    // authoritative snapshot from which the replacement can rehydrate them.
    for (let index = this.runtimeNotices.length - 1; index >= 0; index -= 1) {
      const notice = this.runtimeNotices[index];
      if (!notice?.global || notice.method === "mcpServer/startupStatus/updated") {
        this.runtimeNotices.splice(index, 1);
      }
    }
    for (const binding of this.bindings.values()) binding.generation = previous;
    // Credentials live on disk, not in the child, so a confirmed sign-out
    // stands, but the replacement may have loaded a login made meanwhile.
    if (this.accountSignInRequired) this.checkAccountSignIn(true);
    this.emit({ kind: "engine.generation", generation, previous, engineGeneration: generation });
  }

  private rejectAllWaiters(): void {
    for (const waiters of this.terminalWaiters.values()) {
      for (const waiter of waiters) waiter.resolve("failed");
    }
    this.terminalWaiters.clear();
  }

  private removeMcpRuntimeNotices(name: string, threadId?: string): void {
    for (let index = this.runtimeNotices.length - 1; index >= 0; index -= 1) {
      const notice = this.runtimeNotices[index];
      if (
        notice?.method === "mcpServer/startupStatus/updated" &&
        notice.subject === name &&
        notice.threadId === threadId
      ) {
        this.runtimeNotices.splice(index, 1);
      }
    }
  }

  private latestMcpRuntimeNotice(
    name: string,
    threadId?: string | null,
  ): RuntimeNotice | undefined {
    for (let index = this.runtimeNotices.length - 1; index >= 0; index -= 1) {
      const notice = this.runtimeNotices[index];
      if (
        notice?.method === "mcpServer/startupStatus/updated" &&
        notice.subject === name &&
        (threadId === undefined ||
          notice.global ||
          (typeof threadId === "string" && notice.threadId === threadId))
      ) {
        return notice;
      }
    }
    return undefined;
  }

  private resolveTerminalWaiters(
    threadId: string | null,
    turnId: string,
    status: "completed" | "interrupted" | "failed",
  ): void {
    if (!threadId) return;
    const waiters = this.terminalWaiters.get(threadId);
    if (!waiters) return;
    const remaining = waiters.filter((waiter) => {
      if (waiter.turnId !== turnId) return true;
      waiter.resolve(status);
      return false;
    });
    if (remaining.length > 0) this.terminalWaiters.set(threadId, remaining);
    else this.terminalWaiters.delete(threadId);
  }

  // ---------------------------------------------------------------- models

  /**
   * Paginates `model/list`, preserving the server's ordering.
   *
   * app-server documents that `supportedReasoningEfforts` order is meaningful and
   * clients must not derive it from the names, so it is passed straight through.
   */
  async listModels(): Promise<EngineModel[]> {
    const models: EngineModel[] = [];
    let cursor: string | undefined;
    // Bounded so a misbehaving cursor cannot loop forever.
    for (let page = 0; page < 20; page += 1) {
      const response = await this.supervisor.request<{
        data: Array<Record<string, unknown>>;
        nextCursor: string | null;
      }>("model/list", { ...(cursor ? { cursor } : {}), limit: 50, includeHidden: true });

      for (const model of response.data ?? []) {
        const id = typeof model.id === "string" ? model.id : undefined;
        if (!id) continue;
        models.push({
          id,
          displayName: typeof model.displayName === "string" ? model.displayName : id,
          description: typeof model.description === "string" ? model.description : undefined,
          hidden: model.hidden === true,
          supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts
                .filter(
                  (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
                )
                .map((entry) => ({
                  effort: String(entry.reasoningEffort ?? ""),
                  description:
                    typeof entry.description === "string" ? entry.description : undefined,
                }))
                .filter((entry) => entry.effort.length > 0)
            : [],
          defaultReasoningEffort:
            typeof model.defaultReasoningEffort === "string"
              ? model.defaultReasoningEffort
              : undefined,
          serviceTiers: Array.isArray(model.serviceTiers)
            ? model.serviceTiers
                .filter(
                  (tier): tier is Record<string, unknown> => !!tier && typeof tier === "object",
                )
                .map((tier) => String(tier.id ?? ""))
                .filter((id) => id.length > 0)
            : undefined,
          isDefault: model.isDefault === true,
        });
      }

      cursor = response.nextCursor ?? undefined;
      if (!cursor) return models;
    }
    // A partial picker cannot establish that an inherited model is unavailable.
    throw new Error("Codex model catalogue exceeded its page limit");
  }

  // --------------------------------------------------------------- threads

  /**
   * Thread configuration only app-server can supply: with project resources
   * off, the checkout's own skills, which the untrusted pin does not reach.
   * Failure to establish the inventory refuses the thread, including an older
   * app-server without skills/list.
   */
  private async projectResourceThreadConfig(
    generation: EngineGeneration,
    config: EngineTurnConfig,
  ): Promise<Record<string, unknown>> {
    if (!config.policy || config.policy.projectResources) return {};
    let listed: unknown;
    try {
      listed = await this.supervisor.requestOnGeneration(generation, "skills/list", {
        cwds: [config.cwd ?? this.options.cwd],
        forceReload: true,
      } satisfies SkillsListParams);
    } catch (error) {
      if (error instanceof AppServerRpcError && error.code === JSON_RPC_METHOD_NOT_FOUND) {
        throw new Error("Codex cannot enforce disabled project resources without skills/list");
      }
      throw error;
    }
    return codexProjectSkillsConfig(listed);
  }

  private toThreadParams(
    config: EngineTurnConfig,
    extraConfig: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const approveAgentMcpTools =
      (config.policy?.approvals === "auto-approve" &&
        (config.approvalPolicy ?? "never") === "never" &&
        config.sandbox !== "read-only") ||
      (config.policy?.id === "coordinator-read-only" && Boolean(config.permissionProfile)) ||
      Boolean(config.workflowResultTool && config.agentMcp);
    const cwd = config.cwd ?? this.options.cwd;
    const threadConfig: Record<string, unknown> = {
      // A sandbox's network switch stops commands, not hosted web search, which
      // runs on OpenAI's servers: off, or `cached` (no live page fetches) when
      // the policy allows search. Thread scope is what reaches a network-denied
      // session on a bridge that also serves other policies; a coordinator
      // process carries the same setting as process configuration, which
      // `assertHostedNetworkLock` reads back.
      ...codexNetworkDeniedConfig(config.policy),
      // Project resources off: this thread does not load the checkout's own
      // `.codex` configuration, even where the user trusts it in Codex.
      ...codexProjectTrustConfig(config.policy, cwd),
      // A watched session may ask the user a question; Default mode refuses
      // `request_user_input` without this.
      ...codexRequestUserInputConfig(config.policy),
      ...extraConfig,
      ...(config.agentMcp
        ? {
            // Replace the complete server table. The app-server process may
            // have inherited an environment-wide bearer_token_env_var for
            // this name, and configured bearer tokens take precedence over
            // Authorization headers. Dotted leaf overrides would therefore
            // keep authenticating as the broader environment capability.
            ...(config.agentMcp.design
              ? {
                  "mcp_servers.orkestrator-design": {
                    url: new URL("/design-mcp", config.agentMcp.url).toString(),
                    http_headers: { Authorization: `Bearer ${config.agentMcp.token}` },
                    required: false,
                    startup_timeout_sec: 3,
                  },
                }
              : {}),
            ...(config.agentMcp.artifacts
              ? {
                  // A workflow turn's artifact-only server. Its own bearer is
                  // the turn's artifact grant; the result credential above
                  // carries no artifact authority.
                  [`mcp_servers.${ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME}`]: {
                    url: new URL(ORKESTRATOR_ARTIFACT_MCP_PATH, config.agentMcp.url).toString(),
                    http_headers: { Authorization: `Bearer ${config.agentMcp.artifacts.token}` },
                    required: false,
                    startup_timeout_sec: 3,
                    // It serves only the artifact tools, which bypass the
                    // approval policy on every Orkestrator server.
                    default_tools_approval_mode: "approve",
                  },
                }
              : {}),
            "mcp_servers.orkestrator": {
              url: config.agentMcp.url,
              http_headers: { Authorization: `Bearer ${config.agentMcp.token}` },
              required: false,
              startup_timeout_sec: 3,
              // `approve` bypasses the thread's approval policy, so reserve it
              // for an auto-approved execution mode, the trusted
              // coordinator profile, or a backend-selected tool paired with
              // an attempt-scoped workflow result server. Ask/deny must
              // retain Codex's defaults for ordinary MCP connections — except
              // the mail tools, which a worker always needs to report back.
              ...(approveAgentMcpTools
                ? { default_tools_approval_mode: "approve" }
                : { tools: AGENT_MAIL_TOOL_APPROVALS }),
            },
          }
        : {}),
    };
    return {
      cwd,
      // Passed explicitly on every call rather than relying on inherited state.
      approvalPolicy: config.approvalPolicy ?? "never",
      approvalsReviewer: config.approvalsReviewer ?? "user",
      // Passing a legacy sandbox override makes Codex ignore an active
      // permission profile, including its restricted filesystem reads.
      ...(config.permissionProfile
        ? {}
        : {
            sandbox:
              config.sandbox ?? (config.mode === "plan" ? "read-only" : "danger-full-access"),
          }),
      // A configured model is stated on every call. An unset one is left to
      // Codex: since 0.164.0 a resume keeps the thread's saved model rather
      // than the global default, and `bindThread` adopts the model app-server
      // reports, so the transcript labels what the next turn runs.
      ...(config.model ? { model: config.model } : {}),
      // `null` clears a previously set tier; `undefined` would leave it in place.
      serviceTier: config.serviceTier ?? null,
      ...(Object.keys(threadConfig).length > 0 ? { config: threadConfig } : {}),
    };
  }

  /**
   * Refuse a coordinator thread unless app-server confirms its search mode.
   *
   * The coordinator's permission profile denies the network to commands, and
   * app-server echoes the profile back (`assertPermissionProfile`). Hosted web
   * search is outside that profile, so its mode is read back separately from
   * the effective configuration: `disabled`, or `cached` when the coordinator's
   * research setting allows search, never `live`. A Codex that renames or
   * ignores the switch then fails here, before a thread exists, rather than
   * letting the model open arbitrary URLs. Verified once per app-server
   * generation.
   */
  private async assertHostedNetworkLock(config: EngineTurnConfig): Promise<EngineGeneration> {
    const { id: generation } = await this.supervisor.ensureReady();
    if (!config.permissionProfile) return generation;
    if (this.hostedNetworkLockVerifiedGeneration === generation) return generation;
    const result = await this.supervisor.requestOnGeneration<{ config?: unknown }>(
      generation,
      "config/read",
      { cwd: config.cwd ?? this.options.cwd },
    );
    const gaps = codexHostedNetworkLockGaps(
      result?.config,
      codexNetworkDeniedSearchMode(config.policy),
    );
    if (gaps.length > 0) {
      throw new Error(
        `Codex did not confirm its hosted web search mode (${gaps.join("; ")}), so this coordinator session was refused`,
      );
    }
    if (!this.supervisor.isReady() || this.supervisor.getGeneration() !== generation) {
      throw new Error("Codex exited during hosted web search verification");
    }
    this.hostedNetworkLockVerifiedGeneration = generation;
    return generation;
  }

  /**
   * Refuse a turn that denies hosted search unless its request can declare
   * only the current turn's tools.
   *
   * A thread that was offered `web__run` keeps that declaration in its
   * history while `features.incremental_tools` is on, so dropping the tool
   * from a later turn's configuration would not take it away. The process
   * runs with the feature off (`codexAppServerConfigOverrides`); this reads
   * that back once per generation, and for a resumed or forked thread
   * `assertNoToolHistory` checks the history it inherits.
   */
  private async assertToolHistoryLock(
    generation: EngineGeneration,
    config: EngineTurnConfig,
  ): Promise<void> {
    // A coordinator's hosted network lock already read this back.
    if (!deniesHostedSearch(config) || config.permissionProfile) return;
    if (this.toolHistoryLockVerifiedGeneration === generation) return;
    const result = await this.supervisor.requestOnGeneration<{ config?: unknown }>(
      generation,
      "config/read",
      { cwd: config.cwd ?? this.options.cwd },
    );
    const gaps = codexToolHistoryGaps(result?.config);
    if (gaps.length > 0) {
      throw new Error(
        `Codex did not confirm that tool declarations stay out of thread history (${gaps.join("; ")}), so this session, which has web search off, was refused`,
      );
    }
    if (!this.supervisor.isReady() || this.supervisor.getGeneration() !== generation) {
      throw new Error("Codex exited during tool history verification");
    }
    this.toolHistoryLockVerifiedGeneration = generation;
  }

  /**
   * Refuse a search-denied turn on a thread whose history, or a fork
   * ancestor's, still declares tools: a thread written while
   * `incremental_tools` was on. A history that cannot be read is refused too.
   * `release` lets go of a thread this call just resumed; a fork's source is
   * checked before the fork and left as it was.
   */
  private async assertNoToolHistory(
    threadId: string,
    config: EngineTurnConfig,
    release: boolean,
  ): Promise<void> {
    if (!deniesHostedSearch(config)) return;
    const verdict = await (this.options.toolHistoryVerdict ?? ((id) => this.readToolHistory(id)))(
      threadId,
    ).catch((): ToolHistoryVerdict => "unknown");
    if (verdict === "clean") return;
    if (release) {
      for (const [handle, binding] of this.bindings) {
        if (binding.threadId === threadId) this.bindings.delete(handle);
      }
      await this.supervisor.request("thread/unsubscribe", { threadId }).catch(() => undefined);
    }
    throw new Error(
      verdict === "declares"
        ? "This Codex thread was offered web search in an earlier turn and still declares it in its history, so a turn with web search off was refused. Start a new session for it."
        : "Could not confirm that this Codex thread's history declares no web search, so a turn with web search off was refused.",
    );
  }

  private async readToolHistory(threadId: string): Promise<ToolHistoryVerdict> {
    const codexHome = this.options.codexHome;
    const resolve = async (id: string) =>
      this.rolloutPaths.get(id) ??
      findTranscriptPath(id, () => listTranscriptPaths(codexHome), { allowNegativeCache: false });
    const path = await resolve(threadId);
    return path ? threadToolHistoryVerdict(path, resolve) : "unknown";
  }

  async startThread(options: StartThreadOptions): Promise<EngineThread> {
    const generation = await this.assertHostedNetworkLock(options.config);
    await this.assertToolHistoryLock(generation, options.config);
    const extra = await this.projectResourceThreadConfig(generation, options.config);
    const response = await this.supervisor.requestOnGeneration<{
      thread: Record<string, unknown>;
      model?: unknown;
      activePermissionProfile?: { id?: unknown } | null;
    }>(generation, "thread/start", this.toThreadParams(options.config, extra));
    this.assertPermissionProfile(response.activePermissionProfile, options.config);
    return this.bindThread(response.thread, options.config, response.model);
  }

  async resumeThread(threadId: string, options: ResumeThreadOptions): Promise<EngineThread> {
    const generation = await this.assertHostedNetworkLock(options.config);
    await this.assertToolHistoryLock(generation, options.config);
    const extra = await this.projectResourceThreadConfig(generation, options.config);
    const response = await this.supervisor.requestOnGeneration<{
      thread: Record<string, unknown>;
      model?: unknown;
      activePermissionProfile?: { id?: unknown } | null;
    }>(generation, "thread/resume", { threadId, ...this.toThreadParams(options.config, extra) });
    this.assertPermissionProfile(response.activePermissionProfile, options.config);
    const thread = this.bindThread(response.thread, options.config, response.model);
    await this.assertNoToolHistory(thread.id ?? threadId, options.config, true);
    // app-server reconstructs turn history on resume by default.
    thread.turns = this.extractTurns(response.thread);
    return thread;
  }

  /**
   * Resumes a thread so thread-scoped configuration applies again.
   *
   * app-server rejoins a thread that is still loaded and ignores every config
   * override on `thread/resume`, `mcp_servers.*` included, so a second resume
   * keeps the previous attempt's MCP credential. Releasing the idle thread
   * first makes the resume rebuild it from its rollout with the new
   * configuration. Verified against codex 0.158.0.
   */
  async reloadThread(handle: string, options: ResumeThreadOptions): Promise<EngineThread> {
    const threadId = this.bindings.get(handle)?.threadId ?? handle;
    this.accountProofTurns.delete(threadId);
    this.bindings.delete(handle);
    // A failed unsubscribe cannot prove that the previous attempt's MCP
    // connection was unloaded. Tool names are shared across attempts, so a
    // subsequent inventory check cannot prove that its credential changed.
    await this.supervisor.request("thread/unsubscribe", { threadId });
    return this.resumeThread(threadId, options);
  }

  /** Whether the thread's live `orkestrator` MCP connection lists a workflow result tool. */
  workflowResultToolAvailability(
    threadId: string,
    toolName: string,
    options?: { timeoutMs?: number; pollMs?: number },
  ): Promise<McpToolAvailability> {
    return waitForMcpToolAvailability(
      (timeoutMs) =>
        this.supervisor.request(
          "mcpServerStatus/list",
          { threadId, serverName: "orkestrator", detail: "toolsAndAuthOnly" },
          { timeoutMs },
        ),
      "orkestrator",
      toolName,
      options,
    );
  }

  async forkThread(
    threadId: string,
    config: EngineTurnConfig,
    lastTurnId?: string,
  ): Promise<EngineThread> {
    const generation = await this.assertHostedNetworkLock(config);
    await this.assertToolHistoryLock(generation, config);
    // The whole source, not just the forked prefix: stricter, and it needs no
    // rollout the fork may not have written yet.
    await this.assertNoToolHistory(threadId, config, false);
    const extra = await this.projectResourceThreadConfig(generation, config);
    const response = await this.supervisor.requestOnGeneration<{
      thread: Record<string, unknown>;
      model?: unknown;
      activePermissionProfile?: { id?: unknown } | null;
    }>(generation, "thread/fork", {
      threadId,
      ...(lastTurnId ? { lastTurnId } : {}),
      ...this.toThreadParams(config, extra),
    });
    this.assertPermissionProfile(response.activePermissionProfile, config);
    return this.bindThread(response.thread, config, response.model);
  }

  private assertPermissionProfile(
    active: { id?: unknown } | null | undefined,
    config: EngineTurnConfig,
  ): void {
    if (!config.permissionProfile) return;
    if (active?.id !== config.permissionProfile) {
      throw new Error(
        `Codex did not activate the required permission profile ${config.permissionProfile}`,
      );
    }
  }

  async compactThread(threadId: string): Promise<void> {
    await this.supervisor.request("thread/compact/start", { threadId });
  }

  async steerTurn(
    threadId: string,
    expectedTurnId: string,
    input: EngineUserInput[],
    clientUserMessageId?: string,
  ): Promise<string> {
    const response = await this.supervisor.request<{ turnId: string }>("turn/steer", {
      threadId,
      expectedTurnId,
      input: input.map(toAppServerInput),
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    });
    return response.turnId;
  }

  /** Waits for notifications already handed off for one thread to be reduced. */
  async drainNotifications(threadId: string): Promise<void> {
    await this.supervisor.notificationQueue.drain(threadId);
  }

  async startReview(
    threadId: string,
    target:
      | { type: "uncommittedChanges" }
      | { type: "baseBranch"; branch: string }
      | { type: "commit"; sha: string; title: string | null }
      | { type: "custom"; instructions: string },
    delivery: "inline" | "detached" = "inline",
  ): Promise<{ reviewThreadId: string; turnId: string }> {
    const response = await this.supervisor.request<{
      reviewThreadId: string;
      turn: { id: string };
    }>("review/start", { threadId, target, delivery });
    return { reviewThreadId: response.reviewThreadId, turnId: response.turn.id };
  }

  /**
   * The executable skill inventory, straight from `skills/list`.
   *
   * Deliberately separate from {@link getRuntimeHealth}: that snapshot strips
   * private paths for diagnostics, while invocation needs the exact path
   * app-server reported. The result is untrusted JSON; the caller normalizes
   * and bounds it (`commands/skill-inventory.ts`). Reports the generation that
   * answered so bindings can be withdrawn when that child dies.
   *
   * `forceReload` bypasses app-server's skills cache and rescans disk. Only an
   * explicit refresh sets it; ordinary catalogue reads use the cache.
   */
  async listSkills(options: { cwd: string; forceReload?: boolean }): Promise<{
    result: unknown;
    generation: EngineGeneration;
  }> {
    const params: SkillsListParams = {
      cwds: [options.cwd],
      ...(options.forceReload ? { forceReload: true } : {}),
    };
    return this.supervisor.requestWithGeneration("skills/list", params);
  }

  /** One authenticated, allowlisted snapshot of the running child. */
  async getRuntimeHealth(threadId?: string | null): Promise<{
    engine: {
      state: string;
      generation: number;
      codexVersion?: string;
      restartCount: number;
      circuitOpen: boolean;
    };
    /**
     * Protocol-drift counters, engine-global. This is the surface operators
     * watch after a Codex bump: a rising `serverRequests.unknown-method` or
     * `unknownNotifications` means the pinned protocol has moved. Deliberately
     * not on the public `/global/health` payload — these stay behind auth.
     */
    protocol: {
      unknownNotifications: number;
      unknownMethods: string[];
      unsupportedItems: number;
      serverRequests: ReturnType<ServerRequestRouter["getMetrics"]>;
    };
    mcp: unknown;
    skills: unknown;
    hooks: unknown;
    notices: RuntimeHealthNotice[];
    rateLimits: unknown;
  }> {
    const [mcp, skills, hooks, rateLimits] = await Promise.allSettled([
      this.listMcpServerStatus(threadId),
      this.supervisor.request("skills/list", {
        cwds: [this.options.cwd],
      }),
      this.supervisor.request("hooks/list", {
        cwds: [this.options.cwd],
      }),
      this.supervisor.request("account/rateLimits/read", undefined),
    ]);
    const value = (result: PromiseSettledResult<unknown>) =>
      result.status === "fulfilled" ? result.value : { error: "Unavailable" };
    const engine = this.getHealth();
    const mcpStatuses = mcpRuntimeStatus(value(mcp));
    const rateLimitValue = value(rateLimits);
    const ordinaryUsageAllowed = objectRecord(rateLimitValue).ordinaryUsageAllowed;
    return {
      engine: {
        state: engine.state,
        generation: engine.generation,
        ...(engine.codexVersion ? { codexVersion: engine.codexVersion } : {}),
        restartCount: engine.restartCount,
        circuitOpen: engine.circuitOpen,
      },
      protocol: {
        unknownNotifications: engine.unknownNotifications,
        unknownMethods: engine.unknownMethods,
        unsupportedItems: engine.unsupportedItems,
        serverRequests: engine.serverRequests,
      },
      mcp: allowlistRuntimeInventory(value(mcp), "mcp"),
      skills: allowlistRuntimeInventory(value(skills), "skills"),
      hooks: allowlistRuntimeInventory(value(hooks), "hooks"),
      notices: [
        ...this.runtimeNotices
          .filter(
            (notice) => threadId === undefined || notice.global || notice.threadId === threadId,
          )
          .filter((notice) => {
            if (notice.method !== "mcpServer/startupStatus/updated" || !notice.subject) return true;
            if (!mcpStatuses) return true;
            if (!mcpStatuses.has(notice.subject)) return false;
            return mcpStatusKeepsFailure(mcpStatuses.get(notice.subject));
          })
          .map((notice) => ({
            method: notice.method,
            message:
              notice.method === "mcpServer/startupStatus/updated" && notice.subject
                ? mcpRuntimeNoticeMessage(
                    notice,
                    mcpStatuses?.get(notice.subject),
                    this.accountSignInRequired,
                  )
                : `Codex reported ${notice.method.replaceAll("/", " ")}`,
            severity: notice.severity,
            ...(notice.id ? { id: notice.id } : {}),
            ...(notice.subject ? { subject: notice.subject } : {}),
            ...(notice.detail ? { detail: notice.detail } : {}),
            receivedAt: notice.receivedAt,
          })),
        ...skillLoadNotices(
          skills.status === "fulfilled" ? skills.value : undefined,
          new Date().toISOString(),
        ),
        ...(ordinaryUsageAllowed === false
          ? [
              {
                method: "account/rateLimits/read",
                message:
                  "Included Codex usage is unavailable for this account; configured credits may still be used.",
                severity: "warning" as const,
                id: "account:ordinary-usage-unavailable",
                receivedAt: new Date().toISOString(),
              },
            ]
          : []),
      ],
      rateLimits: allowlistRateLimits(rateLimitValue),
    };
  }

  /**
   * Every page of `mcpServerStatus/list`, merged into one response in the
   * server's order. Bounded by `MCP_STATUS_MAX_PAGES`; past it the merged
   * response keeps the last `nextCursor`, so a reader can tell it is partial.
   */
  private async listMcpServerStatus(threadId?: string | null): Promise<unknown> {
    const data: unknown[] = [];
    let cursor: string | undefined;
    let last: Record<string, unknown> = {};
    for (let page = 0; page < MCP_STATUS_MAX_PAGES; page += 1) {
      const response = await this.supervisor.request("mcpServerStatus/list", {
        ...(cursor ? { cursor } : {}),
        limit: MCP_STATUS_PAGE_SIZE,
        detail: "full",
        ...(threadId ? { threadId } : {}),
      });
      last = objectRecord(response);
      // An unrecognised shape is passed through as the single answer.
      if (!Array.isArray(last.data)) return page === 0 ? response : { ...last, data };
      data.push(...last.data);
      cursor = typeof last.nextCursor === "string" && last.nextCursor ? last.nextCursor : undefined;
      if (!cursor) break;
    }
    // The last page's own `nextCursor` stays: set only when the bound cut it short.
    return { ...last, data };
  }

  async listMcpServers(threadId?: string | null): Promise<unknown> {
    const response = await this.listMcpServerStatus(threadId);
    const root = objectRecord(response);
    if (!Array.isArray(root.data)) return response;
    return {
      ...root,
      data: root.data.map((candidate) => {
        const entry = objectRecord(candidate);
        const name = optionalPublicString(entry.name);
        if (!name) return candidate;
        const runtimeStatus = optionalPublicString(entry.runtimeStatus);
        if (!mcpStatusKeepsFailure(runtimeStatus ?? null)) {
          return candidate;
        }
        const notice = this.latestMcpRuntimeNotice(name, threadId);
        const error = notice ? mcpFailureReason(notice) : undefined;
        return error ? { ...entry, error } : candidate;
      }),
    };
  }

  async reconnectMcpServers(): Promise<void> {
    const previous = this.mcpStartupNotices();
    await this.supervisor.request("config/mcpServer/reload", undefined);
    this.dropNotices(previous);
  }

  /**
   * Reload MCP configuration in an app-server that is already running. Never
   * cold-starts one: configuration is read from disk when a process starts,
   * so with nothing running there is nothing to reload.
   */
  async reloadMcpServersIfRunning(): Promise<{
    reloaded: boolean;
    generation?: EngineGeneration;
  }> {
    const previous = this.mcpStartupNotices();
    const outcome = await this.supervisor.requestIfReady("config/mcpServer/reload", undefined);
    if (!outcome) return { reloaded: false };
    this.dropNotices(previous);
    return { reloaded: true, generation: outcome.generation };
  }

  private mcpStartupNotices(): Set<RuntimeNotice> {
    return new Set(
      this.runtimeNotices.filter((notice) => notice.method === "mcpServer/startupStatus/updated"),
    );
  }

  /**
   * Reload is authoritative only after it succeeds. Remove the snapshot that
   * predates the request, while retaining fresh failures emitted in flight.
   */
  private dropNotices(previous: Set<RuntimeNotice>): void {
    for (let index = this.runtimeNotices.length - 1; index >= 0; index -= 1) {
      const notice = this.runtimeNotices[index];
      if (notice && previous.has(notice)) this.runtimeNotices.splice(index, 1);
    }
  }

  async beginMcpOauth(
    name: string,
    threadId?: string | null,
  ): Promise<{ authorizationUrl: string }> {
    return this.supervisor.request("mcpServer/oauth/login", {
      name,
      ...(threadId ? { threadId } : {}),
    });
  }

  private clearPendingSignIn(): void {
    clearTimeout(this.pendingSignInTimer);
    this.pendingSignInTimer = undefined;
    this.pendingSignIn = null;
  }

  /** Forget both the display and the cancellable login. */
  private forgetSignIn(): void {
    this.clearPendingSignIn();
    this.activeLoginId = null;
  }

  async readAccount(): Promise<unknown> {
    // Order by request, but only a successful response supersedes an older
    // one. A failed routine read leaves a pending failure check free to land.
    const sequence = ++this.accountCheckSequence;
    const generation = this.supervisor.getGeneration();
    // On-demand UI auth-status reads must not force a token refresh here (see
    // `checkAccountSignIn`). App-server refreshes a stale token on its own.
    const loginSequence = this.loginSequence;
    const response = await this.supervisor
      .request("account/read", { refreshToken: false })
      .catch(signedOutAccountRead);
    // Auth-status reads answer from account/read itself. A connector reload is
    // independent work and must not turn a valid account answer into an error.
    void this.applyAccountRead(response, sequence, generation, false).catch((error: unknown) => {
      console.warn(
        "[codex-bridge] Account connector recovery failed:",
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    });
    if (loginSequence === this.loginSequence && objectRecord(response).account) this.forgetSignIn();
    const pendingSignIn = normalizePendingSignIn(this.pendingSignIn?.display);
    if (!pendingSignIn) this.clearPendingSignIn();
    return { ...objectRecord(response), ...(pendingSignIn ? { pendingSignIn } : {}) };
  }

  async readAccountUsage(): Promise<EngineAccountUsageWindow[]> {
    const response = await this.supervisor.request("account/usage/read", undefined);
    return accountUsageWindows(response);
  }

  /**
   * Read the account's plan-limit windows without a thread.
   *
   * `account/rateLimits/read` is thread-free, so the settings page can ask the
   * app-server for quota whenever it opens rather than borrowing a session.
   */
  async readRateLimitWindows(): Promise<EngineRateLimitWindow[]> {
    const response = await this.supervisor.request("account/rateLimits/read", undefined);
    return rateLimitWindowsFromRead(response);
  }

  /**
   * Start a ChatGPT login. The browser flow redirects to a callback app-server
   * serves on this machine's loopback, so a browser elsewhere (a remote
   * backend, a container) cannot finish it; device code has no callback.
   */
  async beginAccountLogin(method: "browser" | "device-code" = "browser"): Promise<unknown> {
    const sequence = ++this.loginSequence;
    this.forgetSignIn();
    const start = this.supervisor.requestWithGeneration(
      "account/login/start",
      method === "device-code"
        ? {
            type: "chatgptDeviceCode",
          }
        : {
            type: "chatgpt",
            codexStreamlinedLogin: true,
            useHostedLoginSuccessPage: true,
          },
    );
    this.loginStart = start;
    let response: unknown;
    try {
      response = (await start).result;
    } finally {
      if (this.loginStart === start) this.loginStart = undefined;
    }
    const raw = objectRecord(response);
    if (
      sequence === this.loginSequence &&
      typeof raw.loginId === "string" &&
      raw.loginId.length > 0 &&
      raw.loginId.length <= 512 &&
      raw.loginId !== this.completedLoginId
    ) {
      this.activeLoginId = raw.loginId;
    }
    const display = normalizePendingSignIn({
      url: raw.verificationUrl,
      code: raw.userCode,
      expiresAt: Date.now() + NATIVE_AGENT_PENDING_SIGN_IN_TTL_MS,
    });
    if (
      sequence === this.loginSequence &&
      typeof raw.loginId === "string" &&
      raw.loginId.length > 0 &&
      raw.loginId.length <= 512 &&
      raw.loginId !== this.completedLoginId &&
      display
    ) {
      this.pendingSignIn = { loginId: raw.loginId, display };
      this.pendingSignInTimer = setTimeout(
        // The device code has lapsed, so nobody can finish this login: release
        // app-server's side of it too rather than leaving it to time out there.
        () => void this.cancelAccountLogin().catch(() => undefined),
        Math.max(0, display.expiresAt - Date.now()),
      );
      this.pendingSignInTimer.unref?.();
    }
    return response;
  }

  /**
   * Abandon the sign-in this bridge started, if one is still open. App-server
   * stops waiting on its loopback callback or device code (`account/login/cancel`).
   * `none` when nothing was open or app-server had already finished it.
   */
  async cancelAccountLogin(): Promise<"canceled" | "none"> {
    let loginId = this.activeLoginId;
    const start = this.loginStart;
    let generation = this.supervisor.getGeneration();
    // Fence the display immediately, but keep the ID and expiry until the RPC
    // succeeds so a failed cancellation can be retried.
    const sequence = ++this.loginSequence;
    if (!loginId && start) {
      const started = await start;
      generation = started.generation;
      if (generation !== this.supervisor.getGeneration()) return "none";
      const raw = objectRecord(started.result);
      if (
        typeof raw.loginId === "string" &&
        raw.loginId.length > 0 &&
        raw.loginId.length <= 512 &&
        raw.loginId !== this.completedLoginId
      ) {
        loginId = raw.loginId;
        if (sequence === this.loginSequence) {
          this.activeLoginId = loginId;
          this.pendingSignInTimer = setTimeout(
            () => void this.cancelAccountLogin().catch(() => undefined),
            NATIVE_AGENT_PENDING_SIGN_IN_TTL_MS,
          );
          this.pendingSignInTimer.unref?.();
        }
      }
    }
    if (!loginId) return "none";
    const response = await this.supervisor.requestOnGeneration(generation, "account/login/cancel", {
      loginId,
    });
    if (
      sequence === this.loginSequence &&
      this.activeLoginId === loginId &&
      generation === this.supervisor.getGeneration()
    )
      this.forgetSignIn();
    return objectRecord(response).status === "canceled" ? "canceled" : "none";
  }

  async logoutAccount(): Promise<void> {
    this.forgetSignIn();
    this.loginSequence++;
    await this.supervisor.request("account/logout", undefined);
  }

  async revertThread(threadId: string, beforeTurnId: string): Promise<void> {
    await this.supervisor.request("thread/revert", { threadId, beforeTurnId });
  }

  async readThread(
    threadId: string,
    options: ReadThreadOptions = {},
  ): Promise<EngineThread | null> {
    try {
      const response = await this.supervisor.request<{ thread: Record<string, unknown> }>(
        "thread/read",
        { threadId, ...(options.includeTurns ? { includeTurns: true } : {}) },
      );
      const thread = this.toEngineThread(response.thread);
      if (options.includeTurns) thread.turns = this.extractTurns(response.thread);
      return thread;
    } catch (error) {
      /**
       * A thread whose first turn never materialized rejects `includeTurns`
       * instead of returning an empty list. The not-yet-indexed response is the
       * recovery signal; because Codex 0.153.3 shares its wording with unsupported
       * paginated history, confirm the metadata is still the untouched start
       * snapshot before reporting "no turns".
       */
      let metadata: Record<string, unknown> | undefined;
      if (isPaginatedHistoryUnsupportedError(error)) {
        try {
          const response = await this.supervisor.request<{ thread: Record<string, unknown> }>(
            "thread/read",
            { threadId },
          );
          metadata = response.thread;
        } catch {
          // The original full-history error remains authoritative.
        }
      }
      if (isUnmaterializedThreadError(error, metadata)) {
        return metadata
          ? { ...this.toEngineThread(metadata), turns: [] }
          : { id: threadId, handle: threadId, turns: [] };
      }
      throw error;
    }
  }

  /**
   * Lists root threads for this workspace.
   *
   * Explicit `sourceKinds`, exact-cwd filtering and dropping anything with a
   * `parentThreadId` are all required: without them the resume dialog either
   * empties or fills with sub-agent threads.
   */
  async listThreads(options: ListThreadsOptions = {}): Promise<ListThreadsResult> {
    const cwd = options.cwd ?? this.options.cwd;
    const response = await this.supervisor.request<{
      data: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>("thread/list", {
      sourceKinds: [...ROOT_THREAD_SOURCE_KINDS],
      cwd,
      limit: options.limit ?? 100,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.includeArchived === undefined ? {} : { archived: options.includeArchived }),
    });

    const threads = (response.data ?? [])
      .map((thread) => this.toEngineThread(thread))
      // Sub-agent threads are children of a conversation, not conversations.
      .filter((thread) => !thread.parentThreadId)
      // `cwd` is a server-side filter, but re-check exactly: a prefix match would
      // pull in sibling worktrees, which are separate environments.
      .filter((thread) => !thread.cwd || thread.cwd === cwd);

    return { threads, nextCursor: response.nextCursor, supported: true };
  }

  private bindThread(
    raw: Record<string, unknown>,
    config: EngineTurnConfig,
    confirmedModel?: unknown,
  ): EngineThread {
    const thread = this.toEngineThread(raw);
    if (typeof confirmedModel === "string" && confirmedModel.trim().length > 0) {
      thread.model = confirmedModel.trim();
    }
    if (thread.id) {
      // app-server names the rollout before the thread is materialized, so
      // the file may not exist yet.
      if (typeof raw.path === "string" && isAbsolute(raw.path)) {
        this.rolloutPaths.set(thread.id, raw.path);
      }
      // The thread id doubles as the engine handle: app-server addresses
      // everything by thread id, so a second indirection would add nothing.
      this.bindings.set(thread.id, {
        handle: thread.id,
        threadId: thread.id,
        config,
        generation: this.supervisor.getGeneration(),
      });
      thread.handle = thread.id;
    }
    return thread;
  }

  private toEngineThread(raw: unknown): EngineThread {
    const thread = (raw ?? {}) as Record<string, unknown>;
    const id = typeof thread.id === "string" ? thread.id : null;
    return {
      id,
      handle: id ?? "",
      cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
      name: typeof thread.name === "string" ? thread.name : null,
      preview: typeof thread.preview === "string" ? thread.preview : undefined,
      source: describeSource(thread.source),
      originator: optionalPublicString(thread.originator),
      parentThreadId: typeof thread.parentThreadId === "string" ? thread.parentThreadId : null,
      updatedAt: secondsToIso(thread.updatedAt),
      createdAt: secondsToIso(thread.createdAt),
    };
  }

  private extractTurns(raw: Record<string, unknown>): EngineThreadTurn[] {
    const turns = Array.isArray(raw.turns) ? raw.turns : [];
    return turns
      .filter((turn): turn is Record<string, unknown> => !!turn && typeof turn === "object")
      .map((turn) => {
        const items = Array.isArray(turn.items) ? turn.items : [];
        const clientIds = items
          .filter(
            (item): item is Record<string, unknown> =>
              !!item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).type === "userMessage",
          )
          .map((item) => item.clientId)
          .filter((clientId): clientId is string => typeof clientId === "string");
        const reconciliationItems = items.map((item) => {
          if (!item || typeof item !== "object") return {};
          const record = item as Record<string, unknown>;
          return {
            ...(typeof record.type === "string" ? { type: record.type } : {}),
            ...(typeof record.id === "string" ? { id: record.id } : {}),
            ...(typeof record.clientId === "string" || record.clientId === null
              ? { clientId: record.clientId }
              : {}),
          };
        });
        const itemsView =
          turn.itemsView === "notLoaded" ||
          turn.itemsView === "summary" ||
          turn.itemsView === "full"
            ? turn.itemsView
            : undefined;
        return {
          id: String(turn.id ?? ""),
          status: (turn.status as EngineThreadTurn["status"]) ?? "completed",
          items: [],
          clientId: clientIds[0] ?? null,
          clientIds,
          reconciliationItems,
          ...(itemsView ? { itemsView } : {}),
          startedAt: secondsToIso(turn.startedAt),
          completedAt: secondsToIso(turn.completedAt),
        } satisfies EngineThreadTurn;
      });
  }

  /**
   * Replays a resumed thread's history as engine events, so a rehydrated
   * transcript is built by exactly the same code path as a streamed one.
   */
  replayHistory(threadId: string, raw: unknown): void {
    const { events, unsupportedItemTypes } = reduceHistoricalTurns(
      raw,
      this.supervisor.getGeneration(),
      threadId,
      threadId,
    );
    this.unsupportedItemCount += unsupportedItemTypes.length;
    for (const event of events) this.emit(event);
  }

  async setThreadName(threadId: string, name: string): Promise<boolean> {
    try {
      await this.supervisor.request("thread/name/set", { threadId, name });
      return true;
    } catch (error) {
      // A failed rename must not fail the turn; the bridge's own title index is
      // still authoritative for the UI.
      console.warn(
        "[codex-bridge] thread/name/set failed:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /**
   * The rollout file app-server reported for a bound thread. The bridge reads
   * it for calls app-server reports no item for (`RefusedCellTail`).
   */
  rolloutPath(threadId: string): string | undefined {
    return this.rolloutPaths.get(threadId);
  }

  /**
   * Releases a thread. Deliberately `thread/unsubscribe`, never `thread/delete`:
   * closing a tab must not destroy the user's conversation or its descendants.
   */
  async unsubscribeThread(handle: string, requireConfirmation = false): Promise<void> {
    const binding = this.bindings.get(handle);
    const threadId = binding?.threadId ?? handle;
    if (!binding && !requireConfirmation) {
      this.accountProofTurns.delete(threadId);
      this.rolloutPaths.delete(threadId);
      return;
    }
    try {
      await this.supervisor.request("thread/unsubscribe", { threadId });
    } catch (error) {
      // Policy changes must prove that a loaded thread released its old config.
      // Keep the binding on failure so a retry can still unsubscribe it.
      if (requireConfirmation) throw error;
      console.warn(
        "[codex-bridge] thread/unsubscribe failed:",
        error instanceof Error ? error.message : error,
      );
    }
    this.accountProofTurns.delete(threadId);
    this.rolloutPaths.delete(threadId);
    this.bindings.delete(handle);
  }

  /**
   * Records new config for the thread. app-server applies policy per turn, so
   * this only updates what the next `turn/start` will send — no protocol call and
   * no new thread object, unlike the SDK engine.
   */
  async configureThread(handle: string, config: EngineTurnConfig): Promise<void> {
    const binding = this.bindings.get(handle);
    if (binding) binding.config = config;
  }

  // ----------------------------------------------------------------- turns

  async startTurn(options: StartTurnOptions): Promise<EngineTurn> {
    const binding = this.bindings.get(options.handle);
    if (!binding) throw new Error(`Unknown app-server thread handle: ${options.handle}`);

    const params = {
      threadId: binding.threadId,
      // The at-most-once key: echoed back on the persisted userMessage as
      // `clientId`, which is what makes ambiguous dispatch recoverable.
      ...(options.requestId ? { clientUserMessageId: options.requestId } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      input: options.input.map(toAppServerInput),
      cwd: options.config.cwd ?? this.options.cwd,
      approvalPolicy: options.config.approvalPolicy ?? "never",
      // A turn's reviewer persists into later turns, so every turn states it.
      approvalsReviewer: options.config.approvalsReviewer ?? "user",
      ...(options.config.model ? { model: options.config.model } : {}),
      ...(options.config.serviceTier !== undefined
        ? { serviceTier: options.config.serviceTier }
        : {}),
      ...(options.config.reasoningEffort ? { effort: options.config.reasoningEffort } : {}),
      // turn/start takes a resolved policy object, not the mode string.
      ...(options.config.permissionProfile
        ? {}
        : { sandboxPolicy: toSandboxPolicy(options.config) }),
    };
    const { result, generation } = await this.supervisor.requestWithGeneration<{
      turn: { id: string };
    }>("turn/start", params);

    binding.generation = generation;
    return { threadId: binding.threadId, turnId: result.turn.id, engineGeneration: generation };
  }

  /**
   * Asks app-server to interrupt. This only *requests* it — the caller must await
   * `waitForTurnTerminal` before treating the thread as idle, or a new prompt
   * could overlap a turn that is still running.
   */
  async interruptTurn(handle: string, turnId: string): Promise<void> {
    const binding = this.bindings.get(handle);
    if (!binding) return;
    await this.supervisor.request("turn/interrupt", { threadId: binding.threadId, turnId });
  }

  /**
   * Resolves when the turn reaches a terminal status.
   *
   * Escalation on timeout: re-ask once (the first interrupt may have raced a
   * busy turn), then check persisted state, and only restart the child as a last
   * resort. Never silently return "idle" — that is what would let a new turn
   * overlap one that is still executing.
   */
  async waitForTurnTerminal(
    handle: string,
    turnId: string,
    options: { timeoutMs?: number; allowRestart?: boolean } = {},
  ): Promise<"completed" | "interrupted" | "failed" | "unknown"> {
    const binding = this.bindings.get(handle);
    if (!binding) return "unknown";
    const timeoutMs = options.timeoutMs ?? this.interruptTimeoutMs;

    const first = await this.raceTerminal(binding.threadId, turnId, timeoutMs);
    if (first) return first;

    // Still running. Ask again before escalating.
    try {
      await this.supervisor.request("turn/interrupt", { threadId: binding.threadId, turnId });
    } catch {
      // The process may already be gone; the read below settles it either way.
    }
    const second = await this.raceTerminal(binding.threadId, turnId, timeoutMs);
    if (second) return second;

    // Consult persisted state rather than guessing.
    const persisted = await this.reconcileTurnById(binding.threadId, turnId);
    if (persisted.result === "terminal") return persisted.status;

    if (options.allowRestart) {
      // Last resort: replacing the child guarantees the turn is not still
      // running, at the cost of every other thread in the environment.
      await this.supervisor.restartNow(`turn ${turnId} would not interrupt`);
      return "interrupted";
    }
    return "unknown";
  }

  private raceTerminal(
    threadId: string,
    turnId: string,
    timeoutMs: number,
  ): Promise<"completed" | "interrupted" | "failed" | null> {
    return new Promise((resolve) => {
      const waiters = this.terminalWaiters.get(threadId) ?? [];
      const waiter: TerminalWaiter = {
        turnId,
        resolve: (status) => {
          clearTimeout(timer);
          resolve(status);
        },
      };
      waiters.push(waiter);
      this.terminalWaiters.set(threadId, waiters);

      const timer = setTimeout(() => {
        const current = this.terminalWaiters.get(threadId) ?? [];
        this.terminalWaiters.set(
          threadId,
          current.filter((entry) => entry !== waiter),
        );
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  /** Reads persisted turn status when live events cannot answer. */
  async reconcileTurnById(
    threadId: string,
    turnId: string,
  ): Promise<
    | { result: "terminal"; status: "completed" | "interrupted" | "failed" }
    | { result: "running" }
    | { result: "absent" }
    | { result: "unknown" }
  > {
    try {
      const thread = await this.readThread(threadId, { includeTurns: true });
      const turn = thread?.turns?.find((entry) => entry.id === turnId);
      if (!turn) return { result: "absent" };
      if (turn.status === "inProgress") return { result: "running" };
      return { result: "terminal", status: turn.status };
    } catch {
      return { result: "unknown" };
    }
  }

  /**
   * Answers "did this request already execute?" after an ambiguous failure.
   *
   * This is the only safe basis for deciding whether to dispatch again — matching
   * on prompt text would be wrong, because the same text under a different
   * request id is a legitimately different turn.
   */
  async reconcileRequest(threadId: string, requestId: string): Promise<ReconciliationOutcome> {
    const thread = await this.readThread(threadId, { includeTurns: true });
    const turns = (thread?.turns ?? []).map((turn) => ({
      id: turn.id,
      status: turn.status,
      items:
        turn.reconciliationItems ??
        (turn.clientIds ?? (turn.clientId ? [turn.clientId] : [])).map((clientId) => ({
          type: "userMessage" as const,
          clientId,
        })),
    }));
    return reconcileFromThreadTurns(turns, requestId);
  }

  /** Classifies a dispatch failure so callers know if a retry is even legal. */
  classifyFailure(error: unknown): {
    class: "rejected" | "ambiguous";
    retryImmediately: boolean;
    engineError: EngineError;
  } {
    return {
      class: classifyDispatchFailure(error),
      retryImmediately: isSafeToRetryImmediately(error),
      engineError: toEngineError(error),
    };
  }

  /** Re-reads the environment and restarts the child if managed vars changed. */
  async ensureEnvironmentIsCurrent(options: {
    hasActiveTurns: () => boolean;
    waitForIdle: () => Promise<void>;
  }): Promise<{ restarted: boolean }> {
    const { restarted } = await this.supervisor.ensureEnvironmentIsCurrent(options);
    return { restarted };
  }

  isOverloaded(error: unknown): boolean {
    return error instanceof AppServerRpcError && error.isOverload();
  }
}

/**
 * Engine input → the pinned v2 `UserInput` wire shape.
 *
 * Exhaustive on purpose: the old fallthrough treated every non-text item as an
 * image, so a new union member would have been sent as a `localImage` with
 * whatever `path` it happened to carry.
 */
export function toAppServerInput(input: EngineUserInput): UserInput {
  switch (input.type) {
    case "text":
      // `text_elements` is required by the protocol even when empty.
      return { type: "text", text: input.text, text_elements: [] };
    case "local_image":
      return { type: "localImage", path: input.path };
    case "skill":
      return { type: "skill", name: input.name, path: input.path };
    default: {
      const unreachable: never = input;
      throw new Error(`Unsupported engine input: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** turn/start takes a resolved `SandboxPolicy` object, not the mode shorthand. */
function toSandboxPolicy(config: EngineTurnConfig): Record<string, unknown> {
  const sandbox = config.sandbox ?? (config.mode === "plan" ? "read-only" : "danger-full-access");
  const networkAccess = config.networkAccessEnabled ?? true;
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly", networkAccess };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case "danger-full-access":
    default:
      return { type: "dangerFullAccess" };
  }
}

/** `SessionSource` is a string or a single-key object (`{ subagent: ... }`). */
function describeSource(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return Object.keys(value)[0];
  return undefined;
}

/** app-server timestamps are unix *seconds*; the bridge speaks ISO strings. */
function secondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toISOString();
}
