import { afterEach, describe, expect, test } from "bun:test";
import { controlMcpHarness } from "./control-mcp-test-support.js";
import { cleanupSessionHarnesses, setActivity } from "./public-api/test-provider.js";

/**
 * The original operator tools, for operator credentials, over public actions
 * on the real stack: their documented output shapes, the public request-key
 * and busy rules, and receipts under the credential's authority.
 */

const harnesses: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
  await cleanupSessionHarnesses();
});

async function open() {
  const harness = await controlMcpHarness();
  harnesses.push(harness);
  return harness;
}

describe("operator tools over public actions", () => {
  test("list_projects keeps its shape and never leaks the checkout path", async () => {
    const harness = await open();
    const listed = await harness.call(harness.defaultToken, "list_projects");
    expect(listed.structuredContent).toEqual({
      projects: [
        {
          id: harness.projectId,
          name: "session",
          addedAt: expect.any(String),
          order: 0,
          hasLocalCheckout: false,
        },
      ],
      total: 1,
    });
  });

  test("launch_job is one session.start under the credential's request key", async () => {
    const harness = await open();
    const job = {
      requestId: "job-1",
      environmentId: "env-1",
      agent: "claude",
      conversationMode: "build",
      title: "Fix it",
      prompt: "Fix the failing test.",
    };
    const launched = await harness.call(harness.defaultToken, "launch_job", job);
    expect(launched.isError).not.toBe(true);
    const result = launched.structuredContent as Record<string, unknown> & {
      receipt: { action: string; requestId: string; operationId: string };
    };
    expect(result.jobId).toBe(String(result.tabId).replace(/^agent-job-/, ""));
    expect(result).toMatchObject({
      environmentId: "env-1",
      tabId: expect.stringMatching(/^agent-job-/),
      sessionId: expect.stringMatching(/^ses_/),
      status: "accepted",
      receipt: { action: "session.start", requestId: "job-1" },
    });
    expect(harness.stub.sends).toHaveLength(1);

    const replayed = await harness.call(harness.defaultToken, "launch_job", job);
    expect((replayed.structuredContent as typeof result).receipt.operationId).toBe(
      result.receipt.operationId,
    );
    expect(harness.stub.sends).toHaveLength(1);

    const conflict = await harness.call(harness.defaultToken, "launch_job", {
      ...job,
      prompt: "Something else.",
    });
    expect(conflict.isError).toBe(true);
    expect((conflict.structuredContent as { error: { code: string } }).error.code).toBe(
      "request-conflict",
    );

    // The CLI never sees the credential's operation.
    const cli = await harness.harness.call("run.get", { operationId: result.receipt.operationId });
    expect(!cli.ok && cli.error.code).toBe("not-found");
  });

  test("launch_environment returns the created environment and replays its receipt", async () => {
    const harness = await open();
    const repository = await harness.harness.createRepository("operator-launch");
    const added = await harness.harness.call<{ project: { id: string } }>(
      "project.add",
      { path: repository.projectPath },
      { requestId: "launch-project" },
    );
    if (!added.ok) throw new Error(added.error.message);
    const input = {
      requestId: "environment-1",
      projectId: added.result.project.id,
      environmentType: "local",
      agent: "claude",
      conversationMode: "build",
      prompt: "work",
      name: "operator-launch",
    };
    const launched = await harness.call(harness.defaultToken, "launch_environment", input);
    expect(launched.isError).not.toBe(true);
    const result = launched.structuredContent as {
      environmentId: string;
      receipt: { operationId: string };
    };
    const environmentId = result.environmentId;
    expect(typeof environmentId).toBe("string");
    expect(result).toMatchObject({
      environmentId: expect.any(String),
      sessionId: expect.stringMatching(/^ses_/),
      tabId: "startup-agent",
      runId: result.receipt.operationId,
      status: "accepted",
      receipt: { action: "environment.launch", requestId: input.requestId },
    });
    const replay = await harness.call(harness.defaultToken, "launch_environment", input);
    expect(replay.structuredContent).toMatchObject({
      environmentId,
      receipt: { operationId: result.receipt.operationId, replayed: true },
    });
    const conflict = await harness.call(harness.defaultToken, "launch_environment", {
      ...input,
      prompt: "different",
    });
    expect(conflict.structuredContent).toMatchObject({
      ok: false,
      error: { code: "request-conflict" },
    });
    await harness.harness.commands.get("delete_environment")!(
      { environmentId },
      harness.harness.context,
    );
  }, 60_000);

  test("send_prompt_to_tab follows the public busy rule and never steers", async () => {
    const harness = await open();
    const started = await harness.call(harness.defaultToken, "launch_job", {
      requestId: "job-2",
      environmentId: "env-1",
      agent: "claude",
      conversationMode: "build",
      prompt: "First.",
    });
    const tabId = (started.structuredContent as { tabId: string }).tabId;
    const providerSessionId = harness.stub.sends[0]!.sessionId;

    setActivity(harness.service, "claude", tabId, providerSessionId, "working");
    const busy = await harness.call(harness.defaultToken, "send_prompt_to_tab", {
      requestId: "prompt-busy",
      environmentId: "env-1",
      tabId,
      prompt: "Second.",
    });
    expect((busy.structuredContent as { error: { code: string } }).error.code).toBe("busy");
    expect(harness.stub.sends).toHaveLength(1);

    setActivity(harness.service, "claude", tabId, providerSessionId, "idle");
    const sent = await harness.call(harness.defaultToken, "send_prompt_to_tab", {
      requestId: "prompt-idle",
      environmentId: "env-1",
      tabId,
      prompt: "Second.",
    });
    expect(sent.structuredContent).toMatchObject({
      environmentId: "env-1",
      tabId,
      outcome: "accepted",
      receipt: { action: "session.prompt", requestId: "prompt-idle" },
    });
    expect(harness.stub.sends.at(-1)?.prompt).toBe("Second.");
  });

  test("ticket tools keep their shapes over ticket.* with durable request keys", async () => {
    const harness = await open();
    const created = await harness.call(harness.defaultToken, "create_ticket", {
      requestId: "ticket-1",
      projectId: harness.projectId,
      title: "Investigate",
      description: "Details",
    });
    const ticket = (created.structuredContent as { ticket: { id: string } }).ticket;
    expect(created.structuredContent).toMatchObject({
      ticket: { title: "Investigate", description: "Details", status: "backlog", commentCount: 0 },
      receipt: { action: "ticket.create", requestId: "ticket-1" },
    });
    const replay = await harness.call(harness.defaultToken, "create_ticket", {
      requestId: "ticket-1",
      projectId: harness.projectId,
      title: "Investigate",
      description: "Details",
    });
    expect((replay.structuredContent as { ticket: { id: string } }).ticket.id).toBe(ticket.id);
    expect(await harness.harness.storage.getKanbanTasks(harness.projectId)).toHaveLength(1);

    const update = { projectId: harness.projectId, ticketId: ticket.id, status: "done" };
    const updated = await harness.call(harness.defaultToken, "update_ticket", update);
    expect(updated.structuredContent).toMatchObject({
      ticket: { id: ticket.id, status: "done" },
      receipt: { action: "ticket.update", requestId: expect.stringMatching(/^update-ticket-/) },
    });

    await harness.call(harness.defaultToken, "update_ticket", { ...update, status: "in-progress" });
    const doneAgain = await harness.call(harness.defaultToken, "update_ticket", update);
    expect(doneAgain.structuredContent).toMatchObject({ ticket: { status: "done" } });
    expect(
      (doneAgain.structuredContent as { receipt: { operationId: string } }).receipt.operationId,
    ).not.toBe(
      (updated.structuredContent as { receipt: { operationId: string } }).receipt.operationId,
    );
    const keyed = { ...update, requestId: "explicit-edit" };
    const firstEdit = await harness.call(harness.defaultToken, "update_ticket", keyed);
    const retriedEdit = await harness.call(harness.defaultToken, "update_ticket", keyed);
    expect(retriedEdit.structuredContent).toMatchObject({
      receipt: {
        operationId: (firstEdit.structuredContent as { receipt: { operationId: string } }).receipt
          .operationId,
        replayed: true,
      },
    });

    await harness.call(harness.defaultToken, "add_ticket_comment", {
      requestId: "comment-1",
      projectId: harness.projectId,
      ticketId: ticket.id,
      text: "Looks good",
    });
    await harness.call(harness.defaultToken, "add_ticket_comment", {
      requestId: "comment-1",
      projectId: harness.projectId,
      ticketId: ticket.id,
      text: "Looks good",
    });
    const fetched = await harness.call(harness.defaultToken, "get_ticket", {
      projectId: harness.projectId,
      ticketId: ticket.id,
    });
    expect(fetched.structuredContent).toMatchObject({
      ticket: { commentCount: 1, comments: [{ text: "Looks good" }] },
    });
    const listed = await harness.call(harness.defaultToken, "list_tickets", {
      projectId: harness.projectId,
      status: "done",
    });
    expect(listed.structuredContent).toMatchObject({ total: 1, tickets: [{ id: ticket.id }] });

    const elsewhere = await harness.call(harness.defaultToken, "get_ticket", {
      projectId: "another-project",
      ticketId: ticket.id,
    });
    expect(elsewhere.isError).toBe(true);
  });

  test("send_message returns a body-free result over mail.send", async () => {
    const harness = await open();
    const config = await harness.harness.storage.loadConfig();
    await harness.harness.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging, enabled: true },
    } as typeof config.global);
    const started = await harness.call(harness.defaultToken, "launch_job", {
      requestId: "mail-target",
      environmentId: "env-1",
      agent: "claude",
      conversationMode: "build",
      prompt: "Wait for mail.",
    });
    const tabId = (started.structuredContent as { tabId: string }).tabId;
    const listed = await harness.call(harness.defaultToken, "list_mailboxes", {});
    expect(listed.isError).not.toBe(true);
    const sent = await harness.call(harness.defaultToken, "send_message", {
      requestId: "mail-1",
      toEnvironmentId: "env-1",
      toTabId: tabId,
      body: "sensitive body",
    });
    expect(sent.isError).not.toBe(true);
    expect(sent.structuredContent).toMatchObject({
      message: { id: expect.any(String), toEnvironmentId: "env-1", toTabId: tabId },
      receipt: { action: "mail.send", requestId: "mail-1" },
    });
    expect(JSON.stringify(sent)).not.toContain("sensitive body");
  });

  test("a read-only credential lists no mutation and run_action refuses one", async () => {
    const harness = await open();
    const readOnly = await harness.credential("read-only");
    const names = (await harness.list(readOnly.token)).tools.map((tool) => tool.name);
    for (const mutation of ["launch_job", "send_prompt_to_tab", "create_ticket", "session_start"]) {
      expect(names).not.toContain(mutation);
    }
    const refused = await harness.call(readOnly.token, "run_action", {
      action: "session.start",
      input: { environmentId: "env-1", agent: "claude", prompt: "no" },
      requestId: "refused",
    });
    expect((refused.structuredContent as { error: { code: string } }).error.code).toBe(
      "capability-unavailable",
    );
    expect(harness.stub.sends).toHaveLength(0);
  });
});
