/**
 * The `node-mail` domain client (plan item 1010; §11.2 "Client adapters",
 * §11.4): what a command node calls on a leaf for coordinator mail and the
 * leaf outbox. Backend to backend: the command node's sender builds one per
 * leaf over its node link (`apps/backend/src/core/nodes/node-domain-clients.ts`).
 *
 * **Version 1** (a node whose hello advertises `node-mail`): every feature
 * that used to be capability-gated (steer, coordinator mail and notices,
 * attachments, returning outbox mail) is part of the domain, so arguments are
 * sent as they are. `steer` (and the other critical keys of
 * `deliver_node_mail`) travel in the envelope's `critical` list, so a node
 * that did not understand one would refuse with a typed `unsupported-field`
 * instead of silently ignoring it.
 *
 * `actionRequests` and `resolveActionRequest` are the command node's own
 * coordinator action requests (the approvals list in the window; plan item
 * 7001's audit on 2026-11-07).
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
import type { AnyCommandDef, ArgsOf, ResultOf } from "../../command.js";
import {
  ackNodeOutboxCommand,
  collectNodeOutboxCommand,
  deliverNodeMailCommand,
  getNodeProjectCoordinatorCommand,
  listNodeActionRequestsCommand,
  prepareNodeMailAttachmentsCommand,
  resolveNodeActionRequestCommand,
  returnNodeOutboxMailCommand,
} from "./commands.js";
import { nodeMailDomain } from "./domain.js";

type Call<C extends AnyCommandDef> = (args: ArgsOf<C>) => Promise<ResultOf<C>>;

export interface NodeMailApi {
  deliver: Call<typeof deliverNodeMailCommand>;
  projectCoordinator: Call<typeof getNodeProjectCoordinatorCommand>;
  collectOutbox: Call<typeof collectNodeOutboxCommand>;
  ackOutbox: Call<typeof ackNodeOutboxCommand>;
  returnOutboxMail: Call<typeof returnNodeOutboxMailCommand>;
  /** Which of a batch's images the node still needs. */
  prepareAttachments: Call<typeof prepareNodeMailAttachmentsCommand>;
  /** The command node's coordinator action requests (the window's approvals). */
  actionRequests: Call<typeof listNodeActionRequestsCommand>;
  /** Approve or reject one of them. */
  resolveActionRequest: Call<typeof resolveNodeActionRequestCommand>;
}

function currentApi(call: CommandCall): NodeMailApi {
  return {
    deliver: (args) => call(deliverNodeMailCommand, args),
    projectCoordinator: (args) => call(getNodeProjectCoordinatorCommand, args),
    collectOutbox: (args) => call(collectNodeOutboxCommand, args),
    ackOutbox: (args) => call(ackNodeOutboxCommand, args),
    returnOutboxMail: (args) => call(returnNodeOutboxMailCommand, args),
    prepareAttachments: (args) => call(prepareNodeMailAttachmentsCommand, args),
    actionRequests: (args) => call(listNodeActionRequestsCommand, args),
    resolveActionRequest: (args) => call(resolveNodeActionRequestCommand, args),
  };
}

export const nodeMailClient = domainClient(nodeMailDomain, {
  1: (call) => currentApi(call),
});
