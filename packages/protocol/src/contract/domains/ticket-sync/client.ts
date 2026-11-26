/**
 * The `ticket-sync` domain client (plan item 1010; §11.2 "Client adapters",
 * §11.4): what a command node calls on a leaf to sync a board. Backend to
 * backend, built per leaf over the node link
 * (`apps/backend/src/core/nodes/node-domain-clients.ts`).
 *
 * **Version 1** (a node whose hello advertises `ticket-sync`): the node
 * syncs tickets; `reset`/`liveIds` on `apply_ticket_sync` travel as critical.
 *
 * `status` is the command node's own board read (`get_ticket_sync_status`,
 * the Kanban sync strip, plan item 7001's audit on 2026-11-07); the board's
 * other calls (`leafStatus`, `share`, `dismissConflicts`, #2027) are the
 * same. `readImage` and `putImage` are the image calls between machines.
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
import type { AnyCommandDef, ArgsOf, ResultOf } from "../../command.js";
import {
  ackTicketSyncOutboxCommand,
  applyTicketSyncCommand,
  collectTicketSyncOutboxCommand,
  dismissTicketSyncConflictsCommand,
  getTicketSyncCursorCommand,
  getTicketSyncLeafStatusCommand,
  getTicketSyncStatusCommand,
  putTicketImageCommand,
  readTicketImageCommand,
  shareTicketsWithCommandNodeCommand,
} from "./commands.js";
import { ticketSyncDomain } from "./domain.js";

type Call<C extends AnyCommandDef> = (args: ArgsOf<C>) => Promise<ResultOf<C>>;

export interface TicketSyncApi {
  collectOutbox: Call<typeof collectTicketSyncOutboxCommand>;
  ackOutbox: Call<typeof ackTicketSyncOutboxCommand>;
  cursor: Call<typeof getTicketSyncCursorCommand>;
  apply: Call<typeof applyTicketSyncCommand>;
  readImage: Call<typeof readTicketImageCommand>;
  putImage: Call<typeof putTicketImageCommand>;
  /** The command node's per-leaf sync state for one project's board. */
  status: Call<typeof getTicketSyncStatusCommand>;
  /** A leaf board's view of its command nodes. */
  leafStatus: Call<typeof getTicketSyncLeafStatusCommand>;
  /** Leaf: share tickets made before sync with the command node. */
  share: Call<typeof shareTicketsWithCommandNodeCommand>;
  /** Command node: dismiss conflicts from a board's list. */
  dismissConflicts: Call<typeof dismissTicketSyncConflictsCommand>;
}

function api(call: CommandCall): TicketSyncApi {
  return {
    collectOutbox: (args) => call(collectTicketSyncOutboxCommand, args),
    ackOutbox: (args) => call(ackTicketSyncOutboxCommand, args),
    cursor: (args) => call(getTicketSyncCursorCommand, args),
    apply: (args) => call(applyTicketSyncCommand, args),
    readImage: (args) => call(readTicketImageCommand, args),
    putImage: (args) => call(putTicketImageCommand, args),
    status: (args) => call(getTicketSyncStatusCommand, args),
    leafStatus: (args) => call(getTicketSyncLeafStatusCommand, args),
    share: (args) => call(shareTicketsWithCommandNodeCommand, args),
    dismissConflicts: (args) => call(dismissTicketSyncConflictsCommand, args),
  };
}

export const ticketSyncClient = domainClient(ticketSyncDomain, {
  1: api,
});
