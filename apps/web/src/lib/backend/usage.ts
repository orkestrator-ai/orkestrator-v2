import type { UsageHistoryQuery, UsageHistoryReport } from "@orkestrator/protocol/usage-history";

import { machineInvoke, type AccountMachine } from "./agent-accounts";

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
export async function getUsageHistory(
  query: UsageHistoryQuery = {},
  machine?: AccountMachine,
): Promise<UsageHistoryReport> {
  return machineInvoke<UsageHistoryReport>(machine, "get_usage_history", { ...query });
}
