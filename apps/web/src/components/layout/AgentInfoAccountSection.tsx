/**
 * Account source messages, pending moves, machine-wide switching, and Settings access.
 *
 * Accounts belong to the machine the session runs on, and this view's
 * transport already reaches it (a leaf's workspace talks to the leaf), so
 * every call here goes to that machine. Switching is machine-wide: every
 * Claude (or Codex) agent on the machine moves over the next time it starts
 * work while idle, and a running turn finishes on the old account.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accountOptionLabel } from "@/components/settings/machines/MachineAgentAccountsSection";
import { useFederation } from "@/components/federation/FederationProvider";
import { useAgentAccountsChanged } from "@/hooks/useAgentAccountsChanged";
import {
  getNativeAgentSessionAccount,
  listAgentAccounts,
  setActiveAgentAccount,
} from "@/lib/backend";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import {
  isAgentAccountPlatform,
  type AgentAccountPlatform,
  type AgentAccountsSnapshot,
  type AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The machine this view's backend is, named only when the client shows more than one. */
export function useSessionMachineName(): string | null {
  const { enabled, bound } = useFederation();
  return enabled && bound ? bound.name : null;
}

export function AgentInfoAccountSection({
  environmentId,
  provider,
  open = true,
  refreshKey,
  onSessionAccount,
}: {
  environmentId: string;
  provider: string;
  open?: boolean;
  refreshKey?: unknown;
  /** Each read of the account this session runs on, for views that name it. */
  onSessionAccount?: (session: AgentSessionAccount | null) => void;
}) {
  if (!isAgentAccountPlatform(provider)) return null;
  return (
    <AccountSection
      key={`${environmentId}:${provider}`}
      environmentId={environmentId}
      platform={provider}
      open={open}
      refreshKey={refreshKey}
      onSessionAccount={onSessionAccount}
    />
  );
}

function AccountSection({
  environmentId,
  platform,
  open,
  refreshKey,
  onSessionAccount,
}: {
  environmentId: string;
  platform: AgentAccountPlatform;
  open: boolean;
  refreshKey?: unknown;
  onSessionAccount?: (session: AgentSessionAccount | null) => void;
}) {
  const [session, setSession] = useState<AgentSessionAccount | null>(null);
  const [snapshot, setSnapshot] = useState<AgentAccountsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const latest = useRef(0);
  const reportSession = useRef(onSessionAccount);
  useEffect(() => {
    reportSession.current = onSessionAccount;
  }, [onSessionAccount]);
  const machineName = useSessionMachineName();
  const platformLabel = AGENT_PLATFORM_LABELS[platform];

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      latest.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const read = ++latest.current;
    try {
      const [nextSession, nextSnapshot] = await Promise.all([
        getNativeAgentSessionAccount(environmentId, platform),
        listAgentAccounts(),
      ]);
      if (!mounted.current || latest.current !== read) return;
      setSession(nextSession);
      setSnapshot(nextSnapshot);
      reportSession.current?.(nextSession);
      setError(null);
    } catch (cause) {
      if (mounted.current && latest.current === read) setError(messageOf(cause));
    }
  }, [environmentId, platform]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load, open, refreshKey]);
  // A switch or sign-in elsewhere (Settings, another window) moves this too.
  useAgentAccountsChanged(platform, () => void load());

  const choose = async (accountId: string) => {
    setBusy(true);
    setError(null);
    try {
      await setActiveAgentAccount(platform, accountId);
      await load();
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const accounts = snapshot?.accounts.filter((account) => account.platform === platform) ?? [];
  const activeId = snapshot?.active[platform];
  const where = machineName ? ` on ${machineName}` : "";

  return (
    <div
      className="space-y-2 border-t border-border/60 pt-4 text-xs"
      data-testid="agent-info-account"
    >
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
        {platformLabel} account{where}
      </div>
      {!session && !error ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Reading account…
        </p>
      ) : null}
      {session?.source === "container" ? (
        <p className="leading-relaxed text-muted-foreground">
          This container keeps its own {platformLabel} login, signed in from a terminal inside it.
        </p>
      ) : session?.source === "unknown" ? (
        <p className="leading-relaxed text-muted-foreground">
          Could not tell which account this session runs on.
        </p>
      ) : null}

      {session?.source !== "container" && accounts.length > 1 && activeId ? (
        <div>
          <label
            className="mb-2 block text-muted-foreground"
            htmlFor={`agent-account-${environmentId}`}
          >
            Use for every {platformLabel} agent{where}
          </label>
          <Select
            value={activeId}
            onValueChange={(accountId) => {
              if (accountId !== activeId) void choose(accountId);
            }}
            disabled={busy}
          >
            <SelectTrigger id={`agent-account-${environmentId}`} className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {accountOptionLabel(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {session?.pendingActive ? (
        <p className="leading-relaxed text-muted-foreground">
          Moves to {session.pendingActive.label} the next time this session is idle.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}

      {session?.source !== "container" ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => requestGlobalSettings(platform)}
        >
          {accounts.length > 1 ? "Manage accounts" : "Add an account"}
        </Button>
      ) : null}
    </div>
  );
}
