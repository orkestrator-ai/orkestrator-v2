/**
 * The `design` domain client (plan item 7004; §11.2 "Client adapters").
 *
 * - **Version 1** (a node that advertises the domain) sends the envelope and
 *   decodes every result with the command's schema. Every build that
 *   advertises the domain has every design capability (`DesignCapabilities`
 *   all `true`, the backend-owned intent queue included), so the capability
 *   flags gate nothing there: `capabilities()` still asks the node, because
 *   its answer also says whether the design service is available, and lays
 *   {@link DESIGN_CONTRACT_CAPABILITIES} over it.
 * - **Version 0** (a pre-contract node, every release in the support window
 *   today) is today's path: the command by name, without an envelope, its
 *   answer undecoded, so an older backend's older shapes are never refused.
 *   Callers keep today's gating on the answer of `design_capabilities`
 *   (which every release since the v2.21.0 floor serves; Appendix F). It is
 *   read through `invoke`, not `capability()`, because a `{ ok: false }`
 *   answer (the service is unavailable) must not be kept for the generation.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `design` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
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

function legacyApi(_call: CommandCall, context: DomainAdapterContext): DesignApi {
  const command = <C extends DesignCommandDef>(def: C, args: ArgsOf<C>) =>
    context.invoke(def.name, args as Readonly<Record<string, unknown>>) as Promise<ResultOf<C>>;
  return {
    command,
    capabilities: () => command(designCapabilitiesCommand, {}),
  };
}

export const designClient = domainClient(designDomain, {
  1: contractApi,
  0: legacyApi,
});
