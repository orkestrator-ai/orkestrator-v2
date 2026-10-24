/**
 * Which Claude and Codex account each machine's agents use.
 *
 * Every machine keeps its own logins; nothing here moves a credential. The
 * command node collects each machine's accounts (`list_machine_agent_accounts`)
 * and a choice is sent to that machine alone. Adding, renaming or signing an
 * account in happens in the platform's own section, opened on that machine.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listMachineAgentAccounts, setActiveAgentAccount } from "@/lib/backend";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useAccountMachineStore } from "@/components/settings/account-machine";
import {
  AGENT_ACCOUNT_PLATFORMS,
  type AgentAccountPlatform,
  type AgentAccountSummary,
  type MachineAgentAccounts,
} from "@orkestrator/protocol/agent-accounts";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import { MachineSection, MachineStatusDot } from "./machine-ui";

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

function AccountCell({
  machine,
  platform,
  busy,
  onChoose,
  onManage,
}: {
  machine: MachineAgentAccounts;
  platform: AgentAccountPlatform;
  busy: boolean;
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
  return (
    <div className="flex items-center gap-1.5">
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
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs text-zinc-400"
        onClick={() => {
          useAccountMachineStore.getState().choose(machineTarget(machine));
          onManage?.();
          requestGlobalSettings(platform);
        }}
      >
        Manage
      </Button>
    </div>
  );
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
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await listMachineAgentAccounts();
      if (!mounted.current) return;
      setMachines(Array.isArray(result?.machines) ? result.machines : []);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (
    machine: MachineAgentAccounts,
    platform: AgentAccountPlatform,
    accountId: string,
  ) => {
    const key = `${machine.nodeId}:${platform}`;
    setBusy(key);
    setError(null);
    try {
      const snapshot = await setActiveAgentAccount(platform, accountId, machineTarget(machine));
      if (!mounted.current) return;
      setMachines((current) =>
        (current ?? []).map((entry) =>
          entry.nodeId === machine.nodeId ? { ...entry, snapshot } : entry,
        ),
      );
    } catch (cause) {
      if (mounted.current) setError(`${machine.name}: ${messageOf(cause)}`);
      void load();
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const shown = (machines ?? []).filter((machine) =>
    selfOnly ? machine.self : nodeId ? machine.nodeId === nodeId : true,
  );

  return (
    <MachineSection
      title="Agent accounts"
      description={
        nodeId || selfOnly
          ? "The Claude and Codex accounts this machine's agents use. Each machine keeps its own logins."
          : "The Claude and Codex accounts each machine's agents use. Each machine keeps its own logins; a change applies to that machine's agents the next time they start work while idle."
      }
      testId="machine-agent-accounts"
      action={
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
      {shown.length > 0 ? (
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
                        busy={busy === `${machine.nodeId}:${platform}`}
                        onChoose={(accountId) => void choose(machine, platform, accountId)}
                        {...(onManage ? { onManage } : {})}
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
