/**
 * The `agent-mail` domain (plan item 7008): the definitions declare every key
 * the lenient handlers read, classify reads as the routing classifier does,
 * refuse nothing the handlers accepted, keep every field of a mail record
 * through a client's decode, and the client sends the envelope (with the
 * critical keys it carries) only to a node with the domain.
 */
import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";
import { isNodeReadCommand } from "../../../command-nodes.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { decodeCommandArgs, decodeCommandResult, type AnyCommandDef } from "../../command.js";
import {
  AGENT_MAIL_COMMANDS,
  agentMailClient,
  getAgentMailMailboxCommand,
  getAgentMailMessageCommand,
  getAgentRegistryCommand,
  listAgentMailboxesCommand,
  retryAgentMailInjectCommand,
  sendAgentMailCommand,
  setAgentMessagingPausedCommand,
} from "./index.js";

/** The keys each handler read before (2026-11-07); every handler was lenient. */
const HANDLER_KEYS: Record<string, readonly string[]> = {
  get_agent_registry: ["projectId", "environmentId"],
  list_agent_mailboxes: [
    "projectId",
    "environmentId",
    "q",
    "offset",
    "limit",
    "includeTombstoned",
    "strictProjectScope",
  ],
  get_agent_mail_summary: [],
  get_agent_mail_inbox_snapshot: [],
  get_agent_mail_mailbox: ["environmentId", "tabId", "unreadOnly", "offset", "limit"],
  get_agent_mail_mailboxes: ["addresses"],
  list_agent_mail_inbox: ["environmentId", "tabId", "unreadOnly", "offset", "limit"],
  get_agent_mail_message: ["environmentId", "tabId", "messageId"],
  get_agent_mail_status: ["messageId"],
  list_agent_mail_sent: ["environmentId", "tabId"],
  list_agent_mail_conversations: ["participant"],
  get_agent_mail_conversation: ["a", "b", "limit"],
  mark_agent_mail_conversation_seen: ["a", "b", "messageIds"],
  send_agent_mail: [
    "requestId",
    "toEnvironmentId",
    "toTabId",
    "subject",
    "body",
    "replyToMessageId",
  ],
  send_external_agent_mail: ["requestId", "toEnvironmentId", "toTabId", "subject", "body"],
  ack_agent_mail: ["environmentId", "tabId", "messageId"],
  mark_agent_mail_seen: ["environmentId", "tabId", "messageId"],
  mute_agent_mail: ["environmentId", "tabId", "inject", "mutedInbound", "mutedOutbound"],
  retry_agent_mail_inject: ["environmentId", "tabId", "messageId", "now"],
  discard_agent_mail_inject: ["environmentId", "tabId", "messageId"],
  get_agent_messaging_settings: [],
  update_agent_messaging_settings: ["settings"],
  set_agent_messaging_paused: ["paused"],
};

const ALL: readonly AnyCommandDef[] = AGENT_MAIL_COMMANDS;

const message = {
  version: 1,
  id: "m-1",
  threadId: "m-1",
  requestId: "req-1",
  createdAt: "2026-11-07T00:00:00.000Z",
  from: { kind: "user" },
  toEnvironmentId: "env-1",
  toTabId: "tab-1",
  toIncarnationId: "inc-1",
  body: "hello",
  bodyBytes: 5,
  trust: "user",
  injectDepth: 0,
  threadDepth: 0,
  placement: "pending-inject",
  revision: 3,
  newerField: { kept: true },
};
const descriptor = {
  mailboxId: "env-1:tab-1",
  incarnationId: "inc-1",
  projectId: "p-1",
  projectName: "P",
  environmentId: "env-1",
  environmentName: "E",
  environmentStatus: "running",
  tabId: "tab-1",
  tabType: "native",
  title: null,
  displayName: "Claude 1",
  tabOrdinal: 1,
  agent: "claude",
  kind: "native",
  presence: "live",
  injectPolicy: "idle",
  mutedInbound: false,
  mutedOutbound: false,
  unreadCount: 1,
  userUnseenCount: 0,
  agentUnackedCount: 1,
  pendingInjectCount: 1,
  failedInjectCount: 0,
  capabilities: { canPull: true, canSend: true, canInject: true },
};

describe("agent-mail definitions", () => {
  it("cover the 23 commands once, each in version 1 of the domain", () => {
    expect(ALL).toHaveLength(23);
    expect(ALL.map((def) => def.name).sort()).toEqual(Object.keys(HANDLER_KEYS).sort());
    for (const def of ALL) {
      expect({ name: def.name, since: def.since, domain: def.domain.name }).toEqual({
        name: def.name,
        since: 1,
        domain: "agent-mail",
      });
    }
  });

  it("declare exactly the keys each handler reads", () => {
    for (const def of ALL) {
      expect({ name: def.name, keys: Object.keys(def.args.fields).sort() }).toEqual({
        name: def.name,
        keys: [...HANDLER_KEYS[def.name]!].sort(),
      });
    }
  });

  it("classify reads as the routing classifier does, all workspace access", () => {
    for (const def of ALL) {
      expect({ name: def.name, read: def.read, access: def.access }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
        access: "workspace",
      });
    }
  });

  it("name the critical keys", () => {
    const critical = Object.fromEntries(
      ALL.filter((def) => def.critical.length).map((def) => [def.name, [...def.critical]]),
    );
    expect(critical).toEqual({
      list_agent_mailboxes: ["strictProjectScope"],
      send_agent_mail: ["requestId"],
      send_external_agent_mail: ["requestId"],
      retry_agent_mail_inject: ["now"],
    });
  });

  it("refuse nothing a lenient handler accepted, and drop unknown keys", () => {
    // Each of these reaches the handler, which answers with its own message.
    for (const [def, args] of [
      [getAgentMailMessageCommand, { environmentId: 7, tabId: null }],
      [sendAgentMailCommand, { requestId: "", body: 12 }],
      [retryAgentMailInjectCommand, { now: "yes" }],
      [setAgentMessagingPausedCommand, { paused: "no" }],
      [getAgentMailMailboxCommand, { limit: "all", unreadOnly: 1 }],
    ] as const) {
      expect({ name: def.name, ok: Result.isSuccess(decodeCommandArgs(def, args)) }).toEqual({
        name: def.name,
        ok: true,
      });
    }
    const decoded = decodeCommandArgs(listAgentMailboxesCommand, {
      projectId: "p-1",
      strictProjectScope: true,
      newerOption: true,
    });
    expect(Result.isSuccess(decoded) && decoded.success).toEqual({
      projectId: "p-1",
      strictProjectScope: true,
    });
  });

  it("decode mail records whole, keeping fields they do not declare", () => {
    const read = decodeCommandResult(getAgentMailMessageCommand, message);
    expect(Result.isSuccess(read) && (read.success as unknown)).toEqual(message);
    const page = decodeCommandResult(getAgentMailMailboxCommand, {
      descriptor,
      messages: [{ ...message, body: undefined }],
      total: 1,
      offset: 0,
      limit: 200,
      revision: 3,
    });
    expect(Result.isSuccess(page)).toBe(true);
    // A message without its id, or a descriptor without its counts, is refused.
    const { id: _id, ...anonymous } = message;
    expect(Result.isFailure(decodeCommandResult(sendAgentMailCommand, anonymous))).toBe(true);
    const { unreadCount: _count, ...uncounted } = descriptor;
    expect(
      Result.isFailure(
        decodeCommandResult(listAgentMailboxesCommand, {
          mailboxes: [uncounted],
          total: 1,
          offset: 0,
          limit: 100,
        }),
      ),
    ).toBe(true);
    const registry = decodeCommandResult(getAgentRegistryCommand, {
      generatedAt: "2026-11-07T00:00:00.000Z",
      entries: [
        {
          projectId: "p-1",
          environmentId: "env-1",
          environmentName: "E",
          tabId: "tab-1",
          ownerKind: "environment",
          kind: "native",
          agent: null,
          displayName: "Agent 1",
          tabOrdinal: 1,
          state: "idle",
        },
      ],
      environments: [{ environmentId: "env-1", tabs: 1, working: 0, idle: 1 }],
    });
    expect(Result.isSuccess(registry)).toBe(true);
  });
});

function fakeTransport(domains: NegotiatedDomains | null) {
  const calls: Array<{
    command: string;
    args: unknown;
    envelope: ContractEnvelopeFields | undefined;
  }> = [];
  const invoked: Array<{ command: string; args: unknown }> = [];
  const client = createDomainClient(agentMailClient, {
    call: async (def, args, envelope) => {
      calls.push({ command: def.name, args, envelope });
      return message;
    },
    domains: () => domains,
    invoke: async (command, args) => {
      invoked.push({ command, args });
      return { older: "shape" };
    },
  });
  return { client, calls, invoked };
}

describe("agent-mail client", () => {
  it("version 1 sends the envelope with the critical keys it carries and decodes", async () => {
    const { client, calls, invoked } = fakeTransport({ "agent-mail": { min: 1, max: 1 } });
    expect(client.version()).toBe(1);
    const sent = await client.api().send_agent_mail({
      requestId: "req-1",
      toEnvironmentId: "env-1",
      toTabId: "tab-1",
      body: "hello",
    });
    expect(sent.id).toBe("m-1");
    await client.api().retry_agent_mail_inject({
      environmentId: "env-1",
      tabId: "tab-1",
      messageId: "m-1",
    });
    expect(calls).toEqual([
      {
        command: "send_agent_mail",
        args: { requestId: "req-1", toEnvironmentId: "env-1", toTabId: "tab-1", body: "hello" },
        envelope: { domain: "agent-mail", version: 1, critical: ["requestId"] },
      },
      {
        command: "retry_agent_mail_inject",
        args: { environmentId: "env-1", tabId: "tab-1", messageId: "m-1" },
        // `now` is not sent, so it is not named.
        envelope: { domain: "agent-mail", version: 1 },
      },
    ]);
    expect(invoked).toEqual([]);
  });

  it("version 0 sends today's call without an envelope and returns the answer as sent", async () => {
    const { client, calls, invoked } = fakeTransport(null);
    expect(client.version()).toBe(0);
    const answer = await client.api().get_agent_mail_summary({});
    expect(answer as unknown).toEqual({ older: "shape" });
    expect(invoked).toEqual([{ command: "get_agent_mail_summary", args: {} }]);
    expect(calls).toEqual([]);
  });
});
