import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  PublicGraphRunActionResult,
  PublicGraphRunSummary,
  PublicGraphTemplateDetail,
  PublicGraphTemplateSummary,
  PublicGraphValidation,
  PublicPage,
} from "@orkestrator/protocol/public-api-resources";
import { graphLaunchRunId } from "../graph-run-launch.js";
import { graphLaunchIntent, parseGraphLaunch } from "./actions-graphs.js";
import { graphPublicLaunchRequestId } from "./graph-recovery.js";
import {
  createGraphHarness,
  GRAPH_TEST_HEAD,
  ticketLoopTemplate,
  type GraphHarness,
} from "./graph-test-support.js";
import { intentFingerprint, requestKey } from "./operation-ledger.js";

/**
 * `graph.*` (item 214): saved templates listed, shown, validated and
 * launched through the one launch service, and runs read and cancelled, over
 * real graph services, real storage and the real registry.
 */

const harnesses: GraphHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function setup(): Promise<GraphHarness> {
  const graph = await createGraphHarness();
  harnesses.push(graph);
  return graph;
}

async function restart(graph: GraphHarness): Promise<GraphHarness> {
  harnesses.splice(harnesses.indexOf(graph), 1);
  const restarted = await graph.restart();
  harnesses.push(restarted);
  return restarted;
}

const LENS = "LENS-TEXT: trace untrusted input to its sinks.";

function launchInput(graph: GraphHarness, extra: Record<string, unknown> = {}) {
  return {
    projectId: graph.projectId,
    template: "user:ticket-loop",
    environmentId: "env-1",
    ticketId: graph.ticketId,
    roles: {
      builder: [{ agent: "codex", model: "gpt-5.5", reasoningEffort: "high" }],
      reviewer: [{ agent: "claude", lens: { label: "Security", instruction: LENS } }],
    },
    ...extra,
  };
}

/** No ticket text, lens text or input value in a response. */
function expectContentFree(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain("SECRET-TICKET-BODY");
  expect(json).not.toContain(LENS);
  expect(json).not.toContain(GRAPH_TEST_HEAD);
}

async function admitted(graph: GraphHarness, requestId: string): Promise<boolean> {
  const key = requestKey("operator", "graph.launch", `project:${graph.projectId}`, requestId);
  return Boolean(await graph.harness.storage.publicOperations.findPublicOperationByKey(key));
}

describe("graph.list, graph.show and graph.validate", () => {
  test("list and show report metadata, providers and defaults, never prompts", async () => {
    const graph = await setup();
    const listed = await graph.harness.call<PublicPage<PublicGraphTemplateSummary>>("graph.list", {
      projectId: graph.projectId,
    });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.result.items).toEqual([
      expect.objectContaining({
        template: "user:ticket-loop",
        scope: "user",
        trust: "trusted",
        launchable: true,
        errors: 0,
      }),
    ]);

    const shown = await graph.harness.call<PublicGraphTemplateDetail>("graph.show", {
      template: "user:ticket-loop",
      projectId: graph.projectId,
    });
    if (!shown.ok) throw new Error(shown.error.message);
    expect(shown.result.inputs).toContainEqual({
      name: "ticket",
      type: "ticket@1",
      required: true,
      ticket: true,
    });
    expect(shown.result.workspace).toEqual({ kind: "environment", create: "worktree" });
    const reviewer = shown.result.launch!.roles.find((role) => role.key === "reviewer")!;
    expect(reviewer.floor).toBe("provider-configured");
    const grok = reviewer.providers.find((provider) => provider.agent === "grok")!;
    expect(grok).toMatchObject({ available: false, tier: "advisory" });
    expect(grok.unavailableReason).toContain("floor");
    // No prompt text leaves the template: built-in prompts are named only.
    expect(JSON.stringify(shown.result)).not.toContain("builtIn");

    const without = await graph.harness.call<PublicGraphTemplateDetail>("graph.show", {
      template: "user:ticket-loop",
    });
    expect(without.ok && without.result.launch).toBeNull();
  });

  test("validate compiles a saved template or inline text and saves nothing", async () => {
    const graph = await setup();
    const saved = await graph.harness.call<PublicGraphValidation>("graph.validate", {
      template: "user:ticket-loop",
      projectId: graph.projectId,
    });
    expect(saved.ok && saved.result).toMatchObject({
      template: "user:ticket-loop",
      ok: true,
      launchable: true,
      errors: 0,
    });

    const draft = ticketLoopTemplate("draft-only");
    const inline = await graph.harness.call<PublicGraphValidation>("graph.validate", {
      text: JSON.stringify(draft),
    });
    expect(inline.ok && inline.result).toMatchObject({ template: null, ok: true });

    const broken = {
      ...draft,
      nodes: draft.nodes.map((node) => (node.kind === "agent" ? { ...node, role: "ghost" } : node)),
    };
    const failing = await graph.harness.call<PublicGraphValidation>("graph.validate", {
      text: JSON.stringify(broken),
    });
    if (!failing.ok) throw new Error(failing.error.message);
    expect(failing.result.ok).toBe(false);
    expect(failing.result.errors).toBeGreaterThan(0);
    expect(failing.result.diagnostics[0]!.severity).toBe("error");

    const garbage = await graph.harness.call<PublicGraphValidation>("graph.validate", {
      text: '{"format": "orkestrator.graph", "format": 1}',
    });
    expect(garbage.ok && garbage.result.diagnostics[0]!.code).toBe("template-invalid_json");

    expect((await graph.templates.list()).templates.map((entry) => entry.id)).toEqual([
      "ticket-loop",
    ]);
    const both = await graph.harness.call("graph.validate", {
      template: "user:ticket-loop",
      text: "{}",
    });
    expect(!both.ok && both.error.code).toBe("invalid-input");
  });
});

describe("graph.launch", () => {
  test("launches once per request key through the launch service, content-free", async () => {
    const graph = await setup();
    const input = launchInput(graph);
    const launched = await graph.harness.call<PublicGraphRunActionResult>("graph.launch", input, {
      requestId: "launch-1",
    });
    if (!launched.ok) throw new Error(`${launched.error.code}: ${launched.error.message}`);
    expect(launched.receipt).toMatchObject({ action: "graph.launch", state: "succeeded" });
    expect(launched.result).toMatchObject({
      projectId: graph.projectId,
      environmentId: "env-1",
      status: "running",
      template: { id: "ticket-loop" },
    });
    expectContentFree(launched);

    const run = (await graph.harness.storage.graphRuns.getGraphRun(launched.result.runId))!;
    const key = requestKey("operator", "graph.launch", `project:${graph.projectId}`, "launch-1");
    expect(run.id).toBe(graphLaunchRunId(graph.projectId, graphPublicLaunchRequestId(key)));
    expect(run.launch).toEqual({ requestedBy: "cli", ticket: { taskId: graph.ticketId } });
    expect(run.bindings.roles.builder).toEqual({
      platform: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
    });
    expect(run.bindings.roles.reviewer).toEqual({
      platform: "claude",
      lens: { label: "Security", instruction: LENS },
    });
    expect(Object.keys(run.bindings.inputs).sort()).toEqual(["target", "ticket"]);
    expect(graph.linked).toEqual([[graph.ticketId, "env-1"]]);

    const replay = await graph.harness.call<PublicGraphRunActionResult>("graph.launch", input, {
      requestId: "launch-1",
    });
    expect(replay.receipt).toMatchObject({
      operationId: launched.receipt!.operationId,
      replayed: true,
    });
    expect(replay.ok && replay.result.runId).toBe(run.id);
    expect(await graph.harness.storage.graphRuns.listGraphRuns("env-1")).toHaveLength(1);

    const conflict = await graph.harness.call(
      "graph.launch",
      launchInput(graph, { params: {}, roles: undefined }),
      { requestId: "launch-1" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
  });

  test("a new environment is left to the run's provisioner", async () => {
    const graph = await setup();
    const launched = await graph.harness.call<PublicGraphRunActionResult>(
      "graph.launch",
      {
        projectId: graph.projectId,
        template: "user:ticket-loop",
        newEnvironment: "container",
        ticketId: graph.ticketId,
      },
      { requestId: "new-env" },
    );
    if (!launched.ok) throw new Error(`${launched.error.code}: ${launched.error.message}`);
    expect(launched.result).toMatchObject({ environmentId: null, status: "provisioning" });
    const run = (await graph.harness.storage.graphRuns.getGraphRun(launched.result.runId))!;
    expect(run.launch).toMatchObject({ requestedBy: "cli", create: "container" });
    // Linked once the provisioner creates the environment.
    expect(graph.linked).toEqual([]);
  });

  test("refusals map to stable codes before admission and launch nothing", async () => {
    const graph = await setup();
    const cases: Array<{
      name: string;
      input: Record<string, unknown>;
      code: string;
      reason?: string;
    }> = [
      {
        name: "provider below a floor",
        input: launchInput(graph, { roles: { reviewer: [{ agent: "grok" }] } }),
        code: "invalid-input",
        reason: "invalid-binding",
      },
      {
        name: "unknown role",
        input: launchInput(graph, { roles: { ghost: [{ agent: "claude" }] } }),
        code: "invalid-input",
        reason: "invalid-binding",
      },
      {
        name: "list for a one-model role",
        input: launchInput(graph, {
          roles: { builder: [{ agent: "claude" }, { agent: "codex" }] },
        }),
        code: "invalid-input",
        reason: "invalid-binding",
      },
      {
        name: "unknown input",
        input: launchInput(graph, { inputs: { ghost: 1 } }),
        code: "invalid-input",
        reason: "invalid-launch",
      },
      {
        name: "missing template",
        input: launchInput(graph, { template: "user:missing" }),
        code: "not-found",
        reason: "not-found",
      },
      {
        name: "two targets",
        input: launchInput(graph, { newEnvironment: "worktree" }),
        code: "invalid-input",
      },
      {
        name: "bad reference",
        input: launchInput(graph, { template: "nope" }),
        code: "invalid-input",
      },
      {
        name: "missing ticket",
        input: launchInput(graph, { ticketId: "ticket-missing" }),
        code: "not-found",
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const requestId = `refused-${index}`;
      const response = await graph.harness.call("graph.launch", entry.input, { requestId });
      if (response.ok) throw new Error(`${entry.name}: launched`);
      expect({ name: entry.name, code: response.error.code as string }).toEqual({
        name: entry.name,
        code: entry.code,
      });
      if (entry.reason) {
        expect({ name: entry.name, reason: response.error.details?.reason }).toEqual({
          name: entry.name,
          reason: entry.reason,
        });
      }
      expect({ name: entry.name, admitted: await admitted(graph, requestId) }).toEqual({
        name: entry.name,
        admitted: false,
      });
    }
    expect(await graph.harness.storage.graphRuns.listGraphRuns("env-1")).toHaveLength(0);
  });

  test("untrusted and broken templates are refused with their reasons", async () => {
    const graph = await setup();
    const project = (await graph.harness.storage.getProject(graph.projectId))!;
    const directory = path.join(project.localPath!, ".orkestrator", "graphs");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "repo.graph.json"),
      JSON.stringify(ticketLoopTemplate("repo-loop")),
    );
    const untrusted = await graph.harness.call(
      "graph.launch",
      launchInput(graph, { template: "project:repo.graph.json", roles: undefined }),
      { requestId: "untrusted" },
    );
    expect(!untrusted.ok && untrusted.error).toMatchObject({
      code: "conflict",
      details: { reason: "untrusted" },
    });
    const shown = await graph.harness.call<PublicGraphTemplateDetail>("graph.show", {
      template: "project:repo.graph.json",
      projectId: graph.projectId,
    });
    expect(shown.ok && shown.result.launch).toMatchObject({ launchable: false, roles: [] });

    const broken = ticketLoopTemplate("broken-loop");
    broken.nodes = broken.nodes.map((node) =>
      node.kind === "agent" ? { ...node, role: "ghost" } : node,
    );
    await graph.templates.save(broken);
    const notLaunchable = await graph.harness.call(
      "graph.launch",
      launchInput(graph, { template: "user:broken-loop", roles: undefined }),
      { requestId: "broken" },
    );
    expect(!notLaunchable.ok && notLaunchable.error.code).toBe("not-ready");
    expect(await admitted(graph, "untrusted")).toBe(false);
    expect(await admitted(graph, "broken")).toBe(false);
  });
});

describe("graph.status and graph.cancel", () => {
  test("status counts states; cancel replays and refuses an ended run", async () => {
    const graph = await setup();
    const launched = await graph.harness.call<PublicGraphRunActionResult>(
      "graph.launch",
      launchInput(graph),
      { requestId: "to-cancel" },
    );
    if (!launched.ok) throw new Error(launched.error.message);
    const runId = launched.result.runId;
    const status = await graph.harness.call<PublicGraphRunSummary>("graph.status", { runId });
    if (!status.ok) throw new Error(status.error.message);
    expect(status.result).toMatchObject({
      id: runId,
      status: "running",
      requestedBy: "cli",
      ticketId: graph.ticketId,
      usage: { agentSessions: 0, tokens: 0 },
    });
    expectContentFree(status.result);

    const cancelled = await graph.harness.call<PublicGraphRunActionResult>(
      "graph.cancel",
      { runId },
      { requestId: "cancel-1" },
    );
    expect(cancelled.ok && cancelled.result.status).toBe("cancelling");
    const replay = await graph.harness.call("graph.cancel", { runId }, { requestId: "cancel-1" });
    expect(replay.receipt).toMatchObject({ replayed: true, state: "succeeded" });

    await graph.runs.advanceNow(runId);
    const ended = await graph.harness.call("graph.cancel", { runId }, { requestId: "cancel-2" });
    expect(!ended.ok && ended.error.code).toBe("conflict");
    const missing = await graph.harness.call("graph.status", { runId: "run-missing" });
    expect(!missing.ok && missing.error.code).toBe("not-found");
  });
});

describe("restart recovery", () => {
  async function inFlight(graph: GraphHarness, input: Record<string, unknown>) {
    const scope = `project:${graph.projectId}`;
    const key = requestKey("operator", "graph.launch", scope, "restart");
    const { record } = await graph.harness.storage.publicOperations.admitPublicOperation({
      authority: "operator",
      action: "graph.launch",
      scope,
      requestId: "restart",
      requestKey: key,
      fingerprint: intentFingerprint("graph.launch", graphLaunchIntent(parseGraphLaunch(input))),
      generation: graph.harness.storage.getResourceGeneration(),
      resources: { projectId: graph.projectId },
    });
    await graph.harness.storage.publicOperations.updatePublicOperation(
      record.operationId,
      (current) => ({ ...current, state: "running", stage: "launching" }),
    );
    return { operationId: record.operationId, key };
  }

  test("a launch the restart interrupted settles from the run it created, never twice", async () => {
    let graph = await setup();
    const input = launchInput(graph);
    const { operationId, key } = await inFlight(graph, input);
    // The run the interrupted launch created, under the key-derived id.
    const created = await graph.launches.launch(
      {
        ref: { scope: "user", id: "ticket-loop" },
        projectId: graph.projectId,
        environment: { kind: "existing", environmentId: "env-1" },
        ticket: { taskId: graph.ticketId },
        requestId: graphPublicLaunchRequestId(key),
      },
      { requestedBy: "cli" },
    );
    graph = await restart(graph);
    const recovered = await graph.harness.call("run.get", { operationId });
    expect(recovered.receipt).toMatchObject({
      state: "succeeded",
      result: { runId: created.runId, environmentId: "env-1" },
    });
    const replay = await graph.harness.call("graph.launch", input, { requestId: "restart" });
    expect(replay.receipt).toMatchObject({ operationId, replayed: true, state: "succeeded" });
    expect(await graph.harness.storage.graphRuns.listGraphRuns("env-1")).toHaveLength(1);
  });

  test("without a run the launch is interrupted, not run again", async () => {
    let graph = await setup();
    const input = launchInput(graph);
    await inFlight(graph, input);
    graph = await restart(graph);
    const replay = await graph.harness.call("graph.launch", input, { requestId: "restart" });
    expect(replay.receipt).toMatchObject({ replayed: true, state: "interrupted" });
    expect(!replay.ok && replay.error.code).toBe("run-interrupted");
    expect(await graph.harness.storage.graphRuns.listGraphRuns("env-1")).toHaveLength(0);
  });
});
