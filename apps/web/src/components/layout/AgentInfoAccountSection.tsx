/**
 * Which account this session's agent runs on, and a switch to another.
 *
 * Accounts belong to the machine the session runs on, and this view's
 * transport already reaches it (a leaf's workspace talks to the leaf), so
 * every call here goes to that machine. Switching is machine-wide: every
 * Claude (or Codex) agent on the machine moves over the next time it starts
 * work while idle, and a running turn finishes on the old account.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentAccountLoginPanel } from "@/components/settings/AgentAccountLoginPanel";
import { accountOptionLabel } from "@/components/settings/machines/MachineAgentAccountsSection";
import { useFederation } from "@/components/federation/FederationProvider";
import { useAgentAccountReauth } from "@/hooks/useAgentAccountReauth";
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
  type AgentAccountSummary,
  type AgentSessionAccount,
} from "@orkestrator/protocol/agent-accounts";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function identityLine(account: AgentAccountSummary): string {
  const { email, organizationName, plan } = account.identity;
  return [email && email !== account.label ? email : undefined, organizationName, plan]
    .filter(Boolean)
    .join(" · ");
}

/** The machine this view's backend is, named only when the client shows more than one. */
export function useSessionMachineName(): string | null {
  const { enabled, bound } = useFederation();
  return enabled && bound ? bound.name : null;
}

export function AgentInfoAccountSection({
  environmentId,
  provider,
}: {
  environmentId: string;
  provider: string;
}) {
  if (!isAgentAccountPlatform(provider)) return null;
  return <AccountSection environmentId={environmentId} platform={provider} />;
}

function AccountSection({
  environmentId,
  platform,
}: {
  environmentId: string;
  platform: AgentAccountPlatform;
}) {
  const [session, setSession] = useState<AgentSessionAccount | null>(null);
  const [snapshot, setSnapshot] = useState<AgentAccountsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const machineName = useSessionMachineName();
  const platformLabel = AGENT_PLATFORM_LABELS[platform];
  const reauth = useAgentAccountReauth(platform, platform === "claude");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [nextSession, nextSnapshot] = await Promise.all([
        getNativeAgentSessionAccount(environmentId, platform),
        listAgentAccounts(),
      ]);
      if (!mounted.current) return;
      setSession(nextSession);
      setSnapshot(nextSnapshot);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    }
  }, [environmentId, platform]);

  useEffect(() => {
    void load();
  }, [load]);
  // A switch or sign-in elsewhere (Settings, another window) moves this too.
  useAgentAccountsChanged(platform, () => void load());

  // A finished sign-in changes what the account reports.
  const reauthState = reauth.progress.state;
  useEffect(() => {
    if (reauthState === "succeeded") void load();
  }, [load, reauthState]);

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
  const account = session?.account;
  const where = machineName ? ` on ${machineName}` : "";

  return (
    <div
      className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs"
      data-testid="agent-info-account"
    >
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
        {platformLabel} account{where}
      </div>
      {!session && !error ? (
        <p className="mt-1.5 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Reading account…
        </p>
      ) : null}
      {session?.source === "container" ? (
        <p className="mt-1.5 leading-relaxed text-muted-foreground">
          This container keeps its own {platformLabel} login, signed in from a terminal inside it.
        </p>
      ) : session?.source === "unknown" ? (
        <p className="mt-1.5 leading-relaxed text-muted-foreground">
          Could not tell which account this session runs on.
        </p>
      ) : account ? (
        <div className="mt-1.5">
          <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
            <span className="truncate">{account.label}</span>
            {!account.signedIn ? (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                Signed out
              </span>
            ) : null}
          </div>
          {identityLine(account) ? (
            <p className="mt-0.5 text-muted-foreground">{identityLine(account)}</p>
          ) : null}
          {session?.pendingActive ? (
            <p className="mt-1 leading-relaxed text-muted-foreground">
              Moves to {session.pendingActive.label} the next time this session is idle.
            </p>
          ) : !session?.running ? (
            <p className="mt-1 leading-relaxed text-muted-foreground">
              The agent starts on this account.
            </p>
          ) : null}
        </div>
      ) : null}

      {session?.source !== "container" && accounts.length > 1 && activeId ? (
        <div className="mt-2.5 space-y-1">
          <label className="text-muted-foreground" htmlFor={`agent-account-${environmentId}`}>
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
          <p className="leading-relaxed text-muted-foreground/80">
            A running turn finishes on its current account; conversations carry over.
          </p>
        </div>
      ) : null}

      {reauth.progress.state === "pending" ? (
        <div className="mt-2.5">
          <AgentAccountLoginPanel
            progress={reauth.progress}
            onCancel={() => void reauth.cancel()}
            onError={reauth.reportError}
          />
        </div>
      ) : null}
      {error || reauth.error ? (
        <p role="alert" className="mt-2 text-destructive">
          {error ?? reauth.error}
        </p>
      ) : null}

      {session?.source !== "container" ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {/* Signing in again renews the active account, which this session is on. */}
          {platform === "claude" &&
          reauth.progress.state !== "pending" &&
          !session?.pendingActive ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              disabled={reauth.starting}
              onClick={() => void reauth.start()}
            >
              {reauth.starting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <LogIn className="h-3 w-3" />
              )}
              Sign in again
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => requestGlobalSettings(platform)}
          >
            {accounts.length > 1 ? "Manage accounts" : "Add an account"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
