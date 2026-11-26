/**
 * The `design` domain client (plan item 7004; §11.2 "Client adapters").
 *
 * - **Version 2** (a node that advertises the domain) sends the envelope and
 *   decodes every result with the command's schema. Every build that
 *   advertises the domain has every design capability (`DesignCapabilities`
 *   all `true`, the backend-owned intent queue included), so the capability
 *   flags gate nothing there: `capabilities()` still asks the node, because
 *   its answer also says whether the design service is available, and lays
 *   {@link DESIGN_CONTRACT_CAPABILITIES} over it.
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26), so a node
 * that advertises no range for the domain is refused with
 * `unsupported-version`. Later bumps keep an adapter for every version a
 * release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall } from "../../client.js";
import type { ArgsOf, ResultOf } from "../../command.js";
import type { DesignCapabilities } from "../../../design-operations.js";
import { DESIGN_COMMANDS, designCapabilitiesCommand } from "./commands.js";
import { designDomain } from "./domain.js";

/** Any `design` command definition. */
export type DesignCommandDef = (typeof DESIGN_COMMANDS)[number];

/** What every node speaking the `design` domain supports. */
export const DESIGN_CONTRACT_CAPABILITIES = Object.freeze({
  snapshot: true,
  operations: true,
  sync: true,
  save: true,
  history: true,
  lifecycle: true,
  rendererHealth: true,
  library: true,
  batch: true,
  sessions: true,
  validation: true,
  hierarchyPaging: true,
  intents: true,
} as const satisfies Partial<DesignCapabilities>);

export interface DesignApi {
  /**
   * Runs one design command. A v2 command answers its typed envelope
   * (`{ ok: true, value } | { ok: false, failure }`); a legacy one its value.
   */
  command<C extends DesignCommandDef>(def: C, args: ArgsOf<C>): Promise<ResultOf<C>>;
  /** `design_capabilities`' envelope (see the module comment). */
  capabilities(): Promise<ResultOf<typeof designCapabilitiesCommand>>;
}

function contractApi(call: CommandCall): DesignApi {
  return {
    command: (def, args) => call(def, args),
    capabilities: async () => {
      const answer = await call(designCapabilitiesCommand, {});
      return answer.ok
        ? { ok: true, value: { ...answer.value, ...DESIGN_CONTRACT_CAPABILITIES } }
        : answer;
    },
  };
}

export const designClient = domainClient(designDomain, {
  2: contractApi,
});
