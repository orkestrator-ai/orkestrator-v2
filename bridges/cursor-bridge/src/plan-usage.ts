/**
 * Cursor plan-quota reads for the shared account panel.
 *
 * `agent.getUsage()` answers what this durable agent spent. The plan-quota
 * percentages come from a separate account read, mapped by the shared protocol
 * module so the backend's settings read and this one cannot disagree.
 */
import type { NativeAgentAccountUsageWindow } from "@orkestrator/protocol/native-agent";
import {
  accountWindowsFromPlanUsage,
  CURSOR_PLAN_WINDOW,
  DEFAULT_PLAN_LABELS,
  isPlanQuotaWindow,
} from "@orkestrator/protocol/cursor-plan-usage";
import { CATALOG_TIMEOUT_MS } from "./config.js";
import { resolveCredential } from "./credentials.js";
import { isObject } from "./state.js";

export { accountWindowsFromPlanUsage, CURSOR_PLAN_WINDOW, DEFAULT_PLAN_LABELS, isPlanQuotaWindow };

const CURSOR_API_BASE = "https://api2.cursor.sh";
const ACCOUNT_USAGE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const FALLBACK_TOKEN_LIFETIME_MS = 55 * 60_000;

function finiteNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

/**
 * Keep session-scoped agent totals and fold in the latest plan-quota rows.
 *
 * `refreshAgentUsage` used to replace the whole `account` list with the agent
 * total, which dropped any quota windows the panel needs for progress bars.
 */
export function mergeAccountWindows(
  session: NativeAgentAccountUsageWindow[] | undefined,
  plan: NativeAgentAccountUsageWindow[] | undefined,
): NativeAgentAccountUsageWindow[] | undefined {
  const sessionWindows = (session ?? []).filter((entry) => !isPlanQuotaWindow(entry.window));
  const persistedPlan = (session ?? []).filter((entry) => isPlanQuotaWindow(entry.window));
  const planWindows = plan && plan.length > 0 ? plan : persistedPlan;
  const merged = [...planWindows, ...sessionWindows].slice(-16);
  return merged.length > 0 ? merged : undefined;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let cachedPlan: { windows: NativeAgentAccountUsageWindow[]; expiresAt: number } | undefined;
let inFlight: Promise<NativeAgentAccountUsageWindow[] | undefined> | undefined;
let accessToken: { value: string; expiresAt: number } | undefined;
let testFetchImpl: FetchLike | undefined;

export function peekPlanAccountWindows(): NativeAgentAccountUsageWindow[] | undefined {
  if (cachedPlan && cachedPlan.expiresAt > Date.now()) return cachedPlan.windows;
  return cachedPlan?.windows;
}

export function resetPlanAccountWindowsForTests(): void {
  cachedPlan = undefined;
  inFlight = undefined;
  accessToken = undefined;
  testFetchImpl = async () => new Response(null, { status: 599 });
}

export function seedPlanAccountWindowsForTests(
  windows: NativeAgentAccountUsageWindow[],
  expiresAt = Date.now() + ACCOUNT_USAGE_TTL_MS,
): void {
  cachedPlan = { windows, expiresAt };
}

/**
 * Refresh the account-wide plan-quota cache. Never rejects: a failed or
 * missing read leaves the last windows in place so a billing outage cannot
 * blank bars the user could already see.
 */
export async function refreshPlanAccountWindows(options?: {
  apiKey?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}): Promise<NativeAgentAccountUsageWindow[] | undefined> {
  const now = options?.now ?? Date.now;
  if (cachedPlan && cachedPlan.expiresAt > now()) return cachedPlan.windows;
  if (inFlight) return inFlight;
  inFlight = loadPlanAccountWindows(options)
    .catch(() => cachedPlan?.windows)
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

async function loadPlanAccountWindows(options?: {
  apiKey?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}): Promise<NativeAgentAccountUsageWindow[] | undefined> {
  const apiKey = options?.apiKey ?? (await resolveCredential()).apiKey;
  if (!apiKey) return cachedPlan?.windows;
  const fetchImpl = options?.fetchImpl ?? testFetchImpl ?? fetch;
  const now = options?.now ?? Date.now;
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const token = await exchangeAccessToken(apiKey, fetchImpl, now, timeoutMs);
  if (!token) return cachedPlan?.windows;
  const period = await dashboardRequest(token, "GetCurrentPeriodUsage", fetchImpl, timeoutMs);
  const windows = accountWindowsFromPlanUsage(period);
  if (windows.length > 0) {
    cachedPlan = { windows, expiresAt: now() + ACCOUNT_USAGE_TTL_MS };
    return windows;
  }
  return cachedPlan?.windows;
}

function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const expirySeconds = finiteNumber(parsed?.exp);
    return expirySeconds === undefined ? undefined : expirySeconds * 1_000;
  } catch {
    return undefined;
  }
}

function exchangeExpiryMs(payload: Record<string, unknown>, token: string, now: number): number {
  const expiresIn = finiteNumber(payload.expiresIn) ?? finiteNumber(payload.expires_in);
  const candidates = [
    jwtExpiryMs(token),
    finiteNumber(payload.expiresAt),
    finiteNumber(payload.expires_at),
    expiresIn === undefined ? undefined : now + expiresIn * 1_000,
  ].filter((candidate): candidate is number => candidate !== undefined && candidate > now);
  return candidates.length > 0 ? Math.min(...candidates) : now + FALLBACK_TOKEN_LIFETIME_MS;
}

async function exchangeAccessToken(
  apiKey: string,
  fetchImpl: FetchLike,
  now: () => number,
  timeoutMs: number,
): Promise<string | undefined> {
  const current = now();
  if (accessToken && accessToken.expiresAt > current + TOKEN_EXPIRY_SKEW_MS) {
    return accessToken.value;
  }
  const response = await requestJson(
    `${CURSOR_API_BASE}/auth/exchange_user_api_key`,
    { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    fetchImpl,
    timeoutMs,
  );
  const payload = record(response);
  const value = [payload?.accessToken, payload?.access_token, payload?.token].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  if (!payload || !value) return undefined;
  accessToken = { value, expiresAt: exchangeExpiryMs(payload, value, current) };
  return value;
}

async function dashboardRequest(
  accessTokenValue: string,
  method: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<unknown> {
  return requestJson(
    `${CURSOR_API_BASE}/aiserver.v1.DashboardService/${method}`,
    {
      Authorization: `Bearer ${accessTokenValue}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    fetchImpl,
    timeoutMs,
  );
}

async function requestJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function schedulePlanAccountRefresh(timeoutMs: number = CATALOG_TIMEOUT_MS): void {
  void refreshPlanAccountWindows({ timeoutMs }).catch(() => undefined);
}
