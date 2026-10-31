import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { MailWorld } from "../agent-mail-world-test-support.js";
import { NodeOutcomeUnknownError, NodeUnavailableError } from "./node-link.js";
import { NodeCoordination } from "./node-coordination.js";

/**
 * The approval executor of `answer-worker-question` requests: only an
 * approval answers, with the user's edit when there is one, through the
 * approval-only command on the worker's own node; a stale question, a
 * decline, malformed answers and a lost node answer never answer.
 */

const worlds: MailWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

type Routed = (args: Record<string, unknown>) => Promise<unknown>;

async function setup(routed: Routed = async () => ({ outcome: "ok", result: {} })) {
  const world = await MailWorld.create();
  worlds.push(world);
  const main = await world.main();
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const remote: Array<Record<string, unknown>> = [];
  let local: (args: Record<string, unknown>) => unknown = () => ({ result: "answered" });
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
        remote.push(args);
        return routed(args);
      },
    } as never,
    invoke: (async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      return local(args);
    }) as never,
    emit: () => undefined,
  });
  const notice = spyOn(world.storage, "sendAgentMail");
  const create = (nodeId = "bk_self", requestId = "answer-1") =>
    instance.createActionRequest({
      requestId,
      kind: "answer-worker-question",
      targets: [
        {
          nodeId,
          nodeName: nodeId === "bk_self" ? "this machine" : "Build box",
          environmentId: "worker-1",
          environmentName: "auth-fix",
          projectId: "project-on-node",
        },
      ],
      requestedBy: {
        coordinatorEnvironmentId: main.environmentId,
        coordinatorTabId: main.tabId,
        projectId: world.projectId,
      },
      reason: "The ticket says Postgres",
      workerQuestion: {
        tabId: "agent-1",
        tabName: "Claude 1",
        interactionId: "q-1",
        revision: 2,
        title: "Which database?",
        questions: [
          {
            id: "db",
            prompt: "Which database should the service use?",
            required: true,
            multiple: false,
            allowFreeText: true,
            options: [
              { id: "pg", label: "Postgres" },
              { id: "sqlite", label: "SQLite" },
            ],
          },
        ],
        proposed: [{ questionId: "db", optionIds: ["pg"] }],
      },
    });
  const done = () => {
    notice.mockRestore();
    instance.collector.dispose();
  };
  return {
    world,
    main,
    instance,
    calls,
    remote,
    notice,
    create,
    done,
    setLocal: (next: typeof local) => {
      local = next;
    },
  };
}

describe("answer-worker-question approval", () => {
  test("approving unchanged sends the coordinator's proposal on this node and mails a content-free outcome", async () => {
    const t = await setup();
    const request = await t.create();
    expect(request.workerQuestion?.proposed).toEqual([{ questionId: "db", optionIds: ["pg"] }]);
    expect(t.calls).toEqual([]);
    const resolved = await t.instance.actions.resolve(request.requestId, "approve");
    expect(resolved).toMatchObject({ state: "executed", result: { code: "answered" } });
    expect(resolved.result?.message).toContain("the coordinator's proposed answer");
    expect(t.calls).toEqual([
      {
        command: "answer_project_worker_question",
        args: {
          projectId: "project-on-node",
          environmentId: "worker-1",
          tabId: "agent-1",
          interactionId: "q-1",
          revision: 2,
          answers: [{ questionId: "db", optionIds: ["pg"] }],
        },
      },
    ]);
    expect(t.notice).toHaveBeenCalledTimes(1);
    const mail = t.notice.mock.calls[0]![1];
    expect(mail).toMatchObject({
      toEnvironmentId: t.main.environmentId,
      toTabId: t.main.tabId,
      requestId: `node-action:${request.requestId}:executed`,
      subject: expect.stringContaining("Answer a question in tab “Claude 1” of “auth-fix”"),
    });
    expect(JSON.stringify(mail)).not.toContain("Postgres");
    t.done();
  });

  test("the user's edited answer is what is sent", async () => {
    const t = await setup();
    const request = await t.create();
    const resolved = await t.instance.actions.resolve(request.requestId, "approve", {
      answers: [{ questionId: "db", freeText: "Postgres 16 with pgvector" }],
    });
    expect(resolved.state).toBe("executed");
    expect(resolved.result?.message).toContain("as the user edited it");
    expect(t.calls[0]!.args.answers).toEqual([
      { questionId: "db", freeText: "Postgres 16 with pgvector" },
    ]);
    expect(JSON.stringify(t.notice.mock.calls[0]![1])).not.toContain("pgvector");
    t.done();
  });

  test("a question gone by approval settles stale, and a decline never answers", async () => {
    const t = await setup();
    t.setLocal(() => ({ result: "stale", reason: "The question was no longer waiting." }));
    const request = await t.create();
    const resolved = await t.instance.actions.resolve(request.requestId, "approve");
    expect(resolved).toMatchObject({ state: "stale", result: { code: "stale" } });
    expect(resolved.result?.message).toContain("Nothing was sent");
    expect(t.notice.mock.calls[0]![1]).toMatchObject({
      requestId: `node-action:${request.requestId}:stale`,
      subject: expect.stringContaining("Request stale"),
    });

    const declined = await t.create("bk_self", "answer-2");
    const calls = t.calls.length;
    expect((await t.instance.actions.resolve(declined.requestId, "reject")).state).toBe("rejected");
    expect(t.calls).toHaveLength(calls);
    expect(t.notice.mock.calls.at(-1)![1]).toMatchObject({
      body: expect.stringContaining("still waiting in the worker's tab"),
    });
    t.done();
  });

  test("malformed or incomplete answers fail without reaching the worker", async () => {
    const t = await setup();
    const request = await t.create();
    const wrong = await t.instance.actions.resolve(request.requestId, "approve", {
      answers: [{ questionId: "db", optionIds: ["mongo"] }],
    });
    expect(wrong.state).toBe("failed");
    expect(wrong.result?.message).toContain("Nothing was sent");
    expect(t.calls).toEqual([]);
    await expect(
      t.instance.createActionRequest({
        requestId: "no-question",
        kind: "answer-worker-question",
        targets: [{ nodeId: "bk_self", nodeName: "this machine", environmentId: "w" }],
        requestedBy: {
          coordinatorEnvironmentId: t.main.environmentId,
          coordinatorTabId: t.main.tabId,
          projectId: t.world.projectId,
        },
      }),
    ).rejects.toThrow("carries the question");
    t.done();
  });

  test("a worker on a connected node is answered once over the node link", async () => {
    const t = await setup(async () => ({ outcome: "ok", result: { result: "answered" } }));
    const request = await t.create("bk_remote");
    const resolved = await t.instance.actions.resolve(request.requestId, "approve");
    expect(resolved.state).toBe("executed");
    expect(resolved.result?.message).toContain("on Build box");
    expect(t.calls).toEqual([]);
    expect(t.remote).toEqual([
      {
        nodeId: "bk_remote",
        command: "answer_controller_worker_question",
        args: expect.objectContaining({ projectId: "project-on-node", revision: 2 }),
        requestKey: `worker-answer:${request.requestId}`,
      },
    ]);
    t.done();
  });

  for (const [name, routed, state] of [
    ["a lost answer", async () => ({ outcome: "unknown", outcomeId: "o" }), "outcome-unknown"],
    [
      "a dropped link",
      async () => {
        throw new NodeOutcomeUnknownError("lost");
      },
      "outcome-unknown",
    ],
    [
      "a disconnected node",
      async () => {
        throw new NodeUnavailableError("not connected");
      },
      "failed",
    ],
  ] as const) {
    test(`${name} is never resent`, async () => {
      const t = await setup(routed as Routed);
      const request = await t.create("bk_remote");
      const resolved = await t.instance.actions.resolve(request.requestId, "approve");
      expect(resolved.state).toBe(state);
      expect(t.remote).toHaveLength(1);
      if (state === "failed") expect(resolved.result?.message).toContain("nothing was sent");
      else expect(resolved.result?.message).toContain("It was not resent");
      t.done();
    });
  }
});
