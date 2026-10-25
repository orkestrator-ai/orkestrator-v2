/**
 * Which agent login each machine's agents use.
 *
 * Every machine keeps its own logins; nothing here moves a credential. The
 * command node collects each machine's accounts (`list_machine_agent_accounts`)
 * and a choice is sent to that machine alone. Adding, renaming or signing an
 * account in happens in the platform's own section, opened on that machine.
 *
 * Kept current by each machine's `agent-accounts-changed` event, relayed by
 * the command node: an event (or a possible gap) re-reads that machine only.
 * Grok and Pi have no accounts; their sign-in state is shown read-only, with a
 * terminal sign-in on the machine.
 *
 * A preferred login per platform (an email, kept by the machine answering)
 * flags machines on another login and offers to switch the ones that have
 * it. It is chosen in the "By account" view and never switches anything by
 * itself.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, LogIn, RefreshCw, Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listAgentAccounts,
  listMachineAgentAccounts,
  openAgentSignInTerminal,
  readHostAgentSignIns,
  setActiveAgentAccount,
  setPreferredAgentIdentity,
} from "@/lib/backend";
import { subscribeCommandNodeEvents, subscribeNodeEvents } from "@/lib/federation/node-events";
import { requestCloseGlobalSettings, requestGlobalSettings } from "@/lib/settings-navigation";
import { useAccountMachineStore } from "@/components/settings/account-machine";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import {
  isPreferredIdentity,
  parseHostAgentSignIns,
  parseAgentAccountsSnapshot,
  parsePreferredAgentIdentities,
  AGENT_ACCOUNT_PLATFORMS,
  AGENT_ACCOUNTS_CHANGED_EVENT,
  HOST_SIGN_IN_PLATFORMS,
  type AgentAccountPlatform,
  type AgentAccountSummary,
  type HostSignInPlatform,
  type MachineAgentAccounts,
  type PreferredAgentIdentities,
} from "@orkestrator/protocol/agent-accounts";
import type { BackendId } from "@orkestrator/protocol/federation";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import { MachineSection, MachineStatusDot } from "./machine-ui";

/** Coalesces a burst of changes on one machine into one read. */
const REREAD_DEBOUNCE_MS = 250;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The node to ask for a machine, or `null` for the command node answering. */
function machineTarget(machine: MachineAgentAccounts): string | null {
  return machine.self ? null : machine.nodeId;
}

export function accountOptionLabel(account: AgentAccountSummary): string {
  const email = account.identity.email;
  const name = email && email !== account.label ? `${account.label} (${email})` : account.label;
  return account.signedIn ? name : `${name} — signed out`;
}

/** Open the platform's own settings section on one machine, to add or manage its accounts. */
function manageOn(
  machine: MachineAgentAccounts,
  platform: AgentAccountPlatform,
  onManage?: () => void,
) {
  useAccountMachineStore.getState().choose(machineTarget(machine));
  onManage?.();
  requestGlobalSettings(platform);
}

/** Where a machine stands against the preferred login for a platform. */
export type PreferredStatus =
  | { kind: "active" }
  | { kind: "available"; accountId: string }
  | { kind: "missing" };

/** Undefined when nothing is preferred or the machine could not be read. */
export function preferredStatus(
  machine: MachineAgentAccounts,
  platform: AgentAccountPlatform,
  email: string | undefined,
): PreferredStatus | undefined {
  const snapshot = machine.snapshot;
  if (!email || machine.state !== "ok" || !snapshot) return undefined;
  const accounts = snapshot.accounts.filter((account) => account.platform === platform);
  const active = accounts.find((account) => account.id === snapshot.active[platform]);
  if (active && isPreferredIdentity(active.identity, email)) return { kind: "active" };
  const matches = accounts.filter((account) => isPreferredIdentity(account.identity, email));
  const match = matches.find((account) => account.signedIn) ?? matches[0];
  return match ? { kind: "available", accountId: match.id } : { kind: "missing" };
}

function AccountCell({
  machine,
  platform,
  busy,
  preferredEmail,
  onChoose,
  onManage,
}: {
  machine: MachineAgentAccounts;
  platform: AgentAccountPlatform;
  busy: boolean;
  preferredEmail?: string;
  onChoose: (accountId: string) => void;
  onManage?: () => void;
}) {
  const snapshot = machine.snapshot;
  if (machine.state !== "ok" || !snapshot) {
    return (
      <span className="text-xs text-zinc-500">
        {machine.state === "unavailable" ? "Not connected" : "Could not read accounts"}
      </span>
    );
  }
  const accounts = snapshot.accounts.filter((account) => account.platform === platform);
  const active = accounts.find((account) => account.id === snapshot.active[platform]);
  const preferred = preferredStatus(machine, platform, preferredEmail);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        value={snapshot.active[platform]}
        onValueChange={(accountId) => {
          if (accountId !== snapshot.active[platform]) onChoose(accountId);
        }}
        disabled={busy}
      >
        <SelectTrigger
          aria-label={`${AGENT_PLATFORM_LABELS[platform]} account on ${machine.name}`}
          className="h-8 w-full max-w-[15rem] text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {accountOptionLabel(account)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active && !active.signedIn ? (
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
          Signed out
        </span>
      ) : null}
      {preferred?.kind === "available" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-amber-400"
          disabled={busy}
          title={`Switch ${machine.name} to ${preferredEmail}`}
          onClick={() => onChoose(preferred.accountId)}
        >
          Use preferred
        </Button>
      ) : preferred?.kind === "missing" ? (
        <span
          className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
          title={`${machine.name} has no ${preferredEmail} login`}
        >
          No preferred login
        </span>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-zinc-400"
        onClick={() => manageOn(machine, platform, onManage)}
      >
        Manage
      </Button>
    </div>
  );
}

function SignInCell({
  machine,
  platform,
  busy,
  onSignIn,
}: {
  machine: MachineAgentAccounts;
  platform: HostSignInPlatform;
  busy: boolean;
  onSignIn: () => void;
}) {
  const signIn = machine.signIns?.[platform];
  if (machine.state !== "ok" || !signIn) {
    return <span className="text-xs text-zinc-500">—</span>;
  }
  if (signIn.state === "signed-in") {
    return (
      <span className="text-xs text-zinc-300">
        Signed in
        {signIn.source ? <span className="text-zinc-500"> · {signIn.source}</span> : null}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-zinc-500">Not signed in</span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-zinc-400"
        disabled={busy}
        aria-label={`Sign in to ${AGENT_PLATFORM_LABELS[platform]} on ${machine.name}`}
        onClick={onSignIn}
      >
        {busy ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <LogIn className="mr-1 h-3 w-3" />
        )}
        Sign in on {machine.name}
      </Button>
    </div>
  );
}

/** One login and the machines it is on, for the identity view. */
interface IdentityGroup {
  key: string;
  label: string;
  /** Each machine that has it, with the account there. */
  on: Map<string, AgentAccountSummary>;
}

/**
 * Accounts grouped by email across machines. A login without an email cannot
 * be matched to another machine's, so it stays a group of its own.
 */
export function groupAccountsByIdentity(
  machines: readonly MachineAgentAccounts[],
  platform: AgentAccountPlatform,
  preferredEmail?: string,
): IdentityGroup[] {
  const groups = new Map<string, IdentityGroup>();
  for (const machine of machines) {
    if (machine.state !== "ok" || !machine.snapshot) continue;
    for (const account of machine.snapshot.accounts) {
      if (account.platform !== platform) continue;
      const email = account.identity.email?.trim();
      const key = email
        ? `email:${email.toLowerCase()}`
        : `account:${machine.nodeId}:${account.id}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, label: email ?? `${account.label} (${machine.name})`, on: new Map() };
        groups.set(key, group);
      }
      group.on.set(machine.nodeId, account);
    }
  }
  const preferredKey = preferredEmail ? `email:${preferredEmail.toLowerCase()}` : undefined;
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.key === preferredKey) - Number(a.key === preferredKey) ||
      b.on.size - a.on.size ||
      a.label.localeCompare(b.label),
  );
}

function IdentityView({
  machines,
  busy,
  preferred,
  onChoose,
  onPrefer,
  onManage,
}: {
  machines: MachineAgentAccounts[];
  busy: string | null;
  preferred: PreferredAgentIdentities;
  onChoose: (
    machine: MachineAgentAccounts,
    platform: AgentAccountPlatform,
    accountId: string,
  ) => void;
  /** Make an email the platform's preferred login, or clear it with `null`. */
  onPrefer: (platform: AgentAccountPlatform, email: string | null) => void;
  onManage?: () => void;
}) {
  return (
    <div className="space-y-4">
      {AGENT_ACCOUNT_PLATFORMS.map((platform) => {
        const groups = groupAccountsByIdentity(machines, platform, preferred[platform]);
        return (
          <div key={platform} className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-400">{AGENT_PLATFORM_LABELS[platform]}</p>
            {groups.length === 0 ? (
              <p className="text-xs text-zinc-500">No machine could be read.</p>
            ) : (
              <ul className="divide-y divide-zinc-800/60 rounded-xl border border-zinc-800">
                {groups.map((group) => (
                  <li
                    key={group.key}
                    data-testid="machine-agent-identity"
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
                  >
                    <span className="flex min-w-[10rem] items-center gap-1.5">
                      <span className="truncate text-sm text-zinc-100">{group.label}</span>
                      {group.key.startsWith("email:") ? (
                        <PreferToggle
                          platform={platform}
                          email={group.label}
                          preferred={isPreferredIdentity(
                            { email: group.label },
                            preferred[platform],
                          )}
                          busy={busy === `preferred:${platform}`}
                          onPrefer={onPrefer}
                        />
                      ) : null}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {machines.map((machine) => {
                        const account = group.on.get(machine.nodeId);
                        const isActive =
                          account && machine.snapshot?.active[platform] === account.id;
                        if (machine.state !== "ok") {
                          return (
                            <span key={machine.nodeId} className="text-xs text-zinc-600">
                              {machine.name}: not connected
                            </span>
                          );
                        }
                        if (!account) {
                          // A login only an email names cannot be added elsewhere.
                          if (!group.key.startsWith("email:")) return null;
                          return (
                            <Button
                              key={machine.nodeId}
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs text-amber-400"
                              onClick={() => manageOn(machine, platform, onManage)}
                            >
                              {machine.name}: sign in
                            </Button>
                          );
                        }
                        return (
                          <span
                            key={machine.nodeId}
                            className="flex items-center gap-1 rounded bg-zinc-800/60 px-1.5 py-0.5 text-xs text-zinc-300"
                          >
                            <MachineStatusDot
                              colorToken={machine.colorToken}
                              connected
                              label={machine.name}
                              decorative
                            />
                            {machine.name}
                            {!account.signedIn ? (
                              <span className="text-amber-400"> · signed out</span>
                            ) : null}
                            {isActive ? (
                              <span className="text-emerald-400"> · active</span>
                            ) : (
                              <button
                                type="button"
                                className="ml-1 text-zinc-400 underline-offset-2 hover:text-zinc-100 hover:underline disabled:opacity-50"
                                disabled={busy === `${machine.nodeId}:${platform}`}
                                onClick={() => onChoose(machine, platform, account.id)}
                              >
                                use
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PreferToggle({
  platform,
  email,
  preferred,
  busy,
  onPrefer,
}: {
  platform: AgentAccountPlatform;
  email: string;
  preferred: boolean;
  busy: boolean;
  onPrefer: (platform: AgentAccountPlatform, email: string | null) => void;
}) {
  const label = AGENT_PLATFORM_LABELS[platform];
  return (
    <button
      type="button"
      aria-pressed={preferred}
      aria-label={
        preferred
          ? `Stop preferring ${email} for ${label}`
          : `Prefer ${email} for ${label} on every machine`
      }
      title={preferred ? "Preferred login. Click to clear." : "Prefer this login on every machine"}
      disabled={busy}
      className={
        preferred
          ? "flex items-center gap-1 rounded px-1 text-[10px] font-medium text-amber-300 disabled:opacity-50"
          : "flex items-center rounded px-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
      }
      onClick={() => onPrefer(platform, preferred ? null : email)}
    >
      <Star className={preferred ? "h-3 w-3 fill-current" : "h-3 w-3"} />
      {preferred ? "Preferred" : null}
    </button>
  );
}

/**
 * One line per platform with a preferred login: how many machines use it and
 * a switch for every machine that has it but uses another.
 */
function PreferredSummary({
  machines,
  preferred,
  busy,
  onSwitchToPreferred,
}: {
  machines: MachineAgentAccounts[];
  preferred: PreferredAgentIdentities;
  busy: string | null;
  onSwitchToPreferred: (platform: AgentAccountPlatform) => void;
}) {
  const rows = AGENT_ACCOUNT_PLATFORMS.flatMap((platform) => {
    const email = preferred[platform];
    if (!email) return [];
    const statuses = machines.map((machine) => preferredStatus(machine, platform, email));
    const read = statuses.filter((status) => status !== undefined);
    return [
      {
        platform,
        email,
        on: read.filter((status) => status.kind === "active").length,
        read: read.length,
        switchable: read.filter((status) => status.kind === "available").length,
        missing: read.filter((status) => status.kind === "missing").length,
      },
    ];
  });
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-1" data-testid="machine-agent-preferred">
      {rows.map((row) => (
        <li key={row.platform} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Star className="h-3 w-3 fill-current text-amber-300" />
          <span className="text-zinc-300">
            Preferred {AGENT_PLATFORM_LABELS[row.platform]} login:{" "}
            <span className="text-zinc-100">{row.email}</span>
          </span>
          <span className="text-zinc-500">
            · {row.on} of {row.read} {row.read === 1 ? "machine" : "machines"} on it
            {row.missing > 0 ? ` · ${row.missing} without it` : ""}
          </span>
          {row.switchable > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs text-amber-400"
              disabled={busy === `preferred:${row.platform}`}
              onClick={() => onSwitchToPreferred(row.platform)}
            >
              {busy === `preferred:${row.platform}` ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : null}
              Use on {row.switchable} more {row.switchable === 1 ? "machine" : "machines"}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Show the environment a sign-in terminal opened in, on whichever machine it is. */
function showSignInTerminal(
  machine: MachineAgentAccounts,
  terminal: { projectId: string; environmentId: string },
) {
  requestCloseGlobalSettings();
  if (machine.self) {
    useRemoteWorkspaceStore.getState().showLocal();
    const ui = useUIStore.getState();
    ui.selectProject(terminal.projectId);
    ui.selectEnvironment(terminal.environmentId);
    return;
  }
  useRemoteWorkspaceStore.getState().open(machine.nodeId, {
    projectId: terminal.projectId,
    environmentId: terminal.environmentId,
  });
}

/** The environment on screen, when it is on `machine`: a sign-in terminal prefers it. */
function environmentOnScreen(machine: MachineAgentAccounts): string | undefined {
  const remote = useRemoteWorkspaceStore.getState().active;
  if (machine.self) {
    return remote ? undefined : (useUIStore.getState().selectedEnvironmentId ?? undefined);
  }
  return remote?.nodeId === machine.nodeId ? (remote.environmentId ?? undefined) : undefined;
}

export function MachineAgentAccountsSection({
  /** Show one machine only, for its own settings dialog. */
  nodeId,
  selfOnly = false,
  onManage,
}: {
  nodeId?: string | null;
  selfOnly?: boolean;
  /** Called before a platform's settings open, so a dialog showing this can close. */
  onManage?: () => void;
}) {
  const [machines, setMachines] = useState<MachineAgentAccounts[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [byIdentity, setByIdentity] = useState(false);
  const [preferred, setPreferred] = useState<PreferredAgentIdentities>({});
  const mounted = useRef(true);
  /** The latest read of each machine; an older answer is dropped. */
  const readSeq = useRef(new Map<string, number>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const nextSeq = useCallback((nodeId: string) => {
    const seq = (readSeq.current.get(nodeId) ?? 0) + 1;
    readSeq.current.set(nodeId, seq);
    return seq;
  }, []);

  /** Apply one machine's read, unless a newer read of it has started since. */
  const patch = useCallback(
    (nodeId: string, seq: number, update: Partial<MachineAgentAccounts>) => {
      if (!mounted.current || readSeq.current.get(nodeId) !== seq) return;
      setMachines((current) =>
        (current ?? []).map((entry) => (entry.nodeId === nodeId ? { ...entry, ...update } : entry)),
      );
    },
    [],
  );

  const load = useCallback(async () => {
    try {
      const result = await listMachineAgentAccounts();
      if (!mounted.current) return;
      const next = Array.isArray(result?.machines) ? result.machines : [];
      for (const machine of next) nextSeq(machine.nodeId);
      setMachines(next);
      setPreferred(parsePreferredAgentIdentities(result?.preferred));
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    }
  }, [nextSeq]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  /** Re-read one machine after its accounts changed or its events may have been missed. */
  const reread = useCallback(
    async (machine: MachineAgentAccounts) => {
      const seq = nextSeq(machine.nodeId);
      const target = machineTarget(machine);
      const [snapshot, signIns] = await Promise.allSettled([
        listAgentAccounts(target),
        readHostAgentSignIns(target),
      ]);
      const parsedSnapshot =
        snapshot.status === "fulfilled" ? parseAgentAccountsSnapshot(snapshot.value) : undefined;
      if (!parsedSnapshot) {
        patch(machine.nodeId, seq, {
          state: snapshot.status === "rejected" && !machine.self ? "unavailable" : "error",
          snapshot: undefined,
          error:
            snapshot.status === "rejected"
              ? messageOf(snapshot.reason).slice(0, 200)
              : "The machine answered without its accounts",
        });
        return;
      }
      const signInsValue =
        signIns.status === "fulfilled" ? parseHostAgentSignIns(signIns.value) : undefined;
      patch(machine.nodeId, seq, {
        state: "ok",
        snapshot: parsedSnapshot,
        error: undefined,
        // An older machine has no sign-in read; keep what was known.
        ...(signInsValue ? { signIns: signInsValue } : {}),
      });
    },
    [nextSeq, patch],
  );

  // One subscription per machine listed. The first resync arrives once the
  // subscription is in place and re-reads that machine, which covers any
  // change between the overview read and the subscription.
  const machineKey = (machines ?? []).map((machine) => machine.nodeId).join(",");
  const listed = useRef<MachineAgentAccounts[]>([]);
  useEffect(() => {
    listed.current = machines ?? [];
  }, [machines]);
  useEffect(() => {
    if (!machineKey) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const schedule = (nodeId: string) => {
      if (timers.has(nodeId)) return;
      timers.set(
        nodeId,
        setTimeout(() => {
          timers.delete(nodeId);
          const machine = listed.current.find((entry) => entry.nodeId === nodeId);
          if (machine && mounted.current) void reread(machine);
        }, REREAD_DEBOUNCE_MS),
      );
    };
    const stops = machineKey.split(",").map((id) => {
      const subscriber = {
        events: [AGENT_ACCOUNTS_CHANGED_EVENT],
        onResync: () => schedule(id),
        onEvent: () => schedule(id),
      };
      // The command node answering is reached directly, never through its relay.
      return listed.current.find((entry) => entry.nodeId === id)?.self
        ? subscribeCommandNodeEvents(subscriber)
        : subscribeNodeEvents(id as BackendId, subscriber);
    });
    return () => {
      for (const stop of stops) stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [machineKey, reread]);

  const choose = async (
    machine: MachineAgentAccounts,
    platform: AgentAccountPlatform,
    accountId: string,
  ) => {
    const key = `${machine.nodeId}:${platform}`;
    setBusy(key);
    setError(null);
    try {
      const seq = nextSeq(machine.nodeId);
      const result = await setActiveAgentAccount(platform, accountId, machineTarget(machine));
      const snapshot = parseAgentAccountsSnapshot(result);
      if (!snapshot) throw new Error("Invalid account snapshot");
      patch(machine.nodeId, seq, { snapshot });
    } catch (cause) {
      if (mounted.current) setError(`${machine.name}: ${messageOf(cause)}`);
      void reread(machine);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const prefer = async (platform: AgentAccountPlatform, email: string | null) => {
    setBusy(`preferred:${platform}`);
    setError(null);
    try {
      const next = await setPreferredAgentIdentity(platform, email);
      if (mounted.current) setPreferred(parsePreferredAgentIdentities(next));
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  /** Switch every listed machine that has the preferred login but uses another. */
  const switchToPreferred = async (platform: AgentAccountPlatform) => {
    const email = preferred[platform];
    const targets = shown.flatMap((machine) => {
      const status = preferredStatus(machine, platform, email);
      return status?.kind === "available" ? [{ machine, accountId: status.accountId }] : [];
    });
    if (targets.length === 0) return;
    setBusy(`preferred:${platform}`);
    setError(null);
    const failures: string[] = [];
    await Promise.all(
      targets.map(async ({ machine, accountId }) => {
        const seq = nextSeq(machine.nodeId);
        try {
          const snapshot = parseAgentAccountsSnapshot(
            await setActiveAgentAccount(platform, accountId, machineTarget(machine)),
          );
          if (!snapshot) throw new Error("Invalid account snapshot");
          patch(machine.nodeId, seq, { snapshot });
        } catch (cause) {
          failures.push(`${machine.name}: ${messageOf(cause)}`);
          void reread(machine);
        }
      }),
    );
    if (!mounted.current) return;
    if (failures.length > 0) setError(failures.join("; "));
    setBusy(null);
  };

  const signIn = async (machine: MachineAgentAccounts, platform: HostSignInPlatform) => {
    const key = `${machine.nodeId}:${platform}`;
    setBusy(key);
    setError(null);
    try {
      const terminal = await openAgentSignInTerminal(
        platform,
        machineTarget(machine),
        environmentOnScreen(machine),
      );
      onManage?.();
      showSignInTerminal(machine, terminal);
      toast.info(
        platform === "pi"
          ? `Run /login in the Pi terminal on ${machine.name}.`
          : `Finish the Grok sign-in in the terminal on ${machine.name}.`,
      );
    } catch (cause) {
      if (mounted.current) setError(`${machine.name}: ${messageOf(cause)}`);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const shown = (machines ?? []).filter((machine) =>
    selfOnly ? machine.self : nodeId ? machine.nodeId === nodeId : true,
  );
  const signInPlatforms = HOST_SIGN_IN_PLATFORMS.filter((platform) =>
    shown.some((machine) => machine.signIns?.[platform]),
  );
  const single = Boolean(nodeId || selfOnly);

  return (
    <MachineSection
      title="Agent accounts"
      description={
        single
          ? "The agent logins this machine's agents use. Each machine keeps its own logins."
          : "The agent logins each machine's agents use. Each machine keeps its own logins; a change applies to that machine's agents the next time they start work while idle. Star a login under By account to flag machines not on it."
      }
      testId="machine-agent-accounts"
      action={
        <div className="flex items-center gap-1">
          {!single && shown.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-zinc-400"
              aria-pressed={byIdentity}
              onClick={() => setByIdentity((value) => !value)}
            >
              {byIdentity ? "By machine" : "By account"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-zinc-400"
            aria-label="Refresh agent accounts"
            onClick={() => void load()}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      }
    >
      {error ? (
        <p className="flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      {machines === null && !error ? (
        <p className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading each machine's accounts…
        </p>
      ) : null}
      {shown.length > 0 && !single ? (
        <PreferredSummary
          machines={shown}
          preferred={preferred}
          busy={busy}
          onSwitchToPreferred={(platform) => void switchToPreferred(platform)}
        />
      ) : null}
      {shown.length > 0 && byIdentity && !single ? (
        <IdentityView
          machines={shown}
          busy={busy}
          preferred={preferred}
          onChoose={(machine, platform, accountId) => void choose(machine, platform, accountId)}
          onPrefer={(platform, email) => void prefer(platform, email)}
          {...(onManage ? { onManage } : {})}
        />
      ) : null}
      {shown.length > 0 && !(byIdentity && !single) ? (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                <th className="px-3 py-2 font-medium">Machine</th>
                {AGENT_ACCOUNT_PLATFORMS.map((platform) => (
                  <th key={platform} className="px-3 py-2 font-medium">
                    {AGENT_PLATFORM_LABELS[platform]}
                  </th>
                ))}
                {signInPlatforms.map((platform) => (
                  <th key={platform} className="px-3 py-2 font-medium">
                    {AGENT_PLATFORM_LABELS[platform]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((machine) => (
                <tr
                  key={machine.nodeId}
                  data-testid="machine-agent-accounts-row"
                  className="border-b border-zinc-800/60 last:border-0"
                >
                  <td className="px-3 py-2.5 align-middle">
                    <span className="flex items-center gap-2">
                      <MachineStatusDot
                        colorToken={machine.colorToken}
                        connected={machine.state === "ok"}
                        label={machine.name}
                        decorative
                      />
                      <span className="truncate text-zinc-100">{machine.name}</span>
                    </span>
                  </td>
                  {AGENT_ACCOUNT_PLATFORMS.map((platform) => (
                    <td key={platform} className="px-3 py-2.5 align-middle">
                      <AccountCell
                        machine={machine}
                        platform={platform}
                        busy={
                          busy === `${machine.nodeId}:${platform}` ||
                          busy === `preferred:${platform}`
                        }
                        {...(single || !preferred[platform]
                          ? {}
                          : { preferredEmail: preferred[platform] })}
                        onChoose={(accountId) => void choose(machine, platform, accountId)}
                        {...(onManage ? { onManage } : {})}
                      />
                    </td>
                  ))}
                  {signInPlatforms.map((platform) => (
                    <td key={platform} className="px-3 py-2.5 align-middle">
                      <SignInCell
                        machine={machine}
                        platform={platform}
                        busy={busy === `${machine.nodeId}:${platform}`}
                        onSignIn={() => void signIn(machine, platform)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </MachineSection>
  );
}
