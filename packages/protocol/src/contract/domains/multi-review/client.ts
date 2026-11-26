/**
 * The `multi-review` domain client (plan item 7007; §11.2 "Client
 * adapters"): one function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (a restart's `model` is critical) and
 *   decodes the results with the schemas in `./schemas.ts`.
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
import { commandApi, type CommandApi } from "../command-api.js";
import { MULTI_REVIEW_COMMANDS } from "./commands.js";
import { multiReviewDomain } from "./domain.js";

export type MultiReviewApi = CommandApi<typeof MULTI_REVIEW_COMMANDS>;

const multiReviewApi = (call: CommandCall): MultiReviewApi =>
  commandApi(call, MULTI_REVIEW_COMMANDS);

export const multiReviewClient = domainClient(multiReviewDomain, {
  1: multiReviewApi,
});
