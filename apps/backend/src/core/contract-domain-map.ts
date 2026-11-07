/**
 * The contract domain of every string-registered backend command (plan item
 * 1006, docs/reports/unified-federation.md §11.2 "Domains" and §11.3).
 *
 * A command registered with its definition (`register(def, handler)`) carries
 * its domain in the definition. Every other command needs an entry here:
 * `scripts/generate-contract-manifest.ts` fails when a registered command is
 * in neither place, so a new string-registered command has to pick a domain.
 * It also fails on an entry for a command that is no longer registered, or
 * that is now registered with its definition (remove the entry when a command
 * adopts `defineCommand`), and on a command listed under two domains.
 *
 * Seeded on 2026-11-07 from Appendix E's grouping by registering file, split
 * into the finer `DOMAIN_NAMES` by command name where one file serves several
 * domains (see the Notes of plans/unified/1006-contract-manifest-generator.md).
 * Each list is sorted.
 *
 * Regenerate the manifest after editing: `mise run contract:manifest`.
 */
import type { DomainName } from "@orkestrator/protocol/contract/domain";

export type ContractDomainMap = { readonly [Domain in DomainName]?: readonly string[] };

export const CONTRACT_DOMAIN_MAP = {
  coordinator: [],
  "node-mail": [
    "place_node_mail_attachments",
    "prepare_node_mail_attachments",
    "send_coordinator_command_node_mail",
  ],
  "public-api": ["public_action"],
  "ticket-sync": ["coordinator_node_ticket"],
} as const satisfies ContractDomainMap;

/**
 * The map as command name to domain. Throws when a command is listed twice
 * (under one domain or two), so an ambiguous entry never picks a domain
 * silently.
 */
export function contractDomainsByCommand(
  map: ContractDomainMap = CONTRACT_DOMAIN_MAP,
): ReadonlyMap<string, DomainName> {
  const byCommand = new Map<string, DomainName>();
  for (const [domain, commands] of Object.entries(map) as [DomainName, readonly string[]][]) {
    for (const command of commands) {
      const known = byCommand.get(command);
      if (known !== undefined) {
        throw new Error(
          known === domain
            ? `Command ${command} is listed twice under contract domain ${domain}.`
            : `Command ${command} is listed under contract domains ${known} and ${domain}.`,
        );
      }
      byCommand.set(command, domain);
    }
  }
  return byCommand;
}
