import type { UsageHistoryQuery, UsageHistoryReport } from "@orkestrator/protocol/usage-history";

import { invoke } from "@/lib/native/backend";

export type {
  UsageDayPoint,
  UsageEnvironmentSummary,
  UsageHistoryQuery,
  UsageHistoryReport,
  UsageModelSummary,
  UsagePlatformSummary,
  UsageTotals,
} from "@orkestrator/protocol/usage-history";

/** Recorded token and spend history for a range of days ending today. */
export async function getUsageHistory(query: UsageHistoryQuery = {}): Promise<UsageHistoryReport> {
  return invoke<UsageHistoryReport>("get_usage_history", { ...query });
}
