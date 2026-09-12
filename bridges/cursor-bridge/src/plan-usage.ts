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
  CURSOR_API_BASE,
  CURSOR_EXCHANGE_PATH,
  CURSOR_PLAN_WINDOW,
  CURSOR_TOKEN_EXPIRY_SKEW_MS,
  cursorDashboardPath,
  cursorExchangeAccessToken,
  cursorExchangeExpiryMs,
  DEFAULT_PLAN_LABELS,
  isPlanQuotaWindow,
} from "@orkestrator/protocol/cursor-plan-usage";
import { CATALOG_TIMEOUT_MS } from "./config.js";
import { resolveCredential } from "./credentials.js";

export { accountWindowsFromPlanUsage, CURSOR_PLAN_WINDOW, DEFAULT_PLAN_LABELS, isPlanQuotaWindow };

const ACCOUNT_USAGE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

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

function exchangeAccessToken(
  apiKey: string,
  fetchImpl: FetchLike,
  now: () => number,
  timeoutMs: number,
): Promise<string | undefined> {
  const current = now();
  if (accessToken && accessToken.expiresAt > current + CURSOR_TOKEN_EXPIRY_SKEW_MS) {
    return Promise.resolve(accessToken.value);
  }
  return (async () => {
    const response = await requestJson(
      `${CURSOR_API_BASE}${CURSOR_EXCHANGE_PATH}`,
      { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      fetchImpl,
      timeoutMs,
    );
    const value = cursorExchangeAccessToken(response);
    if (!value) return undefined;
    accessToken = { value, expiresAt: cursorExchangeExpiryMs(response, value, current) };
    return value;
  })();
}

async function dashboardRequest(
  accessTokenValue: string,
  method: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<unknown> {
  return requestJson(
    `${CURSOR_API_BASE}${cursorDashboardPath(method)}`,
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
