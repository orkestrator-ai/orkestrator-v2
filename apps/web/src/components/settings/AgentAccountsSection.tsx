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
import { AlertCircle, Check, Copy, ExternalLink, Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccountQuotaList } from "@/components/layout/AgentInfoButton.panels";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import { writeText } from "@/lib/native/clipboard";
import {
  cancelAgentAccountLogin,
  getAgentAccountLogin,
  getAgentAccountUsage,
  listAgentAccounts,
  openInBrowser,
  removeAgentAccount,
  renameAgentAccount,
  setActiveAgentAccount,
  startAgentAccountLogin,
  submitAgentAccountLoginCode,
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

function AccountUsage({
  platform,
  accountId,
  reloadToken,
}: {
  platform: AgentAccountPlatform;
  accountId: string;
  reloadToken: number;
}) {
  const [snapshot, setSnapshot] = useState<PlanUsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seenReloadTokenRef = useRef(reloadToken);

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
  usageReloadToken: number;
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

function LoginPanel({
  progress,
  onCancel,
  onError,
}: {
  progress: AgentAccountLoginProgress;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = progress.url;

  const submit = async () => {
    setSubmitting(true);
    try {
      await submitAgentAccountLoginCode(code);
      setCode("");
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async (value: string) => {
    try {
      await writeText(value);
      setCopied(true);
    } catch (cause) {
      onError(messageOf(cause));
    }
  };

  return (
    <div
      aria-label="Account sign-in"
      className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3"
    >
      {!url ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Starting sign-in…
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {progress.needsCode
              ? "Sign in with the account you want to add, then paste the code the page shows."
              : "Open the page, sign in with the account you want to add and enter this code:"}
          </p>
          {progress.userCode ? (
            <div className="flex items-center gap-2">
              <code className="rounded bg-zinc-900 px-2 py-1 font-mono text-sm tracking-widest text-foreground">
                {progress.userCode}
              </code>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label="Copy code"
                onClick={() => void copy(progress.userCode!)}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void openInBrowser(url)}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open sign-in page
            </Button>
            {progress.needsCode ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => void copy(url)}>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                {copied ? "Link copied" : "Copy link"}
              </Button>
            ) : null}
          </div>
          {progress.needsCode ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Input
                aria-label="Sign-in code"
                placeholder="Paste code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="h-8 text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="submit"
                size="sm"
                disabled={submitting || !code.trim() || progress.codeSubmitted}
              >
                {submitting || progress.codeSubmitted ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Continue
              </Button>
            </form>
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waiting for you to approve the sign-in…
            </p>
          )}
        </>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel sign-in
      </Button>
    </div>
  );
}

export function AgentAccountsSection({
  platform,
  onActiveAccountChange,
}: {
  platform: AgentAccountPlatform;
  /** Fired after a switch so the platform's usage card re-reads past its cache. */
  onActiveAccountChange?: () => void;
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

  const loginHere = login.platform === platform;
  const loginPending = login.state === "pending" && loginHere;
  const loginStatus = useCoordinatedRead<AgentAccountLoginProgress>({
    key: { resource: "agent-account-login", target: "backend" },
    // A sign-in outlives this pane: reopening settings resumes the one running.
    readOnSubscribe: true,
    demand: { intervalMs: loginPending ? POLL_INTERVAL_MS : null, priority: "standard" },
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
      if (activeChanged) {
        setUsageReloadToken((token) => token + 1);
        onActiveAccountChange?.();
      }
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
      if (login.state !== "idle" && login.state !== "pending") await cancelAgentAccountLogin();
      applyLogin(await startAgentAccountLogin(platform));
      await refreshLogin();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const cancelLogin = async () => {
    applyLogin(await cancelAgentAccountLogin().catch(() => ({ state: "idle" as const })));
    await refreshLogin();
  };

  const accounts = snapshot?.accounts.filter((account) => account.platform === platform) ?? [];
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
          <LoginPanel progress={login} onCancel={() => void cancelLogin()} onError={setError} />
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
              usageReloadToken={usageReloadToken}
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
