/**
 * The `coordinator` domain client (plan item 7009; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope and decodes results with the commands'
 *   schemas.
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
import { COORDINATOR_COMMANDS } from "./commands.js";
import { coordinatorDomain } from "./domain.js";

export type CoordinatorApi = CommandApi<typeof COORDINATOR_COMMANDS>;

const coordinatorApi = (call: CommandCall): CoordinatorApi =>
  commandApi(call, COORDINATOR_COMMANDS);

export const coordinatorClient = domainClient(coordinatorDomain, {
  1: coordinatorApi,
});
