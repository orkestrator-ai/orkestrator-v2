/**
 * Which machine the Settings sign-in sections act on.
 *
 * Every machine keeps its own agent logins, and Settings belongs to the
 * command node. Without a choice the sections would always show the command
 * node's logins, even while the window shows another machine's environment.
 * The picker defaults to the machine on screen; `null` is the command node
 * itself, reached through the portal transport.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { create } from "zustand";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MachineStatusDot } from "@/components/settings/machines/machine-ui";
import { useFederation } from "@/components/federation/FederationProvider";
import { useMachineViews } from "@/components/federation/useMachineViews";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";

interface AccountMachineState {
  /** A node chosen for this Settings visit; `undefined` follows the machine on screen. */
  chosen: string | null | undefined;
  choose: (nodeId: string | null | undefined) => void;
}

export const useAccountMachineStore = create<AccountMachineState>()((set) => ({
  chosen: undefined,
  choose: (chosen) => set({ chosen }),
}));

export interface AccountMachineValue {
  /** `null` is the command node; `undefined` follows the current view outside Settings. */
  machine: string | null | undefined;
  /** The machine's name, when this client can show more than one machine. */
  name: string | null;
}

const AccountMachineContext = createContext<AccountMachineValue>({
  machine: undefined,
  name: null,
});

/** Point the sign-in sections inside at one machine without the picker. */
export const AccountMachineProvider = AccountMachineContext.Provider;

export function useAccountMachine(): AccountMachineValue {
  return useContext(AccountMachineContext);
}

/** The machine the sign-in sections act on, resolved against the machines the portal knows. */
export function useResolvedAccountMachine(): AccountMachineValue & {
  options: { nodeId: string | null; name: string; colorToken: string; connected: boolean }[];
} {
  const { enabled, portalState } = useFederation();
  const machines = useMachineViews();
  const chosen = useAccountMachineStore((state) => state.chosen);
  const onScreen = useRemoteWorkspaceStore((state) => state.active?.nodeId ?? null);
  return useMemo(() => {
    const selfId = portalState.selfId;
    const options = machines.map((machine) => ({
      nodeId: machine.backendId === selfId ? null : machine.backendId,
      name: machine.name,
      colorToken: machine.colorToken,
      connected: machine.transport === "connected",
    }));
    if (!enabled || options.length < 2) return { machine: null, name: null, options: [] };
    const wanted = chosen !== undefined ? chosen : onScreen === selfId ? null : onScreen;
    const selected =
      options.find((option) => option.nodeId === wanted) ?? options.find((o) => !o.nodeId);
    return {
      machine: selected?.nodeId ?? null,
      name: selected?.name ?? null,
      options,
    };
  }, [chosen, enabled, machines, onScreen, portalState.selfId]);
}

const SELF_VALUE = "__command-node__";

/**
 * The machine picker above the sign-in sections, and the machine they use.
 * Renders only the children when this client shows a single machine.
 */
export function AccountMachineScope({ children }: { children: ReactNode }) {
  const { machine, name, options } = useResolvedAccountMachine();
  const choose = useAccountMachineStore((state) => state.choose);
  const value = useMemo(() => ({ machine, name }), [machine, name]);
  return (
    <AccountMachineContext.Provider value={value}>
      {options.length > 1 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Sign-ins on</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each machine keeps its own logins. Changes below apply to the machine chosen here.
            </p>
          </div>
          <Select
            value={machine ?? SELF_VALUE}
            onValueChange={(next) => choose(next === SELF_VALUE ? null : next)}
          >
            <SelectTrigger aria-label="Machine" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem
                  key={option.nodeId ?? SELF_VALUE}
                  value={option.nodeId ?? SELF_VALUE}
                  disabled={!option.connected}
                >
                  <span className="flex items-center gap-2">
                    <MachineStatusDot
                      colorToken={option.colorToken}
                      connected={option.connected}
                      label={option.name}
                      decorative
                    />
                    {option.name}
                    {option.connected ? "" : " (offline)"}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {name === null || options.length < 2 ? (
        children
      ) : (
        // Remount per machine so no state from another machine's sign-in carries over.
        <div key={machine ?? SELF_VALUE} className="space-y-5">
          {children}
        </div>
      )}
    </AccountMachineContext.Provider>
  );
}
