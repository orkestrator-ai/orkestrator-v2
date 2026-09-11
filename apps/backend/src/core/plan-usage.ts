/**
 * Plan-quota reads for the settings page, without starting an agent.
 *
 * Every provider here answers over HTTPS from a credential this machine
 * already holds: Claude's OAuth usage endpoint, Codex's account usage endpoint
 * and Cursor's dashboard. None of them spawns a bridge, a CLI or a session, so
 * the settings pane can read plan usage when it opens rather than behind a
 * refresh control.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { accountWindowsFromPlanUsage } from "@orkestrator/protocol/cursor-plan-usage";
import type { NativeAgentAccountUsageWindow } from "@orkestrator/protocol/native-agent";
import {
  isPlanUsagePlatform,
  PLAN_USAGE_PLATFORMS,
  type PlanUsagePlatform,
  type PlanUsageSnapshot,
} from "@orkestrator/protocol/plan-usage";
import type { CommandContext } from "./commands-context.js";
import { getClaudeOAuthAccessToken, resolveContainerClaudeCredentials } from "./commands-files.js";
import {
  CACHE_TTL_MS,
  createPlanUsageCache,
  ERROR_CACHE_TTL_MS,
  okSnapshot,
  sharedPlanUsageCache,
  type PlanUsageCache,
} from "./plan-usage-cache.js";
import { asRecord } from "./agent-provider-runtime.js";
import { resolveCursorApiKey, resolveOpenCodeZenApiKey } from "./commands-validation.js";
import { cursorSdkCredentialPath } from "./cursor-sdk-bridge.js";

/**
 * Platforms whose plan quota Orkestrator can read outside an agent session.
 *
 * Re-exported from the shared protocol module so the backend reader and the
 * settings section cannot drift into disagreeing about who has a plan read.
 */
export { isPlanUsagePlatform, PLAN_USAGE_PLATFORMS };
export type { PlanUsagePlatform };

export const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
export const CURSOR_API_BASE = "https://api2.cursor.sh";

/** Beta header Claude Code itself sends on the OAuth usage read. */
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

const REQUEST_TIMEOUT_MS = 15_000;

const CURSOR_TOKEN_EXPIRY_SKEW_MS = 30_000;
const CURSOR_FALLBACK_TOKEN_LIFETIME_MS = 55 * 60_000;

/**
 * ECMAScript `Date` only represents ±8.64e15 ms around the epoch. A provider
 * reset timestamp outside that range would produce an Invalid Date whose
 * `toISOString()` throws, aborting the whole normalization over one bad field.
 */
const MAX_DATE_MS = 8.64e15;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function finitePercent(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isoReset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Both epoch-second and epoch-millisecond readings are plausible; anything
    // below the year-2001 millisecond mark is treated as seconds.
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
    if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > MAX_DATE_MS) return undefined;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > MAX_DATE_MS) return undefined;
  return new Date(timestamp).toISOString();
}

/** A reset expressed as "in N seconds" rather than as a timestamp. */
function isoResetFromDelta(value: unknown, now: number): string | undefined {
  const seconds = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (seconds === undefined || seconds < 0) return undefined;
  const milliseconds = now + seconds * 1_000;
  if (Math.abs(milliseconds) > MAX_DATE_MS) return undefined;
  return new Date(milliseconds).toISOString();
}

/** "5-hour limit", "Weekly limit", and so on, from a window length. */
function windowLengthLabel(windowMinutes: number | undefined, fallback: string): string {
  if (windowMinutes === undefined) return fallback;
  if (windowMinutes === 7 * 24 * 60) return "Weekly limit";
  if (windowMinutes === 24 * 60) return "Daily limit";
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour limit`;
  return fallback;
}

/**
 * Map OpenCode Zen's `usage` payload onto the generic account windows.
 *
 * The plan reports a percentage spent per window, under `rolling`, `weekly`
 * and `monthly`. A window whose `status` is not `ok` is omitted rather than
 * drawn from a percent that may not apply.
 */
export function openCodePlanWindows(value: unknown): NativeAgentAccountUsageWindow[] {
  const usage = asRecord(asRecord(value)?.usage);
  if (!usage) return [];
  const windows: NativeAgentAccountUsageWindow[] = [];
  for (const [id, label] of [
    ["rolling", "Rolling"],
    ["weekly", "Weekly"],
    ["monthly", "Monthly"],
  ] as const) {
    const raw = asRecord(usage[id]);
    if (!raw) continue;
    if (typeof raw.status === "string" && raw.status !== "ok") continue;
    const usedPercent = finitePercent(raw.percent);
    const resetsAt = isoReset(raw.resetsAt);
    if (usedPercent === undefined && resetsAt === undefined) continue;
    windows.push({
      window: id,
      label,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  return windows;
}

const CLAUDE_WINDOW_LABELS: Record<string, { label: string; windowMinutes: number }> = {
  five_hour: { label: "5-hour limit", windowMinutes: 300 },
  seven_day: { label: "Weekly limit", windowMinutes: 7 * 24 * 60 },
  seven_day_opus: { label: "Weekly Opus limit", windowMinutes: 7 * 24 * 60 },
  seven_day_oauth_apps: { label: "Weekly apps limit", windowMinutes: 7 * 24 * 60 },
};

function snakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function humanizeWindowId(id: string): string {
  const spaced = id.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Map Claude's OAuth usage payload onto the generic account windows.
 *
 * The endpoint is first-party but undocumented, so this reads by shape rather
 * than by a fixed key list: any entry carrying a utilization percentage is a
 * window, whatever Anthropic names it next. Known ids keep their friendly
 * label and period length.
 */
export function claudePlanWindows(value: unknown): NativeAgentAccountUsageWindow[] {
  const body = asRecord(value);
  if (!body) return [];
  const source = asRecord(body.usage) ?? body;
  const windows: NativeAgentAccountUsageWindow[] = [];
  for (const [key, entry] of Object.entries(source)) {
    const raw = asRecord(entry);
    if (!raw) continue;
    const usedPercent = finitePercent(raw.utilization ?? raw.used_percent ?? raw.usedPercent);
    if (usedPercent === undefined) continue;
    const id = snakeCase(key);
    const known = CLAUDE_WINDOW_LABELS[id];
    const resetsAt = isoReset(raw.resets_at ?? raw.resetsAt);
    const windowMinutes =
      positiveNumber(raw.window_minutes ?? raw.windowMinutes) ?? known?.windowMinutes;
    windows.push({
      window: id,
      label: known?.label ?? humanizeWindowId(id),
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    });
  }
  return windows;
}

/**
 * Map Codex's account usage payload onto the generic account windows.
 *
 * The same primary/secondary rate-limit snapshot the app-server hands a
 * session, read here straight from the account endpoint. Field names are
 * accepted in both snake_case and camelCase because the HTTP payload and the
 * app-server protocol disagree about serialization.
 */
export function codexPlanWindows(
  value: unknown,
  now: number,
): { windows: NativeAgentAccountUsageWindow[]; plan?: string } {
  const body = asRecord(value);
  if (!body) return { windows: [] };
  const limits = asRecord(body.rate_limits ?? body.rateLimits) ?? body;
  const limitName = nonEmptyString(limits.limit_name ?? limits.limitName);
  const windows: NativeAgentAccountUsageWindow[] = [];
  for (const [slot, fallbackLabel] of [
    ["primary", "Usage limit"],
    ["secondary", "Secondary limit"],
  ] as const) {
    const raw = asRecord(limits[slot]);
    if (!raw) continue;
    const usedPercent = finitePercent(raw.used_percent ?? raw.usedPercent);
    const windowMinutes = positiveNumber(
      raw.window_minutes ?? raw.windowMinutes ?? raw.window_duration_mins ?? raw.windowDurationMins,
    );
    const resetsAt =
      isoReset(raw.resets_at ?? raw.resetsAt) ??
      isoResetFromDelta(raw.resets_in_seconds ?? raw.resetsInSeconds, now);
    if (usedPercent === undefined && resetsAt === undefined) continue;
    const label =
      slot === "primary" && limitName !== undefined
        ? limitName
        : windowLengthLabel(windowMinutes, fallbackLabel);
    windows.push({
      window: slot,
      label,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    });
  }
  const balance = nonEmptyString(asRecord(limits.credits ?? body.credits)?.balance);
  if (balance !== undefined) {
    windows.push({ window: "credits", label: "Credits", creditBalance: balance.slice(0, 64) });
  }
  const plan = nonEmptyString(
    body.plan_type ?? body.planType ?? limits.plan_type ?? limits.planType,
  );
  return { windows, ...(plan !== undefined ? { plan } : {}) };
}

export function normalizeAccountWindows(value: unknown): NativeAgentAccountUsageWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: NativeAgentAccountUsageWindow[] = [];
  for (const candidate of value) {
    const entry = asRecord(candidate);
    if (!entry) continue;
    const window = typeof entry.window === "string" ? entry.window : undefined;
    if (!window) continue;
    const usedPercent = finitePercent(entry.usedPercent);
    const resetsAt = isoReset(entry.resetsAt);
    windows.push({
      window,
      ...(typeof entry.label === "string" ? { label: entry.label } : {}),
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(typeof entry.windowMinutes === "number" ? { windowMinutes: entry.windowMinutes } : {}),
    });
  }
  return windows;
}

function unavailableSnapshot(
  platform: AgentPlatform,
  message: string,
  fetchedAt: string,
): PlanUsageSnapshot {
  return { platform, status: "unavailable", windows: [], message, fetchedAt };
}

type HttpResult = { status: number; body: unknown };

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<HttpResult> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return { status: response.status, body: undefined };
  return { status: response.status, body: await response.json() };
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Whether this runtime may read the host's credential for a platform.
 *
 * An agent-test profile only reads what the harness explicitly granted, the
 * same gate the bridge launch paths apply before handing a token to a child.
 */
function hostCredentialAllowed(context: CommandContext, platform: PlanUsagePlatform): boolean {
  return (
    context.runtimeFlavor !== "agent-test" || context.credentialSources?.has(platform) === true
  );
}

function jwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const segment = token?.split(".")[1];
  if (!segment) return undefined;
  try {
    return asRecord(JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))) ?? undefined;
  } catch {
    return undefined;
  }
}

function jwtExpiryMs(token: string | undefined): number | undefined {
  const expirySeconds = jwtPayload(token)?.exp;
  return typeof expirySeconds === "number" && Number.isFinite(expirySeconds)
    ? expirySeconds * 1_000
    : undefined;
}

/** Codex tags requests with the ChatGPT account the plan belongs to. */
function chatGptAccountId(tokens: Record<string, unknown> | null | undefined): string | undefined {
  const direct = nonEmptyString(tokens?.account_id ?? tokens?.accountId);
  if (direct) return direct;
  const claims = asRecord(
    jwtPayload(nonEmptyString(tokens?.id_token ?? tokens?.idToken))?.[
      "https://api.openai.com/auth"
    ],
  );
  return nonEmptyString(claims?.chatgpt_account_id);
}

function codexAuthPath(): string {
  const home = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim() || os.homedir();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
  return path.join(codexHome, "auth.json");
}

async function readFileIfPresent(file: string): Promise<string | undefined> {
  return await fs.readFile(file, "utf-8").catch(() => undefined);
}

/**
 * The Cursor key the bridge would itself run under.
 *
 * Configured key first, then the login Orkestrator stored, then the SDK's own
 * default file — the same order `resolveCredential` applies inside the bridge,
 * so the settings card cannot report a plan the agent would not use.
 */
async function defaultCursorApiKey(
  context: CommandContext,
  now: number,
): Promise<string | undefined> {
  if (!hostCredentialAllowed(context, "cursor")) return undefined;
  const configured = resolveCursorApiKey((await context.storage.loadConfig()).global).apiKey;
  if (configured) return configured;
  for (const file of [
    cursorSdkCredentialPath(context),
    path.join(os.homedir(), ".cursor", "sdk", "auth.json"),
  ]) {
    const stored = asRecord(parseJson(await readFileIfPresent(file)));
    const apiKey = nonEmptyString(stored?.apiKey);
    const expiresAt = stored?.apiKeyExpiresAtMs;
    if (!apiKey) continue;
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= now) continue;
    return apiKey;
  }
  return undefined;
}

/** Claude's stored OAuth token, from the Keychain or the credentials file. */
async function defaultClaudeOAuthToken(
  context: CommandContext,
  now: number,
): Promise<string | undefined> {
  if (!hostCredentialAllowed(context, "claude")) return undefined;
  const { global } = await context.storage.loadConfig();
  return getClaudeOAuthAccessToken(await resolveContainerClaudeCredentials(global), now);
}

async function defaultCodexAuthFile(context: CommandContext): Promise<string | undefined> {
  if (!hostCredentialAllowed(context, "codex")) return undefined;
  return await readFileIfPresent(codexAuthPath());
}

export type PlanUsageReaderDependencies = {
  fetchImpl?: FetchLike;
  now?: () => number;
  /** The snapshot cache to serve from; a fresh one per reader by default. */
  cache?: PlanUsageCache;
  /**
   * Credential reads, overridable so a test never touches the host keychain,
   * `~/.codex` or a stored Cursor login.
   */
  credentials?: {
    /** Claude's OAuth access token. */
    claude?: (context: CommandContext, now: number) => Promise<string | undefined>;
    /** Raw contents of Codex's `auth.json`. */
    codex?: (context: CommandContext) => Promise<string | undefined>;
    /** The Cursor API key to exchange for a dashboard token. */
    cursor?: (context: CommandContext, now: number) => Promise<string | undefined>;
  };
};

export type PlanUsageReadOptions = {
  /** Skip the read cache so an explicit refresh actually re-reads. */
  force?: boolean;
};

export type PlanUsageReader = ((
  context: CommandContext,
  platform: AgentPlatform,
  options?: PlanUsageReadOptions,
) => Promise<PlanUsageSnapshot>) & {
  /**
   * Fold account windows a running session just reported into the cache.
   *
   * A session read is as authoritative as the settings read and costs nothing,
   * so it both updates the card and defers the next HTTP read by a full TTL.
   */
  recordSessionWindows: (platform: AgentPlatform, windows: NativeAgentAccountUsageWindow[]) => void;
};

type CursorTokenCache = { entry?: { apiKey: string; token: string; expiresAt: number } };

type ReaderRuntime = {
  fetchImpl: FetchLike;
  now: () => number;
  claudeToken: (context: CommandContext, now: number) => Promise<string | undefined>;
  codexAuth: (context: CommandContext) => Promise<string | undefined>;
  cursorApiKey: (context: CommandContext, now: number) => Promise<string | undefined>;
  cursorTokens: CursorTokenCache;
};

async function readOpenCodePlanUsage(
  context: CommandContext,
  runtime: ReaderRuntime,
): Promise<PlanUsageSnapshot> {
  const nowIso = new Date(runtime.now()).toISOString();
  const config = await context.storage.loadConfig();
  const { apiKey } = hostCredentialAllowed(context, "opencode")
    ? resolveOpenCodeZenApiKey(config.global)
    : { apiKey: undefined as string | undefined };
  if (!apiKey) {
    return unavailableSnapshot(
      "opencode",
      "Add an OpenCode Zen API key below to see your plan usage.",
      nowIso,
    );
  }
  const { status, body } = await requestJson(runtime.fetchImpl, OPENCODE_USAGE_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (status === 401 || status === 403) {
    return unavailableSnapshot(
      "opencode",
      "OpenCode Zen rejected the stored API key. Replace it below to see plan usage.",
      nowIso,
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Usage request failed with HTTP ${status}`);
  }
  // An authoritative read with no windows means the plan is unmetered, which is
  // a fact worth stating rather than a failure.
  return okSnapshot("opencode", openCodePlanWindows(body), new Date(runtime.now()).toISOString());
}

/**
 * Claude's plan windows, from the OAuth usage endpoint Claude Code itself uses.
 *
 * Needs the OAuth login rather than an API key: an API-key account has no
 * subscription windows to report, and says so instead of drawing empty bars.
 */
async function readClaudePlanUsage(
  context: CommandContext,
  runtime: ReaderRuntime,
): Promise<PlanUsageSnapshot> {
  const nowIso = new Date(runtime.now()).toISOString();
  const { global } = await context.storage.loadConfig();
  if (global.useHostClaudeCredentials === false) {
    return unavailableSnapshot(
      "claude",
      "Host Claude credentials are turned off, so plan usage cannot be read.",
      nowIso,
    );
  }
  const token = await runtime.claudeToken(context, runtime.now());
  if (!token) {
    return unavailableSnapshot(
      "claude",
      "Sign in to Claude with a paid plan to see plan usage.",
      nowIso,
    );
  }
  const { status, body } = await requestJson(runtime.fetchImpl, CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": CLAUDE_OAUTH_BETA,
      Accept: "application/json",
    },
  });
  if (status === 401 || status === 403) {
    return unavailableSnapshot(
      "claude",
      "Claude rejected the stored sign-in. Sign in again to see plan usage.",
      nowIso,
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Usage request failed with HTTP ${status}`);
  }
  const windows = claudePlanWindows(body);
  const readIso = new Date(runtime.now()).toISOString();
  // A payload this read cannot recognise is not evidence of an unmetered plan.
  return windows.length > 0
    ? okSnapshot("claude", windows, readIso)
    : unavailableSnapshot("claude", "Claude did not report plan usage for this account.", readIso);
}

/**
 * Codex's plan windows, from the account usage endpoint behind its stored login.
 *
 * Codex refreshes `auth.json` itself; this only reads it. An expired token is
 * reported as a sign-in to refresh rather than as a failed request, because
 * running any Codex session renews it.
 */
async function readCodexPlanUsage(
  context: CommandContext,
  runtime: ReaderRuntime,
): Promise<PlanUsageSnapshot> {
  const nowIso = new Date(runtime.now()).toISOString();
  const tokens = asRecord(asRecord(parseJson(await runtime.codexAuth(context)))?.tokens);
  const accessToken = nonEmptyString(tokens?.access_token ?? tokens?.accessToken);
  if (!accessToken) {
    return unavailableSnapshot("codex", "Sign in to Codex to see plan usage.", nowIso);
  }
  const expiresAt = jwtExpiryMs(accessToken);
  if (expiresAt !== undefined && expiresAt <= runtime.now()) {
    return unavailableSnapshot(
      "codex",
      "Codex's stored sign-in has expired. Start a Codex session or sign in again to refresh it.",
      nowIso,
    );
  }
  const accountId = chatGptAccountId(tokens);
  const { status, body } = await requestJson(runtime.fetchImpl, CODEX_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    },
  });
  if (status === 401 || status === 403) {
    return unavailableSnapshot(
      "codex",
      "Codex rejected the stored sign-in. Sign in again to see plan usage.",
      nowIso,
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Usage request failed with HTTP ${status}`);
  }
  const readIso = new Date(runtime.now()).toISOString();
  const { windows, plan } = codexPlanWindows(body, runtime.now());
  return windows.length > 0
    ? okSnapshot("codex", windows, readIso, plan)
    : unavailableSnapshot("codex", "Codex did not report plan limits for this account.", readIso);
}

/**
 * Exchange the stored Cursor key for a short-lived dashboard token.
 *
 * Cached per key for its own lifetime: the exchange is a second round trip,
 * and the plan read is the only thing that needs it.
 */
async function cursorDashboardToken(
  apiKey: string,
  runtime: ReaderRuntime,
): Promise<string | undefined> {
  const now = runtime.now();
  const cached = runtime.cursorTokens.entry;
  if (cached && cached.apiKey === apiKey && cached.expiresAt > now + CURSOR_TOKEN_EXPIRY_SKEW_MS) {
    return cached.token;
  }
  const { status, body } = await requestJson(
    runtime.fetchImpl,
    `${CURSOR_API_BASE}/auth/exchange_user_api_key`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  if (status < 200 || status >= 300) return undefined;
  const payload = asRecord(body);
  const token = [payload?.accessToken, payload?.access_token, payload?.token].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  if (!token) return undefined;
  const expiresIn = payload?.expiresIn ?? payload?.expires_in;
  const candidates = [
    jwtExpiryMs(token),
    typeof payload?.expiresAt === "number" ? payload.expiresAt : undefined,
    typeof expiresIn === "number" && Number.isFinite(expiresIn)
      ? now + expiresIn * 1_000
      : undefined,
  ].filter((candidate): candidate is number => candidate !== undefined && candidate > now);
  runtime.cursorTokens.entry = {
    apiKey,
    token,
    expiresAt:
      candidates.length > 0 ? Math.min(...candidates) : now + CURSOR_FALLBACK_TOKEN_LIFETIME_MS,
  };
  return token;
}

async function readCursorPlanUsage(
  context: CommandContext,
  runtime: ReaderRuntime,
): Promise<PlanUsageSnapshot> {
  const nowIso = new Date(runtime.now()).toISOString();
  const apiKey = await runtime.cursorApiKey(context, runtime.now());
  if (!apiKey) {
    return unavailableSnapshot(
      "cursor",
      "Sign in to Cursor and reconnect to see plan usage.",
      nowIso,
    );
  }
  const token = await cursorDashboardToken(apiKey, runtime);
  if (!token) {
    return unavailableSnapshot(
      "cursor",
      "Cursor would not exchange the stored credential. Sign in again to see plan usage.",
      nowIso,
    );
  }
  const { status, body } = await requestJson(
    runtime.fetchImpl,
    `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
    },
  );
  if (status === 401 || status === 403) {
    // The exchanged token, not the key, is what the dashboard rejected: drop it
    // so the next read mints a fresh one instead of repeating the rejection.
    runtime.cursorTokens.entry = undefined;
    return unavailableSnapshot(
      "cursor",
      "Cursor rejected the stored credential. Sign in again to see plan usage.",
      nowIso,
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Usage request failed with HTTP ${status}`);
  }
  const readIso = new Date(runtime.now()).toISOString();
  const windows = accountWindowsFromPlanUsage(body);
  return windows.length > 0
    ? okSnapshot("cursor", windows, readIso)
    : unavailableSnapshot("cursor", "Cursor did not report plan quota for this account.", readIso);
}

/**
 * Read one platform's plan quota without an agent session.
 *
 * Reads are cached for two minutes and shared by every caller, so opening the
 * settings pane costs at most one request per platform per window. A running
 * session that reports the same account windows folds into that cache through
 * `recordSessionWindows` and defers the next read by a full window, which is
 * why an idle pane with a busy session never has to ask the provider at all.
 * `force` bypasses the cache for a user-triggered refresh while still
 * coalescing an in-flight read.
 */
export function createPlanUsageReader(
  overrides: PlanUsageReaderDependencies = {},
): PlanUsageReader {
  const now = overrides.now ?? Date.now;
  // A reader built for a test gets its own cache; the shared one is what the
  // session path writes through, so the default reader takes that.
  const cache = overrides.cache ?? createPlanUsageCache(now);
  const flights = new Map<PlanUsagePlatform, Promise<PlanUsageSnapshot>>();
  const runtime: ReaderRuntime = {
    fetchImpl: overrides.fetchImpl ?? fetch,
    now,
    claudeToken: overrides.credentials?.claude ?? defaultClaudeOAuthToken,
    codexAuth: overrides.credentials?.codex ?? defaultCodexAuthFile,
    cursorApiKey: overrides.credentials?.cursor ?? defaultCursorApiKey,
    cursorTokens: {},
  };

  const reader = ((context, platform, options) => {
    if (!isPlanUsagePlatform(platform)) {
      return Promise.resolve(
        unavailableSnapshot(
          platform,
          "Plan usage is not available for this platform.",
          new Date(now()).toISOString(),
        ),
      );
    }
    if (options?.force !== true) {
      const cached = cache.peek(platform);
      if (cached) return Promise.resolve(cached);
    }
    const inFlight = flights.get(platform);
    if (inFlight) return inFlight;
    const read = (async (): Promise<PlanUsageSnapshot> => {
      try {
        const snapshot =
          platform === "opencode"
            ? await readOpenCodePlanUsage(context, runtime)
            : platform === "claude"
              ? await readClaudePlanUsage(context, runtime)
              : platform === "codex"
                ? await readCodexPlanUsage(context, runtime)
                : await readCursorPlanUsage(context, runtime);
        cache.store(platform, snapshot, CACHE_TTL_MS);
        return snapshot;
      } catch (error) {
        const snapshot: PlanUsageSnapshot = {
          platform,
          status: "error",
          windows: [],
          message: error instanceof Error ? error.message : "Plan usage is unavailable",
          fetchedAt: new Date(now()).toISOString(),
        };
        cache.store(platform, snapshot, ERROR_CACHE_TTL_MS);
        return snapshot;
      }
    })().finally(() => {
      if (flights.get(platform) === read) flights.delete(platform);
    });
    flights.set(platform, read);
    return read;
  }) as PlanUsageReader;

  reader.recordSessionWindows = cache.recordSessionWindows;

  return reader;
}

export const readPlanUsage = createPlanUsageReader({ cache: sharedPlanUsageCache });
