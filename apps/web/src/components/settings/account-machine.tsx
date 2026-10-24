/**
 * Which machine Settings acts on.
 *
 * Every machine keeps its own settings, agent logins and tools, and the
 * Settings window belongs to the command node. Its header lists the machines
 * (`SettingsMachineStrip`); the choice defaults to the machine on screen.
 * `null` is the command node itself, reached through the portal transport;
 * another machine is reached through it (`invoke_on_node`).
 */
import { createContext, useContext, useMemo } from "react";
import { create } from "zustand";
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

/** Point the settings sections inside at one machine. */
export const AccountMachineProvider = AccountMachineContext.Provider;

export function useAccountMachine(): AccountMachineValue {
  return useContext(AccountMachineContext);
}

/** Whether `machine` is this window's own backend rather than another machine. */
export function isWindowMachine(machine: string | null | undefined): boolean {
  return machine === null || machine === undefined;
}

export interface AccountMachineOption {
  /** `null` is the command node. */
  nodeId: string | null;
  name: string;
  colorToken: string;
  connected: boolean;
}

/** The machine Settings acts on, resolved against the machines the portal knows. */
export function useResolvedAccountMachine(): {
  /** `null` is the command node. */
  machine: string | null;
  name: string | null;
  /** Every machine, the command node first; empty while there is only one. */
  options: AccountMachineOption[];
} {
  const { enabled, portalState } = useFederation();
  const machines = useMachineViews();
  const chosen = useAccountMachineStore((state) => state.chosen);
  const onScreen = useRemoteWorkspaceStore((state) => state.active?.nodeId ?? null);
  return useMemo(() => {
    const selfId = portalState.selfId;
    const options: AccountMachineOption[] = machines.map((machine) => ({
      nodeId: machine.backendId === selfId ? null : machine.backendId,
      name: machine.name,
      colorToken: machine.colorToken,
      connected: machine.transport === "connected",
    }));
    // The command node leads; the others keep the sidebar's order.
    options.sort((a, b) => Number(a.nodeId !== null) - Number(b.nodeId !== null));
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
