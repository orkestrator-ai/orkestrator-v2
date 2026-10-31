import { afterEach, describe, expect, test } from "bun:test";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorConversationSessionKey,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import {
  decodePublicSessionId,
  encodePublicSessionId,
} from "@orkestrator/protocol/public-api-resources";
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

  describe("Coordinator conversations", () => {
    async function withCoordinator() {
      const harness = await open();
      const storage = harness.harness.storage;
      await storage.updateProject(harness.projectId, { localPath: harness.harness.root });
      const main = {
        id: "main",
        tabId: "coordinator-main",
        logicalSessionKey: coordinatorConversationSessionKey("coordinator-1", {
          id: "main",
          tabId: "coordinator-main",
        }),
        agent: "claude" as const,
        title: "Coordinator",
        createdAt: new Date(0).toISOString(),
        mailboxIncarnationId: "incarnation-main",
        role: "main" as const,
      };
      await storage.coordinators.mutateCoordinatorWorkspace(harness.projectId, () => ({
        version: COORDINATOR_WORKSPACE_VERSION,
        id: "coordinator-1",
        projectId: harness.projectId,
        executionPolicy: COORDINATOR_EXECUTION_POLICY,
        lifecycleState: "ready",
        conversations: [main],
        selectedConversationId: "main",
        repositoryContextRevision: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }));
      const environmentId = coordinatorRuntimeId("coordinator-1", "main");
      const providerSessionId = "provider-coordinator";
      await harness.harness.commands.get("adopt_native_agent_session")!(
        {
          environmentId,
          agent: "claude",
          logicalSessionKey: main.logicalSessionKey,
          providerSessionId,
          origin: "interactive-native",
        },
        harness.harness.context,
      );
      setActivity(harness.service, "claude", main.tabId, providerSessionId, "idle", environmentId);
      return { harness, environmentId, tabId: main.tabId };
    }

    test("what list_agents names, every session and tab tool can then reach", async () => {
      const { harness, environmentId, tabId } = await withCoordinator();
      const agents = await harness.call(harness.defaultToken, "list_agents");
      const entry = (
        agents.structuredContent as {
          entries: Array<{
            ownerKind: string;
            environmentId: string;
            tabId: string;
            sessionId?: string;
          }>;
        }
      ).entries.find((candidate) => candidate.ownerKind === "coordinator")!;
      expect(entry).toMatchObject({ environmentId, tabId });
      const sessionId = entry.sessionId!;
      expect(decodePublicSessionId(sessionId)).toEqual({ environmentId, tabId });

      const tabs = await harness.call(harness.defaultToken, "list_tabs", { environmentId });
      expect(tabs.isError).not.toBe(true);
      expect(tabs.structuredContent).toMatchObject({
        total: 1,
        tabs: [{ id: tabId, type: "agent-native", title: "Coordinator", agent: "claude" }],
      });

      const state = await harness.call(harness.defaultToken, "get_tab_state", {
        environmentId,
        tabId,
      });
      expect(state.isError).not.toBe(true);
      expect(state.structuredContent).toMatchObject({ environmentId, tabId, agent: "claude" });

      const transcript = await harness.call(harness.defaultToken, "get_tab_transcript", {
        environmentId,
        tabId,
      });
      expect(transcript.isError).not.toBe(true);

      expect(
        (await harness.call(harness.defaultToken, "session_list", { environmentId })).isError,
      ).not.toBe(true);
      expect(
        (await harness.call(harness.defaultToken, "session_get", { sessionId })).isError,
      ).not.toBe(true);

      const sent = await harness.call(harness.defaultToken, "send_prompt_to_tab", {
        requestId: "prompt-coordinator",
        environmentId,
        tabId,
        prompt: "What is the state of the release?",
      });
      expect(sent.structuredContent).toMatchObject({
        environmentId,
        tabId,
        outcome: "accepted",
        receipt: { action: "session.prompt", requestId: "prompt-coordinator" },
      });
      expect(harness.stub.sends.at(-1)?.prompt).toContain("What is the state of the release?");
    });

    test("resolve_target finds a project's Coordinator by name", async () => {
      const { harness, environmentId, tabId } = await withCoordinator();
      const target = async (query: string) =>
        (
          (await harness.call(harness.defaultToken, "resolve_target", { query, kind: "session" }))
            .structuredContent as { result?: { target?: { id: string; environmentId: string } } }
        ).result?.target;
      for (const query of ["coordinator", "the session coordinator"]) {
        expect(await target(query)).toMatchObject({
          id: encodePublicSessionId(environmentId, tabId),
          environmentId,
        });
      }
    });

    test("a read-only credential can read a Coordinator but cannot prompt it", async () => {
      const { harness, environmentId, tabId } = await withCoordinator();
      const readOnly = await harness.credential("read-only");
      const listed = await harness.call(readOnly.token, "list_tabs", { environmentId });
      expect(listed.isError).not.toBe(true);
      const names = (await harness.list(readOnly.token)).tools.map((tool) => tool.name);
      expect(names).not.toContain("send_prompt_to_tab");
      const refused = await harness.call(readOnly.token, "run_action", {
        action: "session.prompt",
        requestId: "read-only-prompt",
        input: { sessionId: encodePublicSessionId(environmentId, tabId), prompt: "Hello" },
      });
      expect(refused.isError).toBe(true);
      expect(harness.stub.sends).toHaveLength(0);
    });

    test("mail from a credential stays inbox-only: prompting is the one way in", async () => {
      const { harness, environmentId, tabId } = await withCoordinator();
      await harness.harness.storage.synchronizeAgentMailboxes();
      const sent = await harness.call(harness.defaultToken, "send_message", {
        requestId: "mail-coordinator",
        toEnvironmentId: environmentId,
        toTabId: tabId,
        subject: "Status",
        body: "Hello",
      });
      expect(sent.structuredContent).toMatchObject({ message: { placement: "stored" } });
      expect(harness.stub.sends).toHaveLength(0);
    });
  });

  test("list_tabs refuses an unknown environment instead of reading as no tabs", async () => {
    const harness = await open();
    const missing = await harness.call(harness.defaultToken, "list_tabs", {
      environmentId: "no-such-environment",
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("Environment not found: no-such-environment");
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
    expect(await harness.harness.storage.kanban.getKanbanTasks(harness.projectId)).toHaveLength(1);

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
