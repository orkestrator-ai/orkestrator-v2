import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import {
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicActionResponse,
  type PublicCapabilities,
  type PublicErrorCode,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import type {
  PublicGraphRunSummary,
  PublicGraphTemplateDetail,
  PublicGraphValidation,
} from "@orkestrator/protocol/public-api-resources";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  createGraphHarness,
  type GraphHarness,
} from "../../../apps/backend/src/core/public-api/graph-test-support.js";
import {
  capabilities,
  captureIo,
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
  type GatewayResponder,
  type RecordedRequest,
} from "./support/client-harness.js";

/**
 * `orkestrator graph list|show|validate|launch|status|cancel` (item 214):
 * what each flag sends to `public_action`, the refusals that send nothing,
 * the exit classes of the backend's refusals, and a round trip through a real
 * backend (`public_action`, the launch service, the run service, storage).
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  respond: GatewayResponder,
): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox();
  const gateway = await startFakeGateway(respond);
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  const added = await box.run([
    "connection",
    "add",
    "local",
    "--data-dir",
    dataDir,
    "--default",
    "--no-check",
  ]);
  expect(added.code).toBe(0);
  gateway.requests.length = 0;
  return { box, gateway };
}

function requestsFor(gateway: FakeGateway, action: string): RecordedRequest[] {
  return gateway.requests.filter((request) => request.body.args.action === action);
}

function receipt(action: PublicReceipt["action"]): PublicReceipt {
  return {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    operationId: "op-1790000000000-0a1b2c3d-000000000000000041",
    action,
    state: "succeeded",
    stage: "completed",
    resources: { projectId: "p1", environmentId: "env-1" },
  };
}

const LAUNCHED = {
  runId: "run-1",
  projectId: "p1",
  environmentId: "env-1",
  status: "running",
  template: { id: "ticket-loop", revision: 1, name: "Ticket loop" },
};

const STATUS: PublicGraphRunSummary = {
  id: "run-1",
  projectId: "p1",
  environmentId: "env-1",
  template: { id: "ticket-loop", revision: 1, name: "Ticket loop", scope: "user" },
  status: "waiting",
  mock: false,
  requestedBy: "cli",
  ticketId: "t1",
  activations: { complete: 2, "awaiting-human": 1 },
  usage: { agentSessions: 2, tokens: 1200 },
  error: null,
  errorCause: null,
  createdAt: new Date(0).toISOString(),
  startedAt: new Date(0).toISOString(),
  finishedAt: null,
  updatedAt: new Date(0).toISOString(),
  revision: 7,
};

function fakeBackend(): GatewayResponder {
  return (request) => {
    const action = String(request.body.args.action);
    if (action === "graph.launch" || action === "graph.cancel") {
      return envelope(
        publicSuccessEnvelope(
          action,
          action === "graph.cancel" ? { ...LAUNCHED, status: "cancelling" } : LAUNCHED,
          receipt(action),
        ),
      );
    }
    if (action === "graph.status") return envelope(publicSuccessEnvelope(action, STATUS));
    if (action === "graph.list") {
      return envelope(
        publicSuccessEnvelope(action, {
          items: [
            {
              template: "user:ticket-loop",
              scope: "user",
              id: "ticket-loop",
              name: "Ticket loop",
              revision: 1,
              digest: "d".repeat(64),
              trust: "trusted",
              launchable: true,
              engine: null,
              errors: 0,
              warnings: 0,
              pendingAcknowledgements: 0,
              agentSessions: { best: 5, worst: 15 },
            },
          ],
          total: 1,
        }),
      );
    }
    if (action === "graph.validate") {
      const result: PublicGraphValidation = {
        template: null,
        ok: false,
        launchable: false,
        blockedBy: null,
        errors: 1,
        warnings: 0,
        infos: 0,
        pendingAcknowledgements: 0,
        diagnostics: [
          {
            code: "role-unknown",
            severity: "error",
            message: "Role ghost is not declared",
            nodeId: "build",
            path: "nodes[0].role",
          },
        ],
        omittedDiagnostics: 0,
        planDigest: null,
        cost: null,
      };
      return envelope(publicSuccessEnvelope(action, result));
    }
    if (action === "graph.show") {
      const detail: Partial<PublicGraphTemplateDetail> = {
        template: "user:ticket-loop",
        name: "Ticket loop",
        trust: "trusted",
        launchable: true,
        roles: [
          { key: "reviewer", label: null, multiplicity: "panel", maxPanel: 4, defaultsFrom: [] },
        ],
        parameters: [],
        inputs: [{ name: "ticket", type: "ticket@1", required: true, ticket: true }],
        steps: [{ id: "review", kind: "agent", label: null, role: "reviewer" }],
        workspace: { kind: "environment", create: "worktree" },
        launch: {
          launchable: true,
          blockedReason: null,
          roles: [
            {
              key: "reviewer",
              panel: true,
              maxPanel: 4,
              floor: "provider-configured",
              providers: [
                { agent: "claude", tier: "enforced", available: true, unavailableReason: null },
                {
                  agent: "grok",
                  tier: "advisory",
                  available: false,
                  unavailableReason: "below its floor",
                },
              ],
              default: [],
            },
          ],
          params: {},
          environment: { default: "new-worktree", create: "worktree" },
        },
      };
      return envelope(publicSuccessEnvelope(action, detail));
    }
    return defaultResponder()(request);
  };
}

describe("graph launch", () => {
  test("sends roles, panel focus, typed params, inputs and the ticket", async () => {
    const { box, gateway } = await fixture(fakeBackend());
    const inputFile = path.join(box.root, "target.json");
    await writeFile(inputFile, JSON.stringify({ branch: "main", headRef: "a".repeat(40) }));
    const run = await box.run([
      "graph",
      "launch",
      "user:ticket-loop",
      "--project",
      "p1",
      "--environment",
      "env-1",
      "--role",
      "builder=codex/gpt-5.5@high",
      "--role",
      "reviewer=claude,opencode/anthropic/claude-sonnet",
      "--focus",
      "reviewer.2=Security\nTrace untrusted input.",
      "--param",
      "maxRounds=2",
      "--param",
      "autoFix=true",
      "--param",
      "mode=strict",
      "--input",
      'note={"text":"hi"}',
      "--input-file",
      `target=${inputFile}`,
      "--ticket",
      "t1",
      "--request-id",
      "graph-key",
      "--json",
    ]);
    expect(run.code).toBe(0);
    const sent = requestsFor(gateway, "graph.launch");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.args.request).toMatchObject({ requestId: "graph-key" });
    expect(sent[0]!.body.args.input).toEqual({
      projectId: "p1",
      template: "user:ticket-loop",
      environmentId: "env-1",
      roles: {
        builder: [{ agent: "codex", model: "gpt-5.5", reasoningEffort: "high" }],
        reviewer: [
          { agent: "claude" },
          {
            agent: "opencode",
            model: "anthropic/claude-sonnet",
            lens: { label: "Security", instruction: "Trace untrusted input." },
          },
        ],
      },
      params: { maxRounds: 2, autoFix: true, mode: "strict" },
      inputs: { note: { text: "hi" }, target: { branch: "main", headRef: "a".repeat(40) } },
      ticketId: "t1",
    });
    expect(JSON.parse(run.out)).toMatchObject({
      ok: true,
      action: "graph.launch",
      result: LAUNCHED,
    });

    const ids = await box.run([
      "graph",
      "launch",
      "project:repo.graph.json",
      "--project",
      "p1",
      "--new-container",
      "--output",
      "id",
    ]);
    expect(ids.code).toBe(0);
    expect(ids.out.trim()).toBe("run-1");
    expect(requestsFor(gateway, "graph.launch")[1]!.body.args.input).toEqual({
      projectId: "p1",
      template: "project:repo.graph.json",
      newEnvironment: "container",
    });
  });

  test("reads one input from stdin", async () => {
    const { box, gateway } = await fixture(fakeBackend());
    const io = captureIo(box.env, box.root);
    io.stdinBytes = new TextEncoder().encode('{"title":"From stdin"}');
    const run = await box.run(
      [
        "graph",
        "launch",
        "user:ticket-loop",
        "--project",
        "p1",
        "--new-worktree",
        "--input-file",
        "brief=-",
        "--json",
      ],
      io,
    );
    expect(run.code).toBe(0);
    expect(requestsFor(gateway, "graph.launch")[0]!.body.args.input).toMatchObject({
      newEnvironment: "worktree",
      inputs: { brief: { title: "From stdin" } },
    });
  });

  test("refuses bad flags with exit 2 and sends nothing", async () => {
    const { box, gateway } = await fixture(fakeBackend());
    const base = ["graph", "launch", "user:ticket-loop", "--project", "p1"];
    for (const argv of [
      ["graph", "launch", "user:ticket-loop", "--new-worktree"],
      [...base],
      [...base, "--new-worktree", "--new-container"],
      [...base, "--environment", "env-1", "--new-worktree"],
      ["graph", "launch", "ticket-loop", "--project", "p1", "--new-worktree"],
      ["graph", "launch", "team:x", "--project", "p1", "--new-worktree"],
      [...base, "--new-worktree", "--role", "builder"],
      [...base, "--new-worktree", "--role", "builder=gpt-5.5"],
      [...base, "--new-worktree", "--role", "builder=claude/"],
      [...base, "--new-worktree", "--role", "builder=claude", "--role", "builder=codex"],
      [...base, "--new-worktree", "--focus", "reviewer=Security"],
      [...base, "--new-worktree", "--role", "reviewer=claude", "--focus", "reviewer.2=Security"],
      [...base, "--new-worktree", "--param", "=1"],
      [...base, "--new-worktree", "--param", "a=1", "--param", "a=2"],
      [...base, "--new-worktree", "--input", "target={not json"],
      [...base, "--new-worktree", "--input", "target"],
      [...base, "--new-worktree", "--input", "a=1", "--input-file", "a=/nonexistent"],
      [...base, "--new-worktree", "--ticket-input", "ticket"],
    ]) {
      const bad = await box.run([...argv, "--json"]);
      expect({ argv, code: bad.code }).toEqual({ argv, code: 2 });
      expect(JSON.parse(bad.out).ok).toBe(false);
    }
    expect(requestsFor(gateway, "graph.launch")).toHaveLength(0);
  });

  test("the backend's refusals keep their exit classes", async () => {
    const refusals: Record<string, { code: PublicErrorCode; message: string }> = {
      "user:missing": { code: "not-found", message: "No user template missing" },
      "user:untrusted": { code: "conflict", message: "This project template is not trusted" },
      "user:broken": { code: "not-ready", message: "The template does not compile" },
      "user:engine": { code: "unsupported", message: "A built-in template runs on its own engine" },
      "user:floor": { code: "invalid-input", message: "grok misses the enforcement floor" },
    };
    const { box } = await fixture((request) => {
      const action = String(request.body.args.action);
      const input = request.body.args.input as { template?: string };
      if (action === "graph.launch") {
        return envelope(
          publicErrorEnvelope(action, refusals[input.template!]!) as PublicActionResponse,
        );
      }
      return defaultResponder()(request);
    });
    const expected: Record<string, number> = {
      "user:missing": 3,
      "user:untrusted": 8,
      "user:broken": 8,
      "user:engine": 8,
      "user:floor": 2,
    };
    for (const [template, code] of Object.entries(expected)) {
      const run = await box.run([
        "graph",
        "launch",
        template,
        "--project",
        "p1",
        "--new-worktree",
        "--json",
      ]);
      expect({ template, code: run.code }).toEqual({ template, code });
      expect(JSON.parse(run.out).error.code).toBe(refusals[template]!.code);
    }
  });
});

describe("graph list, show, validate, status and cancel", () => {
  test("reads templates and runs and cancels by ID", async () => {
    const { box, gateway } = await fixture(fakeBackend());
    const listed = await box.run(["graph", "list", "--project", "p1", "--output", "id"]);
    expect(listed.code).toBe(0);
    expect(listed.out.trim()).toBe("user:ticket-loop");
    expect(requestsFor(gateway, "graph.list")[0]!.body.args.input).toEqual({ projectId: "p1" });

    const shown = await box.run(["graph", "show", "user:ticket-loop", "--project", "p1"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("reviewer: claude enforced, grok unavailable");
    expect((await box.run(["graph", "show", "user:x", "--environment", "e1", "--json"])).code).toBe(
      2,
    );

    const file = path.join(box.root, "draft.graph.json");
    await writeFile(file, JSON.stringify(graphTemplateExample("multi-review")));
    const validated = await box.run(["graph", "validate", "--file", file]);
    expect(validated.code).toBe(0);
    expect(validated.out).toContain("error role-unknown (build): Role ghost is not declared");
    expect(requestsFor(gateway, "graph.validate")[0]!.body.args.input).toEqual({
      text: JSON.stringify(graphTemplateExample("multi-review")),
    });
    const stored = await box.run(["graph", "validate", "user:ticket-loop", "--project", "p1"]);
    expect(stored.code).toBe(0);
    expect(requestsFor(gateway, "graph.validate")[1]!.body.args.input).toEqual({
      template: "user:ticket-loop",
      projectId: "p1",
    });
    expect((await box.run(["graph", "validate", "--json"])).code).toBe(2);
    expect((await box.run(["graph", "validate", "user:x", "--file", file, "--json"])).code).toBe(2);

    const status = await box.run(["graph", "status", "run-1"]);
    expect(status.code).toBe(0);
    expect(status.out).toContain("2 complete, 1 awaiting-human");
    expect(requestsFor(gateway, "graph.status")[0]!.body.args.input).toEqual({ runId: "run-1" });

    const cancelled = await box.run(["graph", "cancel", "run-1", "--request-id", "c1", "--json"]);
    expect(cancelled.code).toBe(0);
    expect(JSON.parse(cancelled.out).result.status).toBe("cancelling");
    expect(requestsFor(gateway, "graph.cancel")[0]!.body.args).toMatchObject({
      input: { runId: "run-1" },
      request: { requestId: "c1" },
    });
  });
});

describe("round trip through a real backend", () => {
  function forwardTo(target: { graph: GraphHarness }): GatewayResponder {
    return async (request) => {
      const { harness } = target.graph;
      const response = (await harness.commands.get("public_action")!(
        request.body.args,
        harness.context,
      )) as PublicActionResponse;
      if (response.ok && response.action === "capabilities") {
        const real = response.result as PublicCapabilities;
        return envelope({
          ...response,
          result: { ...real, backend: { ...real.backend, ...capabilities().backend } },
        });
      }
      return envelope(response);
    };
  }

  test("a launch from the CLI is the launch service's run, replayed by its key and readable after a restart", async () => {
    const target = { graph: await createGraphHarness() };
    cleanups.push(() => target.graph.cleanup());
    const { box } = await fixture(forwardTo(target));
    const { projectId, ticketId } = target.graph;
    const launch = [
      "graph",
      "launch",
      "user:ticket-loop",
      "--project",
      projectId,
      "--environment",
      "env-1",
      "--role",
      "reviewer=claude",
      "--focus",
      "reviewer=Security\nLENS-TEXT: trace untrusted input.",
      "--ticket",
      ticketId,
      "--request-id",
      "round-trip",
      "--json",
    ];
    const launched = await box.run(launch);
    expect(launched.code).toBe(0);
    const out = JSON.parse(launched.out);
    expect(out.receipt).toMatchObject({ action: "graph.launch", state: "succeeded" });
    const runId = out.result.runId as string;
    for (const text of ["LENS-TEXT", "SECRET-TICKET-BODY"]) {
      expect(launched.out).not.toContain(text);
    }

    const replay = await box.run(launch);
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.out).receipt).toMatchObject({ replayed: true });

    target.graph = await target.graph.restart();
    const run = (await target.graph.harness.storage.graphRuns.getGraphRun(runId))!;
    expect(run.launch).toEqual({ requestedBy: "cli", ticket: { taskId: ticketId } });
    expect(run.bindings.roles.reviewer).toEqual({
      platform: "claude",
      lens: { label: "Security", instruction: "LENS-TEXT: trace untrusted input." },
    });
    expect(await target.graph.harness.storage.graphRuns.listGraphRuns("env-1")).toHaveLength(1);

    const status = await box.run(["graph", "status", runId, "--json"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out).result).toMatchObject({
      id: runId,
      status: "running",
      ticketId,
    });

    const refused = await box.run([
      "graph",
      "launch",
      "user:ticket-loop",
      "--project",
      projectId,
      "--environment",
      "env-1",
      "--role",
      "reviewer=grok",
      "--json",
    ]);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.out).error).toMatchObject({
      code: "invalid-input",
      details: { reason: "invalid-binding" },
    });

    const cancelled = await box.run(["graph", "cancel", runId, "--json"]);
    expect(cancelled.code).toBe(0);
    expect(JSON.parse(cancelled.out).result).toMatchObject({ runId, status: "cancelling" });
  });
});
