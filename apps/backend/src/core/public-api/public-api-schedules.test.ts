import { afterEach, describe, expect, jest, test, spyOn } from "bun:test";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import type { ScheduledJob, ScheduledJobSummary } from "@orkestrator/protocol/scheduled-jobs";
import { AgentToolsServer } from "../agent-tools.js";
import { ProjectGitService } from "../project-git-service.js";
import { ScheduledJobExecutor } from "../scheduled-jobs/executor.js";
import { ScheduledJobService } from "../scheduled-jobs/service.js";
import { withPublicAuthority } from "./dispatch.js";
import { controlMcpAuthority } from "./operation-ledger.js";
import { publicActionHandlers } from "./registry.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";
import { commitFile, headCommit, type PublicApiHarness } from "./test-support.js";
import { runCommand } from "../shell.js";
import { rpc } from "../control-mcp-test-support.js";
import { SCHEDULED_JOB_LIMITS } from "@orkestrator/protocol/scheduled-jobs";

/**
 * Scheduled jobs end to end over the real registry, storage, public actions
 * and agent tools, with a scripted provider: a schedule fires each of the
 * three action kinds (an internal action, a prompt to a tab, an environment
 * launch with its base resolved at fire time), schedules are managed through
 * `schedule.*`, Control MCP credentials only see their own, and an agent's
 * schedule runs through its own tools as its own tab.
 */

jest.setTimeout(60_000);
afterEach(cleanupSessionHarnesses);

async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** First-prompt naming ran once, through the harness's stub `codex`. */
async function expectOneNamingCall(harness: PublicApiHarness, prompt: string): Promise<void> {
  const calls = await waitFor(
    () => harness.namingCalls(),
    (calls) => calls.length > 0,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("exec");
  expect(calls[0]).toContain("--output-last-message");
  expect(calls[0]!.at(-1)).toContain(prompt);
}

async function enableMessaging(harness: PublicApiHarness): Promise<void> {
  const config = await harness.storage.loadConfig();
  await harness.storage.updateGlobalConfig({
    ...config.global,
    agentMessaging: { ...config.global.agentMessaging, enabled: true },
  } as typeof config.global);
}

function attachScheduler(
  harness: PublicApiHarness,
  clock: { now: number },
  agentTools?: AgentToolsServer,
) {
  const handlers = publicActionHandlers();
  const policies = new Map<
    string,
    { id: string; profile: "full" | "read-only"; capabilities: string[]; deniedActions: string[] }
  >();
  const executor = new ScheduledJobExecutor({
    invoke: async <T>(command: string, args: Record<string, unknown> = {}) =>
      (await harness.commands.get(command)!(args, harness.context)) as T,
    storage: harness.storage,
    publicHandlers: () => handlers,
    controlMcp: {
      credentialPolicy: (id) => (policies.get(id) as never) ?? null,
      callCoordinatorTool: async () => ({ isError: true, text: "unused" }),
      listCoordinatorTools: async () => [],
    },
    ...(agentTools
      ? {
          agentTools: {
            callTool: (scope, tool, args) => agentTools.callToolAs(scope, tool, args),
            listTools: (scope) => agentTools.listToolsAs(scope),
          },
        }
      : {}),
  });
  const service = new ScheduledJobService({
    store: harness.storage.scheduledJobStore(),
    executor,
    now: () => clock.now,
    defaultTimeZone: () => "Europe/London",
  });
  harness.context.scheduledJobs = service;
  harness.context.projectGit ??= new ProjectGitService(harness.storage);
  agentTools?.setScheduledJobs(service);
  return {
    service,
    policies,
    async fire() {
      await service.tick();
      await service.idle();
    },
  };
}

async function startIdleSession(
  harness: PublicApiHarness,
  service: Parameters<typeof setActivity>[0],
  stub: Awaited<ReturnType<typeof setup>>["stub"],
  requestId: string,
) {
  const started = await harness.call<{ tabId: string; sessionId: string; runId: string }>(
    "session.start",
    { environmentId: "env-1", agent: "claude", prompt: "listen" },
    { requestId },
  );
  if (!started.ok) throw new Error(started.error.message);
  stub.setStatus(async () => "idle");
  const send =
    stub.sends.find((item) => item.requestId?.includes(started.result.runId)) ?? stub.sends.at(-1)!;
  setActivity(service, "claude", started.result.tabId, send.sessionId, "idle");
  await waitFor(
    async () =>
      (await harness.call("run.get", { operationId: started.result.runId }))
        .receipt as PublicReceipt,
    (receipt) => receipt.state === "succeeded",
  );
  return started.result;
}

describe("a schedule fires each action kind", () => {
  test("internal action: agent mail through mail.send", async () => {
    const { harness, service: agents, stub } = await setup();
    await enableMessaging(harness);
    const clock = { now: Date.now() };
    const scheduler = attachScheduler(harness, clock);
    const session = await startIdleSession(harness, agents, stub, "mail-target");
    const created = await harness.call<{ scheduleId: string; nextFireAt: string }>(
      "schedule.create",
      {
        at: "+2m",
        action: {
          kind: "action",
          action: "mail.send",
          input: { toEnvironmentId: "env-1", toTabId: session.tabId, body: "Resume the workers." },
        },
      },
      { requestId: "schedule-mail" },
    );
    if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
    expect(JSON.stringify(created.receipt)).not.toContain("Resume the workers");

    await scheduler.fire();
    expect(
      scheduler.service.get({ kind: "operator" }, created.result.scheduleId).fires,
    ).toHaveLength(0);
    clock.now += 2 * 60_000;
    await scheduler.fire();
    const job = scheduler.service.get({ kind: "operator" }, created.result.scheduleId);
    expect(job.state).toBe("completed");
    expect(job.fires[0]).toMatchObject({
      state: "succeeded",
      outcome: { messageId: expect.any(String) },
    });
    const inbox = await harness.storage.getAgentMailMailbox("env-1", session.tabId, { limit: 10 });
    // Re-read: toMatchObject's asymmetric matchers replace matched values.
    const messageId = scheduler.service.get({ kind: "operator" }, created.result.scheduleId)
      .fires[0]!.outcome!.messageId!;
    expect(JSON.stringify(inbox)).toContain(messageId);
  });

  test("prompt to a tab: waits out a busy session, then sends exactly once", async () => {
    const { harness, service: agents, stub } = await setup();
    const clock = { now: Date.now() };
    const scheduler = attachScheduler(harness, clock);
    const session = await startIdleSession(harness, agents, stub, "prompt-target");
    const created = await harness.call<{ scheduleId: string }>(
      "schedule.create",
      {
        at: "+1m",
        action: { kind: "prompt", sessionId: session.sessionId, prompt: "Nightly summary" },
      },
      { requestId: "schedule-prompt" },
    );
    if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
    // Busy at fire time: refused before admission and retried.
    stub.setStatus(async () => "running");
    setActivity(agents, "claude", session.tabId, stub.sends.at(-1)!.sessionId, "working");
    clock.now += 60_000;
    await scheduler.fire();
    expect(
      scheduler.service.get({ kind: "operator" }, created.result.scheduleId).fires[0],
    ).toMatchObject({
      state: "pending",
      error: { code: "busy" },
    });
    stub.setStatus(async () => "idle");
    setActivity(agents, "claude", session.tabId, stub.sends.at(-1)!.sessionId, "idle");
    clock.now += 31_000;
    await scheduler.fire();
    const fire = scheduler.service.get({ kind: "operator" }, created.result.scheduleId).fires[0]!;
    expect(fire).toMatchObject({
      state: "succeeded",
      attempts: 2,
      outcome: { operationId: expect.any(String) },
    });
    expect(stub.sends.filter((send) => send.prompt.includes("Nightly summary"))).toHaveLength(1);
  });

  test("environment launch: resolves the base branch's newest commit when it fires", async () => {
    const { harness, stub } = await setup();
    const clock = { now: Date.now() };
    const scheduler = attachScheduler(harness, clock);
    const repository = await harness.createRepository("scheduled-launch");
    const added = await harness.call<{ project: { id: string } }>(
      "project.add",
      { path: repository.projectPath },
      { requestId: "schedule-launch-add" },
    );
    if (!added.ok) throw new Error(added.error.message);
    const created = await harness.call<{ scheduleId: string }>(
      "schedule.create",
      {
        at: "+5m",
        action: {
          kind: "launch",
          projectId: added.result.project.id,
          type: "local",
          agent: "claude",
          prompt: "scheduled audit",
          baseBranch: "main",
        },
      },
      { requestId: "schedule-launch" },
    );
    if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
    clock.now += 5 * 60_000;
    await scheduler.fire();
    const fire = scheduler.service.get({ kind: "operator" }, created.result.scheduleId).fires[0]!;
    expect(fire).toMatchObject({
      state: "succeeded",
      outcome: {
        baseBranch: "main",
        baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
        environmentId: expect.any(String),
      },
    });
    await waitFor(
      () => stub.sends.filter((send) => send.prompt.includes("scheduled audit")).length,
      (count) => count === 1,
    );
    await expectOneNamingCall(harness, "scheduled audit");
    const launched = scheduler.service.get({ kind: "operator" }, created.result.scheduleId)
      .fires[0]!;
    await harness.commands.get("delete_environment")!(
      { environmentId: launched.outcome!.environmentId },
      harness.context,
    );
  });
});

describe("schedule.* public actions", () => {
  test("list, get, pause, resume, run and delete; credentials see only their own", async () => {
    const { harness } = await setup();
    const clock = { now: Date.now() };
    const scheduler = attachScheduler(harness, clock);
    scheduler.policies.set("codex-1", {
      id: "codex-1",
      profile: "full",
      capabilities: ["schedules", "tickets"],
      deniedActions: [],
    });
    const asCredential = (action: string, input: Record<string, unknown>, requestId?: string) =>
      harness.commands.get("public_action")!(
        withPublicAuthority(
          {
            schemaVersion: 1,
            action,
            actionVersion: 1,
            input,
            ...(requestId ? { request: { requestId } } : {}),
          },
          controlMcpAuthority("codex-1"),
        ),
        harness.context,
      ) as Promise<{ ok: boolean; result: Record<string, unknown>; error?: { code: string } }>;
    const project = (await harness.storage.loadProjects())[0]!;
    const ticket = await harness.call<{ ticketId: string }>(
      "ticket.create",
      { projectId: project.id, title: "Nightly" },
      { requestId: "schedule-ticket" },
    );
    if (!ticket.ok) throw new Error(ticket.error.message);

    const operator = await harness.call<{ scheduleId: string }>(
      "schedule.create",
      {
        cron: "0 3 * * *",
        name: "Nightly comment",
        action: {
          kind: "action",
          action: "ticket.comment",
          input: { projectId: project.id, ticketId: ticket.result.ticketId, text: "tick" },
        },
      },
      { requestId: "operator-schedule" },
    );
    if (!operator.ok) throw new Error(`${operator.error.code}: ${operator.error.message}`);
    const mine = await asCredential(
      "schedule.create",
      {
        everySeconds: 3600,
        action: {
          kind: "action",
          action: "ticket.comment",
          input: { projectId: project.id, ticketId: ticket.result.ticketId, text: "hourly" },
        },
      },
      "credential-schedule",
    );
    expect(mine.ok).toBe(true);
    // A credential cannot schedule what it could not run itself.
    const refused = await asCredential(
      "schedule.create",
      {
        at: "+1h",
        action: { kind: "action", action: "environment.delete", input: { environmentId: "env-1" } },
      },
      "credential-refused",
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "capability-unavailable" } });
    const listedByCredential = await asCredential("schedule.list", {});
    expect(
      (listedByCredential.result.schedules as ScheduledJobSummary[]).map((job) => job.id),
    ).toEqual([mine.result.scheduleId as string]);
    const hidden = await asCredential("schedule.get", { scheduleId: operator.result.scheduleId });
    expect(hidden).toMatchObject({ ok: false, error: { code: "not-found" } });

    const listed = await harness.call<{ schedules: ScheduledJobSummary[]; total: number }>(
      "schedule.list",
      {},
    );
    expect(listed.ok && listed.result.total).toBe(2);
    expect(listed.ok && listed.result.schedules.map((job) => job.ownerLabel).sort()).toEqual([
      "MCP: codex-1",
      "You",
    ]);

    for (const [action, requestId] of [
      ["schedule.pause", "p"],
      ["schedule.resume", "r"],
      ["schedule.run", "run"],
    ] as const) {
      const response = await harness.call(
        action,
        { scheduleId: operator.result.scheduleId },
        { requestId },
      );
      expect(response.ok).toBe(true);
    }
    await scheduler.fire();
    const got = await harness.call<{ schedule: ScheduledJob }>("schedule.get", {
      scheduleId: operator.result.scheduleId,
    });
    if (!got.ok) throw new Error(got.error.message);
    expect(got.result.schedule.fires).toMatchObject([{ kind: "manual", state: "succeeded" }]);
    const detail = await harness.call<{ commentCount: number }>("ticket.get", {
      projectId: project.id,
      ticketId: ticket.result.ticketId,
    });
    expect(detail.ok && detail.result.commentCount).toBe(1);

    // Revoking the credential pauses its schedule at the next fire.
    scheduler.policies.delete("codex-1");
    await harness.call(
      "schedule.run",
      { scheduleId: mine.result.scheduleId as string },
      { requestId: "run-revoked" },
    );
    await scheduler.fire();
    const revoked = scheduler.service.get({ kind: "operator" }, mine.result.scheduleId as string);
    expect(revoked).toMatchObject({ state: "paused", pausedReason: "authority-lost" });

    const deleted = await harness.call(
      "schedule.delete",
      { scheduleId: operator.result.scheduleId },
      { requestId: "d" },
    );
    expect(deleted.ok).toBe(true);
    const gone = await harness.call("schedule.get", { scheduleId: operator.result.scheduleId });
    expect(!gone.ok && gone.error.code).toBe("not-found");
  });

  test("refuses reads, schedule actions and invalid inputs before admission", async () => {
    const { harness } = await setup();
    attachScheduler(harness, { now: Date.now() });
    for (const action of [
      { kind: "action", action: "environment.list", input: {} },
      { kind: "action", action: "schedule.delete", input: { scheduleId: "sch_x" } },
      { kind: "action", action: "project.remove", input: { projectId: "p" } },
      { kind: "action", action: "ticket.comment", input: { nope: true } },
    ]) {
      const response = await harness.call(
        "schedule.create",
        { at: "+1h", action },
        { requestId: `bad-${action.action}` },
      );
      expect(response.ok).toBe(false);
      expect(response.receipt).toBeUndefined();
    }
    const twoTimes = await harness.call(
      "schedule.create",
      {
        at: "+1h",
        cron: "* * * * *",
        action: { kind: "action", action: "ticket.comment", input: {} },
      },
      { requestId: "two-times" },
    );
    expect(!twoTimes.ok && twoTimes.error.code).toBe("invalid-input");
  });
});

describe("agent schedules", () => {
  test("run as the agent's own tab: mail to the coordinator path, and a reminder to itself", async () => {
    const { harness, service: agents, stub } = await setup();
    await enableMessaging(harness);
    const agentTools = new AgentToolsServer(harness.storage);
    const clock = { now: Date.now() };
    const scheduler = attachScheduler(harness, clock, agentTools);
    const sender = await startIdleSession(harness, agents, stub, "agent-sender");
    const recipient = await startIdleSession(harness, agents, stub, "agent-recipient");
    await harness.storage.synchronizeAgentMailboxes();
    const project = (await harness.storage.loadProjects())[0]!;
    const scope = { environmentId: "env-1", projectId: project.id, tabId: sender.tabId };

    const tools = await agentTools.listToolsAs(scope);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["create_schedule", "list_schedules", "cancel_schedule"]),
    );

    const peer = await agentTools.callToolAs(scope, "create_schedule", {
      requestId: "peer-1",
      at: "+10m",
      action: {
        type: "send_message",
        toEnvironmentId: "env-1",
        toTabId: recipient.tabId,
        body: "peer ping",
      },
    });
    expect(peer.isError).toBe(false);
    const reminder = await agentTools.callToolAs(scope, "create_schedule", {
      requestId: "self-1",
      at: "+10m",
      action: { type: "send_message", toEnvironmentId: "env-1", body: "check CI again" },
    });
    expect(reminder.isError).toBe(false);
    // Agents cannot schedule what they cannot do: a read, or a schedule tool.
    const read = await agentTools.callToolAs(scope, "create_schedule", {
      requestId: "read-1",
      at: "+10m",
      action: { type: "tool", tool: "list_tickets", arguments: {} },
    });
    expect(read.isError).toBe(true);

    const listed = await agentTools.callToolAs(scope, "list_schedules", {});
    expect(listed.structuredContent!.schedules as unknown[]).toHaveLength(2);

    clock.now += 10 * 60_000;
    await scheduler.fire();
    await scheduler.fire();
    const jobs = scheduler.service.list({ kind: "operator" });
    expect(jobs.map((job) => [job.owner.kind, job.lastFire?.state])).toEqual([
      ["agent", "succeeded"],
      ["agent", "succeeded"],
    ]);
    // Listings carry metadata, not bodies: the sender and the fire's request key.
    const recipientInbox = await harness.storage.getAgentMailMailbox("env-1", recipient.tabId, {
      limit: 10,
    });
    expect(recipientInbox.messages).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ kind: "tab", tabId: sender.tabId }),
        requestId: expect.stringMatching(/^sched:sch_/),
        bodyBytes: Buffer.byteLength("peer ping"),
      }),
    ]);
    const ownInbox = await harness.storage.getAgentMailMailbox("env-1", sender.tabId, {
      limit: 10,
    });
    expect(ownInbox.messages).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ kind: "system", source: "workflow" }),
        subject: expect.stringContaining("Scheduled reminder"),
        requestId: expect.stringMatching(/^sched:sch_/),
      }),
    ]);

    const cancelled = await agentTools.callToolAs(scope, "cancel_schedule", {
      scheduleId: jobs[0]!.id,
    });
    expect(cancelled.structuredContent).toMatchObject({ deleted: true });
  });
});

function interruptSettlement(harness: PublicApiHarness) {
  const store = harness.storage.scheduledJobStore();
  const mutate = store.mutate.bind(store);
  return spyOn(store, "mutate").mockImplementation((id, update) =>
    mutate(id, (current) => {
      const next = update(current);
      if ("value" in next && next.value.fires.some((fire) => fire.state === "succeeded"))
        throw new Error("Simulated backend interruption before settlement");
      return next;
    }),
  );
}

test("public launch replay after admission uses its original commit after the branch advances", async () => {
  const { harness, stub } = await setup();
  const clock = { now: Date.now() };
  const scheduler = attachScheduler(harness, clock);
  const repository = await harness.createRepository("scheduled-replay");
  const originalCommit = await headCommit(repository.projectPath);
  const added = await harness.call<{ project: { id: string } }>(
    "project.add",
    { path: repository.projectPath },
    { requestId: "replay-add" },
  );
  if (!added.ok) throw new Error(added.error.message);
  // The default branch must be pinned too, even when no branch was supplied.
  const { job } = await scheduler.service.create(
    { kind: "operator" },
    {
      at: "+1m",
      action: {
        kind: "launch",
        projectId: added.result.project.id,
        type: "local",
        agent: "claude",
        prompt: "replay audit",
      },
    },
  );
  const interruption = interruptSettlement(harness);
  try {
    clock.now += 60_000;
    await scheduler.fire();
    expect(scheduler.service.get({ kind: "operator" }, job.id).fires[0]).toMatchObject({
      state: "running",
      outcome: { baseCommit: originalCommit },
    });
  } finally {
    interruption.mockRestore();
  }
  await waitFor(
    () => stub.sends.filter((send) => send.prompt.includes("replay audit")).length,
    (count) => count === 1,
  );
  const advanced = await commitFile(repository.projectPath, "README.md", "advanced branch");
  expect(advanced).not.toBe(originalCommit);
  await runCommand("git", ["push", "origin", "main"], { cwd: repository.projectPath });
  clock.now += SCHEDULED_JOB_LIMITS.fireStaleMs;
  await scheduler.fire();
  const fire = scheduler.service.get({ kind: "operator" }, job.id).fires[0]!;
  expect(fire).toMatchObject({
    state: "succeeded",
    attempts: 2,
    outcome: { baseCommit: originalCommit },
  });
  expect(stub.sends.filter((send) => send.prompt.includes("replay audit"))).toHaveLength(1);
  await expectOneNamingCall(harness, "replay audit");
  await harness.commands.get("delete_environment")!(
    { environmentId: fire.outcome!.environmentId },
    harness.context,
  );
});

test("environment-wide schedule credentials select a caller mailbox and tab credentials cannot impersonate siblings", async () => {
  const { harness, service: agents, stub, projectId } = await setup();
  await enableMessaging(harness);
  const tools = new AgentToolsServer(harness.storage);
  const scheduler = attachScheduler(harness, { now: Date.now() }, tools);
  const a = await startIdleSession(harness, agents, stub, "claim-a");
  const b = await startIdleSession(harness, agents, stub, "claim-b");
  await harness.storage.synchronizeAgentMailboxes();
  await tools.start();
  try {
    const environment = tools.connection("env-1", projectId, "host");
    const bound = tools.connection("env-1", projectId, "host", a.tabId);
    const call = async (
      credential: typeof environment,
      name: string,
      args: Record<string, unknown>,
    ) =>
      (await rpc(credential.url, credential.token, "tools/call", { name, arguments: args })).body
        .result!;
    const input = {
      requestId: "claimed",
      at: "+1h",
      action: { type: "send_message", toEnvironmentId: "coordinator", body: "wake" },
    };
    expect((await call(environment, "create_schedule", input)).isError).toBe(true);
    const created = await call(environment, "create_schedule", { ...input, tabId: b.tabId });
    expect(created.isError).not.toBe(true);
    const id = String(created.structuredContent!.scheduleId);
    expect(scheduler.service.get({ kind: "operator" }, id).owner).toMatchObject({
      kind: "agent",
      tabId: b.tabId,
    });
    expect(
      (await call(environment, "list_schedules", { tabId: b.tabId })).structuredContent!.total,
    ).toBe(1);
    for (const [name, args] of [
      ["create_schedule", input],
      ["list_schedules", {}],
      ["cancel_schedule", { scheduleId: id }],
    ] as const) {
      expect((await call(bound, name, { ...args, tabId: b.tabId })).isError).toBe(true);
    }
    expect(
      (await call(environment, "cancel_schedule", { scheduleId: id, tabId: b.tabId }))
        .structuredContent,
    ).toMatchObject({ deleted: true });
  } finally {
    await tools.stop();
  }
});

test("scheduled agent tickets and comments replay once after committed effects and interrupted settlement", async () => {
  const { harness, service: agents, stub, projectId } = await setup();
  await enableMessaging(harness);
  const tools = new AgentToolsServer(harness.storage);
  const clock = { now: Date.now() };
  const scheduler = attachScheduler(harness, clock, tools);
  const sender = await startIdleSession(harness, agents, stub, "ticket-owner");
  await harness.storage.synchronizeAgentMailboxes();
  const owner = { kind: "agent", environmentId: "env-1", projectId, tabId: sender.tabId } as const;
  const create = await scheduler.service.create(owner, {
    at: "+1m",
    action: { kind: "action", action: "create_ticket", input: { title: "Scheduled ticket" } },
  });
  let interruption = interruptSettlement(harness);
  try {
    clock.now += 60_000;
    await scheduler.fire();
  } finally {
    interruption.mockRestore();
  }
  expect(scheduler.service.get(owner, create.job.id).fires[0]!.state).toBe("running");
  let tickets = await harness.storage.kanban.getKanbanTasks(projectId);
  expect(tickets).toHaveLength(1);
  clock.now += SCHEDULED_JOB_LIMITS.fireStaleMs;
  await scheduler.fire();
  expect(scheduler.service.get(owner, create.job.id).fires[0]!.state).toBe("succeeded");
  tickets = await harness.storage.kanban.getKanbanTasks(projectId);
  expect(tickets).toHaveLength(1);
  const comment = await scheduler.service.create(owner, {
    at: "+1m",
    action: {
      kind: "action",
      action: "add_ticket_comment",
      input: { ticketId: tickets[0]!.id, text: "Once" },
    },
  });
  interruption = interruptSettlement(harness);
  try {
    clock.now += 60_000;
    await scheduler.fire();
  } finally {
    interruption.mockRestore();
  }
  expect(scheduler.service.get(owner, comment.job.id).fires[0]!.state).toBe("running");
  clock.now += SCHEDULED_JOB_LIMITS.fireStaleMs;
  await scheduler.fire();
  tickets = await harness.storage.kanban.getKanbanTasks(projectId);
  expect(tickets[0]!.comments).toHaveLength(1);
  expect(scheduler.service.get(owner, comment.job.id).fires[0]!.state).toBe("succeeded");
});

test("agent schedules survive credential teardown but lose authority when their mailbox tab is removed", async () => {
  const { harness, service: agents, stub, projectId } = await setup();
  await enableMessaging(harness);
  const tools = new AgentToolsServer(harness.storage);
  const clock = { now: Date.now() };
  const scheduler = attachScheduler(harness, clock, tools);
  const sender = await startIdleSession(harness, agents, stub, "teardown-owner");
  await harness.storage.synchronizeAgentMailboxes();
  const owner = { kind: "agent", environmentId: "env-1", projectId, tabId: sender.tabId } as const;
  const { job } = await scheduler.service.create(owner, {
    everySeconds: 60,
    action: {
      kind: "action",
      action: "send_message",
      input: { toEnvironmentId: "env-1", body: "reminder" },
    },
  });
  await tools.start();
  try {
    tools.connection("env-1", projectId, "host", sender.tabId);
    tools.revokeTab("env-1", sender.tabId);
    clock.now += 60_000;
    await scheduler.fire();
    expect(scheduler.service.get(owner, job.id).fires[0]!.state).toBe("succeeded");
    await harness.storage.deletePaneLayout("env-1");
    await harness.storage.synchronizeAgentMailboxes();
    clock.now += 60_000;
    await scheduler.fire();
    expect(scheduler.service.get(owner, job.id)).toMatchObject({
      state: "paused",
      pausedReason: "authority-lost",
    });
  } finally {
    await tools.stop();
  }
});
