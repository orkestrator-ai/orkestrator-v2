/**
 * Additional Claude or Codex logins, shown in that platform's settings pane.
 *
 * Deliberately thin, like the Cursor sign-in: the backend owns account
 * directories, drives the CLI's own sign-in and decides which account launches
 * use. This view lists what it is told, starts and polls a sign-in, and asks
 * for a switch. A switch takes effect as each agent next starts work while
 * idle, so nothing running is interrupted. Entries of one login are shown once
 * (`groupAgentAccountLogins`).
 *
 * A signed-out Claude account is signed in again in place, without becoming
 * the active account, and each signed-in account's usage can be read afresh
 * on demand (a forced probe, which still waits out a provider rate limit).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, LogIn, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { AgentAccountLoginPanel } from "@/components/settings/AgentAccountLoginPanel";
import { AutoSwitchBadge } from "@/components/settings/AutoSwitchBadge";
import { AutoSwitchKeptNote } from "@/components/settings/AutoSwitchKeptNote";
import { CoordinatorAccountSwitchGrant } from "@/components/settings/CoordinatorAccountSwitchGrant";
import { useAccountMachine } from "@/components/settings/account-machine";
import { UsageReadingAge, UsageReadingBars } from "@/components/settings/UsageReading";
import { useAgentAccountsChanged } from "@/hooks/useAgentAccountsChanged";
import { useAgentUsageReadingsChanged } from "@/hooks/useAgentUsageReadingsChanged";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import {
  cancelAgentAccountLogin,
  getAgentAccountLogin,
  getAgentAccountUsage,
  listAgentAccounts,
  reauthenticateAgentAccount,
  removeAgentAccount,
  renameAgentAccount,
  setActiveAgentAccount,
  setAgentAccountAutoSwitchEnabled,
  setAgentAccountAutoSwitchIncluded,
  startAgentAccountLogin,
} from "@/lib/backend";
import {
  agentAccountLoginOf,
  groupAgentAccountLogins,
  type AgentAccountLogin,
  type AgentAccountLoginProgress,
  type AgentAccountPlatform,
  type AgentAccountsSnapshot,
  type AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import type { AgentAccountAutoSwitchState } from "@orkestrator/protocol/agent-account-auto-switch";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { SETTINGS_CARD_CLASS, SettingsSectionHeader } from "./SettingsPageLayout";
import { cn } from "@/lib/utils";

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

/**
 * Of one login's readings, the one to show: the newest reading, by when it was
 * taken. Its entries share one allowance, so the freshest wins. A last known
 * reading keeps its original time, so a newer fresh one always beats it; a
 * failed read with no reading at all comes last.
 */
export function freshestUsage(snapshots: readonly PlanUsageSnapshot[]): PlanUsageSnapshot | null {
  const rank = (snapshot: PlanUsageSnapshot) => (snapshot.status !== "ok" ? 1 : 0);
  return (
    [...snapshots].sort(
      (left, right) =>
        rank(left) - rank(right) || Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt),
    )[0] ?? null
  );
}

function AccountUsage({
  platform,
  accountIds,
  reloadToken,
  readToken,
  refreshToken,
  onRefreshed,
}: {
  platform: AgentAccountPlatform;
  /** Every entry of one login. */
  accountIds: readonly string[];
  reloadToken: string;
  /** Raised when a newer reading may be on the machine: read again, from its cache. */
  readToken: number;
  /** Raised by the row's refresh button: the next read bypasses the cache. */
  refreshToken: number;
  /** Called once a read for `refreshToken` has settled, whatever its outcome. */
  onRefreshed: (refreshToken: number) => void;
}) {
  const idsKey = accountIds.join(",");
  const [snapshot, setSnapshot] = useState<PlanUsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A credential can change while the general settings pane is visible. A
  // newly mounted account row must also bypass the pre-change cache then.
  const seenReloadTokenRef = useRef("0:0");
  const seenRefreshTokenRef = useRef(0);
  const onRefreshedRef = useRef(onRefreshed);
  useEffect(() => {
    onRefreshedRef.current = onRefreshed;
  }, [onRefreshed]);
  const { machine } = useAccountMachine();

  useEffect(() => {
    let current = true;
    const forced =
      reloadToken !== seenReloadTokenRef.current || refreshToken !== seenRefreshTokenRef.current;
    seenReloadTokenRef.current = reloadToken;
    seenRefreshTokenRef.current = refreshToken;
    const load = async () => {
      const results = await Promise.allSettled(
        idsKey
          .split(",")
          .map((accountId) =>
            getAgentAccountUsage(platform, accountId, { force: forced }, machine),
          ),
      );
      if (!current) return;
      onRefreshedRef.current(refreshToken);
      const next = freshestUsage(
        results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
      );
      if (next) {
        setSnapshot(next);
        setError(null);
      } else {
        const failed = results.find((result) => result.status === "rejected");
        setError(messageOf(failed?.status === "rejected" ? failed.reason : "No usage reading"));
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [platform, idsKey, reloadToken, readToken, refreshToken, machine]);

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
    // No reading at all: a last known one would have been served, marked stale.
    return (
      <div className="space-y-0.5">
        {snapshot.message ? (
          <p className="text-xs text-muted-foreground">{snapshot.message}</p>
        ) : null}
        <UsageReadingAge snapshot={null} />
      </div>
    );
  }
  return (
    <UsageReadingBars
      snapshot={snapshot}
      empty={<p className="text-xs text-muted-foreground">No metered plan limits reported.</p>}
    />
  );
}

/**
 * The provider's main tick and which state this machine is in. A manual switch
 * leaves it unticked and pinned, so ticking it again is what resumes.
 */
function AutoSwitchControls({
  platformLabel,
  state,
  logins,
  busy,
  machineName,
  onChange,
}: {
  platformLabel: string;
  state: AgentAccountAutoSwitchState;
  logins: AgentAccountLogin[];
  busy: boolean;
  machineName: string | null;
  onChange: (enabled: boolean) => void;
}) {
  const pinned = agentAccountLoginOf(logins, state.pinnedAccountId)?.account;
  const moved = agentAccountLoginOf(logins, state.lastSwitch?.toAccountId)?.account;
  // A stay is news until a later switch; the store also drops it on that switch.
  const kept =
    state.lastKept &&
    (!state.lastSwitch || Date.parse(state.lastKept.at) > Date.parse(state.lastSwitch.at))
      ? state.lastKept
      : undefined;
  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="flex items-start gap-2">
        <Checkbox
          id={`auto-switch-${platformLabel}`}
          className="mt-0.5"
          checked={state.mode === "automatic"}
          disabled={busy}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor={`auto-switch-${platformLabel}`}
              className="text-sm font-medium text-foreground"
            >
              Automatically use the account whose weekly limit resets soonest
            </label>
            <InfoHint label="About automatic switching">
              {state.mode === "pinned" ? (
                <p>
                  A manual switch pinned {pinned?.label ?? "this account"}
                  {machineName ? ` on ${machineName}` : ""}, so automatic switching is off here.
                  Tick this to turn it back on.
                </p>
              ) : null}
              <p>
                Moves on at 98% of the general weekly or 5-hour limit, or when a fresh reading
                confirms one is used up, and resends the work it stopped. It comes back when that
                5-hour limit resets, so accounts are used up in the order their weeks end.
              </p>
              <p>
                When a limit stops work, it reads every account afresh before choosing, and an
                account under 100% counts as having room.
              </p>
              <p>
                Applies to {platformLabel} on every machine this one controls. Fable and other model
                limits never move it. Switching by hand pins that account and turns this off until
                you tick it again.
              </p>
            </InfoHint>
            <AutoSwitchBadge state={state} pinnedLabel={pinned?.label} />
          </div>
          {state.mode === "automatic" && moved && !kept ? (
            <p className="text-xs text-muted-foreground">Last moved to {moved.label}.</p>
          ) : null}
          {state.mode === "automatic" && kept ? (
            <AutoSwitchKeptNote kept={kept} logins={logins} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Shared entries the CLI replaced with its own copy in this account's
 * directory (`privateSharedEntries` on the backend). One line; the
 * explanation and the way back are behind the info icon.
 */
function PrivateEntriesNotice({
  account,
  entries,
}: {
  account: AgentAccountSummary;
  entries: readonly string[];
}) {
  const cli = account.platform === "claude" ? "Claude" : "Codex";
  const hostHome = account.platform === "claude" ? "~/.claude" : "~/.codex";
  const homeSetting = account.platform === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const accountHome = `agent-accounts/${account.platform}/${account.id}`;
  const names = entries.join(", ");
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-amber-500">
      <AlertCircle className="h-3 w-3 shrink-0" />
      <span>Not shared with your other accounts: {names}</span>
      <InfoHint label={`About ${names} not being shared`}>
        <p>
          {cli} saved its own copy of {entries.length === 1 ? "this" : "these"} for this account
          instead of using the host login&apos;s. Changes this account makes stay here, and changes
          from the host login and your other accounts don&apos;t show up here. Everything else is
          still shared.
        </p>
        <p>
          To share {entries.length === 1 ? "it" : "them"} again, copy anything you want to keep into{" "}
          the configured {cli} host directory on the machine that owns this account (
          <code>{homeSetting}</code> if set, otherwise <code>{hostHome}</code>). Verify the saved
          content is there before deleting {names} from <code>{accountHome}</code> in
          Orkestrator&apos;s data folder. It is linked back the next time {cli} starts on this
          account.
        </p>
      </InfoHint>
    </div>
  );
}

/** Signing a signed-out account in again from its row. */
interface AccountSignIn {
  /** False while another sign-in is running on this machine. */
  available: boolean;
  /** The running sign-in, when it is renewing this account. */
  progress: AgentAccountLoginProgress | null;
  onStart: () => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

/**
 * Only Claude renews an account in place. A Codex login keeps refreshing
 * itself, and one that has lapsed is removed and added again.
 */
function canSignInAgain(platform: AgentAccountPlatform): boolean {
  return platform === "claude";
}

function AccountRow({
  login,
  busy,
  usageReloadToken,
  usageReadToken,
  autoSwitchIncluded,
  signIn,
  onUse,
  onRename,
  onRemove,
  onAutoSwitchIncluded,
}: {
  login: AgentAccountLogin;
  busy: boolean;
  usageReloadToken: string;
  /** Raised when a newer reading may be on the machine; re-read without forcing. */
  usageReadToken: number;
  /** Absent from a machine that predates automatic switching. */
  autoSwitchIncluded?: boolean;
  signIn: AccountSignIn;
  onAutoSwitchIncluded: (included: boolean) => void;
  onUse: () => void;
  onRename: (label: string) => Promise<void>;
  onRemove: () => void;
}) {
  const { account } = login;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.label);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [usageRefresh, setUsageRefresh] = useState({ requested: 0, settled: 0 });
  const refreshingUsage = usageRefresh.requested > usageRefresh.settled;
  const onUsageRefreshed = useCallback(
    (token: number) =>
      setUsageRefresh((current) =>
        token > current.settled ? { ...current, settled: token } : current,
      ),
    [],
  );
  const identity = describeIdentity(account);
  const signingIn = signIn.progress !== null;
  const offerSignIn = !account.signedIn && canSignInAgain(account.platform);

  return (
    <li
      aria-label={account.label}
      className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-48">
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
              {login.isActive ? (
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
              {!account.signedIn && !canSignInAgain(account.platform) ? (
                <InfoHint label={`About signing ${account.label} in`}>
                  <p>
                    A signed-out Codex account cannot be signed in again in place. Remove it and add
                    it again with Add account.
                  </p>
                </InfoHint>
              ) : null}
            </p>
          )}
          {identity ? <p className="mt-0.5 text-xs text-muted-foreground">{identity}</p> : null}
          {login.alsoHostLogin ? (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              Also the host login
              <InfoHint label="About the host login">
                <p>
                  The host login is whatever{" "}
                  {account.platform === "claude" ? "~/.claude" : "~/.codex"} is signed in to on this
                  machine. It is signed in to this same account, so the two are shown once and share
                  one allowance. Usage shows whichever was read most recently.
                </p>
              </InfoHint>
            </p>
          ) : null}
          {autoSwitchIncluded !== undefined && account.signedIn ? (
            <label className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                aria-label={`Include ${account.label} in automatic switching`}
                checked={autoSwitchIncluded}
                disabled={busy}
                onCheckedChange={(checked) => onAutoSwitchIncluded(checked === true)}
              />
              {account.identity.email
                ? "Include in automatic switching"
                : "Include in automatic switching on this machine (it has no email to match elsewhere)"}
            </label>
          ) : null}
          {account.privateEntries?.length ? (
            <PrivateEntriesNotice account={account} entries={account.privateEntries} />
          ) : null}
        </div>
        {!editing ? (
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
            {offerSignIn && !signingIn ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={signIn.onStart}
                disabled={busy || !signIn.available}
                title={signIn.available ? undefined : "Finish or cancel the other sign-in first"}
              >
                <LogIn className="mr-1.5 h-3.5 w-3.5" />
                Sign in
              </Button>
            ) : null}
            {account.signedIn ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground"
                aria-label={`Refresh usage for ${account.label}`}
                title="Check usage limits now"
                disabled={refreshingUsage}
                onClick={() =>
                  setUsageRefresh((current) => ({ ...current, requested: current.requested + 1 }))
                }
              >
                <RefreshCw className={cn("h-3.5 w-3.5", refreshingUsage && "animate-spin")} />
              </Button>
            ) : null}
            {!login.isActive ? (
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
      {signIn.progress ? (
        <AgentAccountLoginPanel
          progress={signIn.progress}
          onCancel={signIn.onCancel}
          onError={signIn.onError}
        />
      ) : null}
      {account.signedIn ? (
        <AccountUsage
          platform={account.platform}
          accountIds={login.entryIds}
          reloadToken={usageReloadToken}
          readToken={usageReadToken}
          refreshToken={usageRefresh.requested}
          onRefreshed={onUsageRefreshed}
        />
      ) : null}
    </li>
  );
}

export function AgentAccountsSection({
  platform,
  reloadToken = 0,
  onAccountsChanged,
}: {
  platform: AgentAccountPlatform;
  reloadToken?: number;
  onAccountsChanged?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<AgentAccountsSnapshot | null>(null);
  const [login, setLogin] = useState<AgentAccountLoginProgress>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usageReloadToken, setUsageReloadToken] = useState(0);
  const [usageReadToken, setUsageReadToken] = useState(0);
  const mounted = useRef(true);
  const platformLabel = AGENT_PLATFORM_LABELS[platform];
  const { machine, name: machineName } = useAccountMachine();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(
    () =>
      listAgentAccounts(machine).then(
        (loaded) => {
          if (mounted.current) setSnapshot(loaded);
        },
        (cause: unknown) => {
          if (mounted.current) setError(messageOf(cause));
        },
      ),
    [machine],
  );

  useEffect(() => {
    void reload();
  }, [reload]);
  // Automatic switching moves the active account with no one here.
  useAgentAccountsChanged(platform, () => void reload());
  // A reading this machine took, or one another machine took of the same login.
  useAgentUsageReadingsChanged(platform, () => setUsageReadToken((token) => token + 1));

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
        onAccountsChanged?.();
      }
    },
    [reload, onAccountsChanged],
  );

  // Signing an account in again is shown on that account's row (whether this
  // pane or the agent's own tab started it), never as one being added.
  const loginHere = login.platform === platform && login.mode !== "reauthenticate";
  const loginPending = login.state === "pending" && loginHere;
  const renewingAccountId =
    login.state === "pending" && login.platform === platform && login.mode === "reauthenticate"
      ? login.accountId
      : undefined;
  const loginStatus = useCoordinatedRead<AgentAccountLoginProgress>({
    key: { resource: "agent-account-login", target: machine ?? "backend" },
    // A sign-in outlives this pane: reopening settings resumes the one running.
    readOnSubscribe: true,
    demand: {
      intervalMs: login.state === "pending" ? POLL_INTERVAL_MS : null,
      priority: "standard",
    },
    read: () => getAgentAccountLogin(machine),
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
      onAccountsChanged?.();
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
        await cancelAgentAccountLogin(login.operationId, machine);
      applyLogin(await startAgentAccountLogin(platform, {}, machine));
      await refreshLogin();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const signInAgain = async (accountId: string) => {
    setError(null);
    try {
      // Dismiss a finished sign-in first so its result does not linger.
      if (login.state !== "idle" && login.state !== "pending")
        await cancelAgentAccountLogin(login.operationId, machine);
      applyLogin(await reauthenticateAgentAccount(platform, accountId, machine));
      await refreshLogin();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const cancelLogin = async () => {
    applyLogin(
      await cancelAgentAccountLogin(login.operationId, machine).catch(() => ({
        state: "idle" as const,
      })),
    );
    await refreshLogin();
  };

  const logins = groupAgentAccountLogins(
    sortAccounts(snapshot?.accounts.filter((account) => account.platform === platform) ?? []),
  );
  const renewingRowShown =
    renewingAccountId !== undefined &&
    logins.some((entry) => entry.entryIds.includes(renewingAccountId));
  // A renewal shown on its row explains itself; any other sign-in is named here.
  const otherLoginPending = login.state === "pending" && !loginHere && !renewingRowShown;
  const autoSwitch = snapshot?.autoSwitch?.[platform];

  return (
    <section aria-label={`${platformLabel} accounts`} className={cn(SETTINGS_CARD_CLASS, "p-4")}>
      <div className="flex items-start justify-between gap-4">
        <SettingsSectionHeader title={machineName ? `Accounts on ${machineName}` : "Accounts"}>
          {platformLabel} agents, containers and new terminals
          {machineName ? ` on ${machineName}` : ""} use the active account. Switching applies to
          each agent the next time it starts work while idle; conversations carry over.
        </SettingsSectionHeader>
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
            disabled={login.state === "pending"}
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

      {autoSwitch ? (
        <AutoSwitchControls
          platformLabel={platformLabel}
          state={autoSwitch}
          logins={logins}
          busy={busy}
          machineName={machineName}
          onChange={(enabled) =>
            void run(() =>
              setAgentAccountAutoSwitchEnabled(
                platform,
                enabled,
                autoSwitch.pinnedAccountId !== undefined,
                machine,
              ),
            )
          }
        />
      ) : null}

      {snapshot ? (
        <CoordinatorAccountSwitchGrant
          platform={platform}
          platformLabel={platformLabel}
          machine={machine}
          machineName={machineName}
          refreshKey={`${reloadToken}:${snapshot.active[platform] ?? ""}`}
        />
      ) : null}

      {snapshot ? (
        <ul className="mt-4 space-y-2">
          {logins.map((entry) => {
            const { account } = entry;
            return (
              <AccountRow
                key={account.id}
                login={entry}
                busy={busy}
                usageReloadToken={`${reloadToken}:${usageReloadToken}`}
                usageReadToken={usageReadToken}
                {...(autoSwitch
                  ? { autoSwitchIncluded: autoSwitch.includedAccountIds.includes(account.id) }
                  : {})}
                signIn={{
                  available: login.state !== "pending",
                  progress:
                    renewingAccountId !== undefined && entry.entryIds.includes(renewingAccountId)
                      ? login
                      : null,
                  onStart: () => void signInAgain(account.id),
                  onCancel: () => void cancelLogin(),
                  onError: setError,
                }}
                onAutoSwitchIncluded={(included) =>
                  void run(() =>
                    setAgentAccountAutoSwitchIncluded(
                      platform,
                      account.id,
                      account.identity.email,
                      included,
                      machine,
                    ),
                  )
                }
                onUse={() =>
                  void run(() => setActiveAgentAccount(platform, account.id, machine), true)
                }
                onRename={(label) =>
                  run(() => renameAgentAccount(platform, account.id, label, machine))
                }
                onRemove={() => void run(() => removeAgentAccount(platform, account.id, machine))}
              />
            );
          })}
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
