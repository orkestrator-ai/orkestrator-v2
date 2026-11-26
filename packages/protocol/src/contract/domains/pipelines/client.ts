/**
 * The `pipelines` domain client (plan item 7007; §11.2 "Client adapters"):
 * one function per command (`commandApi`), keyed by command name.
 *
 * - Version 2 sends the envelope (`existingEnvironmentId` and
 *   `deliveryPolicy` on the launches, `requestId` on a feature build, a
 *   restart's `selection` and the unread badge's `expectedLastActivityAt` are
 *   critical) and decodes the results with the schemas in `./schemas.ts`.
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
import { PIPELINES_COMMANDS } from "./commands.js";
import { pipelinesDomain } from "./domain.js";

export type PipelinesApi = CommandApi<typeof PIPELINES_COMMANDS>;

const pipelinesApi = (call: CommandCall): PipelinesApi => commandApi(call, PIPELINES_COMMANDS);

export const pipelinesClient = domainClient(pipelinesDomain, {
  2: pipelinesApi,
});
