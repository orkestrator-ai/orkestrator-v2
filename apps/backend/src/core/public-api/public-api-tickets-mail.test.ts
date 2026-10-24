import { afterEach, describe, expect, test } from "bun:test";
import type { PublicPage, PublicTicketDetail } from "@orkestrator/protocol/public-api-resources";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";

/**
 * Kanban tickets and agent mail as public actions, through the real
 * registry and storage: request keys replay, content stays out of receipts,
 * and disabled messaging refuses before admission.
 */

afterEach(cleanupSessionHarnesses);

describe("ticket actions", () => {
  test("create, update, comment, list and get under request keys", async () => {
    const { harness, projectId } = await setup();
    const created = await harness.call<{ ticketId: string; status: string }>(
      "ticket.create",
      { projectId, title: "Fix login", description: "Steps", status: "in-progress" },
      { requestId: "ticket-1" },
    );
    if (!created.ok) throw new Error(created.error.message);
    expect(created.result.status).toBe("in-progress");
    expect(JSON.stringify(created.receipt)).not.toContain("Steps");
    const replay = await harness.call<{ ticketId: string }>(
      "ticket.create",
      { projectId, title: "Fix login", description: "Steps", status: "in-progress" },
      { requestId: "ticket-1" },
    );
    expect(replay.ok && replay.result.ticketId).toBe(created.result.ticketId);
    expect(replay.receipt?.replayed).toBe(true);
    const conflict = await harness.call(
      "ticket.create",
      { projectId, title: "Another" },
      { requestId: "ticket-1" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");

    const ticketId = created.result.ticketId;
    const updated = await harness.call(
      "ticket.update",
      { projectId, ticketId, status: "done", title: "Fix the login redirect" },
      { requestId: "ticket-update-1" },
    );
    expect(updated.ok).toBe(true);
    const nothing = await harness.call(
      "ticket.update",
      { projectId, ticketId },
      { requestId: "ticket-update-2" },
    );
    expect(!nothing.ok && nothing.error.code).toBe("invalid-input");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const commented = await harness.call(
        "ticket.comment",
        { projectId, ticketId, text: "Reproduced" },
        { requestId: "comment-1" },
      );
      expect(commented.ok).toBe(true);
    }

    const ticket = await harness.call<PublicTicketDetail>("ticket.get", { projectId, ticketId });
    if (!ticket.ok) throw new Error(ticket.error.message);
    expect(ticket.result).toMatchObject({
      title: "Fix the login redirect",
      status: "done",
      description: "Steps",
      commentCount: 1,
      comments: [{ text: "Reproduced" }],
    });
    const listed = await harness.call<PublicPage<{ id: string }>>("ticket.list", {
      projectId,
      status: "done",
    });
    expect(listed.ok && listed.result.items.map((item) => item.id)).toEqual([ticketId]);

    const wrongProject = await harness.call("ticket.get", { projectId: "missing", ticketId });
    expect(!wrongProject.ok && wrongProject.error.code).toBe("not-found");
    const unknownField = await harness.call("ticket.list", { projectId, owner: "me" });
    expect(!unknownField.ok && unknownField.error.code).toBe("invalid-input");
  });
});

describe("mail actions", () => {
  test("refuse before admission while messaging is disabled", async () => {
    const { harness } = await setup();
    const config = await harness.storage.loadConfig();
    await harness.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging, enabled: false },
    } as typeof config.global);
    const listed = await harness.call("mail.mailboxes", {});
    expect(!listed.ok && listed.error.code).toBe("capability-unavailable");
    const sent = await harness.call(
      "mail.send",
      { toEnvironmentId: "env-1", toTabId: "startup-agent", body: "hello" },
      { requestId: "mail-disabled" },
    );
    expect(!sent.ok && sent.error.code).toBe("capability-unavailable");
    expect(sent.receipt).toBeUndefined();
  });

  test("send places a body-free receipt and maps refusals to public codes", async () => {
    const { harness } = await setup();
    const config = await harness.storage.loadConfig();
    await harness.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging, enabled: true },
    } as typeof config.global);
    const started = await harness.call<{ tabId: string }>(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "listen" },
      { requestId: "mail-session" },
    );
    if (!started.ok) throw new Error(started.error.message);
    const sent = await harness.call<{ messageId: string }>(
      "mail.send",
      { toEnvironmentId: "env-1", toTabId: started.result.tabId, body: "private body" },
      { requestId: "mail-1" },
    );
    if (!sent.ok) throw new Error(`${sent.error.code}: ${sent.error.message}`);
    expect(sent.result.messageId).toEqual(expect.any(String));
    expect(JSON.stringify(sent)).not.toContain("private body");
    const missing = await harness.call(
      "mail.send",
      { toEnvironmentId: "env-1", toTabId: "no-such-tab", body: "hello" },
      { requestId: "mail-2" },
    );
    expect(!missing.ok && missing.error.code).toBe("not-found");
    const mailboxes = await harness.call<{ mailboxes: Array<{ tabId: string }> }>(
      "mail.mailboxes",
      { q: "sessions" },
    );
    expect(mailboxes.ok && mailboxes.result.mailboxes.map((mailbox) => mailbox.tabId)).toContain(
      started.result.tabId,
    );
  });
});
