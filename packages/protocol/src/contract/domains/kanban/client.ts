/**
 * The `kanban` domain client (plan item 7008; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 2 sends the envelope (`requestId`, `markdown`/`sections`,
 *   `projectId` and `operationId` are critical where the definitions say) and
 *   decodes the result with the command's schema.
 *
 * Kanban ticket ids are the same on every node, so a caller keeps results
 * under the node it asked (one client per node scope).
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26). A domains map
 * that omits this domain yields `unsupported-version`. Without a domains
 * map, calls use the lowest adapter unnegotiated. Later bumps keep an
 * adapter for every version a release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall } from "../../client.js";
import { commandApi, type CommandApi } from "../command-api.js";
import { KANBAN_COMMANDS } from "./commands.js";
import { kanbanDomain } from "./domain.js";

export type KanbanApi = CommandApi<typeof KANBAN_COMMANDS>;

const kanbanApi = (call: CommandCall): KanbanApi => commandApi(call, KANBAN_COMMANDS);

export const kanbanClient = domainClient(kanbanDomain, {
  2: kanbanApi,
});
