import type { UsageHistoryQuery, UsageHistoryReport } from "@orkestrator/protocol/usage-history";

import { type AccountMachine } from "./agent-accounts";
import { accountsOn } from "@/lib/node-scope/domains/accounts";
import { commandBackendClient, type BackendClient } from "./client";

export type {
  UsageDayPoint,
  UsageEnvironmentSummary,
  UsageHistoryQuery,
  UsageHistoryReport,
  UsageModelSummary,
  UsagePlatformSummary,
  UsageTotals,
} from "@orkestrator/protocol/usage-history";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createUsageApi(client: BackendClient) {
  // `get_usage_history` is in the `accounts` domain (plan item 7008).
  const on = accountsOn(client);

  /** Recorded token and spend history for a range of days ending today. */
  async function getUsageHistory(
    query: UsageHistoryQuery = {},
    machine?: AccountMachine,
  ): Promise<UsageHistoryReport> {
    return on(machine).get_usage_history({ ...query });
  }

  return { getUsageHistory };
}

export type UsageApi = ReturnType<typeof createUsageApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const { getUsageHistory } = createUsageApi(commandBackendClient);
