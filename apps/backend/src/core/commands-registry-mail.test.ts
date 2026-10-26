import { describe, expect, mock, test } from "bun:test";
import { AGENT_MAIL_MAX_LIST_LIMIT } from "@orkestrator/protocol/agent-mail";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerAgentMailCommands } from "./commands-registry-mail.js";

function fixture(enabled = true) {
  const storage = {
    loadConfig: async () => ({ global: { agentMessaging: { enabled } } }),
    listAgentMailConversations: mock(async (_options: unknown) => ({ conversations: [] })),
    getAgentMailConversation: mock(async (_a: string, _b: string, _options: unknown) => ({})),
    markAgentMailConversationSeen: mock(async (_a: string, _b: string, _ids: string[]) => 2),
  };
  const handlers = new Map<string, CommandHandler>();
  registerAgentMailCommands((name, handler) => handlers.set(name, handler));
  const call = (name: string, args: Record<string, unknown> = {}) =>
    handlers.get(name)!(args, { storage } as unknown as CommandContext);
  return { call, storage };
}

describe("conversation commands", () => {
  test.each([
    "list_agent_mail_conversations",
    "get_agent_mail_conversation",
    "mark_agent_mail_conversation_seen",
  ])("%s refuses disabled messaging before reading or mutating mail", async (name) => {
    const { call, storage } = fixture(false);
    await expect(call(name, { a: "a", b: "b", messageIds: ["m"] })).rejects.toMatchObject({
      code: "messaging-disabled",
    });
    expect(storage.listAgentMailConversations).not.toHaveBeenCalled();
    expect(storage.getAgentMailConversation).not.toHaveBeenCalled();
    expect(storage.markAgentMailConversationSeen).not.toHaveBeenCalled();
  });
  test("passes participant filtering and conversation limits through", async () => {
    const { call, storage } = fixture();
    await call("list_agent_mail_conversations", { participant: "agent" });
    await call("list_agent_mail_conversations");
    expect(storage.listAgentMailConversations.mock.calls).toEqual([
      [{ participant: "agent" }],
      [{}],
    ]);
    await call("get_agent_mail_conversation", { a: " a ", b: " b ", limit: 50 });
    expect(storage.getAgentMailConversation).toHaveBeenCalledWith("a", "b", { limit: 50 });
    await call("get_agent_mail_conversation", { a: "a", b: "b" });
    expect(storage.getAgentMailConversation).toHaveBeenCalledWith("a", "b", {});
  });
  test.each(["get_agent_mail_conversation", "mark_agent_mail_conversation_seen"])(
    "%s requires both participants",
    async (name) => {
      const { call } = fixture();
      await expect(call(name, { a: " ", b: "b", messageIds: [] })).rejects.toThrow("a is required");
      await expect(call(name, { a: "a", messageIds: [] })).rejects.toThrow("b is required");
    },
  );
  test("seen requires a bounded list of displayed message IDs", async () => {
    const { call, storage } = fixture();
    for (const messageIds of [
      undefined,
      "all",
      [1],
      [" "],
      Array(AGENT_MAIL_MAX_LIST_LIMIT + 1).fill("m"),
    ])
      await expect(
        call("mark_agent_mail_conversation_seen", { a: "a", b: "b", messageIds }),
      ).rejects.toThrow();
    expect(storage.markAgentMailConversationSeen).not.toHaveBeenCalled();
    expect(
      await call("mark_agent_mail_conversation_seen", { a: "a", b: "b", messageIds: ["m1", "m2"] }),
    ).toEqual({ marked: 2 });
    expect(storage.markAgentMailConversationSeen).toHaveBeenCalledWith("a", "b", ["m1", "m2"]);
  });
});

describe("retry_agent_mail_inject", () => {
  test("now asks for the message to be steered into a running turn", async () => {
    const retryAgentMailInject = mock(
      async (_environmentId: string, _tabId: string, _messageId: string, _options: unknown) => ({}),
    );
    const storage = {
      retryAgentMailInject,
      getAgentMailMessage: mock(async () => ({ id: "m" })),
    };
    const drainAgentMail = mock(async () => undefined);
    const handlers = new Map<string, CommandHandler>();
    registerAgentMailCommands((name, handler) => handlers.set(name, handler));
    const call = (args: Record<string, unknown>) =>
      handlers.get("retry_agent_mail_inject")!(args, {
        storage,
        drainAgentMail,
      } as unknown as CommandContext);

    await call({ environmentId: "e", tabId: "t", messageId: "m" });
    await call({ environmentId: "e", tabId: "t", messageId: "m", now: true });
    await expect(
      call({ environmentId: "e", tabId: "t", messageId: "m", now: "yes" }),
    ).rejects.toThrow();

    expect(retryAgentMailInject.mock.calls).toEqual([
      ["e", "t", "m", { steer: false }],
      ["e", "t", "m", { steer: true }],
    ]);
    // The delivery attempt runs before the command answers, so the caller sees its result.
    expect(drainAgentMail).toHaveBeenCalledTimes(2);
  });
});
