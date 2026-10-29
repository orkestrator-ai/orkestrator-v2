import { describe, expect, test } from "bun:test";
import { buildPipelineBuiltInTemplate } from "./builtins/build-pipeline.js";
import { compile, type GraphCompileDiagnostic } from "./compile.js";
import { graphTemplateExample } from "./examples.js";
import type { GraphRewind } from "./run-model.js";
import {
  checkGraphSystemParams,
  GRAPH_SYSTEM_ACTION_SPECS,
  GRAPH_WAIT_FOR_CHECKS_DEFAULT_MINUTES,
  GRAPH_WAIT_FOR_CHECKS_MAX_MINUTES,
  graphForcePushRewind,
  graphSystemActionParams,
  graphSystemRequiredInputs,
} from "./system-actions.js";
import {
  GRAPH_SYSTEM_ACTIONS,
  type GraphSystemNode,
  type GraphSystemParamValue,
  type GraphTemplateV1,
} from "./template-model.js";
import { graphBuiltInType } from "./types.js";

const codes = (action: GraphSystemNode["action"], params: Record<string, GraphSystemParamValue>) =>
  checkGraphSystemParams(action, params).map((issue) => [issue.param ?? "$", issue.code]);

/** The base of the system-node compile tests: one workspace input, a system node reading it. */
function template(node: Omit<GraphSystemNode, "id" | "kind">): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "system",
    revision: 1,
    name: "System",
    parameters: [],
    roles: [],
    inputs: [
      { name: "target", type: "workspace@1" },
      { name: "description", type: "pr-description@1" },
    ],
    workspace: { kind: "environment" },
    nodes: [{ id: "act", kind: "system", ...node }],
    edges: (node.inputs ?? []).map((input) => ({
      id: `in-${input.name}`,
      from: { input: input.type === "workspace@1" ? "target" : "description" },
      to: { node: "act", port: input.name },
    })),
    limits: { maxAgentSessions: 1, maxConcurrentAgents: 1 },
  };
}

function systemErrors(value: GraphTemplateV1): Partial<GraphCompileDiagnostic>[] {
  return compile(value)
    .diagnostics.filter((diagnostic) => diagnostic.code.startsWith("system-"))
    .map(({ code, path, detail, port }) => ({
      code,
      path,
      ...(detail ? { detail } : {}),
      ...(port ? { port } : {}),
    }));
}

describe("system action table", () => {
  test("covers every action, with built-in or declared types only", () => {
    expect(Object.keys(GRAPH_SYSTEM_ACTION_SPECS).sort()).toEqual([...GRAPH_SYSTEM_ACTIONS].sort());
    for (const spec of Object.values(GRAPH_SYSTEM_ACTION_SPECS)) {
      for (const port of [...spec.inputs, ...spec.outputs]) {
        if (port.type === "pull-request-state@1") continue;
        // A list port (`select-workspace`'s candidates) lists a built-in element type.
        const element = /^list<(.+)>$/.exec(port.type)?.[1] ?? port.type;
        expect({
          action: spec.action,
          type: port.type,
          builtIn: !!graphBuiltInType(element),
        }).toEqual({
          action: spec.action,
          type: port.type,
          builtIn: true,
        });
      }
    }
  });

  test("only wait-for-checks has no side effect (the mock-run seam)", () => {
    expect(
      Object.values(GRAPH_SYSTEM_ACTION_SPECS)
        .filter((spec) => !spec.sideEffect)
        .map((spec) => spec.action),
    ).toEqual(["wait-for-checks"]);
  });

  test("select-workspace falls back only when told to (item 403)", () => {
    expect(graphSystemActionParams("select-workspace")).toEqual({ fallback: "fail" });
    expect(checkGraphSystemParams("select-workspace", { fallback: "first" })).toEqual([]);
    expect(checkGraphSystemParams("select-workspace", { fallback: "best" })).toMatchObject([
      { param: "fallback", code: "type" },
    ]);
  });

  test("defaults fill absent parameters", () => {
    expect(graphSystemActionParams("wait-for-checks")).toEqual({
      timeoutMinutes: GRAPH_WAIT_FOR_CHECKS_DEFAULT_MINUTES,
    });
    expect(graphSystemActionParams("wait-for-checks", { timeoutMinutes: 5 })).toEqual({
      timeoutMinutes: 5,
    });
    expect(graphSystemActionParams("open-pull-request")).toEqual({
      targetBranch: undefined,
      draft: false,
    });
    expect(graphSystemActionParams("prepare-environment")).toEqual({ setup: true });
  });
});

describe("system parameters", () => {
  test("unknown keys, types and ranges", () => {
    expect(codes("push-branch", { force: true })).toEqual([["force", "unknown"]]);
    expect(codes("wait-for-checks", { timeoutMinutes: 0 })).toEqual([["timeoutMinutes", "range"]]);
    expect(
      codes("wait-for-checks", { timeoutMinutes: GRAPH_WAIT_FOR_CHECKS_MAX_MINUTES + 1 }),
    ).toEqual([["timeoutMinutes", "range"]]);
    expect(codes("wait-for-checks", { timeoutMinutes: 1.5 })).toEqual([["timeoutMinutes", "type"]]);
    expect(codes("wait-for-checks", { timeoutMinutes: GRAPH_WAIT_FOR_CHECKS_MAX_MINUTES })).toEqual(
      [],
    );
    expect(codes("open-pull-request", { draft: "yes" })).toEqual([["draft", "type"]]);
    expect(codes("open-pull-request", { draft: [true] })).toEqual([["draft", "type"]]);
    expect(codes("update-ticket", { status: "doing" })).toEqual([["status", "type"]]);
  });

  test("formats", () => {
    expect(codes("open-pull-request", { targetBranch: "release/2026-10" })).toEqual([]);
    for (const branch of ["-main", "a..b", "main.lock", "x y", "a//b", "main/", " "]) {
      expect(codes("open-pull-request", { targetBranch: branch })).toEqual([
        ["targetBranch", "format"],
      ]);
    }
    expect(codes("update-ticket", { status: "review", taskId: "two words" })).toEqual([
      ["taskId", "format"],
    ]);
    expect(codes("update-ticket", { comment: "Line\u0007" })).toEqual([["comment", "format"]]);
    expect(codes("update-ticket", { comment: "x".repeat(2_001) })).toEqual([["comment", "range"]]);
  });

  test("required and contradictory combinations", () => {
    expect(codes("notify", {})).toEqual([
      ["to", "required"],
      ["message", "required"],
    ]);
    expect(codes("notify", { to: "tab", message: "Done" })).toEqual([["tabId", "required"]]);
    expect(codes("notify", { to: "coordinator", tabId: "t1", message: "Done" })).toEqual([
      ["tabId", "conflict"],
    ]);
    expect(codes("notify", { to: "tab", tabId: "t1", message: "Done" })).toEqual([]);
    expect(codes("update-ticket", {})).toEqual([["$", "required"]]);
    expect(codes("update-ticket", { lifecycle: "complete", status: "done" })).toEqual([
      ["status", "conflict"],
    ]);
    expect(codes("update-ticket", { lifecycle: "build-started" })).toEqual([]);
  });

  test("parameters that need an input", () => {
    expect(graphSystemRequiredInputs("update-ticket", { record: "criteria" })).toEqual([
      { type: "verification-verdict@1", because: "record: criteria reads it" },
    ]);
    expect(graphSystemRequiredInputs("update-ticket", { lifecycle: "pr-raised" })).toEqual([
      { type: "pr-result@1", because: "a pr-raised update links it" },
    ]);
    expect(graphSystemRequiredInputs("push-branch").map((entry) => entry.type)).toEqual([
      "workspace@1",
    ]);
  });
});

describe("the compiler checks system nodes", () => {
  test("the built-ins and examples that use system nodes pass", () => {
    const built = compile(buildPipelineBuiltInTemplate());
    expect(built.diagnostics.filter((d) => d.code.startsWith("system-"))).toEqual([]);
    expect(built.ok).toBe(true);
    for (const key of ["multi-review", "build-pipeline-loop", "failure-diagnosis"] as const) {
      expect(systemErrors(graphTemplateExample(key))).toEqual([]);
    }
  });

  test("bad parameters are pinned to the parameter", () => {
    expect(
      systemErrors(
        template({
          action: "push-branch",
          params: { force: true },
          inputs: [{ name: "code", type: "workspace@1" }],
        }),
      ),
    ).toEqual([{ code: "system-param-invalid", path: "nodes[0].params.force", detail: "unknown" }]);
    expect(systemErrors(template({ action: "update-ticket", params: {} }))).toEqual([
      { code: "system-param-invalid", path: "nodes[0].params", detail: "required" },
    ]);
  });

  test("ports bind by type: unread inputs, duplicates, missing inputs, unproduced outputs", () => {
    expect(
      systemErrors(
        template({
          action: "push-branch",
          inputs: [
            { name: "code", type: "workspace@1" },
            { name: "other", type: "workspace@1" },
            { name: "description", type: "pr-description@1" },
          ],
          outputs: [
            { name: "code", type: "workspace@1" },
            { name: "pr", type: "pr-result@1" },
          ],
        }),
      ),
    ).toEqual([
      {
        code: "system-port-unsupported",
        path: "nodes[0].inputs[1].type",
        detail: "duplicate",
        port: "other",
      },
      {
        code: "system-port-unsupported",
        path: "nodes[0].inputs[2].type",
        detail: "input-type",
        port: "description",
      },
      {
        code: "system-port-unsupported",
        path: "nodes[0].outputs[1].type",
        detail: "output-type",
        port: "pr",
      },
    ]);
    expect(
      systemErrors(
        template({ action: "open-pull-request", inputs: [{ name: "code", type: "workspace@1" }] }),
      ),
    ).toEqual([{ code: "system-input-missing", path: "nodes[0].inputs" }]);
    expect(
      systemErrors(
        template({
          action: "update-ticket",
          params: { lifecycle: "pr-raised" },
          inputs: [{ name: "code", type: "workspace@1" }],
        }),
      ).map((entry) => [entry.code, entry.detail]),
    ).toEqual([
      ["system-port-unsupported", "input-type"],
      ["system-input-missing", undefined],
    ]);
  });

  test("a routed error port is always allowed", () => {
    expect(
      systemErrors(
        template({
          action: "push-branch",
          inputs: [{ name: "code", type: "workspace@1" }],
          outputs: [{ name: "error", type: "error@1" }],
          onFailure: "route",
        }),
      ),
    ).toEqual([]);
  });

  test("the declared pull-request-state@1 must accept what the action reports", () => {
    const value = template({
      action: "open-pull-request",
      inputs: [
        { name: "code", type: "workspace@1" },
        { name: "description", type: "pr-description@1" },
      ],
      outputs: [{ name: "state", type: "pull-request-state@1" }],
    });
    value.types = [
      {
        name: "pull-request-state",
        version: 1,
        schema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
          additionalProperties: false,
        },
        storage: "value",
        budgets: { maxBytes: 4096 },
      },
    ];
    expect(systemErrors(value)).toEqual([
      {
        code: "system-port-unsupported",
        path: "nodes[0].outputs[0].type",
        detail: "schema_mismatch",
        port: "state",
      },
    ]);
    value.types = buildPipelineBuiltInTemplate().types!.filter(
      (type) => type.name === "pull-request-state",
    );
    expect(systemErrors(value)).toEqual([]);
  });
});

describe("force-with-lease only after a code rewind", () => {
  const rewind = (id: string, code?: GraphRewind["code"]): GraphRewind => ({
    id,
    kind: code ? "rewind-code" : "restart",
    nodeId: "build",
    activation: "build#iter=1#attempt=1",
    iteration: 1,
    requestedAt: "2026-10-29T00:00:00.000Z",
    requestedBy: "user",
    superseded: { activations: [], artifacts: [] },
    ...(code ? { code } : {}),
  });
  const sha = "a".repeat(40);

  test("no rewind, a restart, or a rewind that dropped nothing upstream: a plain push", () => {
    expect(graphForcePushRewind([], new Set())).toBeNull();
    expect(graphForcePushRewind([rewind("r1")], new Set())).toBeNull();
    expect(
      graphForcePushRewind(
        [rewind("r1", { headRef: sha, upstream: "origin/feature", upstreamCommitsDropped: 0 })],
        new Set(),
      ),
    ).toBeNull();
    expect(graphForcePushRewind([rewind("r1", { headRef: sha })], new Set())).toBeNull();
  });

  test("a rewind that dropped upstream commits forces the next push only", () => {
    const rewinds = [
      rewind("r1", { headRef: sha, upstream: "origin/feature", upstreamCommitsDropped: 2 }),
    ];
    expect(graphForcePushRewind(rewinds, new Set())).toEqual({
      rewindId: "r1",
      upstream: "origin/feature",
    });
    expect(graphForcePushRewind(rewinds, new Set(["r1"]))).toBeNull();
    // A later plain restart does not hide the code rewind.
    expect(graphForcePushRewind([...rewinds, rewind("r2")], new Set())?.rewindId).toBe("r1");
  });
});
