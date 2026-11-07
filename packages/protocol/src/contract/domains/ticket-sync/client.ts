/**
 * The `ticket-sync` domain client (plan item 1010; §11.2 "Client adapters",
 * §11.4): what a command node calls on a leaf to sync a board. Backend to
 * backend, built per leaf over the node link
 * (`apps/backend/src/core/nodes/node-domain-clients.ts`).
 *
 * - **Version 1** (a node whose hello advertises `ticket-sync`): the node
 *   syncs tickets; `reset`/`liveIds` on `apply_ticket_sync` travel as critical.
 * - **Version 0** (a pre-contract node): today's gating on the hello's
 *   `ticket-sync` capability. Without it, `syncs` is `false` (the board says
 *   "update that machine") and every call is refused with `unknown-command`,
 *   which is what such a leaf would answer.
 *
 * `status` is the command node's own board read (`get_ticket_sync_status`,
 * the Kanban sync strip, plan item 7001's audit on 2026-11-07). It is not
 * gated on `syncs`: a renderer's client often carries no capabilities, and a
 * backend that predates it answers `unknown-command` itself. At version 0 it
 * is today's untyped call, answered as sent.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `ticket-sync` domain.
 *
 * Browser-safe.
 */
import { BACKEND_CAPABILITIES } from "../../../backend-profile.js";
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "../../command.js";
import { unknownCommand } from "../../errors.js";
import {
  ackTicketSyncOutboxCommand,
  applyTicketSyncCommand,
  collectTicketSyncOutboxCommand,
  getTicketSyncCursorCommand,
  getTicketSyncStatusCommand,
} from "./commands.js";
import { ticketSyncDomain } from "./domain.js";

type Call<C extends AnyCommandDef> = (args: ArgsOf<C>) => Promise<ResultOf<C>>;

export interface TicketSyncApi {
  /** Whether the node syncs tickets: `false` only for a pre-contract leaf without `ticket-sync`. */
  readonly syncs: boolean;
  collectOutbox: Call<typeof collectTicketSyncOutboxCommand>;
  ackOutbox: Call<typeof ackTicketSyncOutboxCommand>;
  cursor: Call<typeof getTicketSyncCursorCommand>;
  apply: Call<typeof applyTicketSyncCommand>;
  /** The command node's per-leaf sync state for one project's board; never gated. */
  status: Call<typeof getTicketSyncStatusCommand>;
}

function api(
  call: CommandCall,
  syncs: boolean,
  status: TicketSyncApi["status"] = (args) => call(getTicketSyncStatusCommand, args),
): TicketSyncApi {
  const run =
    <C extends AnyCommandDef>(def: C): Call<C> =>
    async (args) => {
      if (!syncs) throw unknownCommand(def.name, ticketSyncDomain.name);
      return call(def, args);
    };
  return {
    syncs,
    collectOutbox: run(collectTicketSyncOutboxCommand),
    ackOutbox: run(ackTicketSyncOutboxCommand),
    cursor: run(getTicketSyncCursorCommand),
    apply: run(applyTicketSyncCommand),
    status,
  };
}

export const ticketSyncClient = domainClient(ticketSyncDomain, {
  1: (call) => api(call, true),
  0: (call, context: DomainAdapterContext) =>
    api(
      call,
      context.capabilities?.has(BACKEND_CAPABILITIES.ticketSync) ?? false,
      (args) =>
        context.invoke(getTicketSyncStatusCommand.name, args) as ReturnType<
          TicketSyncApi["status"]
        >,
    ),
});
