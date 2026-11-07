/**
 * The `multi-review` domain client (plan item 7007; §11.2 "Client
 * adapters"): one function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (a restart's `model` is critical) and
 *   decodes the results with the schemas in `./schemas.ts`.
 * - Version 0 (a pre-contract node) is today's untyped call, answered as
 *   sent (`legacyCommandApi`). No Multi Review command was capability-gated.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `multi-review` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { MULTI_REVIEW_COMMANDS } from "./commands.js";
import { multiReviewDomain } from "./domain.js";

export type MultiReviewApi = CommandApi<typeof MULTI_REVIEW_COMMANDS>;

const multiReviewApi = (call: CommandCall): MultiReviewApi =>
  commandApi(call, MULTI_REVIEW_COMMANDS);
const legacyMultiReviewApi = (_call: CommandCall, context: DomainAdapterContext): MultiReviewApi =>
  legacyCommandApi(context, MULTI_REVIEW_COMMANDS);

export const multiReviewClient = domainClient(multiReviewDomain, {
  1: multiReviewApi,
  0: legacyMultiReviewApi,
});
