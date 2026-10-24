/**
 * A coordinator acting on a node it controls, over the real coordinator
 * store: receipts, associations and delegations are kept here with the
 * node's ID, and the work is routed to the node (simulated).
 */
import { afterEach, describe, expect, test } from "bun:test";

import { MailWorld } from "./agent-mail-world-test-support.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerCoordinatorNodeCommands } from "./commands-registry-coordinator-nodes.js";

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
  options: { available?: boolean; hasCopy?: boolean; answers?: Record<string, unknown> } = {},
) {
  const world = await MailWorld.create({ statusWakes: { coalesceMs: 0 } });
  worlds.push(world);
  await world.storage.updateProject(world.projectId, { gitUrl: "git@github.com:acme/site.git" });
  const main = await world.main();
  const routed: Array<{ command: string; args: Record<string, unknown>; requestKey?: string }> = [];
  let unknownOnce: string | null = null;
  const answers: Record<string, unknown> = {
    get_environment: { id: "leaf-env", projectId: "p-leaf", name: "leaf-env", status: "running" },
    create_controller_environment: { id: "leaf-env", status: "stopped" },
    deliver_node_mail: { messageId: "m1", toTabId: "startup-agent" },
    start_controller_build_pipeline: { id: "pipeline-leaf", projectId: "p-leaf" },
    ...options.answers,
  };
  const context = {
    storage: world.storage,
    coordinators: world.coordinator,
    nodes: { status: async () => ({ nodeId: "bk_cmd", mode: "command" }) },
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
                : [{ ref: { projectId: "p-leaf" }, repositoryHint: "github.com/acme/site" }],
          },
        ],
      }),
      invokeOnNode: async (input: {
        command: string;
        args: Record<string, unknown>;
        requestKey?: string;
      }) => {
        routed.push(input);
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
  registerCoordinatorNodeCommands((name, handler) => commands.set(name, handler));
  const scope = {
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: main.conversationId!,
  };
  const run = (name: string, args: Record<string, unknown>) =>
    commands.get(name)!(args, context) as Promise<Record<string, unknown>>;
  const associations = async () =>
    (await world.storage.listCoordinatorWorkflowAssociations(world.projectId)).filter(
      (entry) => entry.nodeId === "bk_leaf",
    );
  return {
    world,
    main,
    scope,
    run,
    routed,
    associations,
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
      delegation: { state: "running", workerTabId: "startup-agent" },
    });

    // A retry of the same request finds the first launch.
    const creates = routed.filter((entry) => entry.command === "create_controller_environment");
    await run("launch_coordinator_node_environment", {
      scope,
      requestId: "launch-1",
      nodeId: "bk_leaf",
      input: launchInput(scope.projectId),
    });
    expect(routed.filter((entry) => entry.command === "create_controller_environment")).toEqual(
      creates,
    );
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

  for (const placement of ["stored", "bounced"]) {
    test(`${placement} remote mail opens no delegation and names a stopped recipient`, async () => {
      const { run, scope, associations } = await setup({
        answers: {
          get_environment: { id: "leaf-env", projectId: "p-leaf", status: "stopped" },
          deliver_node_mail: { messageId: "m1", toTabId: "startup-agent", placement },
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
});

describe("workflows on a node", () => {
  test("a build pipeline is reserved here and started on the node's copy", async () => {
    const { run, scope, routed, associations } = await setup();
    const workflow = await run("start_coordinator_node_build_pipeline", {
      scope,
      requestId: "build-1",
      nodeId: "bk_leaf",
      input: {
        projectId: scope.projectId,
        taskId: "t1",
        taskTitle: "Fix",
        delegationBaseBranch: "main",
        delegationBaseCommit: BASE,
      },
    });
    expect(workflow).toMatchObject({ id: "pipeline-leaf" });
    expect(
      routed.find((entry) => entry.command === "start_controller_build_pipeline")!.args.input,
    ).toMatchObject({ projectId: "p-leaf", taskId: "t1" });
    expect(await associations()).toEqual([
      expect.objectContaining({ kind: "build-pipeline", resourceId: "pipeline-leaf" }),
    ]);
  });

  test("a Multi Review launch reattaches its receipt to the review the node ran", async () => {
    const { run, scope, routed, associations } = await setup({
      answers: {
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
        controller_multi_review_surface: { outcome: "pending" },
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
