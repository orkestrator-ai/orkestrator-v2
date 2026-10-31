import { afterEach, describe, expect, type mock, spyOn, test } from "bun:test";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { NativeAgentSlashCommand } from "@orkestrator/protocol/native-agent";
import type { CommandContext } from "./commands-context.js";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp-tools.js";
import { ControlMcpServer } from "./control-mcp-server.js";
import { CoordinatorService } from "./coordinator-service.js";
import type { ProviderCommandCatalogue, ProviderSendOptions } from "./native-agent-provider.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./public-api/test-provider.js";
import { createEnvironment } from "./storage.js";

/**
 * The coordinator's worker-turn tools on this node, over the real command
 * registry, storage, native-agent service, dispatch journal and coordinator
 * delegations, with a scripted provider: stop a running turn (and what that
 * does to an open delegation), list a tab's slash commands and run one.
 */

afterEach(cleanupSessionHarnesses);

const controls = new Set<ControlMcpServer>();
afterEach(async () => {
  for (const server of controls) await server.stop();
  controls.clear();
});

function command(name: string, extra: Partial<NativeAgentSlashCommand> = {}) {
  return {
    name,
    source: "project" as const,
    id: `claude:${name}`,
    executionKind: "provider-prompt" as const,
    bindingRevision: `rev:${name}`,
    description: `Run ${name}`,
    ...extra,
  };
}

async function world(catalogue: NativeAgentSlashCommand[] = [command("/review")]) {
  const context = await setup();
  const { harness, service, stub, projectId } = context;
  Object.assign(stub.provider, {
    commandCatalogue: async (): Promise<ProviderCommandCatalogue> => ({
      enhanced: true,
      status: "ready",
      commands: catalogue,
    }),
  });
  // A coordinator needs a checkout to read; the worker stays env-1.
  const repository = await harness.createRepository("coordinated");
  await harness.storage.updateProject(projectId, { localPath: repository.projectPath });
  const coordinators = new CoordinatorService(harness.storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  (harness.context as { coordinators?: CoordinatorService }).coordinators = coordinators;
  const snapshot = await coordinators.ensure(projectId);
  const conversation = snapshot.workspace.conversations[0]!;
  const scope = {
    projectId,
    coordinatorId: snapshot.workspace.id,
    conversationId: conversation.id,
  };
  const started = await harness.call<{ sessionId: string; tabId: string; runId: string }>(
    "session.start",
    { environmentId: "env-1", agent: "claude", prompt: "hello" },
    { requestId: "start" },
  );
  if (!started.ok) throw new Error(started.error.message);
  const providerSessionId = stub.sends[0]!.sessionId;
  const tabId = started.result.tabId;
  const run = <T = Record<string, unknown>>(name: string, args: Record<string, unknown>) =>
    harness.commands.get(name)!(
      { scope, ...args },
      harness.context as CommandContext,
    ) as Promise<T>;
  const activity = (state: "idle" | "working" | "waiting") =>
    setActivity(service, "claude", tabId, providerSessionId, state);
  const coordinatorMail = async () => {
    const address = coordinatorRuntimeId(scope.coordinatorId, scope.conversationId);
    const listed = await harness.storage.getAgentMailMailbox(address, conversation.tabId);
    return Promise.all(
      listed.messages.map((message) =>
        harness.storage.getAgentMailMessage(address, conversation.tabId, message.id),
      ),
    );
  };
  const openDelegations = async () =>
    (await harness.storage.coordinators.listOpenCoordinatorDelegations()).filter(
      (association) => association.delegation?.workerTabId === tabId,
    );
  const sendOptions = () =>
    (stub.provider.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => call[2] as ProviderSendOptions,
    );
  return {
    ...context,
    coordinators,
    scope,
    tabId,
    runId: started.result.runId,
    run,
    activity,
    coordinatorMail,
    openDelegations,
    sendOptions,
    conversation,
  };
}

describe("stop_worker_turn", () => {
  test("a delegation on a turn whose stop is not confirmed yet settles on the turn end", async () => {
    const w = await world();
    w.activity("working");
    await w.run("open_coordinator_delegation", {
      environmentId: "env-1",
      tabId: w.tabId,
      requestId: "job-slow",
    });
    const stopped = await w.run("stop_coordinator_worker_turn", {
      input: { requestId: "stop-slow", environmentId: "env-1", tabId: w.tabId },
    });
    // The scripted turn still reads as running after the abort.
    expect(stopped).toMatchObject({ stopped: true, acknowledged: false, delegationOpen: true });
    const [open] = await w.openDelegations();
    expect(open?.delegation?.stopRequestedAt).toBeString();
    expect(await w.coordinatorMail()).toHaveLength(0);
    // The turn-end edge settles it as any other, without the background-work hold.
    w.activity("idle");
    await w.coordinators.settleWorkerDelegations({
      environmentId: "env-1",
      tabId: w.tabId,
      state: "completed",
    });
    expect(await w.openDelegations()).toHaveLength(0);
    const mail = await w.coordinatorMail();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.body).toContain("because you stopped its turn with stop_worker_turn");
    await expect(
      w.run("assert_coordinator_delegation_available", {
        environmentId: "env-1",
        tabId: w.tabId,
        requestId: "after-slow-stop",
      }),
    ).resolves.toEqual({ available: true });
  });

  test("stops the running turn, cancels its run, and wakes the waiting coordinator once", async () => {
    const w = await world();
    w.activity("working");
    // A provider that confirms the stop: its projection reads idle once aborted.
    const abort = w.stub.provider.abort as unknown as ReturnType<typeof mock>;
    const stopOnce = w.service.stopProjectionSession.bind(w.service);
    spyOn(w.service, "stopProjectionSession").mockImplementation(async (input) => {
      const projection = await stopOnce(input);
      w.activity("idle");
      return projection && { ...projection, turn: { ...projection.turn, phase: "idle" } };
    });
    await w.run("open_coordinator_delegation", {
      environmentId: "env-1",
      tabId: w.tabId,
      requestId: "job-1",
    });
    expect(await w.openDelegations()).toHaveLength(1);
    const input = { requestId: "stop-1", environmentId: "env-1", tabId: w.tabId };

    const stopped = await w.run("stop_coordinator_worker_turn", { input });
    expect(stopped).toMatchObject({
      environmentId: "env-1",
      tabId: w.tabId,
      stopped: true,
      acknowledged: true,
      turn: "idle",
      runId: w.runId,
      delegationOpen: true,
    });
    expect(abort).toHaveBeenCalledTimes(1);
    // The shared stop path marked the public run, so it settles as cancelled.
    const record = await w.harness.storage.publicOperations.getPublicOperation(w.runId);
    expect(record.status === "found" && record.record.stopRequestedAt).toBeTruthy();
    w.activity("idle");
    const receipt = await w.harness.call<{ state: string }>("run.get", { operationId: w.runId });
    expect(receipt.receipt?.state).toBe("cancelled");

    // The acknowledged stop settled the delegation at once, as the turn end would.
    expect(await w.openDelegations()).toHaveLength(0);
    const settled = (
      await w.harness.storage.coordinators.listCoordinatorWorkflowAssociations(w.scope.projectId)
    ).find((association) => association.delegation?.workerTabId === w.tabId)!;
    expect(settled.delegation).toMatchObject({ state: "completed", wakeKind: "notice" });
    expect(settled.delegation?.stopRequestedAt).toBeString();
    expect(settled.delegation?.wokenAt).toBeString();
    // A second turn-end edge for the same turn changes nothing.
    await w.coordinators.settleWorkerDelegations({
      environmentId: "env-1",
      tabId: w.tabId,
      state: "completed",
    });
    const mail = await w.coordinatorMail();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toContain("stopped");
    expect(mail[0]!.body).toContain("because you stopped its turn with stop_worker_turn");
    expect(mail[0]!.body).not.toContain("hello");

    // A later prompt to the tab is not refused over the stopped delegation.
    await expect(
      w.run("assert_coordinator_delegation_available", {
        environmentId: "env-1",
        tabId: w.tabId,
        requestId: "next-task",
      }),
    ).resolves.toEqual({ available: true });

    // The same request replays; it never stops a later turn.
    w.activity("working");
    expect(await w.run("stop_coordinator_worker_turn", { input })).toMatchObject({
      stopped: true,
      replayed: true,
    });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test("an idle tab answers plainly, and nothing is marked or stopped", async () => {
    const w = await world();
    w.activity("idle");
    await w.run("open_coordinator_delegation", {
      environmentId: "env-1",
      tabId: w.tabId,
      requestId: "job-idle",
    });
    const answer = await w.run("stop_coordinator_worker_turn", {
      input: { requestId: "stop-idle", environmentId: "env-1", tabId: w.tabId },
    });
    expect(answer).toMatchObject({ stopped: false, turn: "idle" });
    expect(String(answer.note)).toContain("not an error");
    expect(w.stub.provider.abort).not.toHaveBeenCalled();
    const [open] = await w.openDelegations();
    expect(open?.delegation?.stopRequestedAt).toBeUndefined();
  });

  test("refuses terminal tabs, the project home and other projects' environments", async () => {
    const w = await world();
    const layout = (await w.harness.storage.getPaneLayout("env-1"))!;
    const root = layout.root as { tabs: Array<Record<string, unknown>> };
    root.tabs.push({ id: "shell", type: "plain" }, { id: "tmux", type: "claude-tmux" });
    await w.harness.storage.savePaneLayout("env-1", layout, layout.revision);
    for (const [tabId, kind] of [
      ["shell", "terminal"],
      ["tmux", "Claude tmux"],
    ] as const) {
      await expect(
        w.run("stop_coordinator_worker_turn", {
          input: { requestId: `stop-${tabId}`, environmentId: "env-1", tabId },
        }),
      ).rejects.toThrow(`is a ${kind} tab, not a native agent tab`);
    }
    await expect(
      w.run("stop_coordinator_worker_turn", {
        input: { requestId: "stop-missing", environmentId: "env-1", tabId: "nope" },
      }),
    ).rejects.toThrow("list_tabs");
    const home = createEnvironment(w.projectId, { name: "home", environmentType: "local" });
    Object.assign(home, { status: "running", setupPhase: "ready", projectHome: true });
    await w.harness.storage.addEnvironment(home);
    await expect(
      w.run("stop_coordinator_worker_turn", {
        input: { requestId: "stop-home", environmentId: home.id, tabId: w.tabId },
      }),
    ).rejects.toThrow("project checkout");
    expect(w.stub.provider.abort).not.toHaveBeenCalled();
  });
});

describe("worker slash commands", () => {
  test("lists a tab's commands without live-turn commands", async () => {
    const w = await world([
      command("/review", { inputPolicy: { arguments: "required" } }),
      command("/help", { executionKind: "bridge-local" }),
    ]);
    w.activity("idle");
    const listed = await w.run<{ commands: Array<{ id: string }>; catalogue: { status: string } }>(
      "list_coordinator_worker_commands",
      { input: { environmentId: "env-1", tabId: w.tabId, refresh: true } },
    );
    expect(listed.catalogue.status).toBe("ready");
    const ids = listed.commands.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["claude:/review", "claude:/help"]));
    expect(ids).toContain("orkestrator:compact");
    expect(ids).not.toContain("orkestrator:steer");
    expect(JSON.stringify(listed)).not.toContain("executionKind");
  });

  test("a turn-starting command runs as a selection and opens one delegation", async () => {
    const w = await world([command("/review", { inputPolicy: { arguments: "required" } })]);
    w.activity("idle");
    const input = {
      requestId: "review-1",
      environmentId: "env-1",
      tabId: w.tabId,
      command: "review",
      arguments: "the open  diff",
    };
    const ran = await w.run("run_coordinator_worker_command", { input });
    expect(ran).toMatchObject({
      commandId: "claude:/review",
      command: "/review",
      startsTurn: true,
      outcome: "accepted",
      delegationOpened: true,
    });
    expect(w.stub.sends.at(-1)?.prompt).toBe("/review the open  diff");
    expect(String(w.stub.sends.at(-1)?.requestId)).toStartWith("coordinator-command:");
    expect(w.sendOptions().at(-1)?.command).toMatchObject({ id: "claude:/review" });
    expect(await w.openDelegations()).toHaveLength(1);
    // A retry replays; a second request while the coordinator waits is refused.
    expect(await w.run("run_coordinator_worker_command", { input })).toMatchObject({
      replayed: true,
    });
    expect(w.stub.sends).toHaveLength(2);
    await expect(
      w.run("run_coordinator_worker_command", { input: { ...input, requestId: "review-2" } }),
    ).rejects.toThrow("outstanding coordinator delegation");
  });

  test("a command that answers without a turn opens no delegation", async () => {
    const w = await world([command("/help", { executionKind: "bridge-local" })]);
    w.activity("idle");
    const ran = await w.run("run_coordinator_worker_command", {
      input: { requestId: "help", environmentId: "env-1", tabId: w.tabId, command: "/help" },
    });
    expect(ran).toMatchObject({ startsTurn: false, outcome: "accepted", delegationOpened: false });
    expect(await w.openDelegations()).toHaveLength(0);
  });

  test("keeps session.command's refusals and refuses /steer", async () => {
    const w = await world([
      command("/review", { inputPolicy: { arguments: "required" } }),
      command("/gone", {
        availability: { state: "unavailable", reason: "disabled", message: "Disabled here" },
      }),
    ]);
    w.activity("idle");
    const attempt = (requestId: string, extra: Record<string, unknown>) =>
      w.run("run_coordinator_worker_command", {
        input: { requestId, environmentId: "env-1", tabId: w.tabId, ...extra },
      });
    await expect(attempt("a", { command: "steer", arguments: "focus" })).rejects.toThrow(
      "deliverNow",
    );
    await expect(attempt("b", { command: "/nope" })).rejects.toThrow("list_worker_commands");
    await expect(attempt("c", { command: "/review" })).rejects.toThrow("needs arguments");
    await expect(attempt("d", { command: "/gone" })).rejects.toThrow("Disabled here");
    await expect(
      attempt("e", { command: "/review", arguments: "x", expectedBindingRevision: "old" }),
    ).rejects.toThrow("changed since it was listed");
    w.activity("working");
    await expect(attempt("f", { command: "/review", arguments: "x" })).rejects.toThrow("busy");
    expect(w.stub.sends).toHaveLength(1);
  });
});

test("the worker-turn tools are the main coordinator's, never a side agent's", async () => {
  const w = await world();
  const server = new ControlMcpServer(
    w.harness.root,
    async <T>(name: string, args: Record<string, unknown> = {}) =>
      (await w.harness.commands.get(name)!(args, w.harness.context as CommandContext)) as T,
  );
  controls.add(server);
  const side = await w.coordinators.createConversation(w.projectId);
  const sideConversation = side.workspace.conversations.find((item) => item.role === "side")!;
  const scope = (conversation: typeof w.conversation, role: "main" | "side") =>
    ({
      role: "coordinator",
      ...w.scope,
      conversationId: conversation.id,
      mailboxIncarnationId: conversation.mailboxIncarnationId!,
      capabilities: coordinatorRoleCapabilities(role),
    }) satisfies CoordinatorControlScope;
  const names = async (value: CoordinatorControlScope) =>
    ((await server.listCoordinatorTools(value)) as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
  const tools = ["stop_worker_turn", "list_worker_commands", "run_worker_command"];
  const main = await names(scope(w.conversation, "main"));
  for (const tool of tools) expect(main).toContain(tool);
  const sideTools = await names(scope(sideConversation, "side"));
  for (const tool of tools) expect(sideTools).not.toContain(tool);
  const refused = await server.callCoordinatorTool(
    scope(sideConversation, "side"),
    "stop_worker_turn",
    { requestId: "side", environmentId: "env-1", tabId: w.tabId },
  );
  expect(refused.isError).toBe(true);
  // Through the MCP tool an idle answer is a plain result, not an error.
  w.activity("idle");
  const idle = await server.callCoordinatorTool(scope(w.conversation, "main"), "stop_worker_turn", {
    requestId: "main-idle",
    environmentId: "env-1",
    tabId: w.tabId,
  });
  expect(idle.isError).toBe(false);
  expect(idle.structuredContent).toMatchObject({ stopped: false, turn: "idle" });
});
