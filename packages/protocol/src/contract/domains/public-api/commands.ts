/**
 * `public-api` commands (plan item 7009; docs/architecture/public-cli.md):
 * `public_action`, the single public entrypoint.
 *
 * The handler was lenient before it was defined and stays so: every wrapper
 * key it reads is `optionalKey(Unknown)`, so a wrapper it answered with a
 * structured envelope (`backend-incompatible`, `unsupported`, `invalid-input`)
 * is still answered with the same envelope, never refused by the decode. The
 * input of each action is checked by that action's own parser. Admission,
 * request keys and receipts are the dispatcher's and are unchanged.
 *
 * Browser-safe. Nothing in `packages/cli` imports this module: the CLI calls
 * `public_action` by name (`PUBLIC_ACTION_COMMAND`), which a defined command
 * still answers, so `dist/client.js` does not take the contract schemas.
 */
import * as Schema from "effect/Schema";
import type { PublicActionResponse } from "../../../public-api.js";
import { defineCommand } from "../../command.js";
import { variantRecord } from "../../model-schema.js";
import { publicApiDomain } from "./domain.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/**
 * A `PublicActionResponse`: the success or error envelope. The fields every
 * envelope has are checked; `result`, `error`, `receipt`, `backend`, `node`
 * and `warnings` pass through as the dispatcher wrote them
 * (`isPublicActionResponse` is the client's structural check).
 */
export const PublicActionResponseSchema = variantRecord<PublicActionResponse>()({
  schemaVersion: Schema.Finite,
  action: Schema.String,
  ok: Schema.Boolean,
});

/** One public action: `{ schemaVersion, action, actionVersion, input, request?, node? }`. */
export const publicActionCommand = defineCommand({
  domain: publicApiDomain,
  name: "public_action",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    schemaVersion: optionalUnknown,
    action: optionalUnknown,
    actionVersion: optionalUnknown,
    input: optionalUnknown,
    /** The request key `{ requestId, namespace? }` every mutation is admitted under. */
    request: optionalUnknown,
    /** Run on this node (`nodeId` from `node.list`, or `all`), routed by this command node. */
    node: optionalUnknown,
    /** A command node routing for one of its Control MCP credentials (node link only). */
    relayedAuthority: optionalUnknown,
  }),
  result: PublicActionResponseSchema,
  // node: ignored, the action runs on the connected node instead of the one named.
  // relayedAuthority: ignored, a credential's relayed action runs as the operator.
  critical: ["node", "relayedAuthority"],
});

/** Every `public-api` command definition. */
export const PUBLIC_API_COMMANDS = [publicActionCommand] as const;
