/**
 * Linear sync between a command node and its leaf (docs/architecture/tickets.md,
 * "Linear"). Leaf side, called by an attached command node over its link only
 * (never routable through a portal, workspace grant or relay; see
 * `node-routing.ts`):
 *
 * - `get_linear_sync_state`: the leaf's board links, disconnects and whether
 *   it holds a key (its fingerprint and who it signs in as, never the key).
 * - `apply_linear_sync_state`: the command node's merged links and
 *   disconnects; the leaf keeps whichever side changed each link last.
 * - `export_linear_connection`: the leaf's key, for the one user-initiated
 *   copy `copy_linear_connection_from_node` makes. The only command that
 *   returns a credential to another machine; see command-nodes.md, "Settings".
 *
 * An older leaf answers `unknown-command` and keeps its own links.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { mutableArray } from "../../model-schema.js";
import { LinearBoardLinkSchema, LinearRevocationSchema } from "../kanban/schemas.js";
import { ticketSyncDomain } from "./domain.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

export const getLinearSyncStateCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "get_linear_sync_state",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({ controllerId: optionalUnknown }),
  result: Schema.Struct({
    links: Schema.optionalKey(mutableArray(LinearBoardLinkSchema)),
    revocations: Schema.optionalKey(mutableArray(LinearRevocationSchema)),
    connection: Schema.optionalKey(
      Schema.Struct({
        connected: Schema.Boolean,
        keyFingerprint: Schema.optionalKey(Schema.String),
        viewerName: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
  critical: [],
});

export const applyLinearSyncStateCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "apply_linear_sync_state",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({
    controllerId: optionalUnknown,
    links: optionalUnknown,
    revocations: optionalUnknown,
  }),
  result: Schema.Struct({
    applied: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    cleared: Schema.optionalKey(Schema.Boolean),
  }),
  critical: [],
});

export const exportLinearConnectionCommand = defineCommand({
  domain: ticketSyncDomain,
  name: "export_linear_connection",
  since: 1,
  access: "internal",
  // Classified as a write, like every command the routing classifier does not
  // name as a read; it is link-only either way.
  read: false,
  args: Schema.Struct({ controllerId: optionalUnknown }),
  result: Schema.Struct({ apiKey: Schema.optionalKey(Schema.String) }),
  critical: [],
});

export const LINEAR_SYNC_COMMANDS = [
  getLinearSyncStateCommand,
  applyLinearSyncStateCommand,
  exportLinearConnectionCommand,
] as const;
