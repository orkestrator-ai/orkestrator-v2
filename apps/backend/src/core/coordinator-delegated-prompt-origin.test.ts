import { afterEach, beforeEach, expect, test } from "bun:test";
import { COORDINATOR_MAIL_ORIGIN_NOTE } from "@orkestrator/protocol/agent-mail";
import type { CoordinatorTurnOrigin } from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_DELEGATION_PRESENTATION,
  coordinatorDelegationFromMail,
  createCoordinatorMailOriginPrompt,
  parseCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { coordinatorScopeTurnOrigin } from "./control-mcp/tools-shared.js";
import { coordinatorCallerTurnOrigin } from "./coordinator-turn-origin.js";
import { NativeAgentService } from "./native-agent-service.js";
import { createProviderStub } from "./native-agent-service-projection-test-support.js";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { ControlMcpServer } from "./control-mcp/server.js";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp/tools.js";
import { coordinatorDelegationPresentationFrom } from "./coordinator-delegation-authority.js";

/**
 * To-do 6080 task 5: `send_prompt_to_tab` and `launch_job` say when the
 * coordinator's turn arose from agent mail, as its mail does, and a
 * scheduled fire is framed from the turn that set the schedule.
 *
 * Real Control MCP tools and commands over real stores; only the provider
 * dispatch and the job launch are captured.
 */

let world: MailWorld;
let mcp: ControlMcpServer;
let commands: Map<string, CommandHandler>;
let scope: CoordinatorControlScope;
let worker: Awaited<ReturnType<MailWorld["addEnvironment"]>>;
let dispatched: Array<Record<string, unknown>>;
let jobs: Array<Record<string, unknown>>;

beforeEach(async () => {
  world = await MailWorld.create();
  commands = createCommandRegistry();
  const context = {
    storage: world.storage,
    coordinators: world.coordinator,
    runtime: new BackendRuntime({ emit: () => undefined }),
  } as unknown as CommandContext;
  mcp = new ControlMcpServer(
    world.root,
    async <T>(command: string, args = {}) => (await commands.get(command)!(args, context)) as T,
    { port: 0 },
  );
  await world.storage.updateGlobalConfig({
    ...(await world.storage.loadConfig()).global,
    enabledAgentPlatforms: ["codex", "claude"],
  });
  const snapshot = await world.coordinator.ensure(world.projectId);
  const conversation = snapshot.workspace.conversations[0]!;
  scope = {
    role: "coordinator",
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: conversation.id,
    mailboxIncarnationId: conversation.mailboxIncarnationId!,
    capabilities: coordinatorRoleCapabilities("main"),
  };
  worker = await world.addEnvironment("worker");
  // Delegation bookkeeping has its own suites; these tests read the prompt.
  commands.set("assert_coordinator_delegation_available", async () => ({ available: true }));
  commands.set("open_coordinator_delegation", async () => ({ opened: true }));
  commands.set("get_native_agent_model_catalog", async () => []);
  dispatched = [];
  commands.set("dispatch_native_agent_intent", async (args) => {
    dispatched.push(args);
    return { outcome: "dispatched" };
  });
  jobs = [];
  commands.set("launch_control_job", async (args) => {
    jobs.push(args);
    return { environmentId: worker.environmentId, tabId: "job-tab", status: "accepted" };
  });
});

afterEach(async () => {
  await mcp.stop();
  await world.close();
});

async function setLastTurnOrigin(origin: CoordinatorTurnOrigin | undefined): Promise<void> {
  await world.storage.coordinators.mutateCoordinatorWorkspace(world.projectId, (workspace) => ({
    ...workspace!,
    conversations: workspace!.conversations.map((conversation) =>
      conversation.id === scope.conversationId
        ? { ...conversation, lastTurnOrigin: origin }
        : conversation,
    ),
  }));
}

async function promptSent(
  prompt: string,
  callScope: CoordinatorControlScope = scope,
): Promise<string> {
  const result = await mcp.callCoordinatorTool(callScope, "send_prompt_to_tab", {
    requestId: crypto.randomUUID(),
    environmentId: worker.environmentId,
    tabId: worker.tabId,
    prompt,
  });
  expect(result.isError).toBe(false);
  return String(dispatched.at(-1)!.prompt);
}

async function jobLaunched(prompt: string): Promise<Record<string, unknown>> {
  const result = await mcp.callCoordinatorTool(scope, "launch_job", {
    requestId: crypto.randomUUID(),
    environmentId: worker.environmentId,
    agent: "codex",
    prompt,
  });
  expect({ isError: result.isError, text: result.isError ? result.text : "ok" }).toEqual({
    isError: false,
    text: "ok",
  });
  return jobs.at(-1)!;
}

test("send_prompt_to_tab from a mail turn carries the note-only frame", async () => {
  await setLastTurnOrigin("mail");
  const sent = await promptSent("Continue with step two.");
  expect(sent).toBe(createCoordinatorMailOriginPrompt("Continue with step two.").source);
  expect(sent).toContain(COORDINATOR_MAIL_ORIGIN_NOTE);
});

test("send_prompt_to_tab with no recorded turn origin is not the user's either", async () => {
  await setLastTurnOrigin(undefined);
  expect(await promptSent("Run it")).toContain(COORDINATOR_MAIL_ORIGIN_NOTE);
});

test("send_prompt_to_tab from the user's turn is sent exactly as written", async () => {
  await setLastTurnOrigin("user");
  expect(await promptSent("Run it")).toBe("Run it");
});

test("launch_job from a mail turn ends its delegation frame with the note", async () => {
  await setLastTurnOrigin("mail");
  const args = await jobLaunched("Investigate the failing test");
  const parsed = parseCoordinatorDelegatedPrompt(String(args.prompt));
  expect(parsed?.source).toBe("Investigate the failing test");
  expect(coordinatorDelegationFromMail(parsed!.frame)).toBe(true);
  // The stored presentation is the same frame, so the transcript hides it.
  expect(coordinatorDelegationPresentationFrom(args)).toEqual({
    kind: COORDINATOR_DELEGATION_PRESENTATION,
    frame: parsed!.frame,
  });
});

test("launch_job from the user's turn has no note", async () => {
  await setLastTurnOrigin("user");
  const args = await jobLaunched("Investigate the failing test");
  const parsed = parseCoordinatorDelegatedPrompt(String(args.prompt));
  expect(parsed?.source).toBe("Investigate the failing test");
  expect(coordinatorDelegationFromMail(parsed!.frame)).toBe(false);
});

test("a scheduled fire uses the origin it carries, not the newest turn", async () => {
  // Set by the user, fired after a mail turn: the user's.
  await setLastTurnOrigin("mail");
  expect(await promptSent("Nightly check", { ...scope, turnOrigin: "user" })).toBe("Nightly check");
  // Set from mail, fired after the user's turn: still from mail.
  await setLastTurnOrigin("user");
  expect(await promptSent("Nightly check", { ...scope, turnOrigin: "mail" })).toContain(
    COORDINATOR_MAIL_ORIGIN_NOTE,
  );
});

test("scheduled mail uses the origin it carries, not the newest turn", async () => {
  const send = async (callScope: CoordinatorControlScope) => {
    const subject = `Status ${crypto.randomUUID()}`;
    const result = await mcp.callCoordinatorTool(callScope, "send_message", {
      requestId: crypto.randomUUID(),
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      subject,
      body: "Status?",
    });
    expect(result.isError).toBe(false);
    return (await world.undelivered(worker)).find((message) => message.subject === subject)!;
  };
  await setLastTurnOrigin("mail");
  expect("turnOrigin" in (await send({ ...scope, turnOrigin: "user" })).from).toBe(false);
  await setLastTurnOrigin("user");
  expect((await send({ ...scope, turnOrigin: "mail" })).from).toMatchObject({
    kind: "coordinator",
    turnOrigin: "mail",
  });
  // Without a carried origin, the newest turn decides, as before.
  expect("turnOrigin" in (await send(scope)).from).toBe(false);
});

for (const snapshot of [
  null,
  { workspace: { id: "wrong", conversations: [] } },
  { workspace: { id: "coordinator", conversations: [] } },
]) {
  test(`MCP origin fails closed for absent or mismatched coordinator: ${JSON.stringify(snapshot)}`, async () => {
    const value =
      snapshot?.workspace.id === "coordinator"
        ? { workspace: { id: scope.coordinatorId, conversations: [] } }
        : snapshot;
    expect(await coordinatorScopeTurnOrigin(async <T>() => value as T, scope)).toBe("mail");
  });
}

test("MCP origin read failure marks mail and logs the diagnostic", async () => {
  const capture = captureLogs();
  try {
    expect(
      await coordinatorScopeTurnOrigin(async () => {
        throw new Error("unavailable");
      }, scope),
    ).toBe("mail");
    expect(
      capture.records().some((entry) => entry.event === "delegation.turn-origin-unreadable"),
    ).toBe(true);
  } finally {
    capture.restore();
  }
});

test("registry origin fails closed for missing workspace or conversation", async () => {
  const context = { storage: world.storage };
  expect(
    await coordinatorCallerTurnOrigin(
      context,
      { coordinatorId: "missing", conversationId: scope.conversationId },
      undefined,
    ),
  ).toBe("mail");
  expect(
    await coordinatorCallerTurnOrigin(
      context,
      { coordinatorId: scope.coordinatorId, conversationId: "missing" },
      undefined,
    ),
  ).toBe("mail");
});

for (const firstOrigin of ["user", "mail"] as const) {
  test(`launch_job retry retains persisted ${firstOrigin} provenance after an origin change`, async () => {
    const provider = createProviderStub("codex");
    const service = new NativeAgentService(
      world.storage,
      async () => {
        throw new Error("Unexpected invoke");
      },
      { provider: async () => provider.provider },
    );
    const context = {
      storage: world.storage,
      runtime: new BackendRuntime({ emit: () => undefined }),
      emit: () => undefined,
      nativeAgents: service,
    } as unknown as CommandContext;
    try {
      const handler = createCommandRegistry().get("launch_control_job")!;
      commands.set("launch_control_job", (args) => handler(args, context));
      const input = {
        requestId: crypto.randomUUID(),
        environmentId: worker.environmentId,
        agent: "codex",
        prompt: "Check the fixture",
      };
      await setLastTurnOrigin(firstOrigin);
      const first = await mcp.callCoordinatorTool(scope, "launch_job", input);
      expect({ error: first.isError, text: first.isError ? first.text : "ok" }).toEqual({
        error: false,
        text: "ok",
      });
      await setLastTurnOrigin(firstOrigin === "user" ? "mail" : "user");
      const retry = await mcp.callCoordinatorTool(scope, "launch_job", input);
      expect({ error: retry.isError, text: retry.isError ? retry.text : "ok" }).toEqual({
        error: false,
        text: "ok",
      });
      expect(provider.send).toHaveBeenCalledTimes(1);
      const sent = String(provider.send.mock.calls[0]![1]);
      expect(sent.includes(COORDINATOR_MAIL_ORIGIN_NOTE)).toBe(firstOrigin === "mail");
    } finally {
      await service.shutdown();
    }
  });
}

test("send_prompt_to_tab retries retain the request identity across origin changes", async () => {
  const input = {
    requestId: crypto.randomUUID(),
    environmentId: worker.environmentId,
    tabId: worker.tabId,
    prompt: "Continue",
  };
  const provider = createProviderStub("claude");
  const service = new NativeAgentService(
    world.storage,
    async () => {
      throw new Error("Unexpected invoke");
    },
    { provider: async () => provider.provider },
  );
  commands.set("dispatch_native_agent_intent", (args) => service.dispatchIntent(args as never));
  try {
    await setLastTurnOrigin("user");
    expect((await mcp.callCoordinatorTool(scope, "send_prompt_to_tab", input)).isError).toBe(false);
    await setLastTurnOrigin("mail");
    expect((await mcp.callCoordinatorTool(scope, "send_prompt_to_tab", input)).isError).toBe(false);
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send.mock.calls[0]![1]).toBe("Continue");
  } finally {
    await service.shutdown();
  }
});
