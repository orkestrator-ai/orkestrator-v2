/**
 * Replicated agent nodes on the real agent executor (items 204, 205): each
 * branch of a panel × lenses product gets its own session on its panel
 * model with its lens in the prompt, provisional progress is kept per
 * branch, and a consolidator sees every source item's stable id and may
 * cite exactly those (report §5.8, §5.9).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GraphRun, GraphRunBindings, NodeActivation } from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { graphBuiltInType } from "@orkestrator/protocol/graphs/types";
import {
  TEST_WORKSPACE,
  graphAgentWorld,
  toolContent,
  turnSlots,
  type FakeAgentScript,
  type GraphAgentWorld,
} from "./graph-agent-test-support.js";

let world: GraphAgentWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

type Report = Record<string, unknown> & { issues: Record<string, unknown>[] };
const EXAMPLE = graphBuiltInType("review-report@1")!.example as Report;
const ISSUE = EXAMPLE.issues[0]!;

/** A clean report with one issue per title. */
function reportWith(titles: string[], cite?: (index: number) => string[]): Report {
  return {
    ...structuredClone(EXAMPLE),
    issues: titles.map((title, index) => ({
      ...structuredClone(ISSUE),
      title,
      ...(cite ? { reviewSourceIds: cite(index) } : {}),
    })),
    testCoverageGaps: [],
  };
}

const PANEL: GraphRunBindings["roles"] = {
  worker: { platform: "claude", model: "consolidator" },
  panel: [
    { platform: "claude", model: "model-a" },
    { platform: "claude", model: "model-b" },
  ],
};

const LENSES = [
  { key: "security", label: "Security", instruction: "Look only for security problems." },
  { key: "api", label: "API", instruction: "Look only at the public API." },
];

/** `review` (panel, optionally × lenses) → `consolidate` (fan-in, cites its sources). */
function panelTemplate(options: { lenses?: boolean; consolidate?: boolean } = {}): GraphTemplateV1 {
  const consolidate = options.consolidate ?? true;
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "agent-panel",
    revision: 1,
    name: "Agent panel",
    parameters: [],
    roles: [
      { key: "worker", multiplicity: "one" },
      { key: "panel", multiplicity: "panel", maxPanel: 2 },
    ],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs: [
      {
        name: "report",
        type: "review-report@1",
        from: consolidate
          ? { node: "consolidate", port: "report" }
          : { node: "review", port: "report" },
      },
    ].filter(() => consolidate),
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "review",
        kind: "agent",
        role: "panel",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        replicate: options.lenses
          ? {
              over: "cross",
              axes: [
                { over: "panel", role: "panel" },
                { over: "lenses", lenses: LENSES },
              ],
            }
          : { over: "panel", role: "panel" },
        prompt: { template: "Review the change.\n\n{{> input.code}}\n" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
      ...(consolidate
        ? [
            {
              id: "consolidate",
              kind: "agent",
              role: "worker",
              capabilities: { profile: "observer" },
              workspaceAccess: "none",
              prompt: { template: "Consolidate the reviews.\n\n{{> input.reports}}\n" },
              inputs: [{ name: "reports", type: "list<review-report@1>", render: "json-frame" }],
              outputs: [{ name: "report", type: "review-report@1", provenance: "cite" }],
            },
          ]
        : []),
    ],
    edges: [
      { id: "code", from: { input: "target" }, to: { node: "review", port: "code" } },
      ...(consolidate
        ? [
            {
              id: "reports",
              from: { node: "review", port: "report" },
              to: { node: "consolidate", port: "reports" },
            },
          ]
        : []),
    ],
    limits: { maxAgentSessions: 20, maxConcurrentAgents: 8 },
  } as GraphTemplateV1;
}

function activationsOf(run: GraphRun, nodeId: string): NodeActivation[] {
  return run.activations.filter((activation) => activation.nodeId === nodeId);
}

/** The model the turn's session was created on. */
function modelOf(turn: Parameters<FakeAgentScript>[0], w: GraphAgentWorld): string {
  return String(w.provider.session(turn.sessionId).createOptions.model);
}

describe("replicated agent nodes", () => {
  test("panel × lenses: one session per branch on its panel model, with its lens last", async () => {
    world = await graphAgentWorld({
      script: async (turn, tools) => {
        const slots = turnSlots(turn);
        await tools.call("submit_report", {
          resultKey: slots.report,
          result: reportWith([`Found by ${modelOf(turn, world!)}`]),
        });
        return "idle";
      },
    });
    world.start();
    const run = await world.launch(
      panelTemplate({ lenses: true, consolidate: false }),
      { target: TEST_WORKSPACE },
      PANEL,
    );
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const review = activationsOf(done, "review");
    expect(review.map((activation) => activation.branchKey)).toEqual([
      "panel.1+lens.security",
      "panel.1+lens.api",
      "panel.2+lens.security",
      "panel.2+lens.api",
    ]);
    // Four fresh sessions, each on the branch's panel model.
    expect(world.provider.sessions.size).toBe(4);
    for (const activation of review) {
      const model = activation.branchKey!.startsWith("panel.1") ? "model-a" : "model-b";
      expect(activation.session?.model).toBe(model);
      const turn = world.provider
        .turns()
        .find((candidate) => candidate.requestId === activation.session?.requestId)!;
      expect(modelOf(turn, world)).toBe(model);
      // The template never names `lens`: the branch's lens follows the
      // template, after the shared input (one cached prefix for every branch).
      const lens = LENSES.find((entry) => activation.branchKey!.endsWith(entry.key))!;
      const other = LENSES.find((entry) => entry !== lens)!;
      const user = turn.prompt.slice(0, turn.prompt.indexOf(lens.instruction) + 1);
      expect(turn.prompt).toContain(`Lens: ${lens.label}\n\n${lens.instruction}`);
      expect(turn.prompt).not.toContain(other.instruction);
      expect(user.indexOf("Review the change.")).toBeLessThan(user.indexOf("Lens:"));
      expect(user.indexOf("<orkestrator-evidence")).toBeLessThan(user.indexOf("Lens:"));
    }
  });

  test("report_progress entries are kept on each branch's own activation", async () => {
    world = await graphAgentWorld({
      script: async (turn, tools) => {
        const slots = turnSlots(turn);
        const model = modelOf(turn, world!);
        if (turn.index === 1) {
          const item = { ...structuredClone(ISSUE), title: `Progress from ${model}` };
          await tools.call("report_progress", { resultKey: slots.report, item });
          // Ends without its result: the reminder turn submits it.
          return "idle";
        }
        await tools.call("submit_report", {
          resultKey: slots.report,
          result: reportWith([`Found by ${model}`]),
        });
        return "idle";
      },
    });
    world.start();
    const run = await world.launch(
      panelTemplate({ consolidate: false }),
      { target: TEST_WORKSPACE },
      PANEL,
    );
    const paused = await world.drive(
      run.id,
      (current) =>
        activationsOf(current, "review").filter(
          (activation) => (activation.session?.progress?.length ?? 0) > 0,
        ).length === 2,
      8,
    );
    const titles = activationsOf(paused, "review").map((activation) => [
      activation.branchKey,
      activation.session?.progress?.map((entry) => (entry.item as { title: string }).title),
    ]);
    expect(titles).toEqual([
      ["panel.1", ["Progress from model-a"]],
      ["panel.2", ["Progress from model-b"]],
    ]);
    expect((await world.drive(run.id)).status).toBe("complete");
  });

  test("a consolidator sees every source item's id and may cite exactly those", async () => {
    const shown: string[][] = [];
    const refused: Record<string, unknown>[] = [];
    world = await graphAgentWorld({
      script: async (turn, tools) => {
        const slots = turnSlots(turn);
        if (turn.prompt.startsWith("Review the change.")) {
          const model = modelOf(turn, world!);
          await tools.call("submit_report", {
            resultKey: slots.report,
            result: reportWith([`${model} one`, `${model} two`]),
          });
          return "idle";
        }
        const ids = [...turn.prompt.matchAll(/"sourceId":"([^"]+)"/g)].map((match) => match[1]!);
        shown.push(ids);
        // An id that is not an input item is refused.
        refused.push(
          toolContent(
            await tools.call("submit_report", {
              resultKey: slots.report,
              result: reportWith(["Merged"], () => ["review/panel.9/issue-1"]),
            }),
          ),
        );
        await tools.call("submit_report", {
          resultKey: slots.report,
          result: reportWith(
            ids.map((id) => `Merged ${id}`),
            (index) => [ids[index]!],
          ),
        });
        return "idle";
      },
    });
    world.start();
    const run = await world.launch(panelTemplate(), { target: TEST_WORKSPACE }, PANEL);
    const done = await world.drive(run.id);
    expect(done.status).toBe("complete");
    const expected = [
      "review/panel.1/issue-1",
      "review/panel.1/issue-2",
      "review/panel.2/issue-1",
      "review/panel.2/issue-2",
    ];
    // The reviewers' accepted reports recorded the same ids at accept time.
    const recorded = await Promise.all(
      activationsOf(done, "review").map(
        async (activation) =>
          (await world!.artifacts.get(run.id, activation.outputs.report!))?.itemIds,
      ),
    );
    expect(recorded.flat()).toEqual(expected);
    expect(shown).toEqual([expected]);
    expect(refused[0]).toMatchObject({
      ok: false,
      error: {
        issues: [
          {
            path: "$.issues[0].reviewSourceIds[0]",
            message: "The source does not identify an item in the node's inputs.",
          },
        ],
      },
    });
    const consolidate = activationsOf(done, "consolidate")[0]!;
    const merged = await world.artifacts.get(run.id, consolidate.outputs.report!);
    const issues = ("value" in merged!.body ? (merged!.body.value as Report) : EXAMPLE).issues;
    expect(issues.map((issue) => issue.reviewSourceIds)).toEqual(expected.map((id) => [id]));
  });
});
