/**
 * Additional Claude or Codex logins, shown in that platform's settings pane.
 *
 * Deliberately thin, like the Cursor sign-in: the backend owns account
 * directories, drives the CLI's own sign-in and decides which account launches
 * use. This view lists what it is told, starts and polls a sign-in, and asks
 * for a switch. A switch takes effect as each agent next starts work while
 * idle, so nothing running is interrupted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccountQuotaList } from "@/components/layout/AgentInfoButton.panels";
import { AgentAccountLoginPanel } from "@/components/settings/AgentAccountLoginPanel";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import {
  cancelAgentAccountLogin,
  getAgentAccountLogin,
  getAgentAccountUsage,
  listAgentAccounts,
  removeAgentAccount,
  renameAgentAccount,
  setActiveAgentAccount,
  startAgentAccountLogin,
} from "@/lib/backend";
import type {
  AgentAccountLoginProgress,
  AgentAccountPlatform,
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

/** How often to ask the backend whether the browser sign-in has finished. */
const POLL_INTERVAL_MS = 1_500;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function describeIdentity(account: AgentAccountSummary): string {
  const { email, organizationName, plan } = account.identity;
  return [account.label === email ? undefined : email, organizationName, plan]
    .filter(Boolean)
    .join(" · ");
}

/** The active account first, then the rest alphabetically by name. */
function sortAccounts(accounts: AgentAccountSummary[]): AgentAccountSummary[] {
  return [...accounts].sort(
    (a, b) =>
      Number(b.isActive) - Number(a.isActive) ||
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

function AccountUsage({
  platform,
  accountId,
  reloadToken,
}: {
  platform: AgentAccountPlatform;
  accountId: string;
  reloadToken: string;
}) {
  const [snapshot, setSnapshot] = useState<PlanUsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A credential can change while the general settings pane is visible. A
  // newly mounted account row must also bypass the pre-change cache then.
  const seenReloadTokenRef = useRef("0:0");

  useEffect(() => {
    let current = true;
    const forced = reloadToken !== seenReloadTokenRef.current;
    seenReloadTokenRef.current = reloadToken;
    const load = async () => {
      try {
        const next = await getAgentAccountUsage(platform, accountId, { force: forced });
        if (!current) return;
        setSnapshot(next);
        setError(null);
      } catch (cause) {
        if (current) setError(messageOf(cause));
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [platform, accountId, reloadToken]);

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!snapshot) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking usage…
      </p>
    );
  }
  if (snapshot.status !== "ok") {
    return <p className="text-xs text-muted-foreground">{snapshot.message}</p>;
  }
  return snapshot.windows.length > 0 ? (
    <AccountQuotaList account={snapshot.windows} />
  ) : (
    <p className="text-xs text-muted-foreground">No metered plan limits reported.</p>
  );
}

function AccountRow({
  account,
  busy,
  usageReloadToken,
  onUse,
  onRename,
  onRemove,
}: {
  account: AgentAccountSummary;
  busy: boolean;
  usageReloadToken: string;
  onUse: () => void;
  onRename: (label: string) => Promise<void>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.label);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const identity = describeIdentity(account);

  return (
    <li
      aria-label={account.label}
      className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {editing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void onRename(draft).then(() => setEditing(false));
              }}
            >
              <Input
                aria-label="Account name"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="h-7 text-xs"
                autoFocus
              />
              <Button type="submit" size="sm" variant="outline" disabled={busy || !draft.trim()}>
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
              <span className="truncate">{account.label}</span>
              {account.isActive ? (
                <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                  <Check className="h-3 w-3" />
                  Active
                </span>
              ) : null}
              {!account.signedIn ? (
                <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                  Signed out
                </span>
              ) : null}
            </p>
          )}
          {identity ? <p className="mt-0.5 text-xs text-muted-foreground">{identity}</p> : null}
        </div>
        {!editing ? (
          <div className="flex shrink-0 items-center gap-1">
            {!account.isActive ? (
              <Button type="button" size="sm" variant="outline" onClick={onUse} disabled={busy}>
                Use
              </Button>
            ) : null}
            {!account.isDefault ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(account.label);
                  setEditing(true);
                }}
                disabled={busy}
              >
                Rename
              </Button>
            ) : null}
            {!account.isDefault && !account.isActive ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={confirmingRemove ? "text-destructive" : undefined}
                onClick={() => {
                  if (confirmingRemove) onRemove();
                  else setConfirmingRemove(true);
                }}
                onBlur={() => setConfirmingRemove(false)}
                disabled={busy}
              >
                {confirmingRemove ? "Confirm remove" : "Remove"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {account.signedIn ? (
        <AccountUsage
          platform={account.platform}
          accountId={account.id}
          reloadToken={usageReloadToken}
        />
      ) : null}
    </li>
  );
}

export function AgentAccountsSection({
  platform,
  reloadToken = 0,
}: {
  platform: AgentAccountPlatform;
  reloadToken?: number;
}) {
  const [snapshot, setSnapshot] = useState<AgentAccountsSnapshot | null>(null);
  const [login, setLogin] = useState<AgentAccountLoginProgress>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usageReloadToken, setUsageReloadToken] = useState(0);
  const mounted = useRef(true);
  const platformLabel = AGENT_PLATFORM_LABELS[platform];

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const next = await listAgentAccounts();
      if (mounted.current) setSnapshot(next);
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const previousLoginState = useRef<AgentAccountLoginProgress["state"]>("idle");
  const applyLogin = useCallback(
    (next: AgentAccountLoginProgress) => {
      if (!mounted.current) return;
      const previous = previousLoginState.current;
      previousLoginState.current = next.state;
      setLogin(next);
      if (previous === "pending" && next.state !== "pending") {
        if (next.state === "failed" && next.error) setError(next.error);
        void reload();
      }
    },
    [reload],
  );

  // Signing the active account in again is driven from the agent's own tab; it
  // only blocks adding an account here, it is not shown as one being added.
  const loginHere = login.platform === platform && login.mode !== "reauthenticate";
  const loginPending = login.state === "pending" && loginHere;
  const loginStatus = useCoordinatedRead<AgentAccountLoginProgress>({
    key: { resource: "agent-account-login", target: "backend" },
    // A sign-in outlives this pane: reopening settings resumes the one running.
    readOnSubscribe: true,
    demand: {
      intervalMs: login.state === "pending" ? POLL_INTERVAL_MS : null,
      priority: "standard",
    },
    read: () => getAgentAccountLogin(),
    onState: (state) => {
      if (state.status === "current" && state.value) applyLogin(state.value);
    },
  });
  const refreshLogin = loginStatus.refresh;

  const run = async (operation: () => Promise<AgentAccountsSnapshot>, activeChanged = false) => {
    setBusy(true);
    setError(null);
    try {
      const next = await operation();
      if (!mounted.current) return;
      setSnapshot(next);
      if (activeChanged) setUsageReloadToken((token) => token + 1);
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const addAccount = async () => {
    setError(null);
    try {
      // Dismiss a finished sign-in first so its result does not linger.
      if (login.state !== "idle" && login.state !== "pending")
        await cancelAgentAccountLogin(login.operationId);
      applyLogin(await startAgentAccountLogin(platform));
      await refreshLogin();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const cancelLogin = async () => {
    applyLogin(
      await cancelAgentAccountLogin(login.operationId).catch(() => ({ state: "idle" as const })),
    );
    await refreshLogin();
  };

  const accounts = sortAccounts(
    snapshot?.accounts.filter((account) => account.platform === platform) ?? [],
  );
  const otherLoginPending = login.state === "pending" && !loginHere;

  return (
    <section
      aria-label={`${platformLabel} accounts`}
      className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">Accounts</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {platformLabel} agents, containers and new terminals use the active account. Switching
            applies to each agent the next time it starts work while idle; conversations carry over.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label="Refresh accounts"
            onClick={() => {
              setUsageReloadToken((token) => token + 1);
              void reload();
            }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void addAccount()}
            disabled={loginPending || otherLoginPending}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add account
          </Button>
        </div>
      </div>

      {error ? (
        <p className="mt-3 flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {loginPending ? (
        <div className="mt-3">
          <AgentAccountLoginPanel
            progress={login}
            onCancel={() => void cancelLogin()}
            onError={setError}
          />
        </div>
      ) : null}
      {otherLoginPending ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Another account sign-in is in progress. Finish or cancel it to add a {platformLabel}{" "}
          account.
        </p>
      ) : null}

      {snapshot ? (
        <ul className="mt-4 space-y-2">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              busy={busy}
              usageReloadToken={`${reloadToken}:${usageReloadToken}`}
              onUse={() => void run(() => setActiveAgentAccount(platform, account.id), true)}
              onRename={(label) => run(() => renameAgentAccount(platform, account.id, label))}
              onRemove={() => void run(() => removeAgentAccount(platform, account.id))}
            />
          ))}
        </ul>
      ) : !error ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading accounts…
        </p>
      ) : null}
    </section>
  );
}
