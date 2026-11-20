/**
 * The `rich-interactions` domain client: one function per command.
 *
 * - Version 1 sends the envelope (`expectedRevision` and `idempotencyKey` on
 *   submissions are critical).
 * - Version 0 is a backend that predates the domain: its commands do not
 *   exist, so the renderer checks the advertised domain before showing rich
 *   interaction controls and shows the plain-text fallback otherwise.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { RICH_INTERACTIONS_COMMANDS } from "./commands.js";
import { richInteractionsDomain } from "./domain.js";

export type RichInteractionsApi = CommandApi<typeof RICH_INTERACTIONS_COMMANDS>;

const richInteractionsApi = (call: CommandCall): RichInteractionsApi =>
  commandApi(call, RICH_INTERACTIONS_COMMANDS);
const legacyRichInteractionsApi = (
  _call: CommandCall,
  context: DomainAdapterContext,
): RichInteractionsApi => legacyCommandApi(context, RICH_INTERACTIONS_COMMANDS);

export const richInteractionsClient = domainClient(richInteractionsDomain, {
  1: richInteractionsApi,
  0: legacyRichInteractionsApi,
});
