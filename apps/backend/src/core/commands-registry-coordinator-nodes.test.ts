/**
 * A coordinator acting on a node it controls, over the real coordinator
 * store: receipts, associations and delegations are kept here with the
 * node's ID, and the work is routed to the node (simulated).
 */
import { registrarFrom } from "./commands-registry-contracts.js";
import { afterEach, describe, expect, test } from "bun:test";
import { incompatibility, unsupportedField } from "@orkestrator/protocol/contract/errors";

import { MailWorld } from "./agent-mail-world-test-support.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerCoordinatorNodeCommands } from "./commands-registry-coordinator-nodes.js";
import { registerControllerWorkflowCommands } from "./commands-registry-controller-workflows.js";
import { registerNodeCommands } from "./commands-registry-nodes.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { CoordinatorRequestFlights } from "./coordinator-request-flights.js";
import { NodeCoordination } from "./nodes/node-coordination.js";
import { NodeCoordinatorRemote } from "./nodes/node-coordinator-remote.js";

const worlds: MailWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

const BASE = "b".repeat(40);

/** A Multi Review record the node reports, valid as the protocol reads it. */
function review(id: string, phase: string) {
  const at = new Date().toISOString();
  const row = { agent: "codex", model: "gpt-5.6-codex" };
  return {
    id,
    version: 1,
    controller: "backend",
    environmentId: "leaf-env",
    projectId: "p-leaf",
    targetBranch: "main",
    reviewers: [{ ...row, id: "reviewer-0", status: "pending" }],
    fixModel: row,
    phase,
    backendRevision: 0,
    createdAt: at,
    updatedAt: at,
  };
}

async function setup(
  options: {
    available?: boolean;
    hasCopy?: boolean;
    leafProjectId?: string;
    answers?: Record<string, unknown>;
    /** The leaf's hello capabilities; the default is a leaf from before node-mail-steer. */
    capabilities?: Record<string, number>;
    /** The leaf's hello `domains` (plan item 1010); absent is a pre-contract leaf. */
    domains?: Record<string, { min: number; max: number }>;
  } = {},
) {
  const world = await MailWorld.create({ statusWakes: { coalesceMs: 0 } });
  worlds.push(world);
  await world.storage.updateProject(world.projectId, { gitUrl: "git@github.com:acme/site.git" });
  const main = await world.main();
  const routed: Array<{
    command: string;
    args: Record<string, unknown>;
    requestKey?: string;
    envelope?: unknown;
  }> = [];
  let unknownOnce: string | null = null;
  const answers: Record<string, unknown> = {
    get_environment: { id: "leaf-env", projectId: "p-leaf", name: "leaf-env", status: "running" },
    create_controller_environment: { id: "leaf-env", status: "stopped" },
    deliver_node_mail: { messageId: "m1", toTabId: "startup-agent" },
    start_controller_build_pipeline: (args: Record<string, unknown>) => ({
      id: "pipeline-leaf",
      projectId: "p-leaf",
      environmentId: "leaf-env",
      coordinatorLaunchId: args.coordinatorLaunchId,
    }),
    get_build_pipeline: { snapshot: { id: "pipeline-leaf", projectId: "p-leaf" }, revision: 1 },
    ...options.answers,
  };
  const context = {
    storage: world.storage,
    coordinators: world.coordinator,
    runtime: { coordinatorRequests: new CoordinatorRequestFlights() },
    nodes: {
      status: async () => ({ nodeId: "bk_cmd", mode: "command" }),
      link: (nodeId: string) =>
        nodeId === "bk_leaf"
          ? {
              hello: {
                capabilities: options.capabilities ?? {
                  "node-attachment": 1,
                  "node-coordinator-build-origin": 1,
                },
                ...(options.domains ? { domains: options.domains } : {}),
              },
            }
          : null,
    },
    nodePortal: {
      summaries: async () => ({
        selfId: "bk_cmd",
        nodes: [
          {
            nodeId: "bk_leaf",
            available: options.available ?? true,
            view: { displayName: "Build box" },
            projects:
              options.hasCopy === false
                ? []
                : [
                    {
                      ref: { projectId: options.leafProjectId ?? "p-leaf" },
                      repositoryHint: "github.com/acme/site",
                    },
                  ],
          },
        ],
      }),
      invokeOnNode: async (
        input: {
          command: string;
          args: Record<string, unknown>;
          requestKey?: string;
        },
        options?: { envelope?: unknown },
      ) => {
        routed.push(options?.envelope ? { ...input, envelope: options.envelope } : input);
        if (unknownOnce === input.command) {
          unknownOnce = null;
          return { outcome: "unknown" };
        }
        const answer = answers[input.command];
        return {
          outcome: "ok",
          result: typeof answer === "function" ? await answer(input.args) : answer,
        };
      },
    },
  } as unknown as CommandContext;
  const commands = new Map<string, CommandHandler>();
  registerCoordinatorNodeCommands(registrarFrom((name, handler) => commands.set(name, handler)));
  const scope = {
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: main.conversationId!,
  };
  const run = (name: string, args: Record<string, unknown>) =>
    commands.get(name)!(args, context) as Promise<Record<string, unknown>>;
  const associations = async () =>
    (await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)).filter(
      (entry) => entry.nodeId === "bk_leaf",
    );
  return {
    world,
    main,
    scope,
    run,
    routed,
    associations,
    context,
    loseNext: (command: string) => {
      unknownOnce = command;
    },
  };
}

const launchInput = (projectId: string) => ({
  projectId,
  initialPrompt: "Fix the parser",
  environmentType: "local",
  delegationBaseBranch: "main",
  delegationBaseCommit: BASE,
});

describe("launch_coordinator_node_environment", () => {
  test("creates on the node's copy, records where reports go, starts it and opens the delegation", async () => {
    const { run, routed, scope, main, associations } = await setup();

    const result = await run("launch_coordinator_node_environment", {
      scope,
      requestId: "launch-1",
      nodeId: "bk_leaf",
      input: launchInput(scope.projectId),
    });

    expect(result).toMatchObject({ coordinatorDelegationOpened: true });
    const create = routed.find((entry) => entry.command === "create_controller_environment")!;
    expect(create.args.input).toMatchObject({ projectId: "p-leaf" });
    expect(String((create.args.input as { initialPrompt: string }).initialPrompt)).toContain(
      'send_message to toEnvironmentId "coordinator"',
    );
    expect(create.args.presentation).toMatchObject({ kind: expect.any(String) });
    expect(
      routed.find((entry) => entry.command === "record_node_environment_origin")!.args,
    ).toEqual({
      environmentId: "leaf-env",
      controllerId: "bk_cmd",
      coordinatorEnvironmentId: main.environmentId,
      coordinatorTabId: main.tabId,
    });
    expect(routed.some((entry) => entry.command === "start_environment_background")).toBe(true);
    const [association] = await associations();
    expect(association).toMatchObject({
      kind: "environment",
      resourceId: "leaf-env",
      nodeId: "bk_leaf",
      pending: false,
      baseCommit: BASE,
      delegation: {
        state: "running",
        workerTabId: "startup-agent",
        request: { summary: "Fix the parser", source: "default" },
      },
    });

    // A retry of the same request finds the first launch.
    const creates = routed.filter((entry) => entry.command === "create_controller_environment");
    const replay = await run("launch_coordinator_node_environment", {
      scope,
      requestId: "launch-1",
      nodeId: "bk_leaf",
      input: launchInput(scope.projectId),
    });
    expect(routed.filter((entry) => entry.command === "create_controller_environment")).toEqual(
      creates,
    );
    expect(replay.replayed).toBe(true);
    expect(await associations()).toHaveLength(1);
  });

  test("a lost answer leaves the receipt pending and says the outcome is unknown", async () => {
    const { run, scope, loseNext, associations } = await setup();
    loseNext("create_controller_environment");

    await expect(
      run("launch_coordinator_node_environment", {
        scope,
        requestId: "launch-2",
        nodeId: "bk_leaf",
        input: launchInput(scope.projectId),
      }),
    ).rejects.toThrow("outcome is unknown");
    const [association] = await associations();
    expect(association?.pending).toBe(true);
  });

  test("a lost start answer for a worker the node did start still opens the delegation", async () => {
    const { run, scope, loseNext, associations } = await setup();
    loseNext("start_environment_background");

    const result = await run("launch_coordinator_node_environment", {
      scope,
      requestId: "launch-lost-start",
      nodeId: "bk_leaf",
      input: launchInput(scope.projectId),
    });

    expect(result.startError).toBeUndefined();
    expect(result).toMatchObject({ coordinatorDelegationOpened: true });
    const [association] = await associations();
    expect(association?.delegation).toMatchObject({ state: "running" });
  });

  test("a lost start answer for a worker that is still stopped reports the start error", async () => {
    const { run, scope, loseNext, associations } = await setup({
      answers: {
        get_environment: {
          id: "leaf-env",
          projectId: "p-leaf",
          name: "leaf-env",
          status: "stopped",
        },
      },
    });
    loseNext("start_environment_background");

    const result = await run("launch_coordinator_node_environment", {
      scope,
      requestId: "launch-lost-start-stopped",
      nodeId: "bk_leaf",
      input: launchInput(scope.projectId),
    });

    expect(String(result.startError)).toContain("outcome is unknown");
    expect(result).toMatchObject({ coordinatorDelegationOpened: false });
    const [association] = await associations();
    expect(association?.delegation).toBeUndefined();
  });

  test("refuses a node without a copy, a disconnected node and this node", async () => {
    const noCopy = await setup({ hasCopy: false });
    await expect(
      noCopy.run("launch_coordinator_node_environment", {
        scope: noCopy.scope,
        requestId: "x",
        nodeId: "bk_leaf",
        input: launchInput(noCopy.scope.projectId),
      }),
    ).rejects.toThrow("request_project_on_node");
    const down = await setup({ available: false });
    await expect(
      down.run("launch_coordinator_node_environment", {
        scope: down.scope,
        requestId: "x",
        nodeId: "bk_leaf",
        input: launchInput(down.scope.projectId),
      }),
    ).rejects.toThrow("not connected");
    await expect(
      down.run("launch_coordinator_node_environment", {
        scope: down.scope,
        requestId: "x",
        nodeId: "bk_cmd",
        input: launchInput(down.scope.projectId),
      }),
    ).rejects.toThrow("omit nodeId");
  });
});

test("node delegation-open persists bounded request selection on the owning association", async () => {
  const { run, scope, associations } = await setup();
  const request = {
    summary: "Inspect remote parser",
    agent: "codex",
    model: "model-a",
    reasoning: "high",
    source: "requested",
  };
  await run("open_coordinator_node_delegation", {
    scope,
    nodeId: "bk_leaf",
    environmentId: "leaf-env",
    tabId: "worker-tab",
    requestId: "open-metadata",
    request,
  });
  expect((await associations())[0]).toMatchObject({
    nodeId: "bk_leaf",
    resourceId: "leaf-env",
    delegation: { workerTabId: "worker-tab", request },
  });
});

describe("send_coordinator_node_mail", () => {
  test("side agents are denied before any remote mail side effect", async () => {
    const { world, run, scope, routed, associations } = await setup();
    const side = await world.addSide();
    await expect(
      run("send_coordinator_node_mail", {
        scope: { ...scope, conversationId: side.conversationId },
        nodeId: "bk_leaf",
        requestId: "side",
        toEnvironmentId: "leaf-env",
        body: "Do work",
      }),
    ).rejects.toThrow("only message the main coordinator");
    expect(routed).toEqual([]);
    expect(await associations()).toEqual([]);
  });

  for (const placement of ["stored", "bounced", "inject-held"]) {
    test(`${placement} remote mail opens no delegation and names a stopped recipient`, async () => {
      const { run, scope, associations } = await setup({
        answers: {
          get_environment: { id: "leaf-env", projectId: "p-leaf", status: "stopped" },
          deliver_node_mail: {
            messageId: "m1",
            toTabId: "startup-agent",
            placement,
            placementReason: "hold-reason",
          },
        },
      });
      const result = await run("send_coordinator_node_mail", {
        scope,
        nodeId: "bk_leaf",
        requestId: placement,
        toEnvironmentId: "leaf-env",
        body: "hello",
      });
      expect(result.coordinatorDelegationOpened).toBe(false);
      expect(result).toMatchObject({ placement, placementReason: "hold-reason" });
      expect(result.deliveryNote).toContain('start_environment with nodeId "bk_leaf"');
      expect(await associations()).toEqual([]);
    });
  }

  test("asking a remote worker opens a delegation; a follow-up joins it", async () => {
    const { run, scope, routed, associations } = await setup();

    const first = await run("send_coordinator_node_mail", {
      scope,
      nodeId: "bk_leaf",
      requestId: "ask-1",
      toEnvironmentId: "leaf-env",
      body: "Run the tests.",
    });
    expect(first).toMatchObject({ coordinatorDelegationOpened: true, toTabId: "startup-agent" });
    expect((await associations())[0]?.delegation?.request).toMatchObject({
      summary: "Run the tests.",
    });
    expect(routed.find((entry) => entry.command === "deliver_node_mail")!.args).toMatchObject({
      controllerId: "bk_cmd",
      toEnvironmentId: "leaf-env",
      body: "Run the tests.",
    });

    await run("send_coordinator_node_mail", {
      scope,
      nodeId: "bk_leaf",
      requestId: "ask-2",
      toEnvironmentId: "leaf-env",
      body: "Also lint.",
    });
    const open = (await associations()).filter((entry) => entry.delegation?.state === "running");
    expect(open).toHaveLength(1);
  });
  test("names the recipient by what its node reports, or by the environment it read", async () => {
    const reported = await setup({
      answers: {
        deliver_node_mail: {
          messageId: "m1",
          toTabId: "startup-agent",
          toEnvironmentName: "fix-login-bug",
          toTabName: "Claude 2",
        },
      },
    });
    expect(
      await reported.run("send_coordinator_node_mail", {
        scope: reported.scope,
        nodeId: "bk_leaf",
        requestId: "named",
        toEnvironmentId: "leaf-env",
        body: "Fix it.",
      }),
    ).toMatchObject({
      node: expect.any(String),
      toEnvironmentName: "fix-login-bug",
      toTabName: "Claude 2",
    });
    // An older node reports no names: the environment it was read as stands in.
    const older = await setup();
    const result = await older.run("send_coordinator_node_mail", {
      scope: older.scope,
      nodeId: "bk_leaf",
      requestId: "older",
      toEnvironmentId: "leaf-env",
      body: "Fix it.",
    });
    expect(result.toEnvironmentName).toBe("leaf-env");
    expect(result.toTabName).toBeUndefined();
  });

  test("deliverNow asks a leaf that can steer, reports its outcome and opens the delegation", async () => {
    const { run, scope, routed, associations } = await setup({
      capabilities: { "node-attachment": 1, "node-mail-steer": 1 },
      answers: {
        deliver_node_mail: {
          messageId: "m1",
          toTabId: "startup-agent",
          placement: "injected",
          injectedVia: "steer",
          deliverNow: "steered",
          deliverNowNote: "Steered into the worker's running turn.",
        },
      },
    });
    const result = await run("send_coordinator_node_mail", {
      scope,
      nodeId: "bk_leaf",
      requestId: "correct-1",
      toEnvironmentId: "leaf-env",
      body: "Stop: the requirement changed.",
      deliverNow: true,
    });
    expect(routed.find((entry) => entry.command === "deliver_node_mail")!.args).toMatchObject({
      steer: true,
    });
    expect(result).toMatchObject({
      placement: "injected",
      injectedVia: "steer",
      deliverNow: "steered",
      deliverNowNote: "Steered into the worker's running turn.",
      // Mail already in the running turn still asked the worker something.
      coordinatorDelegationOpened: true,
    });
    expect(
      (await associations()).filter((entry) => entry.delegation?.state === "running"),
    ).toHaveLength(1);
  });

  test("deliverNow to an older leaf sends no steer field and claims no outcome", async () => {
    const { run, scope, routed } = await setup({
      answers: {
        deliver_node_mail: {
          messageId: "m1",
          toTabId: "startup-agent",
          placement: "pending-inject",
        },
      },
    });
    const result = await run("send_coordinator_node_mail", {
      scope,
      nodeId: "bk_leaf",
      requestId: "correct-old",
      toEnvironmentId: "leaf-env",
      body: "Stop.",
      deliverNow: true,
    });
    expect(routed.find((entry) => entry.command === "deliver_node_mail")!.args).not.toHaveProperty(
      "steer",
    );
    expect(result).not.toHaveProperty("deliverNow");
    expect(result).toMatchObject({
      placement: "pending-inject",
      coordinatorDelegationOpened: true,
    });
  });

  test("a turn the user did not start is framed on a leaf that can say so", async () => {
    const answers = {
      deliver_node_mail: { messageId: "m1", toTabId: "startup-agent", placement: "pending-inject" },
    };
    const send = (context: Awaited<ReturnType<typeof setup>>, requestId: string) =>
      context.run("send_coordinator_node_mail", {
        scope: context.scope,
        nodeId: "bk_leaf",
        requestId,
        toEnvironmentId: "leaf-env",
        body: "Do this.",
      });
    const delivered = (context: Awaited<ReturnType<typeof setup>>) =>
      context.routed.find((entry) => entry.command === "deliver_node_mail")!.args;

    const capable = await setup({
      answers,
      capabilities: { "node-attachment": 1, "node-mail-turn-origin": 1 },
    });
    await send(capable, "from-mail");
    expect(delivered(capable).turnOrigin).toBe("mail");

    // An older leaf refuses an unknown key, so it is never sent one.
    const older = await setup({ answers });
    await send(older, "older");
    expect(delivered(older)).not.toHaveProperty("turnOrigin");
  });

  test("without deliverNow a capable leaf is not asked to steer, and drops any outcome", async () => {
    const { run, scope, routed } = await setup({
      capabilities: { "node-attachment": 1, "node-mail-steer": 1 },
    });
    const result = await run("send_coordinator_node_mail", {
      scope,
      nodeId: "bk_leaf",
      requestId: "routine",
      toEnvironmentId: "leaf-env",
      body: "Routine.",
    });
    expect(routed.find((entry) => entry.command === "deliver_node_mail")!.args).not.toHaveProperty(
      "steer",
    );
    expect(result).not.toHaveProperty("deliverNow");
  });

  test("a lost deliverNow answer is outcome-unknown, with no steer claimed or delegation opened", async () => {
    const { run, scope, associations, loseNext } = await setup({
      capabilities: { "node-attachment": 1, "node-mail-steer": 1 },
    });
    loseNext("deliver_node_mail");
    await expect(
      run("send_coordinator_node_mail", {
        scope,
        nodeId: "bk_leaf",
        requestId: "lost",
        toEnvironmentId: "leaf-env",
        body: "Stop.",
        deliverNow: true,
      }),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(await associations()).toEqual([]);
  });
});

describe("node-mail domain client (plan item 1010)", () => {
  const send = (context: Awaited<ReturnType<typeof setup>>, requestId: string) =>
    context.run("send_coordinator_node_mail", {
      scope: context.scope,
      nodeId: "bk_leaf",
      requestId,
      toEnvironmentId: "leaf-env",
      body: "Stop: the requirement changed.",
      deliverNow: true,
    });
  const delivery = (context: Awaited<ReturnType<typeof setup>>) =>
    context.routed.find((entry) => entry.command === "deliver_node_mail")!;
  const legacyCount = () =>
    compatibilityPathUsage.peek().paths["domain-adapter.backend.node-mail.v0"]?.count ?? 0;

  test("current to current: a leaf with the domain is sent steer as critical, without capabilities", async () => {
    const before = legacyCount();
    const context = await setup({
      capabilities: { "node-attachment": 1 },
      domains: { "node-mail": { min: 1, max: 1 } },
      answers: {
        deliver_node_mail: {
          messageId: "m1",
          toTabId: "startup-agent",
          placement: "injected",
          injectedVia: "steer",
          deliverNow: "steered",
          deliverNowNote: "Steered into the worker's running turn.",
        },
      },
    });
    const result = await send(context, "contract-1");
    expect(delivery(context).args).toMatchObject({ steer: true, turnOrigin: "mail" });
    expect(delivery(context).envelope).toEqual({
      domain: "node-mail",
      version: 1,
      critical: ["steer", "requestId"],
    });
    expect(delivery(context).requestKey).toBe(`mail:${context.scope.coordinatorId}:contract-1`);
    expect(result).toMatchObject({ deliverNow: "steered", coordinatorDelegationOpened: true });
    // Version 1 is the current version: nothing is counted.
    expect(legacyCount()).toBe(before);
  });

  test("current to pre-contract: today's capability gating, no envelope, counted", async () => {
    const before = legacyCount();
    const context = await setup({
      capabilities: { "node-attachment": 1, "node-mail-steer": 1 },
      answers: { deliver_node_mail: { messageId: "m1", toTabId: "startup-agent" } },
    });
    await send(context, "legacy-1");
    expect(delivery(context).args).toMatchObject({ steer: true });
    // No `node-mail-turn-origin`: the key such a leaf would refuse is left out.
    expect(delivery(context).args).not.toHaveProperty("turnOrigin");
    expect(delivery(context)).not.toHaveProperty("envelope");
    expect(legacyCount()).toBeGreaterThan(before);
  });

  test("a leaf that refuses a critical field answers a typed error the coordinator sees", async () => {
    const context = await setup({
      domains: { "node-mail": { min: 1, max: 1 } },
      answers: {
        deliver_node_mail: () => {
          throw unsupportedField({
            field: "steer",
            domain: "node-mail",
            command: "deliver_node_mail",
          });
        },
      },
    });
    const error = await send(context, "refused-1").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(incompatibility(error, "deliver_node_mail")).toMatchObject({
      code: "unsupported-field",
      field: "steer",
      domain: "node-mail",
    });
    // Nothing was delivered, so no delegation is open for it.
    expect(
      (await context.associations()).filter((entry) => entry.delegation?.state === "running"),
    ).toHaveLength(0);
  });
});

describe("workflows on a node", () => {
  for (const taskId of ["missing", "other-project"]) {
    test(`a ${taskId} ticket refusal releases the reservation for a corrected retry`, async () => {
      const leafCommands = new Map<string, CommandHandler>();
      registerControllerWorkflowCommands(
        registrarFrom((name, handler) => leafCommands.set(name, handler)),
        {
          commands: new Map(),
        },
      );
      let starts = 0;
      const leafContext = {
        storage: {
          getProject: async () => ({ id: "p-leaf", localPath: "/fixture" }),
          loadConfig: async () => ({ global: {}, repositories: {} }),
          kanban: {
            getKanbanTask: async (id: string) =>
              id === "missing"
                ? null
                : { id, projectId: id === "other-project" ? "p-other" : "p-leaf" },
          },
        },
        buildPipelines: {
          start: async (_input: unknown, coordinatorLaunchId?: string) => {
            starts++;
            return { id: "pipeline-leaf", projectId: "p-leaf", coordinatorLaunchId };
          },
        },
      } as unknown as CommandContext;
      const { run, scope, associations } = await setup({
        answers: {
          start_controller_build_pipeline: (args: Record<string, unknown>) =>
            leafCommands.get("start_controller_build_pipeline")!(args, leafContext),
        },
      });
      const args = {
        scope,
        requestId: "build-refused",
        nodeId: "bk_leaf",
        input: {
          projectId: scope.projectId,
          taskId,
          taskTitle: "Address Findings",
          environmentType: "local",
          agentType: "codex",
          taskSnapshot: {
            title: "Address Findings",
            description: "",
            acceptanceCriteria: "",
            comments: [],
            images: [],
          },
          delegationBaseBranch: "main",
          delegationBaseCommit: BASE,
        },
      };
      await expect(run("start_coordinator_node_build_pipeline", args)).rejects.toMatchObject({
        code: "coordinator-build-ticket-required",
        message: expect.stringContaining("Create the ticket with create_ticket first"),
      });
      expect(starts).toBe(0);
      expect(await associations()).toEqual([]);

      const result = await run("start_coordinator_node_build_pipeline", {
        ...args,
        input: { ...args.input, taskId: "valid-ticket" },
      });
      expect(result.id).toBe("pipeline-leaf");
      expect(starts).toBe(1);
      expect(await associations()).toEqual([
        expect.objectContaining({ resourceId: "pipeline-leaf", pending: false }),
      ]);
    });
  }

  test("an ambiguous build failure retains its reservation and blocks a changed retry", async () => {
    const { run, scope, loseNext, associations, routed } = await setup();
    const args = {
      scope,
      requestId: "build-lost",
      nodeId: "bk_leaf",
      input: { ...launchInput(scope.projectId), taskId: "t1", taskTitle: "Address Findings" },
    };
    loseNext("start_controller_build_pipeline");
    await expect(run("start_coordinator_node_build_pipeline", args)).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    expect(await associations()).toEqual([expect.objectContaining({ pending: true })]);
    await expect(
      run("start_coordinator_node_build_pipeline", {
        ...args,
        input: { ...args.input, taskId: "t2" },
      }),
    ).rejects.toThrow("different payload");
    expect(
      routed.filter((entry) => entry.command === "start_controller_build_pipeline"),
    ).toHaveLength(1);
  });

  test("a remote pipeline in an existing environment grants no creation authority", async () => {
    const { run, world, scope, associations } = await setup();
    await run("start_coordinator_node_build_pipeline", {
      scope,
      requestId: "existing-build",
      nodeId: "bk_leaf",
      input: {
        projectId: scope.projectId,
        taskId: "t1",
        taskTitle: "Fix",
        delegationBaseBranch: "main",
        delegationBaseCommit: BASE,
        existingEnvironmentId: "leaf-env",
      },
    });
    expect((await associations())[0]!.createdEnvironmentId).toBeUndefined();
    await world.storage.patchRepositorySettings(scope.projectId, {
      coordinatorOtherEnvironments: false,
    });
    await expect(
      run("send_coordinator_node_mail", {
        scope,
        nodeId: "bk_leaf",
        requestId: "existing-mail",
        toEnvironmentId: "leaf-env",
        body: "hello",
      }),
    ).rejects.toThrow("did not create");
  });

  test("a reclaimed remote admission repairs its creation receipt after late provisioning", async () => {
    let environmentId = "";
    let coordinatorLaunchId: unknown;
    const { run, world, scope, loseNext, associations } = await setup({
      answers: {
        start_controller_build_pipeline: (args: Record<string, unknown>) => {
          coordinatorLaunchId = args.coordinatorLaunchId;
          return {
            id: "pipeline-leaf",
            projectId: "p-leaf",
            environmentId: "",
            coordinatorLaunchId,
          };
        },
        get_build_pipeline: () => ({
          snapshot: {
            id: "pipeline-leaf",
            projectId: "p-leaf",
            environmentId,
            coordinatorLaunchId,
          },
        }),
      },
    });
    await world.storage.patchRepositorySettings(scope.projectId, {
      coordinatorOtherEnvironments: false,
    });
    const args = {
      scope,
      requestId: "reclaim",
      nodeId: "bk_leaf",
      input: {
        projectId: scope.projectId,
        taskId: "t1",
        taskTitle: "Build",
        delegationBaseBranch: "main",
        delegationBaseCommit: BASE,
      },
    };
    loseNext("start_controller_build_pipeline");
    await expect(run("start_coordinator_node_build_pipeline", args)).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    expect(await run("start_coordinator_node_build_pipeline", args)).toMatchObject({
      environmentId: "",
    });
    expect((await associations())[0]).toMatchObject({ pending: false, createsEnvironment: true });
    await expect(
      run("send_coordinator_node_mail", {
        scope,
        nodeId: "bk_leaf",
        requestId: "mail-before-provisioning",
        toEnvironmentId: "leaf-env",
        body: "hello",
      }),
    ).rejects.toThrow("did not create");
    environmentId = "leaf-env";
    const originalNow = Date.now;
    Date.now = () => originalNow() + 60_001;
    let result: Record<string, unknown>;
    try {
      result = await run("send_coordinator_node_mail", {
        scope,
        nodeId: "bk_leaf",
        requestId: "mail-after-provisioning",
        toEnvironmentId: "leaf-env",
        body: "hello",
      });
    } finally {
      Date.now = originalNow;
    }
    expect(result.messageId).toBe("m1");
    expect((await associations()).find((entry) => entry.kind === "build-pipeline")).toMatchObject({
      createdEnvironmentId: "leaf-env",
    });
  });

  test("a build pipeline is reserved here and started on the node's copy", async () => {
    const { run, scope, routed, associations } = await setup();
    const workflow = await run("start_coordinator_node_build_pipeline", {
      scope,
      requestId: "build-1",
      nodeId: "bk_leaf",
      input: {
        projectId: scope.projectId,
        taskId: "t1",
        taskTitle: "Address Findings",
        delegationBaseBranch: "main",
        delegationBaseCommit: BASE,
      },
    });
    expect(workflow).toMatchObject({ id: "pipeline-leaf" });
    const replay = await run("start_coordinator_node_build_pipeline", {
      scope,
      requestId: "build-1",
      nodeId: "bk_leaf",
      input: {
        projectId: scope.projectId,
        taskId: "t1",
        taskTitle: "Address Findings",
        delegationBaseBranch: "main",
        delegationBaseCommit: BASE,
      },
    });
    expect(replay.replayed).toBe(true);
    expect(
      routed.filter((item) => item.command === "start_controller_build_pipeline"),
    ).toHaveLength(1);
    expect(
      routed.find((entry) => entry.command === "start_controller_build_pipeline")!.args.input,
    ).toMatchObject({
      projectId: "p-leaf",
      taskId: "t1",
      // Linked to the ticket, which the node itself checks is one of its own.
      source: { type: "kanban", taskId: "t1" },
    });
    expect(await associations()).toEqual([
      expect.objectContaining({ kind: "build-pipeline", resourceId: "pipeline-leaf" }),
    ]);
    expect((await associations())[0]).toMatchObject({ createdEnvironmentId: "leaf-env" });
  });

  test("a Multi Review launch reattaches its receipt to the review the node ran", async () => {
    const { run, scope, routed, associations } = await setup({
      answers: {
        get_multi_review_workflow: { snapshot: review("active-review", "preparing"), revision: 1 },
        launch_controller_multi_review: () => ({
          workflow: review("active-review", "preparing"),
          reused: true,
          outcome: "opened",
          ui: { status: "opened" },
        }),
      },
    });
    const result = await run("launch_coordinator_node_multi_review", {
      scope,
      nodeId: "bk_leaf",
      input: { requestId: "review-1", environmentId: "leaf-env" },
    });
    expect(result).toMatchObject({ reused: true, outcome: "opened" });
    const replay = await run("launch_coordinator_node_multi_review", {
      scope,
      nodeId: "bk_leaf",
      input: { requestId: "review-1", environmentId: "leaf-env" },
    });
    expect(replay.replayed).toBe(true);
    expect(
      routed
        .filter((item) => item.command === "launch_controller_multi_review")
        .map((item) => item.requestKey),
    ).toEqual([
      "review:" + scope.coordinatorId + ":review-1",
      "review:" + scope.coordinatorId + ":review-1",
    ]);
    const launch = routed.find((entry) => entry.command === "launch_controller_multi_review")!;
    expect(String(launch.args.reservedId)).toMatch(/^action-[0-9a-f]{32}$/);
    expect(await associations()).toEqual([
      expect.objectContaining({
        kind: "multi-review",
        resourceId: "active-review",
        pending: false,
      }),
    ]);
  });

  test("distinct concurrent launch requests share one actual review owner and status wake", async () => {
    let active: ReturnType<typeof review> | undefined;
    const { run, scope, associations, world, main } = await setup({
      answers: {
        // The leaf may reuse a workflow that was absent from an earlier inventory.
        list_multi_review_workflows: () => [],
        launch_controller_multi_review: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          active ??= review("one-review", "preparing");
          return { workflow: active, outcome: "opened", reused: true, ui: { status: "opened" } };
        },
      },
    });
    await Promise.all(
      ["one", "two"].map((requestId) =>
        run("launch_coordinator_node_multi_review", {
          scope,
          nodeId: "bk_leaf",
          input: { requestId, environmentId: "leaf-env" },
        }),
      ),
    );
    const owners = await associations();
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      resourceId: "one-review",
      pending: false,
      requestId: "one",
      requestAliases: [{ requestId: "two", payloadHash: expect.any(String) }],
    });
    world.coordinator.setRemoteAccess({
      workerState: async () => "unavailable",
      collectMail: async () => true,
      nodeName: async () => "Build box",
      lastAssistantExcerpt: async () => undefined,
      workflow: async () => ({ snapshot: review("one-review", "cancelled"), revision: 2 }),
      environmentPr: async () => ({}),
    });
    await world.coordinator.reconcileWorkflowNotifications();
    await world.deliver();
    await world.coordinator.reconcileWorkflowNotifications();
    await world.deliver();
    expect(world.wakes(main)).toBe(1);
  });

  test("addressing a review on a node adopts it unless another conversation owns it", async () => {
    const { run, scope, world, associations } = await setup({
      answers: {
        get_multi_review_workflow: { snapshot: review("w1", "preparing"), revision: 1 },
        // The node answers a MultiReviewActionResult, which always names its workflow.
        controller_multi_review_surface: {
          outcome: "pending",
          workflow: review("w1", "preparing"),
        },
      },
    });
    await run("coordinator_node_multi_review_surface", {
      scope,
      nodeId: "bk_leaf",
      workflowId: "w1",
      surface: "address",
    });
    expect(await associations()).toEqual([
      expect.objectContaining({ kind: "multi-review", resourceId: "w1", nodeId: "bk_leaf" }),
    ]);

    const side = await world.addSide();
    await expect(
      run("coordinator_node_multi_review_surface", {
        scope: { ...scope, conversationId: side.conversationId! },
        nodeId: "bk_leaf",
        workflowId: "w1",
        surface: "root",
      }),
    ).rejects.toThrow("Adopt this workflow");
  });
});

describe("deliverNow through a linked command and leaf handler", () => {
  for (const joining of [false, true]) {
    test(`steering ${joining ? "joins" : "opens"} a remote delegation and replays once`, async () => {
      const leaf = await MailWorld.create();
      worlds.push(leaf);
      const worker = await leaf.addEnvironment("linked-worker", { launched: true });
      let phase = "working";
      const nodeCoordination = new NodeCoordination({
        storage: leaf.storage,
        nodes: {
          listControllers: () => [{ controllerId: "bk_cmd", displayName: "Office desktop" }],
          subscribe: () => () => {},
        } as never,
        portal: { readModel: { onNodeEvent: () => () => {} } } as never,
        invoke: async () => undefined as never,
        emit: () => {},
      });
      const commands = new Map<string, CommandHandler>();
      registerNodeCommands(registrarFrom((name, handler) => commands.set(name, handler)));
      const leafContext = {
        storage: leaf.storage,
        nodeCoordination,
        drainAgentMail: () => leaf.mail.drainInjects(),
      } as unknown as CommandContext;
      const leafCall = (name: string, args: Record<string, unknown>) =>
        commands.get(name)!(args, leafContext);
      const { world, run, scope, routed, associations, context } = await setup({
        leafProjectId: leaf.projectId,
        capabilities: { "node-attachment": 1, "node-mail-steer": 1 },
        answers: {
          get_environment: () => leaf.storage.getEnvironment(worker.environmentId),
          deliver_node_mail: (args: Record<string, unknown>) => leafCall("deliver_node_mail", args),
          get_worker_request_state: (args: Record<string, unknown>) =>
            leafCall("get_worker_request_state", args),
          get_agent_registry: () => ({
            entries: [{ environmentId: worker.environmentId, tabId: worker.tabId, state: phase }],
          }),
        },
      });
      const remote = new NodeCoordinatorRemote({
        invokeOnNode: (input) => context.nodePortal!.invokeOnNode(input),
        summaries: async () => ({ nodes: [] }) as never,
        collectMail: async () => true,
      });
      world.coordinator.setRemoteAccess(remote);
      const input = {
        scope,
        nodeId: "bk_leaf",
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
      };
      if (joining) {
        await run("send_coordinator_node_mail", {
          ...input,
          requestId: "initial",
          body: "Initial request.",
        });
        expect(
          await remote.workerState("bk_leaf", worker.environmentId, worker.tabId),
        ).toMatchObject({ requestPending: true });
        await world.coordinator.settleRemoteWorker("bk_leaf", worker.environmentId);
        phase = "idle";
        await world.coordinator.settleRemoteWorker("bk_leaf", worker.environmentId);
        expect((await associations())[0]!.delegation?.state).toBe("running");
        phase = "working";
      }
      const correction = {
        ...input,
        requestId: "correction",
        body: "Use the corrected requirement.",
        deliverNow: true,
      };
      const result = await run("send_coordinator_node_mail", correction);
      expect(result).toMatchObject({
        placement: "injected",
        injectedVia: "steer",
        deliverNow: "steered",
        coordinatorDelegationOpened: true,
      });
      expect(result).not.toHaveProperty("placementReason");
      expect(routed.findLast((entry) => entry.command === "deliver_node_mail")!.args).toMatchObject(
        { steer: true, requestId: "correction" },
      );
      const steered = leaf.steered(worker);
      expect(steered.filter((text) => text.includes(correction.body))).toHaveLength(1);
      expect(await run("send_coordinator_node_mail", correction)).toEqual(result);
      expect(leaf.steered(worker)).toEqual(steered);
      expect(await remote.workerState("bk_leaf", worker.environmentId, worker.tabId)).toMatchObject(
        { requestPending: false },
      );
      expect(await associations()).toHaveLength(1);
      await world.coordinator.settleRemoteWorker("bk_leaf", worker.environmentId);
      await leaf.finishTurn(worker, { deliver: false });
      phase = "idle";
      await world.coordinator.settleRemoteWorker("bk_leaf", worker.environmentId);
      expect((await associations())[0]!.delegation?.state).toBe("completed");
    });
  }
});

describe("node mail request collisions", () => {
  test("refuses a different worker before delivering mail", async () => {
    const { run, scope, routed } = await setup();
    await run("send_coordinator_node_mail", {
      scope,
      requestId: "same-mail",
      nodeId: "bk_leaf",
      toEnvironmentId: "leaf-env",
      body: "Go",
    });
    const delivered = routed.filter((item) => item.command === "deliver_node_mail").length;
    await expect(
      run("send_coordinator_node_mail", {
        scope,
        requestId: "same-mail",
        nodeId: "bk_leaf",
        toEnvironmentId: "other-env",
        body: "Go",
      }),
    ).rejects.toThrow("requestId");
    expect(routed.filter((item) => item.command === "deliver_node_mail")).toHaveLength(delivered);
  });
});

test("a leaf without build-origin support is refused before a pipeline can start", async () => {
  const { run, scope, routed, associations } = await setup({
    capabilities: { "node-attachment": 1 },
  });
  await expect(
    run("start_coordinator_node_build_pipeline", {
      scope,
      nodeId: "bk_leaf",
      requestId: "old-leaf-build",
      input: {
        projectId: scope.projectId,
        taskId: "leaf-ticket",
        taskTitle: "Build",
        delegationBaseBranch: "main",
        delegationBaseCommit: BASE,
      },
    }),
  ).rejects.toThrow("Update this node");
  expect(
    routed.filter((entry) => entry.command === "start_controller_build_pipeline"),
  ).toHaveLength(0);
  expect(await associations()).toEqual([]);
});
