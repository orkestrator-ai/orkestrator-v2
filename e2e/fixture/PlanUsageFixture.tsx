import { useState } from "react";
import { PlanUsageSection } from "../../apps/web/src/components/settings/PlanUsageSection";
import { AgentAccountsSection } from "../../apps/web/src/components/settings/AgentAccountsSection";
import type { AgentAccountsSnapshot } from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import type {
  CoordinatorAccountSwitchGrantState,
  CoordinatorAccountSwitchRecord,
} from "@orkestrator/protocol/coordinator-account-switch-grant";

/** Coordinator switches for `?switch-log=1`, oldest first so the dialog has to order them. */
function switchLog(): CoordinatorAccountSwitchRecord[] {
  const at = (hoursAgo: number) =>
    new Date(Date.parse("2026-10-01T13:00:00.000Z") - hoursAgo * 3_600_000).toISOString();
  const record = (
    index: number,
    hoursAgo: number,
    nodeName: string,
    from: string,
    to: string,
    reason: string,
  ): CoordinatorAccountSwitchRecord => ({
    requestId: `switch-${index}`,
    at: at(hoursAgo),
    platform: "codex",
    nodeId: `bk_${nodeName}`,
    nodeName,
    fromAccountLabel: from,
    toAccountId: `acct-${index}`,
    toAccountLabel: to,
    coordinatorName: "orkestrator-v2 coordinator",
    reason,
    state: "executed",
  });
  return [
    record(
      1,
      96,
      "rkmbp",
      "618BTrading",
      "arkaydeusdev",
      "User asked to move off the limited account",
    ),
    record(2, 30, "beelink", "arkaydeusdev", "618BTrading", "Weekly limit reached on arkaydeusdev"),
    ...Array.from({ length: 10 }, (_, index) =>
      record(
        3 + index,
        20 - index,
        "mini",
        "Host login",
        "Second account",
        `Routine move ${index + 1}`,
      ),
    ),
    record(
      13,
      1,
      "omarchy-hp",
      "618BTrading",
      "arkaydeusdev",
      "Workers are about to hit the 5-hour limit",
    ),
  ];
}

function installPlanUsageFixture() {
  const params = new URLSearchParams(window.location.search);
  const staleReading: PlanUsageSnapshot = {
    platform: "codex",
    status: "ok",
    stale: true,
    plan: "pro",
    windows: [{ window: "primary", label: "5-hour limit", usedPercent: 42 }],
    fetchedAt: "2026-10-01T12:00:00.000Z",
    message: "HTTP 429. Retrying in 5 minutes.",
  };
  // `?shared-reading=1`: the host login is read here; the second account's newest
  // reading came from another machine, and a third account was never read.
  const sharedReadings = params.has("shared-reading");
  const freshHere: PlanUsageSnapshot = {
    platform: "codex",
    status: "ok",
    plan: "pro",
    windows: [
      { window: "primary", label: "5-hour limit", usedPercent: 42 },
      { window: "secondary", label: "Weekly limit", usedPercent: 63 },
    ],
    fetchedAt: "2026-10-01T12:57:00.000Z",
  };
  const fromBeelink: PlanUsageSnapshot = {
    ...freshHere,
    windows: [
      { window: "primary", label: "5-hour limit", usedPercent: 100 },
      { window: "secondary", label: "Weekly limit", usedPercent: 88 },
    ],
    fetchedAt: "2026-10-01T12:59:00.000Z",
    readOn: { nodeId: "bk_beelink", nodeName: "beelink" },
  };
  const neverRead: PlanUsageSnapshot = {
    platform: "codex",
    status: "unavailable",
    windows: [],
    message: "Sign in to Codex to see this account's usage.",
    fetchedAt: "2026-10-01T13:00:00.000Z",
  };
  const thirdId = "22222222-3333-4444-8555-666666666666";
  const usageFor = (accountId: unknown): PlanUsageSnapshot => {
    if (!sharedReadings) return staleReading;
    if (accountId === thirdId) return neverRead;
    return accountId === "default" || accountId === undefined ? freshHere : fromBeelink;
  };
  const grant: CoordinatorAccountSwitchGrantState | null = params.has("switch-log")
    ? {
        grants: { claude: false, codex: true },
        limit: { switches: 3, windowMinutes: 60 },
        recentSwitches: switchLog(),
      }
    : null;
  const grouped = params.has("grouped-account");
  const savedId = "11111111-2222-4333-8444-555555555555";
  let snapshot: AgentAccountsSnapshot = {
    active: { claude: "default", codex: "default" },
    accounts: [
      {
        id: "default",
        platform: "codex",
        label: "Host login",
        isDefault: true,
        isActive: true,
        signedIn: true,
        identity: grouped ? { email: "shared@example.com" } : {},
      },
      {
        id: savedId,
        platform: "codex",
        label: "Second account",
        isDefault: false,
        isActive: false,
        signedIn: true,
        identity: grouped ? { email: "shared@example.com" } : {},
      },
      ...(sharedReadings
        ? [
            {
              id: thirdId,
              platform: "codex" as const,
              label: "Third account",
              isDefault: false,
              isActive: false,
              signedIn: true,
              identity: {},
            },
          ]
        : []),
    ],
  };
  window.orkestrator = {
    ...window.orkestrator!,
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      switch (command) {
        case "get_plan_usage":
          return (params.has("unavailable-plan") ? neverRead : usageFor(undefined)) as T;
        case "get_agent_account_usage":
          return usageFor(args?.accountId) as T;
        case "get_coordinator_account_switch_grant":
          return grant as T;
        case "get_agent_account_login":
          return { state: "idle" } as T;
        case "list_agent_accounts":
          return snapshot as T;
        case "remove_agent_account":
          if (args?.accountId !== savedId) throw new Error("Cannot remove the active host login");
          snapshot = {
            ...snapshot,
            accounts: snapshot.accounts.filter(({ id }) => id !== savedId),
          };
          return snapshot as T;
        default:
          throw new Error(`Unexpected plan usage fixture command: ${command}`);
      }
    },
  };
  return true;
}

export function PlanUsageFixture() {
  useState(installPlanUsageFixture);
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4">
      <PlanUsageSection platform="codex" />
      <AgentAccountsSection platform="codex" />
    </main>
  );
}
