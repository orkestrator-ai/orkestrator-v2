import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { agentsMdRequestKey } from "../agents-md-pr.js";
import { MailWorld } from "../agent-mail-world-test-support.js";
import { NodeOutcomeUnknownError } from "./node-link.js";
import {
  NodeActionRequests,
  parseNodeActionApproval,
  type NodeActionRequest,
} from "./node-action-requests.js";
import { NodeCoordination } from "./node-coordination.js";

/**
 * The `update-agents-md` approval: the user's edited entries reach the node
 * owning the project copy, the outcome and the pull request URL are mailed
 * to the coordinator, and an approval interrupted by a restart resumes once.
 */

const worlds: MailWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

type Call = { command: string; args: Record<string, unknown> };

async function setup(options: {
  invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  invokeOnNode?: (args: Record<string, unknown>) => Promise<unknown>;
}) {
  const world = await MailWorld.create();
  worlds.push(world);
  const main = await world.main();
  const calls: Call[] = [];
  const instance = new NodeCoordination({
    storage: world.storage,
    nodes: {
      listControllers: () => [],
      mostRecentControllerId: () => undefined,
      selfIdentity: async () => "bk_self",
      link: () => null,
      getNode: async () => ({ displayName: "node" }),
      subscribe: () => () => undefined,
      listNodes: async () => ({ nodes: [] }),
    } as never,
    portal: {
      readModel: { onNodeEvent: () => () => undefined },
      invokeOnNode: async (args: Record<string, unknown>) => {
        calls.push({ command: `node:${String(args.command)}`, args });
        return options.invokeOnNode?.(args) ?? { outcome: "ok", result: {} };
      },
    } as never,
    invoke: (async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      return options.invoke?.(command, args);
    }) as never,
    emit: () => undefined,
  });
  const input = (nodeId = "bk_self") => ({
    requestId: `agents-md-${nodeId}`,
    kind: "update-agents-md",
    targets: [
      { nodeId, nodeName: nodeId === "bk_self" ? "this machine" : "Build box", projectId: "p1" },
    ],
    requestedBy: {
      coordinatorEnvironmentId: main.environmentId,
      coordinatorTabId: main.tabId,
      projectId: world.projectId,
    },
    reason: "Agreed in chat",
    agentsMd: { changes: [{ action: "add", text: "Use bun." }] },
  });
  return { world, main, calls, instance, input };
}

const opened = {
  status: "opened",
  url: "https://github.com/acme/widgets/pull/9",
  branch: "orkestrator/agents-md-x",
  baseBranch: "main",
  outcomes: [],
};

describe("update-agents-md approval", () => {
  test("approval with the user's edits opens the PR on this node and mails the URL", async () => {
    const { world, main, calls, instance, input } = await setup({ invoke: async () => opened });
    const notice = spyOn(world.storage, "sendAgentMail");
    const request = await instance.createActionRequest(input());
    expect((await instance.createActionRequest(input())).requestId).toBe(request.requestId);
    const resolved = await instance.actions.resolve(
      request.requestId,
      "approve",
      parseNodeActionApproval({ changes: [{ action: "add", text: "Use bun, never npm." }] }),
    );
    expect(resolved).toMatchObject({
      state: "executed",
      result: { code: "pr-opened", url: opened.url },
    });
    expect(calls).toEqual([
      {
        command: "open_project_agents_md_pr",
        args: {
          projectId: "p1",
          requestKey: agentsMdRequestKey(request.requestId),
          changes: [{ action: "add", text: "Use bun, never npm." }],
          reason: "Agreed in chat",
          nodeName: "this machine",
        },
      },
    ]);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]![1]).toMatchObject({
      toEnvironmentId: main.environmentId,
      toTabId: main.tabId,
    });
    expect(notice.mock.calls[0]![1].body).toContain(opened.url);
    instance.collector.dispose();
  });

  test("a decline never runs anything and tells the coordinator", async () => {
    const { world, calls, instance, input } = await setup({ invoke: async () => opened });
    const notice = spyOn(world.storage, "sendAgentMail");
    const request = await instance.createActionRequest(input());
    expect((await instance.actions.resolve(request.requestId, "reject")).state).toBe("rejected");
    expect(calls).toEqual([]);
    expect(notice.mock.calls[0]![1].subject).toContain("Request rejected");
    instance.collector.dispose();
  });

  test("a failure (no gh sign-in) is reported with its code and what to do", async () => {
    const { instance, input } = await setup({
      invoke: async () => {
        throw Object.assign(
          new Error("The GitHub CLI is not signed in on this machine. Run `gh auth login` there."),
          {
            code: "gh-auth",
          },
        );
      },
    });
    const request = await instance.createActionRequest(input());
    const resolved = await instance.actions.resolve(request.requestId, "approve");
    expect(resolved.state).toBe("failed");
    expect(resolved.result).toMatchObject({ code: "gh-auth" });
    expect(resolved.result?.message).toContain("gh auth login");
    instance.collector.dispose();
  });

  test("a copy on another node runs there; a lost answer re-joins the same run", async () => {
    let attempts = 0;
    const { calls, instance, input } = await setup({
      invokeOnNode: async () => {
        attempts += 1;
        if (attempts === 1) throw new NodeOutcomeUnknownError("lost");
        if (attempts === 2) return { outcome: "unknown", outcomeId: "x" };
        return { outcome: "ok", result: { ...opened, status: "existing" } };
      },
    });
    const request = await instance.createActionRequest(input("bk_leaf"));
    const resolved = await instance.actions.resolve(request.requestId, "approve");
    expect(resolved).toMatchObject({ state: "executed", result: { code: "pr-existing" } });
    expect(calls.map((call) => call.command)).toEqual([
      "node:open_project_agents_md_pr",
      "node:open_project_agents_md_pr",
      "node:open_project_agents_md_pr",
    ]);
    expect(calls.map((call) => (call.args as { nodeId: string }).nodeId)).toEqual([
      "bk_leaf",
      "bk_leaf",
      "bk_leaf",
    ]);
    // Each attempt is a distinct routed write; the node joins the one run.
    expect(new Set(calls.map((call) => call.args.requestKey)).size).toBe(3);
    instance.collector.dispose();
  });

  test("the review preview reads the section on the owning node", async () => {
    const { calls, instance, input } = await setup({
      invokeOnNode: async () => ({
        outcome: "ok",
        result: { baseBranch: "main", section: { exists: true, entries: ["a"] } },
      }),
    });
    const request = await instance.createActionRequest(input("bk_leaf"));
    expect(await instance.previewAgentsMd(request.requestId)).toMatchObject({
      baseBranch: "main",
      nodeName: "Build box",
    });
    expect(calls[0]).toMatchObject({
      command: "node:read_project_agents_md_section",
      args: { nodeId: "bk_leaf", args: { projectId: "p1" } },
    });
    instance.collector.dispose();
  });

  test("injected entries are refused when the request is created or approved", async () => {
    const { instance, input } = await setup({});
    await expect(
      instance.createActionRequest({
        ...input(),
        agentsMd: { changes: [{ action: "add", text: "x\n## Escape" }] },
      }),
    ).rejects.toThrow("single line");
    expect(() =>
      parseNodeActionApproval({ changes: [{ action: "add", text: "## Escape" }] }),
    ).toThrow();
    expect(() => parseNodeActionApproval({ changes: [] })).toThrow();
    instance.collector.dispose();
  });
});

describe("restart mid-approval", () => {
  test("an approved request a restart interrupted runs once more with the user's edits", async () => {
    let saved: NodeActionRequest[] = [];
    const store = {
      load: async () => structuredClone(saved),
      save: async (requests: NodeActionRequest[]) => {
        saved = structuredClone(requests);
      },
      emit: () => undefined,
    };
    const first = new NodeActionRequests({
      ...store,
      executors: {
        // The process dies while the pull request is being opened.
        "update-agents-md": () => new Promise(() => undefined),
      },
    });
    const request = await first.create({
      requestId: "r1",
      kind: "update-agents-md",
      targets: [{ nodeId: "bk_self", nodeName: "this machine", projectId: "p1" }],
      requestedBy: { coordinatorEnvironmentId: "c", coordinatorTabId: "t", projectId: "p1" },
      reason: "why",
      agentsMd: { changes: [{ action: "add", text: "Original." }] },
    });
    void first.resolve(request.requestId, "approve", {
      changes: [{ action: "add", text: "Edited." }],
    });
    await Bun.sleep(10);
    expect(saved[0]).toMatchObject({
      state: "approved",
      approval: { changes: [{ action: "add", text: "Edited." }] },
    });

    const runs: unknown[] = [];
    const notified: string[] = [];
    const second = new NodeActionRequests({
      ...store,
      executors: {
        "update-agents-md": async (_request, approval) => {
          runs.push(approval.changes);
          return { code: "pr-existing", message: "already open", url: "https://x/pull/1" };
        },
      },
      notify: async (entry) => {
        notified.push(entry.state);
      },
    });
    await second.resumeInterrupted();
    await second.resumeInterrupted();
    expect(runs).toEqual([[{ action: "add", text: "Edited." }]]);
    expect(notified).toEqual(["executed"]);
    expect(await second.get("r1")).toMatchObject({
      state: "executed",
      result: { url: "https://x/pull/1" },
    });
  });

  test("a pending request survives a restart and can still be approved once", async () => {
    let saved: NodeActionRequest[] = [];
    const store = {
      load: async () => structuredClone(saved),
      save: async (requests: NodeActionRequest[]) => {
        saved = structuredClone(requests);
      },
      emit: () => undefined,
    };
    let runs = 0;
    const executors = {
      "update-agents-md": async () => {
        runs += 1;
        return { code: "pr-opened", message: "ok" };
      },
    };
    const before = new NodeActionRequests({ ...store, executors });
    await before.create({
      requestId: "r2",
      kind: "update-agents-md",
      targets: [{ nodeId: "bk_self", nodeName: "this machine", projectId: "p1" }],
      requestedBy: { coordinatorEnvironmentId: "c", coordinatorTabId: "t", projectId: "p1" },
      agentsMd: { changes: [{ action: "add", text: "A." }] },
    });
    const after = new NodeActionRequests({ ...store, executors });
    await after.resumeInterrupted();
    expect(runs).toBe(0);
    expect((await after.resolve("r2", "approve")).state).toBe("executed");
    await expect(after.resolve("r2", "approve")).rejects.toThrow("already executed");
    expect(runs).toBe(1);
  });
});
