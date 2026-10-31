import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import * as agentsMdPr from "./agents-md-pr.js";
import { agentsMdBaseBranch } from "./agents-md-commands.js";
import { agentsMdBranchName, agentsMdRequestKey } from "./agents-md-pr.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { CoordinatorService } from "./coordinator-service.js";
import { NodeActionRequests } from "./nodes/node-action-requests.js";
import { runCommand } from "./shell.js";
import { StorageService, createProject } from "./storage.js";

let root: string;
let storage: StorageService;
let coordinator: CoordinatorService;
let context: CommandContext;
let commands: Map<string, CommandHandler>;
let requests: NodeActionRequests;
let executed: Array<{ changes: unknown }>;
let scope: { projectId: string; coordinatorId: string; conversationId: string };

const call = (args: Record<string, unknown>, callerScope = scope) =>
  commands.get("request_coordinator_agents_md_update")!(
    { scope: callerScope, ...args },
    context,
  ) as Promise<Record<string, unknown>>;

const proposal = {
  requestId: "save-decisions",
  changes: [
    { action: "add", text: "Never touch ports 34121/34122." },
    { action: "add", text: "Commit flaky-test records in the same change." },
  ],
  reason: "Agreed while planning the release",
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-agents-md-commands-"));
  const checkout = path.join(root, "checkout");
  await mkdir(checkout);
  await runCommand("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const project = await storage.addProject(createProject("remote", checkout));
  coordinator = new CoordinatorService(storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  const snapshot = await coordinator.ensure(project.id);
  scope = {
    projectId: project.id,
    coordinatorId: snapshot.workspace.id,
    conversationId: snapshot.workspace.conversations[0]!.id,
  };
  executed = [];
  requests = new NodeActionRequests({
    load: async () => [],
    save: async () => {},
    emit: () => {},
    executors: {
      "update-agents-md": async (_request, approval) => {
        executed.push({ changes: approval.changes });
        return {
          code: "pr-opened",
          message: "Opened a pull request",
          url: "https://github.com/acme/widgets/pull/9",
        };
      },
    },
  });
  context = {
    storage,
    coordinators: coordinator,
    nodeCoordination: { actions: requests },
  } as unknown as CommandContext;
  commands = createCommandRegistry();
  commands.set("get_node_status", (async () => ({ nodeId: "bk_self" })) as CommandHandler);
  commands.set("create_node_action_request", (async (args) =>
    requests.create(args as never)) as CommandHandler);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("request_coordinator_agents_md_update", () => {
  test("creates one approval request; the coordinator writes nothing else", async () => {
    const result = await call({ input: proposal });
    expect(result).toMatchObject({ state: "pending", nodeId: "bk_self" });
    const [request] = await requests.list();
    expect(request).toMatchObject({
      requestId: result.approvalRequestId,
      kind: "update-agents-md",
      reason: "Agreed while planning the release",
      targets: [{ nodeId: "bk_self", nodeName: "this machine", projectId: scope.projectId }],
      agentsMd: { changes: proposal.changes },
      requestedBy: {
        coordinatorEnvironmentId: coordinatorRuntimeId(scope.coordinatorId, scope.conversationId),
        projectId: scope.projectId,
      },
    });
    expect(result.branch).toBe(agentsMdBranchName(agentsMdRequestKey(request!.requestId)));
    expect(executed).toEqual([]);
  });

  test("a retry with the same requestId returns the same request, then its pull request", async () => {
    const first = await call({ input: proposal });
    const replay = await call({ input: proposal });
    expect(replay).toMatchObject({ approvalRequestId: first.approvalRequestId, replayed: true });
    expect(await requests.list()).toHaveLength(1);
    await requests.resolve(String(first.approvalRequestId), "approve");
    expect(await call({ input: proposal })).toMatchObject({
      approvalRequestId: first.approvalRequestId,
      state: "executed",
      prUrl: "https://github.com/acme/widgets/pull/9",
    });
    expect(executed).toHaveLength(1);
    await expect(call({ input: { ...proposal, reason: "Something else" } })).rejects.toThrow(
      "different payload",
    );
  });

  test("a side agent cannot propose", async () => {
    const snapshot = await coordinator.createConversation(scope.projectId);
    const side = snapshot.workspace.conversations.find((item) => item.role === "side")!;
    await expect(call({ input: proposal }, { ...scope, conversationId: side.id })).rejects.toThrow(
      "Only the main coordinator",
    );
    expect(await requests.list()).toEqual([]);
  });

  test("refuses entries that would escape the section, unknown fields and oversize input", async () => {
    for (const changes of [
      [{ action: "add", text: "ok\n## Injected heading" }],
      [{ action: "add", text: "# Top-level heading" }],
      [{ action: "add", text: "fine", path: "../README.md" }],
      Array.from({ length: 21 }, (_, index) => ({ action: "add", text: `rule ${index}` })),
    ])
      await expect(
        call({ input: { ...proposal, requestId: `bad-${changes.length}`, changes } }),
      ).rejects.toThrow();
    await expect(call({ input: { ...proposal, reason: "x".repeat(501) } })).rejects.toThrow(
      "reason",
    );
    expect(await requests.list()).toEqual([]);
  });

  test("a copy on another node is the request's target", async () => {
    await call({
      input: proposal,
      target: { nodeId: "bk_leaf", nodeName: "Build box", projectId: "leaf-project" },
    });
    expect((await requests.list())[0]!.targets).toEqual([
      { nodeId: "bk_leaf", nodeName: "Build box", projectId: "leaf-project" },
    ]);
  });
});

describe("AGENTS.md base branch selection", () => {
  for (const [config, expected] of [
    [{ prBaseBranch: " release ", defaultBranch: "develop" }, "release"],
    [{ prBaseBranch: "  ", defaultBranch: " develop " }, "develop"],
    [{ defaultBranch: "trunk" }, "trunk"],
    [{}, "main"],
    [{ prBaseBranch: " ", defaultBranch: " " }, "main"],
    [null, "main"],
  ] as const) {
    test(`selects ${expected} from ${JSON.stringify(config)}`, async () => {
      const ctx = {
        storage: { getRepositoryConfig: async () => config },
      } as unknown as CommandContext;
      expect(await agentsMdBaseBranch(ctx, "p1")).toBe(expected);
    });
  }
  test("unreadable repository settings fall back to main", async () => {
    const ctx = {
      storage: {
        getRepositoryConfig: async () => {
          throw new Error("unavailable");
        },
      },
    } as unknown as CommandContext;
    expect(await agentsMdBaseBranch(ctx, "p1")).toBe("main");
  });
});

describe("AGENTS.md command credential wiring", () => {
  test("reading the base section passes the owning storage as the GitHub config source", async () => {
    const read = spyOn(agentsMdPr, "readAgentsMdSectionFromBase").mockResolvedValue({
      baseBranch: "main",
      baseCommit: "base-commit",
      fetched: true,
      fileExists: false,
      section: { exists: false, text: null, entries: [] },
    });
    try {
      await commands.get("read_project_agents_md_section")!(
        { projectId: scope.projectId },
        context,
      );
      expect(read).toHaveBeenCalledWith({
        root: path.join(root, "checkout"),
        baseBranch: "main",
        gitHubConfig: storage,
      });
    } finally {
      read.mockRestore();
    }
  });

  test("opening the approved pull request passes the owning storage as the GitHub config source", async () => {
    const key = agentsMdRequestKey("approved-request");
    const open = spyOn(agentsMdPr, "openAgentsMdPullRequest").mockResolvedValue({
      status: "existing",
      url: "https://github.com/acme/widgets/pull/9",
      branch: agentsMdBranchName(key),
      baseBranch: "main",
      outcomes: [],
    });
    try {
      await commands.get("open_project_agents_md_pr")!(
        {
          projectId: scope.projectId,
          requestKey: key,
          changes: proposal.changes,
          reason: proposal.reason,
        },
        context,
      );
      expect(open).toHaveBeenCalledWith({
        root: path.join(root, "checkout"),
        baseBranch: "main",
        key,
        changes: proposal.changes,
        reason: proposal.reason,
        gitHubConfig: storage,
      });
    } finally {
      open.mockRestore();
    }
  });
});
