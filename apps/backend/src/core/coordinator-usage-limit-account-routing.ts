import {
  isAgentAccountPlatform,
  type AgentSessionAccount,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";
import { usageLimitAccountKey } from "@orkestrator/protocol/coordinator-notices";
import { coordinatorSessionAccount } from "./agent-accounts-session.js";
import type { AgentAccountAutoSwitcher } from "./agent-accounts-auto-switch.js";
import type { UsageLimitNoticeDeps } from "./coordinator-usage-limit-notices.js";

/** Production wiring shared by the backend composition root and its contract test. */
export function usageLimitAccountRouting(deps: {
  readSession(environmentId: string, agent: string): Promise<AgentSessionAccount | null>;
  hasLiveWork(environmentId: string, platform: AgentAccountPlatform): Promise<boolean>;
  machineKey(): Promise<string>;
  switcher: Pick<AgentAccountAutoSwitcher, "moveOffLimitedAccount">;
}): Pick<UsageLimitNoticeDeps, "coordinatorAccountKey" | "moveOff"> {
  return {
    coordinatorAccountKey: async (environmentId, agent) => {
      const session = await deps.readSession(environmentId, agent);
      const account = coordinatorSessionAccount(
        session,
        session?.running === true && (await deps.hasLiveWork(environmentId, session.platform)),
      );
      if (session?.source !== "account" || !account) return null;
      return usageLimitAccountKey({
        platform: agent,
        machineKey: await deps.machineKey(),
        email: account.identity.email,
        accountId: account.id,
      });
    },
    moveOff: async (platform, accountKey, options) => {
      if (!isAgentAccountPlatform(platform))
        return { moved: false, reason: "no-account-with-headroom" };
      const machineKey = await deps.machineKey();
      return deps.switcher.moveOffLimitedAccount(
        platform,
        (account) =>
          usageLimitAccountKey({
            platform,
            machineKey,
            email: account.identity.email,
            accountId: account.id,
          }) === accountKey,
        options,
      );
    },
  };
}
