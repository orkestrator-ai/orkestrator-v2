/**
 * The `node-mail` domain client (plan item 1010; §11.2 "Client adapters",
 * §11.4): what a command node calls on a leaf for coordinator mail and the
 * leaf outbox. Backend to backend: the command node's sender builds one per
 * leaf over its node link (`apps/backend/src/core/nodes/node-domain-clients.ts`).
 *
 * - **Version 1** (a node whose hello advertises `node-mail`): every feature
 *   below is part of the domain, so `supports` answers `true` for all of them
 *   and arguments are sent as they are. `steer` (and the other critical keys of
 *   `deliver_node_mail`) travel in the envelope's `critical` list, so a node
 *   that did not understand one would refuse with a typed `unsupported-field`
 *   instead of silently ignoring it.
 * - **Version 0** (a pre-contract node, §11.4): today's capability gating,
 *   from the hello's `capabilities`. A pre-contract leaf refuses any key it
 *   does not know, so the adapter removes the outbox flags it does not
 *   advertise and `turnOrigin` (an older leaf frames mail as it always did,
 *   so nothing is weakened), and refuses `steer`, `attachments` or a
 *   `return_node_outbox_mail` without their capability with the same typed
 *   errors a contract node would answer, rather than dropping them;
 *   `prepare_node_mail_attachments` without `node-mail-attachments` is
 *   `unknown-command`, which is what such a leaf would answer.
 *
 * `actionRequests` and `resolveActionRequest` are the command node's own
 * coordinator action requests (the approvals list in the window; plan item
 * 7001's audit on 2026-11-07). They are never capability-gated: at version 0
 * they are today's untyped calls, answered as sent.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises `node-mail` (version-compatibility.md, Register).
 *
 * Browser-safe.
 */
import { BACKEND_CAPABILITIES } from "../../../backend-profile.js";
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "../../command.js";
import { unknownCommand, unsupportedField } from "../../errors.js";
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

/**
 * The hello capabilities that gated node mail before the contract. A node
 * that advertises `node-mail` version 1 has all of them.
 */
export const NODE_MAIL_FEATURES = [
  BACKEND_CAPABILITIES.nodeMailSteer,
  BACKEND_CAPABILITIES.nodeMailTurnOrigin,
  BACKEND_CAPABILITIES.nodeCoordinatorMail,
  BACKEND_CAPABILITIES.coordinatorNotices,
  BACKEND_CAPABILITIES.nodeMailAttachments,
  BACKEND_CAPABILITIES.nodeMailReturn,
] as const;

export type NodeMailFeature = (typeof NODE_MAIL_FEATURES)[number];

type Call<C extends AnyCommandDef> = (args: ArgsOf<C>) => Promise<ResultOf<C>>;

export interface NodeMailApi {
  /** Whether the node understands a feature that used to be capability-gated. */
  supports(feature: NodeMailFeature): boolean;
  deliver: Call<typeof deliverNodeMailCommand>;
  projectCoordinator: Call<typeof getNodeProjectCoordinatorCommand>;
  collectOutbox: Call<typeof collectNodeOutboxCommand>;
  ackOutbox: Call<typeof ackNodeOutboxCommand>;
  returnOutboxMail: Call<typeof returnNodeOutboxMailCommand>;
  /** Which of a batch's images the node still needs (`node-mail-attachments` before the contract). */
  prepareAttachments: Call<typeof prepareNodeMailAttachmentsCommand>;
  /** The command node's coordinator action requests (the window's approvals). */
  actionRequests: Call<typeof listNodeActionRequestsCommand>;
  /** Approve or reject one of them. */
  resolveActionRequest: Call<typeof resolveNodeActionRequestCommand>;
}

function currentApi(call: CommandCall): NodeMailApi {
  return {
    supports: () => true,
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

function present(record: object, key: string): boolean {
  return (record as Record<string, unknown>)[key] !== undefined;
}

/** `args` without the keys whose capability the node does not advertise. */
function withoutUnsupported<T extends object>(
  args: T,
  gated: Readonly<Record<string, NodeMailFeature>>,
  supports: (feature: NodeMailFeature) => boolean,
): T {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const feature = gated[key];
    if (feature === undefined || supports(feature)) kept[key] = value;
  }
  return kept as T;
}

const OUTBOX_FLAGS: Readonly<Record<string, NodeMailFeature>> = {
  coordinatorMail: BACKEND_CAPABILITIES.nodeCoordinatorMail,
  coordinatorNotices: BACKEND_CAPABILITIES.coordinatorNotices,
  attachmentMail: BACKEND_CAPABILITIES.nodeMailAttachments,
};

/** Version 0: today's capability gating for a pre-contract node. */
function legacyApi(call: CommandCall, context: DomainAdapterContext): NodeMailApi {
  const supports = (feature: NodeMailFeature) => context.capabilities?.has(feature) ?? false;
  const refuse = (field: string): never => {
    throw unsupportedField({
      field,
      domain: nodeMailDomain.name,
      command: deliverNodeMailCommand.name,
    });
  };
  return {
    supports,
    deliver: async (args) => {
      if (present(args, "steer") && !supports(BACKEND_CAPABILITIES.nodeMailSteer)) refuse("steer");
      if (present(args, "attachments") && !supports(BACKEND_CAPABILITIES.nodeMailAttachments)) {
        refuse("attachments");
      }
      return call(
        deliverNodeMailCommand,
        withoutUnsupported(args, { turnOrigin: BACKEND_CAPABILITIES.nodeMailTurnOrigin }, supports),
      );
    },
    projectCoordinator: (args) => call(getNodeProjectCoordinatorCommand, args),
    collectOutbox: (args) =>
      call(collectNodeOutboxCommand, withoutUnsupported(args, OUTBOX_FLAGS, supports)),
    ackOutbox: (args) =>
      call(ackNodeOutboxCommand, withoutUnsupported(args, OUTBOX_FLAGS, supports)),
    returnOutboxMail: async (args) => {
      if (!supports(BACKEND_CAPABILITIES.nodeMailReturn)) {
        throw unknownCommand(returnNodeOutboxMailCommand.name, nodeMailDomain.name);
      }
      return call(returnNodeOutboxMailCommand, args);
    },
    prepareAttachments: async (args) => {
      // A leaf without the capability has no such command.
      if (!supports(BACKEND_CAPABILITIES.nodeMailAttachments)) {
        throw unknownCommand(prepareNodeMailAttachmentsCommand.name, nodeMailDomain.name);
      }
      return call(prepareNodeMailAttachmentsCommand, args);
    },
    actionRequests: (args) =>
      context.invoke(listNodeActionRequestsCommand.name, args) as ReturnType<
        NodeMailApi["actionRequests"]
      >,
    resolveActionRequest: (args) =>
      context.invoke(resolveNodeActionRequestCommand.name, args) as ReturnType<
        NodeMailApi["resolveActionRequest"]
      >,
  };
}

export const nodeMailClient = domainClient(nodeMailDomain, {
  1: (call) => currentApi(call),
  0: legacyApi,
});
