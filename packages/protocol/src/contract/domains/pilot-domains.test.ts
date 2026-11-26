/**
 * The pilot domains (plan item 1010): `node-mail`, `node-files` and
 * `ticket-sync`. Their definitions keep the argument keys the strict handlers
 * accepted (and, for the lenient neighbours defined on 2026-11-07, the keys
 * their handlers read), classify reads as the routing classifier does, and decode
 * tolerantly; their clients send the envelope to a node with the domain.
 */
import { describe, expect, it } from "bun:test";
import { isNodeReadCommand } from "../../command-nodes.js";
import type { NegotiatedDomains } from "../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../client.js";
import { DOMAIN_CLIENTS, buildAdapterList } from "../client-adapters.js";
import { decodeCommandArgs, type AnyCommandDef } from "../command.js";
import { incompatibility } from "../errors.js";
import { NODE_FILES_COMMANDS, nodeFilesClient } from "./node-files/index.js";
import { NODE_MAIL_COMMANDS, nodeMailClient } from "./node-mail/index.js";
import { TICKET_SYNC_COMMANDS, ticketSyncClient } from "./ticket-sync/index.js";

/**
 * The `assertOnlyKeys` sets of the handlers before they were defined
 * (2026-11-07), and for the four lenient ones the keys their handlers read.
 */
const FORMER_KEYS: Record<string, readonly string[]> = {
  deliver_node_mail: [
    "controllerId",
    "coordinatorEnvironmentId",
    "coordinatorTabId",
    "requestId",
    "toEnvironmentId",
    "toTabId",
    "subject",
    "body",
    "steer",
    "turnOrigin",
    "nodeParent",
    "projectId",
    "attachments",
  ],
  get_node_project_coordinator: ["projectId"],
  get_worker_request_state: ["environmentId", "tabId"],
  record_node_environment_origin: [
    "environmentId",
    "controllerId",
    "coordinatorEnvironmentId",
    "coordinatorTabId",
  ],
  collect_node_outbox: [
    "controllerId",
    "after",
    "coordinatorMail",
    "coordinatorNotices",
    "attachmentMail",
  ],
  ack_node_outbox: [
    "controllerId",
    "upTo",
    "sequences",
    "coordinatorMail",
    "coordinatorNotices",
    "attachmentMail",
  ],
  return_node_outbox_mail: ["controllerId", "seq"],
  create_node_action_request: [
    "requestId",
    "kind",
    "targets",
    "requestedBy",
    "reason",
    "agentsMd",
    "workerQuestion",
    "projectHomeMessage",
    "askedBecause",
  ],
  list_node_action_requests: ["pendingOnly"],
  resolve_node_action_request: ["requestId", "decision", "approval"],
  stat_node_file: ["scope", "path"],
  read_node_file: ["scope", "path", "offset", "length"],
  begin_node_file_write: ["scope", "path", "size", "sha256", "overwrite"],
  append_node_file_write: ["uploadId", "contentBase64"],
  commit_node_file_write: ["uploadId"],
  abort_node_file_write: ["uploadId"],
  transfer_node_files: ["from", "to", "files", "toDirectory", "overwrite", "actor"],
  list_node_transfers: [],
  apply_ticket_sync: [
    "controllerId",
    "projectId",
    "sourceProjectId",
    "epoch",
    "items",
    "cursor",
    "reset",
    "liveIds",
  ],
  get_ticket_sync_cursor: ["controllerId", "projectId"],
  // `features` added with images on synced tickets (#2027).
  collect_ticket_sync_outbox: ["controllerId", "after", "features"],
  // `removedProjects` added for a command node's removed projects (#2328).
  ack_ticket_sync_outbox: ["controllerId", "epoch", "upTo", "removedProjects"],
  get_ticket_sync_status: ["projectId"],
  sync_node_tickets: ["nodeId"],
  // The lenient neighbours (plan item 7009): every key is `optionalKey(Unknown)`.
  prepare_node_mail_attachments: ["to", "attachments"],
  place_node_mail_attachments: ["to", "attachments"],
  send_coordinator_command_node_mail: [
    "scope",
    "requestId",
    "subject",
    "body",
    "replyToMessageId",
    "attachments",
  ],
  coordinator_node_ticket: ["scope", "nodeId", "action", "input"],
  // Defined new with the ticket-sync follow-ups (#2027, 2026-11-09); they had no strict handler.
  read_ticket_image: ["controllerId", "imageId"],
  put_ticket_image: ["controllerId", "imageId", "data"],
  get_ticket_sync_leaf_status: ["projectId"],
  share_tickets_with_command_node: ["projectId", "taskIds"],
  dismiss_ticket_sync_conflicts: ["projectId", "ids"],
  // Linear board-link sync and the one user-initiated key copy (2026-11-11).
  get_linear_sync_state: ["controllerId"],
  apply_linear_sync_state: ["controllerId", "links", "revocations"],
  export_linear_connection: ["controllerId"],
  // Writes a leaf without a Linear key owes, landed by its command node (2026-11-25).
  claim_linear_writes: ["controllerId", "leased", "revalidate"],
  settle_linear_writes: ["controllerId", "results"],
};

const LENIENT = [
  "prepare_node_mail_attachments",
  "place_node_mail_attachments",
  "send_coordinator_command_node_mail",
  "coordinator_node_ticket",
];

const ALL: readonly AnyCommandDef[] = [
  ...NODE_MAIL_COMMANDS,
  ...NODE_FILES_COMMANDS,
  ...TICKET_SYNC_COMMANDS,
];

describe("pilot definitions", () => {
  it("cover the 24 pilot commands, the 4 lenient neighbours, the 5 ticket-sync follow-ups and the 3 Linear sync commands, each in version 1 of its domain", () => {
    expect(ALL.map((def) => def.name).sort()).toEqual(Object.keys(FORMER_KEYS).sort());
    for (const def of ALL) {
      expect(def.since).toBe(1);
      expect({ name: def.name, version: def.domain.version, min: def.domain.min }).toEqual({
        name: def.name,
        version: 1,
        min: 1,
      });
    }
  });

  it.each(ALL.map((def) => [def.name, def] as const))(
    "%s declares the keys its strict handler accepted, and its read class",
    (name, def) => {
      expect(Object.keys(def.args.fields).sort()).toEqual([...FORMER_KEYS[name]!].sort());
      expect(def.read).toBe(isNodeReadCommand(name));
    },
  );

  it("marks steer and the delivery's idempotency and safety keys critical", () => {
    const critical = Object.fromEntries(
      ALL.filter((def) => def.critical.length > 0).map((def) => [def.name, def.critical]),
    );
    expect(critical).toEqual({
      deliver_node_mail: ["steer", "requestId", "nodeParent", "attachments"],
      create_node_action_request: ["requestId"],
      begin_node_file_write: ["sha256"],
      apply_ticket_sync: ["reset", "liveIds"],
      claim_linear_writes: ["leased", "revalidate"],
      send_coordinator_command_node_mail: ["requestId", "attachments", "replyToMessageId"],
    });
  });

  it("keep the lenient neighbours lenient: every key optional and of any type", () => {
    for (const def of ALL.filter((entry) => LENIENT.includes(entry.name))) {
      const odd = Object.fromEntries(Object.keys(def.args.fields).map((key) => [key, 42]));
      const decoded = decodeCommandArgs(def, odd);
      expect(decoded._tag).toBe("Success");
      if (decoded._tag === "Success") expect(decoded.success).toEqual(odd);
      expect(decodeCommandArgs(def, {})._tag).toBe("Success");
      expect(def.access).toBe("internal");
    }
  });

  it("decode tolerantly: an unknown key is dropped, never refused (§11.4)", () => {
    for (const def of ALL) {
      const decoded = decodeCommandArgs(def, { fromANewerPeer: true });
      expect(decoded._tag).toBe("Success");
      // An empty `Schema.Struct({})` (list_node_transfers) passes its input
      // through; that handler reads no argument.
      if (decoded._tag === "Success" && Object.keys(def.args.fields).length > 0) {
        expect(decoded.success).not.toHaveProperty("fromANewerPeer");
      }
    }
  });

  it("refuse an unknown key the sender marked critical", () => {
    const decoded = decodeCommandArgs(
      NODE_MAIL_COMMANDS[0],
      { body: "hi", priority: "urgent" },
      { critical: ["priority"] },
    );
    expect(decoded._tag).toBe("Failure");
    if (decoded._tag === "Failure") {
      expect(incompatibility(decoded.failure, "deliver_node_mail")).toMatchObject({
        code: "unsupported-field",
        field: "priority",
      });
    }
  });

  it("are listed in the adapter list with their current adapter only", () => {
    expect(DOMAIN_CLIENTS).toEqual(
      expect.arrayContaining([nodeMailClient, nodeFilesClient, ticketSyncClient]),
    );
    expect(buildAdapterList().domains).toMatchObject({
      "node-files": { current: 1, adapters: [1] },
      "node-mail": { current: 1, adapters: [1] },
      "ticket-sync": { current: 1, adapters: [1] },
    });
  });
});

interface Sent {
  command: string;
  args: unknown;
  envelope: ContractEnvelopeFields | undefined;
}

function fakeNode(
  domains: NegotiatedDomains | undefined,
  capabilities: readonly string[],
  answer: (command: string) => unknown = () => ({}),
) {
  const sent: Sent[] = [];
  const usage: Array<[string, number]> = [];
  const options = {
    call: async (def: AnyCommandDef, args: unknown, envelope?: ContractEnvelopeFields) => {
      sent.push({ command: def.name, args, envelope });
      return answer(def.name);
    },
    domains,
    capabilities,
    usage: (domain: string, version: number) => usage.push([domain, version]),
  };
  return { sent, usage, options };
}

const NODE_MAIL_V1 = { "node-mail": { min: 1, max: 1 } };

describe("node-mail client", () => {
  const delivery = {
    controllerId: "bk_cmd",
    requestId: "r1",
    toEnvironmentId: "env-1",
    body: "Stop.",
    steer: true,
    turnOrigin: "mail",
  };

  it("version 1: every former capability is part of the domain; steer travels as critical", async () => {
    const node = fakeNode(NODE_MAIL_V1, []);
    const client = createDomainClient(nodeMailClient, node.options);
    expect(client.version()).toBe(1);
    const mail = client.api();
    await mail.deliver(delivery);
    await mail.collectOutbox({
      controllerId: "bk_cmd",
      coordinatorMail: true,
      attachmentMail: true,
    });
    expect(node.sent[0]).toEqual({
      command: "deliver_node_mail",
      args: delivery,
      envelope: { domain: "node-mail", version: 1, critical: ["steer", "requestId"] },
    });
    expect(node.sent[1]!.args).toEqual({
      controllerId: "bk_cmd",
      coordinatorMail: true,
      attachmentMail: true,
    });
    expect(node.usage).toEqual([]);
  });

  it("decodes answers tolerantly: an older leaf's shorter answer and a newer leaf's extra key", async () => {
    const node = fakeNode(NODE_MAIL_V1, [], () => ({ messageId: "m1", fromTheFuture: 1 }));
    const answer = await createDomainClient(nodeMailClient, node.options).api().deliver(delivery);
    expect(answer).toEqual({ messageId: "m1" });
  });

  it("picks again for a new connection generation", () => {
    let domains: NegotiatedDomains | undefined = { "ticket-sync": { min: 1, max: 1 } };
    const node = fakeNode(undefined, []);
    const client = createDomainClient(nodeMailClient, { ...node.options, domains: () => domains });
    expect(client.version()).toBeNull();
    domains = { ...NODE_MAIL_V1 };
    expect(client.version()).toBe(1);
  });
});

describe("ticket-sync client", () => {
  it("version 1 syncs and sends reset with liveIds as critical", async () => {
    const node = fakeNode({ "ticket-sync": { min: 1, max: 1 } }, []);
    const sync = createDomainClient(ticketSyncClient, node.options).api();
    await sync.apply({ controllerId: "bk_cmd", items: [], reset: true, liveIds: [] });
    expect(node.sent[0]!.envelope).toEqual({
      domain: "ticket-sync",
      version: 1,
      critical: ["reset", "liveIds"],
    });
  });

  it("collects with the command node's features", async () => {
    const collect = { controllerId: "bk_cmd", after: 3, features: ["images"] };
    const current = fakeNode({ "ticket-sync": { min: 1, max: 1 } }, []);
    await createDomainClient(ticketSyncClient, current.options).api().collectOutbox(collect);
    expect(current.sent[0]!.args).toEqual(collect);
  });

  it("current acknowledgements preserve removedProjects", async () => {
    const ack = { controllerId: "bk_cmd", epoch: "e1", upTo: 4, removedProjects: ["gone"] };
    const current = fakeNode({ "ticket-sync": { min: 1, max: 1 } }, [], () => ({
      remaining: 0,
      dropped: 1,
    }));
    await createDomainClient(ticketSyncClient, current.options).api().ackOutbox(ack);
    expect(current.sent[0]!.args).toEqual(ack);
  });
});

describe("node-files client", () => {
  it("sends sha256 as critical", async () => {
    const begin = { scope: { projectId: "p" }, path: "a.txt", size: 1, sha256: "f".repeat(64) };
    const current = fakeNode({ "node-files": { min: 1, max: 1 } }, []);
    await createDomainClient(nodeFilesClient, current.options).api().beginWrite(begin);
    expect(current.sent[0]!.envelope).toEqual({
      domain: "node-files",
      version: 1,
      critical: ["sha256"],
    });
  });
});

describe("the command node's own reads in ticket-sync and node-mail", () => {
  const request = {
    requestId: "q1",
    kind: "answer-worker-question",
    state: "pending",
    createdAt: "2026-11-07T00:00:00.000Z",
    expiresAt: "2026-11-08T00:00:00.000Z",
    workerQuestion: { question: "Which?" },
  };
  const status = { projectId: "p1", nodes: [], conflicts: [] };
  const answer = (command: string) =>
    command === "get_ticket_sync_status"
      ? status
      : command.startsWith("list_")
        ? [request]
        : request;

  it("version 1: typed calls with the envelope; an action request keeps every key", async () => {
    const node = fakeNode({ ...NODE_MAIL_V1, "ticket-sync": { min: 1, max: 1 } }, [], answer);
    await expect(
      createDomainClient(ticketSyncClient, node.options).api().status({ projectId: "p1" }),
    ).resolves.toEqual(status);
    const mail = createDomainClient(nodeMailClient, node.options).api();
    await expect(mail.actionRequests({ pendingOnly: true })).resolves.toEqual([request]);
    await expect(
      mail.resolveActionRequest({ requestId: "q1", decision: "approve" }),
    ).resolves.toEqual(request);
    expect(node.sent.map((sent) => [sent.command, sent.envelope?.domain])).toEqual([
      ["get_ticket_sync_status", "ticket-sync"],
      ["list_node_action_requests", "node-mail"],
      ["resolve_node_action_request", "node-mail"],
    ]);
  });
});
