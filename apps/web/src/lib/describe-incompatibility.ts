import { incompatibility } from "@orkestrator/protocol/contract/errors";

/** The machine a failed call went to, as the UI names it. */
export type IncompatibleMachine =
  string | { readonly label: string; readonly version?: string | null };

/**
 * The one UI text for "this machine cannot serve that call because of its
 * version" (docs/reports/unified-federation.md §11.2, plan item 1005):
 * "Not available on <machine> (version x). Update it." The version is the
 * machine's Orkestrator version, shown when the caller knows it.
 *
 * Returns `null` when `error` is not an incompatibility, so the caller shows
 * its own message. `command` lets a pre-contract machine's legacy answer
 * count, and ignores an incompatibility that names another command.
 */
export function describeIncompatibility(
  error: unknown,
  machine: IncompatibleMachine,
  command?: string,
): string | null {
  if (!incompatibility(error, command)) return null;
  const label = (typeof machine === "string" ? machine : machine.label).trim() || "this machine";
  const version = typeof machine === "string" ? null : machine.version?.trim() || null;
  return `Not available on ${label}${version ? ` (version ${version})` : ""}. Update it.`;
}
