import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentAccountPlatform,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import { useAccountMachine } from "@/components/settings/account-machine";
import { useAgentAccountsChanged } from "@/hooks/useAgentAccountsChanged";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";

/**
 * The machine's active account for `platform`: the login a reauthentication
 * renews (`startAgentAccountLogin` with `reauthenticate`). `null` while the
 * read is pending, when it failed, or when `enabled` is false; a sign-in card
 * then simply does not name an account rather than guessing one.
 */
export function useActiveAgentAccount(
  platform: AgentAccountPlatform,
  enabled = true,
): AgentAccountSummary | null {
  const nodeBackend = useScopeBackend();
  const { scope } = useScopesWithCommandFallback();
  const { machine } = useAccountMachine();
  const [account, setAccount] = useState<AgentAccountSummary | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const read = ++latest.current;
    if (!enabled) {
      setAccount(null);
      return;
    }
    try {
      const snapshot = await nodeBackend.listAgentAccounts(machine);
      if (latest.current !== read) return;
      const activeId = snapshot.active[platform];
      setAccount(
        snapshot.accounts.find(
          (candidate) => candidate.platform === platform && candidate.id === activeId,
        ) ?? null,
      );
    } catch {
      if (latest.current === read) setAccount(null);
    }
  }, [enabled, machine, nodeBackend, platform]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => {
      latest.current += 1;
    };
  }, [load]);
  // A switch or sign-in elsewhere (Settings, another window) changes it.
  useAgentAccountsChanged(enabled ? platform : null, () => void load(), scope);

  return account;
}

/** How a sign-in card names an account: its label, and the email when it differs. */
export function agentAccountDisplayName(account: AgentAccountSummary): string {
  const email = account.identity.email?.trim();
  const label = account.label.trim();
  if (!label) return email ?? "";
  return email && email !== label ? `${label} (${email})` : label;
}
