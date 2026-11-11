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
 *   which is what such a leaf would answer. With it, each call carries only
 *   the keys the pre-contract handler accepted: those handlers were strict
 *   (`assertOnlyKeys`), so `collect_ticket_sync_outbox` goes without
 *   `features`, which came with image sync. Such a leaf queues no image
 *   change, so it loses nothing by not hearing the command node's features.
 *
 * `status` is the command node's own board read (`get_ticket_sync_status`,
 * the Kanban sync strip, plan item 7001's audit on 2026-11-07). It is not
 * gated on `syncs`: a renderer's client often carries no capabilities, and a
 * backend that predates it answers `unknown-command` itself. At version 0 it
 * is today's untyped call, answered as sent. The board's other calls
 * (`leafStatus`, `share`, `dismissConflicts`, #2027) are the same.
 * `readImage` and `putImage` are the image calls between machines, gated
 * like the rest of the sync.
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
  /** Whether the node syncs tickets: `false` only for a pre-contract leaf without `ticket-sync`. */
  readonly syncs: boolean;
  collectOutbox: Call<typeof collectTicketSyncOutboxCommand>;
  ackOutbox: Call<typeof ackTicketSyncOutboxCommand>;
  cursor: Call<typeof getTicketSyncCursorCommand>;
  apply: Call<typeof applyTicketSyncCommand>;
  readImage: Call<typeof readTicketImageCommand>;
  putImage: Call<typeof putTicketImageCommand>;
  /** The command node's per-leaf sync state for one project's board; never gated. */
  status: Call<typeof getTicketSyncStatusCommand>;
  /** A leaf board's view of its command nodes; never gated. */
  leafStatus: Call<typeof getTicketSyncLeafStatusCommand>;
  /** Leaf: share tickets made before sync with the command node; never gated. */
  share: Call<typeof shareTicketsWithCommandNodeCommand>;
  /** Command node: dismiss conflicts from a board's list; never gated. */
  dismissConflicts: Call<typeof dismissTicketSyncConflictsCommand>;
}

type BoardCalls = Pick<TicketSyncApi, "status" | "leafStatus" | "share" | "dismissConflicts">;

function api(
  call: CommandCall,
  syncs: boolean,
  board: BoardCalls = {
    status: (args) => call(getTicketSyncStatusCommand, args),
    leafStatus: (args) => call(getTicketSyncLeafStatusCommand, args),
    share: (args) => call(shareTicketsWithCommandNodeCommand, args),
    dismissConflicts: (args) => call(dismissTicketSyncConflictsCommand, args),
  },
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
    readImage: run(readTicketImageCommand),
    putImage: run(putTicketImageCommand),
    ...board,
  };
}

/**
 * The keys `collect_ticket_sync_outbox` accepted before the contract
 * (2026-11-07); a pre-contract leaf refuses any other key.
 */
const PRE_CONTRACT_COLLECT_KEYS = ["controllerId", "after"] as const;

/** `args` with only the keys a pre-contract handler accepted. */
function onlyKeys<T extends object>(args: T, keys: readonly string[]): T {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (keys.includes(key)) kept[key] = value;
  }
  return kept as T;
}

/** Version 0: today's capability gating, and calls a pre-contract handler accepts. */
function legacyApi(call: CommandCall, context: DomainAdapterContext): TicketSyncApi {
  const legacy = api(call, context.capabilities?.has(BACKEND_CAPABILITIES.ticketSync) ?? false, {
    status: untyped(context, getTicketSyncStatusCommand),
    leafStatus: untyped(context, getTicketSyncLeafStatusCommand),
    share: untyped(context, shareTicketsWithCommandNodeCommand),
    dismissConflicts: untyped(context, dismissTicketSyncConflictsCommand),
  });
  return {
    ...legacy,
    collectOutbox: (args) => legacy.collectOutbox(onlyKeys(args, PRE_CONTRACT_COLLECT_KEYS)),
  };
}

/** A board call at version 0: today's untyped call, answered as sent. */
function untyped<C extends AnyCommandDef>(context: DomainAdapterContext, def: C): Call<C> {
  return (args) =>
    context.invoke(def.name, args as Readonly<Record<string, unknown>>) as Promise<ResultOf<C>>;
}

export const ticketSyncClient = domainClient(ticketSyncDomain, {
  1: (call) => api(call, true),
  0: legacyApi,
});
