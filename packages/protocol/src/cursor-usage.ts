export type CursorUsageWindow = "billing_cycle" | "week" | "day" | "custom";

export interface CursorUsageBucket {
  id: string;
  label: string;
  window: CursorUsageWindow;
  usedPercent?: number;
  remainingPercent?: number;
  usedCents?: number;
  remainingCents?: number;
  limitCents?: number;
  resetsAt?: string;
  /** The undocumented Cursor field this bucket was normalized from. */
  sourceField?: string;
}

export interface CursorNormalizedUsage {
  provider: "cursor";
  plan?: string;
  cycle: {
    startsAt?: string;
    endsAt?: string;
  };
  included: {
    usedCents?: number;
    remainingCents?: number;
    limitCents?: number;
  };
  buckets: CursorUsageBucket[];
  onDemand?: {
    usedCents?: number;
    individualLimitCents?: number;
    individualRemainingCents?: number;
    pooledLimitCents?: number;
    pooledUsedCents?: number;
    pooledRemainingCents?: number;
    limitType?: string;
  };
  /** Allowlisted historical field names, retained without exposing the raw response. */
  internalPercentages?: {
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    /** Cursor's reported overall quota percentage, which may use a different denominator. */
    totalPercentUsed?: number;
  };
  source: {
    kind: "internal-dashboard-api" | "admin-api" | "agent-sdk";
    retrievedAt: string;
  };
}

export type CursorUsageErrorCode =
  | "AUTH_FAILED"
  | "TOKEN_EXPIRED"
  | "RATE_LIMITED"
  | "UNSUPPORTED_ACCOUNT_TYPE"
  | "MISSING_PLAN_USAGE"
  | "INTERNAL_API_CHANGED"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE";

export type CursorUsageResult =
  | { ok: true; data: CursorNormalizedUsage }
  | {
      ok: false;
      code: CursorUsageErrorCode;
      message: string;
      retryable: boolean;
    };
