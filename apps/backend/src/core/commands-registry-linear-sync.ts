import {
  applyLinearSyncStateCommand,
  exportLinearConnectionCommand,
  getLinearSyncStateCommand,
} from "@orkestrator/protocol/contract/domains/ticket-sync";
import { createLogger } from "@orkestrator/protocol/logger";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import { attachedController } from "./commands-registry-ticket-sync.js";
import { applyLinearSyncState, readLinearSyncState } from "./linear-sync-state.js";

const log = createLogger("linear");

/**
 * Linear sync, leaf side (docs/architecture/tickets.md, "Linear"): called by
 * an attached command node over its link only, never through a portal,
 * workspace grant or relay (`node-routing.ts`). The command node reads this
 * machine's board links, disconnects and connection, and applies its merged
 * ones here.
 *
 * `export_linear_connection` hands the key to the command node for the one
 * copy the user asked for there (`copy_linear_connection_from_node`); it is
 * the only command that returns a credential to another machine
 * (command-nodes.md, "Settings"). It is logged without the key.
 */
export function registerLinearSyncCommands(register: CommandRegistrar): void {
  register(
    getLinearSyncStateCommand,
    async (args, context) => {
      attachedController(args, context);
      return readLinearSyncState(context.storage);
    },
    ASYNC_HANDLER,
  );

  register(
    applyLinearSyncStateCommand,
    async (args, context) => {
      attachedController(args, context);
      return applyLinearSyncState(context.storage, args);
    },
    ASYNC_HANDLER,
  );

  register(
    exportLinearConnectionCommand,
    async (args, context) => {
      attachedController(args, context);
      const auth = await context.storage.kanban.getLinearAuth();
      log.info("connection.exported-to-command-node", { hadKey: Boolean(auth?.apiKey) });
      return auth?.apiKey ? { apiKey: auth.apiKey } : {};
    },
    ASYNC_HANDLER,
  );
}
