/**
 * Keeping the fleet current in the UI (plan item 5006, report §11.6): a
 * machine whose version differs from the command node's says so in its
 * sidebar header, with the contract domains it lacks, and a typed
 * incompatibility error from a machine leads to that machine's update.
 */
import { machineCurrency, type MachineCurrency } from "@orkestrator/protocol/fleet-currency";
import { describeIncompatibility } from "@/lib/describe-incompatibility";
import type { MachineView } from "@/lib/federation/aggregate";
import type { PortalState } from "@/lib/portal/portal-store";
import { requestMachineUpdate } from "@/lib/settings-navigation";

/** Domains listed before the rest are counted. */
const MAX_LISTED_DOMAINS = 3;

/** How `machine` relates to the command node, or `null` when nothing is to be shown. */
export function machineViewCurrency(
  machine: Pick<MachineView, "release">,
  portalState: Pick<PortalState, "commandRelease">,
): MachineCurrency | null {
  if (!machine.release || !portalState.commandRelease) return null;
  return machineCurrency(machine.release, portalState.commandRelease);
}

/** "lacks git, terminals", "predates contracts", or null when it lacks nothing. */
export function currencyLacksText(currency: MachineCurrency): string | null {
  if (currency.preContract) return "predates contracts";
  if (currency.lacks.length === 0) return null;
  const listed = currency.lacks.slice(0, MAX_LISTED_DOMAINS);
  const more = currency.lacks.length - listed.length;
  return `lacks ${listed.join(", ")}${more > 0 ? ` +${more}` : ""}`;
}

/** The header's full description, for its tooltip and accessible name. */
export function currencyDescription(machineName: string, currency: MachineCurrency): string {
  const relation =
    currency.relation === "older"
      ? "older than"
      : currency.relation === "newer"
        ? "newer than"
        : "not the same as";
  const parts = [
    `${machineName} runs Orkestrator ${currency.version}, ${relation} the command node's ${currency.commandVersion}.`,
  ];
  if (currency.preContract) parts.push("It predates domain contracts.");
  if (currency.lacks.length > 0) parts.push(`It lacks ${currency.lacks.join(", ")}.`);
  return parts.join(" ");
}

/** Whether the header offers the machine's update: only when it is behind. */
export function currencyOffersUpdate(currency: MachineCurrency): boolean {
  return currency.relation !== "newer";
}

/** The machine a failed call went to, with what the UI needs to lead to its update. */
export interface UpdatableMachine {
  /** Its node identity; `null` when unknown (then no update is offered). */
  readonly nodeId: string | null;
  readonly label: string;
  readonly version?: string | null;
}

export interface IncompatibilityNotice {
  /** "Not available on <machine> (version x). Update it." */
  readonly text: string;
  /** Opens that machine's update; absent when the machine is unknown. */
  readonly update?: { readonly label: string; readonly onClick: () => void };
}

/**
 * The typed incompatibility error's message (`describeIncompatibility`) and
 * the action that updates the machine it came from. `null` when `error` is
 * not an incompatibility.
 */
export function incompatibilityNotice(
  error: unknown,
  machine: UpdatableMachine,
  command?: string,
): IncompatibilityNotice | null {
  const text = describeIncompatibility(error, machine, command);
  if (!text) return null;
  const nodeId = machine.nodeId;
  return {
    text,
    ...(nodeId ? { update: { label: "Update", onClick: () => requestMachineUpdate(nodeId) } } : {}),
  };
}

/** {@link UpdatableMachine} of a sidebar machine. */
export function updatableMachine(
  machine: Pick<MachineView, "name" | "backendId" | "release">,
): UpdatableMachine {
  return {
    nodeId: machine.backendId,
    label: machine.name,
    version: machine.release?.version ?? null,
  };
}
