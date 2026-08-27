import { createHash } from "node:crypto";
import type {
  CursorNormalizedUsage,
  CursorUsageErrorCode,
  CursorUsageResult,
} from "@orkestrator/protocol/cursor-usage";

const CURSOR_API_BASE = "https://api2.cursor.sh";
const ACCOUNT_USAGE_TTL_MS = 60_000;
/**
 * Failures are cached too, so a persistent error state does not re-run the
 * whole token exchange on every panel open. A retryable failure is held only
 * long enough to absorb a burst of opens; a non-retryable one (a rejected key,
 * an account with no plan quota) is held far longer, because retrying it
 * sooner cannot produce a different answer. Both are discarded when the
 * credential changes, which mints a new provider.
 */
const RETRYABLE_FAILURE_TTL_MS = 10_000;
const PERMANENT_FAILURE_TTL_MS = 10 * 60_000;
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const FALLBACK_TOKEN_LIFETIME_MS = 55 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * Plausibility window for a billing-cycle timestamp. Cursor reports these as
 * epoch milliseconds; `0`, a second-scale value and a microsecond-scale value
 * all parse as a valid `Date`, so without a range check a defaulted or
 * unit-changed field renders to the user as a 1970 (or year-58539) reset date.
 * Outside the window the boundary is omitted, which is what the rest of the
 * normalizer does with a field it cannot read.
 */
const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2020, 0, 1);
const MAX_PLAUSIBLE_EPOCH_MS = Date.UTC(2100, 0, 1);

export interface UsageProvider {
  getAccountUsage(): Promise<CursorUsageResult>;
}

export interface CursorUsageBucketLabels {
  auto: string;
  api: string;
}

const DEFAULT_BUCKET_LABELS: CursorUsageBucketLabels = {
  auto: "Cursor Models",
  api: "Other Models",
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ProviderOptions = {
  fetchImpl?: FetchLike;
  now?: () => number;
  labels?: Partial<CursorUsageBucketLabels>;
  accountUsageTtlMs?: number;
  requestTimeoutMs?: number;
};

type JsonResponse =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status?: number; code: CursorUsageErrorCode; message: string; retryable: boolean };

function errorResult(
  code: CursorUsageErrorCode,
  message: string,
  retryable: boolean,
): CursorUsageResult {
  return { ok: false, code, message, retryable };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Any finite number, either sign. Use for fields that may legitimately go negative. */
export function signedNumberish(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function numberish(value: unknown): number | undefined {
  const parsed = signedNumberish(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

/**
 * A percentage as Cursor reported it. Deliberately *not* capped at 100: an
 * account that has consumed more than its included allowance is exactly the
 * case the quota readout exists for, and discarding the value there dropped
 * the bar entirely — or, for a response carrying only percentages, dropped
 * every field and reported a well-formed payload as `INVALID_RESPONSE`.
 * Clamping belongs at the progress bar, not in the data.
 */
export function percent(value: unknown): number | undefined {
  return numberish(value);
}

export function unixMsToIso(value: unknown): string | undefined {
  const milliseconds = numberish(value);
  if (milliseconds === undefined) return undefined;
  if (milliseconds < MIN_PLAUSIBLE_EPOCH_MS || milliseconds > MAX_PLAUSIBLE_EPOCH_MS) {
    return undefined;
  }
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Thrown past `MAX_RESPONSE_BYTES` so an oversized body is not reported as malformed JSON. */
export class CursorResponseTooLargeError extends Error {
  constructor() {
    super("Cursor usage response exceeded the size limit");
    this.name = "CursorResponseTooLargeError";
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CursorResponseTooLargeError();
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text.trim() ? JSON.parse(text) : undefined;
  } finally {
    reader.releaseLock();
  }
}

function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const expirySeconds = numberish(parsed?.exp);
    return expirySeconds === undefined ? undefined : expirySeconds * 1_000;
  } catch {
    return undefined;
  }
}

function exchangeExpiryMs(payload: Record<string, unknown>, token: string, now: number): number {
  const candidates = [
    jwtExpiryMs(token),
    numberish(payload.expiresAt),
    numberish(payload.expires_at),
    numberish(payload.expiresIn) === undefined
      ? undefined
      : now + numberish(payload.expiresIn)! * 1_000,
    numberish(payload.expires_in) === undefined
      ? undefined
      : now + numberish(payload.expires_in)! * 1_000,
  ].filter((candidate): candidate is number => candidate !== undefined && candidate > now);
  return candidates.length > 0 ? Math.min(...candidates) : now + FALLBACK_TOKEN_LIFETIME_MS;
}

function responseError(status: number): JsonResponse {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status,
      code: "TOKEN_EXPIRED",
      message: "Cursor rejected the account usage access token.",
      retryable: true,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      status,
      code: "RATE_LIMITED",
      message: "Cursor temporarily rate-limited the account usage request.",
      retryable: true,
    };
  }
  if (status === 404 || status === 405) {
    return {
      ok: false,
      status,
      code: "INTERNAL_API_CHANGED",
      message: "Cursor's account usage endpoint is no longer available in its expected form.",
      retryable: false,
    };
  }
  return {
    ok: false,
    status,
    code: "NETWORK_ERROR",
    message: `Cursor account usage request failed with status ${status}.`,
    retryable: status >= 500,
  };
}

export function normalizeCursorAccountUsage(
  currentPeriodValue: unknown,
  planInfoValue: unknown,
  retrievedAt: string,
  labels: CursorUsageBucketLabels = DEFAULT_BUCKET_LABELS,
): CursorUsageResult {
  const currentPeriod = record(currentPeriodValue);
  if (!currentPeriod) {
    return errorResult(
      "INVALID_RESPONSE",
      "Cursor returned an invalid account usage response.",
      true,
    );
  }
  const planUsage = record(currentPeriod.planUsage);
  if (!planUsage) {
    return errorResult(
      "MISSING_PLAN_USAGE",
      "Cursor did not expose plan quota for this account. Team seats may require an Admin API key.",
      false,
    );
  }

  const usedCents = numberish(planUsage.includedSpend) ?? numberish(planUsage.totalSpend);
  // An overdrawn allowance reports a negative remainder. Keep it: omitting the
  // field would read as "no data", and clamping it to zero would read as
  // "exactly used up".
  const remainingCents = signedNumberish(planUsage.remaining);
  const limitCents = numberish(planUsage.limit);
  const totalPercentUsed = percent(planUsage.totalPercentUsed);
  // Keep the included percentage on the same denominator as its neighboring
  // money fields. Cursor's reported total percentage measures a separate quota
  // and is retained below so the renderer can label both values explicitly.
  const includedUsedPercent =
    usedCents !== undefined && limitCents !== undefined && limitCents > 0
      ? (usedCents / limitCents) * 100
      : undefined;
  const startsAt = unixMsToIso(currentPeriod.billingCycleStart);
  const endsAt = unixMsToIso(currentPeriod.billingCycleEnd);
  const autoPercentUsed = percent(planUsage.autoPercentUsed);
  const apiPercentUsed = percent(planUsage.apiPercentUsed);
  const buckets: CursorNormalizedUsage["buckets"] = [];
  if (autoPercentUsed !== undefined) {
    buckets.push({
      id: "cursor-internal-auto",
      label: labels.auto,
      window: "billing_cycle",
      usedPercent: autoPercentUsed,
      remainingPercent: Math.max(0, 100 - autoPercentUsed),
      ...(endsAt ? { resetsAt: endsAt } : {}),
      sourceField: "planUsage.autoPercentUsed",
    });
  }
  if (apiPercentUsed !== undefined) {
    buckets.push({
      id: "cursor-internal-api",
      label: labels.api,
      window: "billing_cycle",
      usedPercent: apiPercentUsed,
      remainingPercent: Math.max(0, 100 - apiPercentUsed),
      ...(endsAt ? { resetsAt: endsAt } : {}),
      sourceField: "planUsage.apiPercentUsed",
    });
  }

  if (
    usedCents === undefined &&
    remainingCents === undefined &&
    limitCents === undefined &&
    includedUsedPercent === undefined &&
    totalPercentUsed === undefined &&
    buckets.length === 0
  ) {
    return errorResult(
      "INVALID_RESPONSE",
      "Cursor returned plan usage without any recognizable quota fields.",
      true,
    );
  }

  const planInfo = record(record(planInfoValue)?.planInfo);
  const spendLimitUsage = record(currentPeriod.spendLimitUsage);
  const onDemand = spendLimitUsage
    ? {
        ...(numberish(spendLimitUsage.totalSpend) !== undefined
          ? { usedCents: numberish(spendLimitUsage.totalSpend) }
          : {}),
        ...(numberish(spendLimitUsage.individualLimit) !== undefined
          ? { individualLimitCents: numberish(spendLimitUsage.individualLimit) }
          : {}),
        ...(signedNumberish(spendLimitUsage.individualRemaining) !== undefined
          ? { individualRemainingCents: signedNumberish(spendLimitUsage.individualRemaining) }
          : {}),
        ...(numberish(spendLimitUsage.pooledLimit) !== undefined
          ? { pooledLimitCents: numberish(spendLimitUsage.pooledLimit) }
          : {}),
        ...(numberish(spendLimitUsage.pooledUsed) !== undefined
          ? { pooledUsedCents: numberish(spendLimitUsage.pooledUsed) }
          : {}),
        ...(signedNumberish(spendLimitUsage.pooledRemaining) !== undefined
          ? { pooledRemainingCents: signedNumberish(spendLimitUsage.pooledRemaining) }
          : {}),
        ...(typeof spendLimitUsage.limitType === "string"
          ? { limitType: spendLimitUsage.limitType }
          : {}),
      }
    : undefined;
  const hasOnDemand = onDemand && Object.keys(onDemand).length > 0;

  return {
    ok: true,
    data: {
      provider: "cursor",
      ...(typeof planInfo?.planName === "string" ? { plan: planInfo.planName } : {}),
      cycle: {
        ...(startsAt ? { startsAt } : {}),
        ...(endsAt ? { endsAt } : {}),
      },
      included: {
        ...(usedCents !== undefined ? { usedCents } : {}),
        ...(remainingCents !== undefined ? { remainingCents } : {}),
        ...(limitCents !== undefined ? { limitCents } : {}),
        ...(includedUsedPercent !== undefined ? { usedPercent: includedUsedPercent } : {}),
      },
      buckets,
      ...(hasOnDemand ? { onDemand } : {}),
      ...(autoPercentUsed !== undefined ||
      apiPercentUsed !== undefined ||
      totalPercentUsed !== undefined
        ? {
            internalPercentages: {
              ...(autoPercentUsed !== undefined ? { autoPercentUsed } : {}),
              ...(apiPercentUsed !== undefined ? { apiPercentUsed } : {}),
              ...(totalPercentUsed !== undefined ? { totalPercentUsed } : {}),
            },
          }
        : {}),
      source: { kind: "internal-dashboard-api", retrievedAt },
    },
  };
}

export class CursorInternalApiProvider implements UsageProvider {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly labels: CursorUsageBucketLabels;
  private readonly accountUsageTtlMs: number;
  private readonly requestTimeoutMs: number;
  private accessToken?: { value: string; expiresAt: number };
  private cachedUsage?: { result: CursorUsageResult; expiresAt: number };
  private inFlight?: Promise<CursorUsageResult>;

  constructor(
    private readonly apiKey: string,
    options: ProviderOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.labels = { ...DEFAULT_BUCKET_LABELS, ...options.labels };
    this.accountUsageTtlMs = options.accountUsageTtlMs ?? ACCOUNT_USAGE_TTL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async getAccountUsage(): Promise<CursorUsageResult> {
    const now = this.now();
    if (this.cachedUsage && this.cachedUsage.expiresAt > now) return this.cachedUsage.result;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.loadAccountUsage().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async loadAccountUsage(): Promise<CursorUsageResult> {
    const result = await this.readAccountUsage();
    this.cacheResult(result);
    return result;
  }

  private async readAccountUsage(): Promise<CursorUsageResult> {
    const token = await this.getAccessToken();
    if (!token.ok) return token.result;

    let currentPeriod = await this.dashboardRequest("GetCurrentPeriodUsage", token.value);
    if (!currentPeriod.ok && currentPeriod.status && [401, 403].includes(currentPeriod.status)) {
      this.accessToken = undefined;
      const refreshed = await this.getAccessToken();
      if (!refreshed.ok) return refreshed.result;
      currentPeriod = await this.dashboardRequest("GetCurrentPeriodUsage", refreshed.value);
      if (!currentPeriod.ok && currentPeriod.status && [401, 403].includes(currentPeriod.status)) {
        return errorResult(
          "TOKEN_EXPIRED",
          "Cursor rejected a freshly exchanged account usage token.",
          true,
        );
      }
    }
    if (!currentPeriod.ok) {
      return errorResult(currentPeriod.code, currentPeriod.message, currentPeriod.retryable);
    }

    const activeToken = this.accessToken?.value ?? token.value;
    const planResponse = await this.dashboardRequest("GetPlanInfo", activeToken);
    const retrievedAt = new Date(this.now()).toISOString();
    return normalizeCursorAccountUsage(
      currentPeriod.data,
      planResponse.ok ? planResponse.data : undefined,
      retrievedAt,
      this.labels,
    );
  }

  /**
   * Cache the outcome, failures included. `retryable` is the signal the result
   * already carries about whether asking again could help; honouring it here is
   * what stops a rejected key or a team seat with no plan quota from re-running
   * the full exchange plus two dashboard calls on every panel open.
   */
  private cacheResult(result: CursorUsageResult): void {
    const ttl = result.ok
      ? this.accountUsageTtlMs
      : result.retryable
        ? RETRYABLE_FAILURE_TTL_MS
        : PERMANENT_FAILURE_TTL_MS;
    this.cachedUsage = { result, expiresAt: this.now() + ttl };
  }

  private async getAccessToken(): Promise<
    { ok: true; value: string } | { ok: false; result: CursorUsageResult }
  > {
    const now = this.now();
    if (this.accessToken && this.accessToken.expiresAt > now + TOKEN_EXPIRY_SKEW_MS) {
      return { ok: true, value: this.accessToken.value };
    }
    const response = await this.requestJson(`${CURSOR_API_BASE}/auth/exchange_user_api_key`, {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          result: errorResult(
            "AUTH_FAILED",
            "Cursor rejected the configured API key. Update it in Settings and try again.",
            false,
          ),
        };
      }
      return {
        ok: false,
        result: errorResult(response.code, response.message, response.retryable),
      };
    }
    const payload = record(response.data);
    const value = [payload?.accessToken, payload?.access_token, payload?.token].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
    if (!payload || !value) {
      return {
        ok: false,
        result: errorResult(
          "INVALID_RESPONSE",
          "Cursor's API-key exchange returned no access token.",
          true,
        ),
      };
    }
    this.accessToken = { value, expiresAt: exchangeExpiryMs(payload, value, now) };
    return { ok: true, value };
  }

  private dashboardRequest(method: string, accessToken: string): Promise<JsonResponse> {
    return this.requestJson(`${CURSOR_API_BASE}/aiserver.v1.DashboardService/${method}`, {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    });
  }

  private async requestJson(url: string, headers: Record<string, string>): Promise<JsonResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: "{}",
        signal: controller.signal,
      });
      if (!response.ok) return responseError(response.status);
      try {
        return { ok: true, status: response.status, data: await readBoundedJson(response) };
      } catch (error) {
        // The timeout covers the body read as well as the fetch, so an abort
        // can land here. Reporting it as malformed data would blame Cursor for
        // a deadline this process set.
        if (controller.signal.aborted) return this.timeoutError(response.status);
        if (error instanceof CursorResponseTooLargeError) {
          return {
            ok: false,
            status: response.status,
            code: "INVALID_RESPONSE",
            message: "Cursor's account usage response was too large to read.",
            retryable: false,
          };
        }
        return {
          ok: false,
          status: response.status,
          code: "INVALID_RESPONSE",
          message: "Cursor returned malformed account usage data.",
          retryable: true,
        };
      }
    } catch {
      if (controller.signal.aborted) return this.timeoutError();
      return {
        ok: false,
        code: "NETWORK_ERROR",
        message: "Could not reach Cursor's account usage service.",
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private timeoutError(status?: number): JsonResponse {
    return {
      ok: false,
      ...(status === undefined ? {} : { status }),
      code: "NETWORK_ERROR",
      message: `Cursor's account usage request timed out after ${Math.round(
        this.requestTimeoutMs / 1_000,
      )}s.`,
      retryable: true,
    };
  }
}

let sharedProvider:
  | { credentialFingerprint: string; provider: CursorInternalApiProvider }
  | undefined;

export function getCursorAccountUsage(apiKey: string): Promise<CursorUsageResult> {
  const credentialFingerprint = createHash("sha256").update(apiKey).digest("hex");
  if (!sharedProvider || sharedProvider.credentialFingerprint !== credentialFingerprint) {
    sharedProvider = {
      credentialFingerprint,
      provider: new CursorInternalApiProvider(apiKey, {
        labels: {
          auto: process.env.CURSOR_USAGE_AUTO_LABEL?.trim() || DEFAULT_BUCKET_LABELS.auto,
          api: process.env.CURSOR_USAGE_API_LABEL?.trim() || DEFAULT_BUCKET_LABELS.api,
        },
      }),
    };
  }
  return sharedProvider.provider.getAccountUsage();
}

export const MISSING_CURSOR_CREDENTIAL_MESSAGE =
  "Add a Cursor API key or sign in under Settings › Cursor to view account usage.";

/**
 * Resolve which credential to read the account with, then read it. The
 * configured key (global config, or an inherited `CURSOR_API_KEY`) wins over
 * the key Orkestrator's own Cursor SDK login stored, because the configured one
 * is the value the user can see and change in Settings. With neither, the
 * result is a structured `AUTH_FAILED` rather than an exception — the panel
 * renders the message, and there is nothing to retry.
 *
 * The credential lookups and the read are injected so the command's precedence
 * can be tested without a network call or a real credential on disk.
 */
export async function accountUsageForResolvedCredential(options: {
  configuredApiKey: string | undefined;
  storedApiKey: () => Promise<string | undefined>;
  load?: (apiKey: string) => Promise<CursorUsageResult>;
}): Promise<CursorUsageResult> {
  const configured = options.configuredApiKey?.trim();
  const apiKey = configured || (await options.storedApiKey())?.trim();
  if (!apiKey) {
    return errorResult("AUTH_FAILED", MISSING_CURSOR_CREDENTIAL_MESSAGE, false);
  }
  return (options.load ?? getCursorAccountUsage)(apiKey);
}
