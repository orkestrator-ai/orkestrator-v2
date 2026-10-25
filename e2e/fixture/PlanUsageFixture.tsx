import { useState } from "react";
import { PlanUsageSection } from "../../apps/web/src/components/settings/PlanUsageSection";
import { AgentAccountsSection } from "../../apps/web/src/components/settings/AgentAccountsSection";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

function installPlanUsageFixture() {
  const reading: PlanUsageSnapshot = {
    platform: "codex",
    status: "ok",
    stale: true,
    plan: "pro",
    windows: [{ window: "primary", label: "5-hour limit", usedPercent: 42 }],
    fetchedAt: "2026-10-01T12:00:00.000Z",
    message: "HTTP 429. Retrying in 5 minutes.",
  };
  window.orkestrator = {
    ...window.orkestrator!,
    invoke: async <T,>(command: string): Promise<T> => {
      switch (command) {
        case "get_plan_usage":
        case "get_agent_account_usage":
          return reading as T;
        case "get_agent_account_login":
          return { state: "idle" } as T;
        case "list_agent_accounts":
          return {
            active: { claude: "default", codex: "default" },
            accounts: [
              {
                id: "default",
                platform: "codex",
                label: "Host login",
                isDefault: true,
                isActive: true,
                signedIn: true,
                identity: {},
              },
              {
                id: "11111111-2222-4333-8444-555555555555",
                platform: "codex",
                label: "Second account",
                isDefault: false,
                isActive: false,
                signedIn: true,
                identity: {},
              },
            ],
          } as T;
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
