import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import type { CoordinatorWorkspace } from "@orkestrator/protocol/coordinator";
import { graphLaunchParams } from "@orkestrator/protocol/graphs/launch";
import { graphMockPinIssues, graphMockPinTargetFromPlan } from "@orkestrator/protocol/graphs/mock";
import { renderGraphPromptSource } from "@orkestrator/protocol/graphs/prompts";
import type { ScheduleFire, ScheduledJob } from "@orkestrator/protocol/scheduled-jobs";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import {
  buildPipelineBuiltInTemplate,
  multiReviewBuiltInTemplate,
} from "@orkestrator/protocol/graphs/builtins";
import {
  compile,
  graphTemplateDigest,
  type CompiledGraphPlan,
} from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_ARTIFACT_FORMAT_VERSION,
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  GRAPH_RUN_INPUT_PRODUCER,
  graphActivationKey,
  graphArtifactDigest,
  graphArtifactId,
  validateGraphRun,
  type GraphArtifact,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import {
  validateGraphTemplate,
  type GraphTemplateV1,
  type GraphSubgraphNode,
} from "@orkestrator/protocol/graphs/template";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { registerControlReviewActions } from "./control-mcp/review-actions.js";
import { computeGraphReadySet } from "./graph-run-ready-set.js";
import { graphRunFixture } from "./graph-run-test-support.js";
import { GraphRunView } from "./graph-run-view.js";
import { callToolInProcess } from "./mcp-in-process.js";
import { REVIEW_HANDLERS } from "./public-api/actions-reviews.js";
import { ScheduledJobExecutor } from "./scheduled-jobs/executor.js";
import { graphAgentResultKey } from "./graph-agent-state.js";
import {
  MULTI_REVIEW_GRAPH_NODES,
  projectMultiReviewGraphRun,
} from "./multi-review-graph-projection.js";
import { multiReviewGraphEngineTemplate } from "./multi-review-graph-template.js";
import { StorageDatabase } from "./storage-database.js";
import {
  GRAPH_VOCABULARY_UPGRADE_VERSION,
  upgradeGraphDescribeStore,
  upgradeGraphRun,
  upgradeGraphTemplate,
  upgradeGraphTemplatesStore,
  upgradeScheduledJobsStore,
  upgradeWorkflowResultsStore,
} from "./storage-graph-vocabulary-upgrade.js";
import { openBackendDatabase, STORAGE_MIGRATIONS, storeLayout } from "./storage-stores.js";
import { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";

const directories: string[] = [];
const closers: Array<() => void> = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-vocabulary-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

type GraphSubgraphRef = GraphSubgraphNode["template"];

const AT = "2026-11-10T00:00:00.000Z";
const RUN_ID = "multi-review-review-1";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

/**
 * A value in the names builds before to-do 4740 task 3 stored: the inverse of
 * the upgrade, applied to the JSON text of something this build produced.
 */
function former<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll("address-findings-result", "fix-result")
      .replaceAll('"builtIn":"address-findings"', '"builtIn":"fix-review-issues"')
      .replaceAll("address-findings-complete", "fix-complete")
      .replaceAll("address-findings", "fix")
      .replaceAll('"addresser"', '"fixer"')
      .replaceAll("autoAddressFindings", "autoFix")
      .replaceAll('"addressFindings"', '"fixReviewIssues"'),
  ) as T;
}

function digestOf(plan: CompiledGraphPlan): string {
  const { digest: _digest, ...rest } = plan;
  return createHash("sha256").update(canonicalJson(rest, 128), "utf8").digest("hex");
}

/** A plan in the former names whose digest an older build would have computed. */
function formerPlan(plan: CompiledGraphPlan): CompiledGraphPlan {
  const old = former(plan);
  return { ...old, digest: digestOf(old) };
}

const acceptedResult = {
  complete: true,
  summary: "Repaired the retry.",
  filesChanged: ["src/review.ts"],
  commandsRun: [
    { command: "bun test src/review.test.ts", result: "passed" as const, summary: "Passed." },
  ],
  notes: ["fix stays free text"],
  limitations: [] as string[],
};

function artifact(input: {
  type: string;
  producer: GraphArtifact["producer"];
  value: unknown;
  inputs?: string[];
  workspace?: { headRef: string };
}): GraphArtifact {
  const body = { value: input.value };
  const digest = graphArtifactDigest(input.type, body);
  const inputs = input.inputs ?? [];
  const id = graphArtifactId({
    digest,
    runId: RUN_ID,
    producer: input.producer,
    inputs,
    ...(input.workspace ? { workspace: input.workspace } : {}),
  });
  return {
    formatVersion: GRAPH_ARTIFACT_FORMAT_VERSION,
    id,
    digest,
    type: input.type,
    runId: RUN_ID,
    producer: input.producer,
    inputs,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    createdAt: AT,
    bytes: Buffer.byteLength(canonicalJson(input.value, 128), "utf8"),
    body,
    state: "live",
  };
}

/**
 * A graph-engine Multi Review run whose Address Findings step completed and
 * whose pull request description consumed its commit, in the names `names`
 * gives (the current ones, or an older build's).
 */
function scenario(names: {
  addressFindings: string;
  complete: string;
  type: string;
  role: string;
  param: string;
}) {
  const plan = compile(multiReviewGraphEngineTemplate({ targetBranch: "main" })).plan!;
  const target = artifact({
    type: "workspace@1",
    producer: {
      nodeId: GRAPH_RUN_INPUT_PRODUCER,
      activation: GRAPH_RUN_INPUT_PRODUCER,
      port: "target",
    },
    value: { branch: "feature", headRef: COMMIT_A, baseRef: null },
    workspace: { headRef: COMMIT_A },
  });
  const key = graphActivationKey({ nodeId: names.addressFindings, iteration: 1, attempt: 1 });
  const producer = (port: string) => ({ nodeId: names.addressFindings, activation: key, port });
  const result = artifact({
    type: names.type,
    producer: producer("result"),
    value: acceptedResult,
    inputs: [target.id],
  });
  const code = artifact({
    type: "workspace@1",
    producer: producer("code"),
    value: { branch: "feature", headRef: COMMIT_B, baseRef: null },
    inputs: [target.id],
    workspace: { headRef: COMMIT_B },
  });
  const describeKey = graphActivationKey({ nodeId: "describe-pr", iteration: 1, attempt: 1 });
  const description = artifact({
    type: "pr-description@1",
    producer: { nodeId: "describe-pr", activation: describeKey, port: "description" },
    value: { title: "Retry safely", body: "Repairs the retry." },
    inputs: [code.id],
  });
  const activations: NodeActivation[] = [
    {
      key,
      nodeId: names.addressFindings,
      iteration: 1,
      attempt: 1,
      state: "complete",
      inputs: { code: target.id },
      outputs: { result: result.id, code: code.id },
      session: {
        agent: "claude",
        model: "opus",
        providerSessionId: "provider-1",
        requestId: "request-1",
        dispatchState: "sent",
        resultTransport: "tool-call-v1",
      },
      policy: {
        id: "pipeline",
        sandbox: "container",
        approvals: "auto-approve",
        projectResources: false,
        networkAccess: "restricted",
      },
      enforcement: "provider-configured",
      createdAt: AT,
      startedAt: AT,
      finishedAt: AT,
    },
    {
      key: graphActivationKey({ nodeId: names.complete, iteration: 1, attempt: 1 }),
      nodeId: names.complete,
      iteration: 1,
      attempt: 1,
      state: "waiting",
      inputs: {},
      outputs: {},
      createdAt: AT,
    },
    {
      key: describeKey,
      nodeId: "describe-pr",
      iteration: 1,
      attempt: 1,
      state: "complete",
      inputs: { code: code.id },
      outputs: { description: description.id },
      createdAt: AT,
    },
  ];
  const run: GraphRun = {
    format: GRAPH_RUN_FORMAT,
    formatVersion: GRAPH_RUN_FORMAT_VERSION,
    id: RUN_ID,
    projectId: "project-1",
    environmentId: "environment-1",
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    bindings: {
      roles: {
        preparer: { platform: "claude" },
        reviewer: [{ platform: "codex" }],
        consolidator: { platform: "claude" },
        [names.role]: { platform: "claude", model: "opus" },
        describer: { platform: "claude" },
      },
      params: { [names.param]: true, autoPr: false, targetBranch: "main" },
      inputs: { target: target.id },
    },
    status: "running",
    mock: false,
    activations,
    rewinds: [],
    loopIterations: {},
    usage: { agentSessions: 1, tokens: 0 },
    revision: 7,
    createdAt: AT,
    updatedAt: AT,
  };
  return { run, artifacts: [target, result, code, description], key };
}

const CURRENT = {
  addressFindings: "address-findings",
  complete: "address-findings-complete",
  type: "address-findings-result@1",
  role: "addresser",
  param: "autoAddressFindings",
};
const FORMER = {
  addressFindings: "fix",
  complete: "fix-complete",
  type: "fix-result@1",
  role: "fixer",
  param: "autoFix",
};

function formerScenario() {
  const old = scenario(FORMER);
  return { ...old, run: { ...old.run, plan: formerPlan(old.run.plan) } };
}

function userTemplate(): GraphTemplateV1 {
  const template = multiReviewBuiltInTemplate();
  delete template.engine;
  return {
    ...template,
    id: "my-review",
    revision: 1,
    layout: { "address-findings": { x: 400, y: 0 }, plan: { x: 0, y: 0 } },
  };
}

function wrapper(id: string, ref: GraphSubgraphRef, child: GraphTemplateV1): GraphTemplateV1 {
  const inputs = child.inputs ?? [];
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id,
    revision: 1,
    name: id,
    parameters: [],
    roles: child.roles,
    workspace: child.workspace,
    limits: child.limits,
    inputs,
    nodes: [
      {
        id: "inner",
        kind: "subgraph",
        template: ref,
        inputs: inputs.map(({ name, type, required }) => ({
          name,
          type,
          ...(required === undefined ? {} : { required }),
        })),
      },
    ],
    edges: inputs.map(({ name }) => ({
      id: `bind-${name}`,
      from: { input: name },
      to: { node: "inner", port: name },
    })),
  };
}

describe("graph vocabulary upgrade", () => {
  test("the former run fixture is a run an older build could load", () => {
    const { run } = formerScenario();
    expect(validateGraphRun(run).ok).toBe(true);
    expect(JSON.stringify(run.plan)).not.toContain("address-findings");
  });

  test("a user template copied from Multi Review gets the current names, free text kept", () => {
    const current = userTemplate();
    const old = former(current);
    expect(JSON.stringify(old)).toContain('"fixer"');
    const upgraded = upgradeGraphTemplate(old) as GraphTemplateV1;
    expect(upgraded).toEqual(current);
    expect(compile(upgraded).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Nothing left to do on a current template.
    expect(upgradeGraphTemplate(current)).toBe(current);
  });

  test("a Build Pipeline copy renames Rework and Address Findings by their step", () => {
    const current = buildPipelineBuiltInTemplate();
    delete current.engine;
    const verify = current.nodes.find((node) => node.id === "verify")!;
    verify.when = { path: "addressFindings.complete", op: "eq", value: true };
    const errors = (template: GraphTemplateV1) =>
      compile(template).diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    expect(errors(current)).toEqual([]);
    const old = JSON.parse(
      JSON.stringify(current)
        .replaceAll('"rework"', '"fix"')
        .replaceAll("pipeline-rework", "pipeline-fix")
        .replaceAll("pipeline-address-findings", "address-review")
        .replaceAll("address-findings-result@", "fix-result@")
        .replaceAll("address-findings", "address")
        .replaceAll('"addresser"', '"fixer"')
        .replaceAll('"addressFindings"', '"address"')
        .replaceAll("addressFindings.complete", "address.complete")
        .replaceAll('"build-rework"', '"build-fix"')
        .replaceAll('"rework-prepare"', '"fix-prepare"'),
    );
    // The former default-source field and the Verify input used different names.
    for (const role of old.roles) {
      if (!role.defaultsFrom) continue;
      role.defaultsFrom = role.defaultsFrom.map((name: string) =>
        name === "address" ? "fixReviewIssues" : name,
      );
    }
    const upgraded = upgradeGraphTemplate(old) as GraphTemplateV1;
    expect(upgraded.nodes.map(({ id }) => id)).toEqual(current.nodes.map(({ id }) => id));
    expect(upgraded.nodes.find(({ id }) => id === "verify")?.when).toEqual(verify.when);
    expect(errors(upgraded)).toEqual([]);
  });

  test("pinned nested templates follow the leaf's final digest and preserve stale pins", () => {
    const leaf = former(userTemplate());
    const middle = wrapper(
      "middle",
      { scope: "user", id: leaf.id, digest: graphTemplateDigest(leaf) },
      leaf,
    );
    const root = wrapper(
      "root",
      { scope: "user", id: middle.id, digest: graphTemplateDigest(middle) },
      middle,
    );
    const stale = wrapper("stale", { scope: "user", id: leaf.id, digest: "0".repeat(64) }, leaf);
    root.mockPins = { "inner/inner/fix": ["example"] };
    const stored = {
      templates: Object.fromEntries(
        [root, middle, leaf, stale].map((template) => [template.id, { template }]),
      ),
    };
    const upgraded = upgradeGraphTemplatesStore(stored) as typeof stored;
    const resolveTemplate = (ref: GraphSubgraphRef) => upgraded.templates[ref.id];
    const migratedRoot = upgraded.templates.root!.template;
    expect(
      compile(migratedRoot, { resolveTemplate }).diagnostics.filter((d) => d.severity === "error"),
    ).toEqual([]);
    expect(migratedRoot.mockPins).toEqual({
      "inner/inner/address-findings": ["example"],
    });
    expect(
      compile(upgraded.templates.stale!.template, { resolveTemplate }).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "subgraph-digest-mismatch" }));
  });

  test("the exact former built-in pin and saved child mock preset still compile", () => {
    const builtin = multiReviewBuiltInTemplate();
    const old = wrapper(
      "root",
      {
        scope: "builtin",
        id: builtin.id,
        digest: "d36469246d09b603f92d4aa1beeedb4c06c897b1bf6fb61d4785403d213cf981",
      },
      former(builtin),
    );
    old.mockPins = { "inner/fix": ["example"] };
    const migrated = upgradeGraphTemplate(old) as GraphTemplateV1;
    expect(migrated.nodes[0]).toMatchObject({ template: { digest: graphTemplateDigest(builtin) } });
    expect(migrated.mockPins).toEqual({ "inner/address-findings": ["example"] });
    const compiled = compile(migrated, { resolveTemplate: () => ({ template: builtin }) });
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(
      graphMockPinIssues(graphMockPinTargetFromPlan(compiled.plan!), migrated.mockPins),
    ).toEqual([]);
  });

  test("a migrated run evaluates an inlined predicate with its child parameters", () => {
    const child = userTemplate();
    child.inputs = [];
    child.outputs = [];
    child.edges = [];
    const address = child.nodes.find((node) => node.id === "address-findings")!;
    if (address.kind !== "agent") throw new Error("Expected an agent");
    child.nodes = [
      {
        ...address,
        prompt: { template: "Address the findings." },
        // Use only the role and predicate in this test's independent activation.
        inputs: [],
        outputs: [],
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        when: { path: "params.autoAddressFindings", op: "eq", value: true },
      },
    ];
    const parent = wrapper("wrapper", { scope: "user", id: child.id }, child);
    const inner = parent.nodes[0]!;
    if (inner.kind !== "subgraph") throw new Error("Expected a subgraph");
    inner.params = { autoAddressFindings: true };
    const compiled = compile(parent, { resolveTemplate: () => ({ template: child }) });
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const plan = formerPlan(compiled.plan!);
    const run = graphRunFixture({
      plan,
      template: {
        id: plan.template.id,
        revision: plan.template.revision,
        digest: plan.templateDigest,
      },
      loopIterations: {},
      bindings: { roles: { fixer: { platform: "claude" } }, inputs: {}, params: {} },
    });
    const upgraded = upgradeGraphRun(run, [])?.run;
    expect(upgraded?.plan.subgraphs?.[0]?.params).toMatchObject({
      autoAddressFindings: { value: true },
    });
    expect(
      computeGraphReadySet(new GraphRunView(upgraded!), { at: AT, loopDone: () => false }).created,
    ).toContainEqual(expect.objectContaining({ nodeId: "inner/address-findings", state: "ready" }));
  });

  test("custom prompt references migrate without changing literal text", () => {
    const old = former(userTemplate());
    const node = old.nodes.find((entry) => entry.kind === "agent" && entry.id === "fix")!;
    if (node.kind !== "agent") throw new Error("Expected an agent");
    node.prompt = {
      template:
        "autoFix {{! params.autoFix }}{{# params.autoFix }}{{params.autoFix}}{{/params.autoFix}}",
    };
    const migrated = upgradeGraphTemplate(old) as GraphTemplateV1;
    expect(migrated.nodes.find((entry) => entry.id === "address-findings")).toMatchObject({
      prompt: {
        template:
          "autoFix {{! params.autoFix }}{{# params.autoAddressFindings }}{{params.autoAddressFindings}}{{/params.autoAddressFindings}}",
      },
    });
    expect(compile(migrated).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const prompt = migrated.nodes.find((entry) => entry.id === "address-findings");
    if (prompt?.kind !== "agent" || !("template" in prompt.prompt))
      throw new Error("Expected a custom prompt");
    expect(
      renderGraphPromptSource(prompt.prompt.template, { params: { autoAddressFindings: true } })
        .text,
    ).toBe("autoFix true");
  });

  test("colliding and overlong node and edge proposals keep stable identifiers", () => {
    const old = former(userTemplate());
    const longNode = "fix-" + "a".repeat(60);
    const longEdge = "fix-other-" + "b".repeat(54);
    const agent = (id: string, role: string) => ({
      id,
      role,
      kind: "agent" as const,
      capabilities: { profile: "reviewer" as const },
      workspaceAccess: "read" as const,
      prompt: { template: "Read the findings." },
    });
    old.inputs = [];
    old.outputs = [];
    delete old.layout;
    old.nodes = [
      agent("fix", "fixer"),
      agent("address-findings", "fixer"),
      agent("address-findings-findings", "describer"),
      agent(longNode, "fixer"),
      { ...agent("fix-other", "fixer"), outputs: [{ name: "report", type: "review-report@1" }] },
      { ...agent("reader", "describer"), inputs: [{ name: "report", type: "review-report@1" }] },
    ];
    old.edges = [
      {
        id: longEdge,
        from: { node: "fix-other", port: "report" },
        to: { node: "reader", port: "report" },
      },
    ];
    const migrated = upgradeGraphTemplate(old) as GraphTemplateV1;
    expect(validateGraphTemplate(migrated)).toMatchObject({ ok: true });
    expect(migrated.nodes.map(({ id }) => id)).toEqual([
      "fix",
      "address-findings",
      "address-findings-findings",
      longNode,
      "address-findings-other",
      "reader",
    ]);
    expect(compile(migrated).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(migrated.edges.at(-1)).toMatchObject({
      id: old.edges.at(-1)!.id,
      from: { node: "address-findings-other" },
    });
  });

  test("a damaged original plan remains unreadable after opening the migrated store", async () => {
    const directory = await dataDir();
    const before = new StorageDatabase(directory, {
      layoutFor: storeLayout,
      migrations: STORAGE_MIGRATIONS.filter(
        ({ version }) => version < GRAPH_VOCABULARY_UPGRADE_VERSION,
      ),
    });
    const { run } = formerScenario();
    run.plan.digest = "0".repeat(64);
    before.writeStore("graph-runs", { [run.id]: run });
    before.close();

    const storage = new StorageService(directory);
    closers.push(() => storage.close());
    await storage.init();
    await expect(storage.graphRuns.getGraphRun(run.id)).rejects.toMatchObject({
      issues: ["plan:digest"],
    });
    expect(upgradeGraphRun(run, [])).toBeNull();
  });

  test("a run is rewritten consistently: plan digest, keys, artifact ids and lineage", () => {
    const old = formerScenario();
    const current = scenario(CURRENT);
    const upgraded = upgradeGraphRun(old.run, old.artifacts)!;
    expect(upgraded).not.toBeNull();
    // The plan is exactly the one this build compiles, digest included.
    expect(upgraded.run.plan).toEqual(current.run.plan);
    // Artifact ids follow the renamed type and producer, and their lineage.
    expect(upgraded.artifacts.map((entry) => entry.id)).toEqual(
      current.artifacts.map((entry) => entry.id),
    );
    expect(upgraded.artifacts).toEqual(current.artifacts);
    expect(upgraded.run.bindings).toEqual(current.run.bindings);
    const step = upgraded.run.activations[0]!;
    expect(step).toMatchObject({
      key: current.key,
      nodeId: "address-findings",
      outputs: current.run.activations[0]!.outputs,
      // Pinned: the provider session and its transcripts keep the former key.
      session: { sessionKey: `graph:${RUN_ID}:fix#iter=1#attempt=1` },
    });
    expect(upgraded.run.activations[2]!.inputs).toEqual(current.run.activations[2]!.inputs);
    expect(
      upgraded.resultKeys.get(graphAgentResultKey(RUN_ID, old.key, "request-1", "result")),
    ).toBe(graphAgentResultKey(RUN_ID, current.key, "request-1", "result"));
    // A current run has nothing to upgrade.
    expect(upgradeGraphRun(current.run, current.artifacts)).toBeNull();
  });

  test("a run whose rewrite would not validate is left as it was", () => {
    const old = formerScenario();
    const broken = { ...old.run, activations: [{ ...old.run.activations[0]!, iteration: 0 }] };
    expect(upgradeGraphRun(broken, old.artifacts)).toBeNull();
  });

  test("workflow results: kinds, receipts, graph port types and re-keyed slots", () => {
    const entry = (resultKey: string, kind: string, extra: Record<string, unknown> = {}) => ({
      resultKey,
      kind,
      environmentId: "environment-1",
      projectId: "project-1",
      provider: "claude",
      schemaVersion: 1,
      lifecycle: "accepted",
      createdAt: AT,
      updatedAt: AT,
      result: acceptedResult,
      digest: "c".repeat(64),
      receipt: { version: 1, resultKey, receiptId: "r", kind, schemaVersion: 1, acceptedAt: AT },
      rejectedDigests: [],
      ...extra,
    });
    const store = {
      version: 1,
      entries: {
        a: entry("a", "fix-result"),
        b: entry("b", "graph-output", {
          context: { type: "graph-output", port: "result", artifactType: "fix-result@1" },
        }),
        c: entry("c", "review-report"),
      },
    };
    const upgraded = upgradeWorkflowResultsStore(store, new Map([["b", "b2"]])) as typeof store;
    expect(upgraded.entries.a).toMatchObject({
      kind: "address-findings-result",
      receipt: { kind: "address-findings-result" },
    });
    expect(upgraded.entries).not.toHaveProperty("b");
    expect((upgraded.entries as Record<string, unknown>).b2).toMatchObject({
      resultKey: "b2",
      receipt: { resultKey: "b2" },
      context: { artifactType: "address-findings-result@1" },
    });
    expect(upgraded.entries.c).toBe(store.entries.c);
    const current = { version: 1, entries: { c: store.entries.c } };
    expect(upgradeWorkflowResultsStore(current)).toBe(current);
  });

  test("scheduled graph launches and describe drafts get the current names", () => {
    const jobs = {
      one: {
        action: {
          kind: "graph",
          request: {
            ref: { scope: "builtin", id: "multi-review" },
            roles: { fixer: { platform: "claude" } },
            params: { autoFix: true },
          },
        },
      },
      two: {
        action: {
          kind: "graph",
          request: { ref: { scope: "project", id: "x" }, roles: { fixer: { platform: "claude" } } },
        },
      },
      three: { action: { kind: "prompt" } },
    };
    const upgraded = upgradeScheduledJobsStore(jobs) as typeof jobs;
    expect(upgraded.one.action.request).toMatchObject({
      roles: { addresser: { platform: "claude" } },
      params: { autoAddressFindings: true },
    });
    // Project templates keep their names in their repositories.
    expect(upgraded.two).toBe(jobs.two);
    const drafts = { "environment-1": { id: "job-1", template: former(userTemplate()) } };
    expect((upgradeGraphDescribeStore(drafts) as typeof drafts)["environment-1"].template).toEqual(
      userTemplate(),
    );
  });

  test("user graph bindings retain separate values where the child declared both names", async () => {
    const child = former(userTemplate());
    child.parameters.push({ key: "autoAddressFindings", type: "boolean", default: false });
    child.roles.push({ key: "addresser", multiplicity: "one" });
    const parent = wrapper("parent", { scope: "user", id: child.id }, child);
    const inner = parent.nodes[0]!;
    if (inner.kind !== "subgraph") throw new Error("Expected a subgraph");
    inner.roles = { fixer: "preparer", addresser: "addresser" };
    inner.params = { autoFix: true, autoAddressFindings: false };
    const directory = await dataDir();
    const before = new StorageDatabase(directory, {
      layoutFor: storeLayout,
      migrations: STORAGE_MIGRATIONS.filter(
        ({ version }) => version < GRAPH_VOCABULARY_UPGRADE_VERSION,
      ),
    });
    before.writeStore("graph-templates", {
      templates: Object.fromEntries(
        [parent, child].map((template) => [
          template.id,
          {
            id: template.id,
            revision: 1,
            template,
            createdAt: AT,
            updatedAt: AT,
            bytes: Buffer.byteLength(JSON.stringify(template)),
          },
        ]),
      ),
    });
    const request = {
      ref: { scope: "user", id: child.id },
      projectId: "project-1",
      environment: { kind: "existing", environmentId: "env-1" },
      params: { autoFix: true },
      roles: { fixer: { platform: "claude" } },
    };
    before.writeStore("scheduled-jobs", {
      graph: { id: "graph", owner: { kind: "operator" }, action: { kind: "graph", request } },
    });
    before.close();

    const after = openBackendDatabase(directory);
    closers.push(() => after.close());
    const saved = after.readStore("graph-templates")?.value as {
      templates: Record<string, { template: GraphTemplateV1 }>;
    };
    const compiled = compile(saved.templates.parent!.template, {
      resolveTemplate: (ref) => saved.templates[ref.id],
    });
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(compiled.plan?.subgraphs?.[0]).toMatchObject({
      roles: inner.roles,
      params: { autoFix: { value: true }, autoAddressFindings: { value: false } },
    });
    const jobs = after.readStore("scheduled-jobs")?.value as Record<string, ScheduledJob>;
    expect(jobs.graph?.action).toEqual({ kind: "graph", request });
    const executor = new ScheduledJobExecutor({
      async invoke() {
        throw new Error("Unexpected backend command");
      },
      storage: {
        async sendAgentMail() {
          throw new Error("Unexpected mail");
        },
        coordinators: { getCoordinatorWorkspace: async () => null },
      },
      graphs: {
        async options() {
          throw new Error("Unexpected graph options lookup");
        },
        async launch(launched, origin) {
          expect(origin).toEqual({ requestedBy: "schedule", scheduleId: "graph" });
          const plan = compile(saved.templates[child.id]!.template).plan!;
          const resolved = graphLaunchParams(plan.parameters, launched.params ?? {});
          expect(resolved.issues).toEqual([]);
          expect(resolved.params).toMatchObject({ autoFix: true, autoAddressFindings: false });
          return {
            runId: "run-1",
            projectId: launched.projectId,
            status: "running",
            template: plan.template,
            repeated: false,
          };
        },
      },
    });
    expect(
      await executor.execute(jobs.graph!, { fireId: "graph" } as ScheduleFire, () => {}),
    ).toMatchObject({ ok: true, outcome: { runId: "run-1" } });
  });

  test("seeded public and coordinator schedules fire through the renamed action handlers", async () => {
    const directory = await dataDir();
    const before = new StorageDatabase(directory, {
      layoutFor: storeLayout,
      migrations: STORAGE_MIGRATIONS.filter(
        ({ version }) => version < GRAPH_VOCABULARY_UPGRADE_VERSION,
      ),
    });
    const oldModel = { agent: "claude", model: "opus" };
    before.writeStore("scheduled-jobs", {
      public: {
        id: "public",
        owner: { kind: "operator" },
        action: {
          kind: "action",
          action: "review.launch",
          input: { environmentId: "env-1", autoFix: false, fixModel: oldModel },
        },
      },
      coordinator: {
        id: "coordinator",
        owner: {
          kind: "coordinator",
          projectId: "project-1",
          coordinatorId: "coord-1",
          role: "main",
        },
        action: {
          kind: "action",
          action: "custom_fix_multi_review",
          input: { workflowId: "review-1", instruction: "Apply the review", fixModel: oldModel },
        },
      },
    });
    before.close();

    const after = openBackendDatabase(directory);
    closers.push(() => after.close());
    const jobs = after.readStore("scheduled-jobs")?.value as Record<string, ScheduledJob>;
    const publicHandler = REVIEW_HANDLERS.find((handler) => handler.action === "review.launch")!;
    const publicInputs: unknown[] = [];
    const coordinatorInputs: unknown[] = [];
    const executor = new ScheduledJobExecutor({
      async invoke<T>(command: string, input?: Record<string, unknown>) {
        expect(command).toBe("public_action");
        expect(input?.action).toBe("review.launch");
        publicInputs.push(publicHandler.parse(input?.input as Record<string, unknown>).value);
        return { ok: true, result: {} } as T;
      },
      storage: {
        async sendAgentMail() {
          throw new Error("Unexpected mail");
        },
        coordinators: {
          async getCoordinatorWorkspace() {
            return {
              id: "coord-1",
              conversations: [{ id: "main", role: "main", mailboxIncarnationId: "inc-main" }],
            } as CoordinatorWorkspace;
          },
        },
      },
      controlMcp: {
        credentialPolicy: () => null,
        listCoordinatorTools: async () => [],
        async callCoordinatorTool(scope, tool, args) {
          return callToolInProcess(
            () => {
              const server = new McpServer({ name: "schedule-fixture", version: "1" });
              registerControlReviewActions(
                server,
                async <T>(command: string, args?: Record<string, unknown>) => {
                  if (command === "get_config") return { global: {} } as T;
                  expect(command).toBe("custom_fix_coordinator_multi_review_action");
                  coordinatorInputs.push(args?.input);
                  return { workflow: { id: "review-1" }, outcome: "opened" } as T;
                },
                scope,
              );
              return server;
            },
            tool,
            args,
          );
        },
      },
    });
    for (const job of Object.values(jobs)) {
      expect(
        await executor.execute(job, { fireId: job.id } as ScheduleFire, () => {}),
      ).toMatchObject({ ok: true });
    }
    expect(publicInputs).toEqual([
      { environmentId: "env-1", autoAddressFindings: false, addressFindingsModel: oldModel },
    ]);
    expect(coordinatorInputs).toEqual([
      {
        workflowId: "review-1",
        instruction: "Apply the review",
        addressFindingsModel: oldModel,
        requestId: "sched:coordinator",
      },
    ]);
  });

  test("an upgraded database is rewritten once and the backend reads and projects it", async () => {
    const directory = await dataDir();
    const before = new StorageDatabase(directory, {
      layoutFor: storeLayout,
      migrations: STORAGE_MIGRATIONS.filter(
        (migration) => migration.version < GRAPH_VOCABULARY_UPGRADE_VERSION,
      ),
    });
    const old = formerScenario();
    const template = former(userTemplate());
    before.writeStore("graph-templates", {
      templates: {
        "my-review": {
          id: "my-review",
          revision: 1,
          template,
          bytes: Buffer.byteLength(JSON.stringify(template), "utf8"),
          createdAt: AT,
          updatedAt: AT,
        },
      },
      projects: {
        "project-1": {
          projectId: "project-1",
          ceilingRevision: 0,
          trust: [],
          launchDefaults: {
            "builtin:multi-review": {
              roles: { fixer: { platform: "codex" } },
              params: { autoFix: true },
              updatedAt: AT,
            },
            "project:project-1:.orkestrator/graphs/x.graph.json": {
              roles: { fixer: { platform: "codex" } },
              params: { autoFix: true },
              updatedAt: AT,
            },
          },
          updatedAt: AT,
        },
      },
    });
    before.writeStore("graph-runs", { [RUN_ID]: old.run });
    before.writeStore(
      "graph-artifacts",
      Object.fromEntries(old.artifacts.map((entry) => [`${RUN_ID}/${entry.id}`, entry])),
    );
    const slotKey = graphAgentResultKey(RUN_ID, old.key, "request-1", "result");
    const receipt = (resultKey: string, kind: string) => ({
      version: 1,
      resultKey,
      receiptId: `receipt-${resultKey}`,
      kind,
      schemaVersion: 1,
      acceptedAt: AT,
    });
    const bespokeKey = "0b4f1f5e-8a8c-4b0e-9a55-7f1f2a1d3c4e";
    before.writeStore("workflow-results", {
      version: 1,
      entries: {
        [bespokeKey]: {
          resultKey: bespokeKey,
          kind: "fix-result",
          environmentId: "environment-1",
          projectId: "project-1",
          provider: "claude",
          schemaVersion: 1,
          lifecycle: "accepted",
          createdAt: AT,
          updatedAt: AT,
          result: acceptedResult,
          digest: "d".repeat(64),
          receipt: receipt(bespokeKey, "fix-result"),
          rejectedDigests: [],
        },
        [slotKey]: {
          resultKey: slotKey,
          kind: "graph-output",
          environmentId: "environment-1",
          projectId: "project-1",
          provider: "claude",
          schemaVersion: 1,
          lifecycle: "accepted",
          toolName: "submit_result",
          context: { type: "graph-output", port: "result", artifactType: "fix-result@1" },
          createdAt: AT,
          updatedAt: AT,
          result: acceptedResult,
          digest: "d".repeat(64),
          receipt: receipt(slotKey, "graph-output"),
          rejectedDigests: [],
        },
      },
    });
    before.close();

    const upgraded = openBackendDatabase(directory);
    try {
      expect(upgraded.schemaVersion()).toBeGreaterThanOrEqual(GRAPH_VOCABULARY_UPGRADE_VERSION);
    } finally {
      upgraded.close();
    }

    const storage = new StorageService(directory);
    await storage.init();
    const current = scenario(CURRENT);

    const saved = storage.graphTemplates.getGraphTemplateRecord("my-review")!;
    expect(saved.revision).toBe(1);
    expect(saved.template).toEqual(userTemplate());
    expect(
      storage.graphTemplates.getGraphLaunchDefaults("project-1", "builtin:multi-review"),
    ).toMatchObject({
      roles: { addresser: { platform: "codex" } },
      params: { autoAddressFindings: true },
    });
    expect(
      storage.graphTemplates.getGraphLaunchDefaults(
        "project-1",
        "project:project-1:.orkestrator/graphs/x.graph.json",
      ),
    ).toMatchObject({ roles: { fixer: { platform: "codex" } } });

    // The run loads (its plan digest holds) at the revision it had.
    const run = (await storage.graphRuns.getGraphRun(RUN_ID))!;
    expect(run.revision).toBe(7);
    expect(run.plan).toEqual(current.run.plan);
    const artifacts = await storage.graphRuns.listGraphArtifacts(RUN_ID);
    expect(artifacts.map((entry) => entry.id).sort()).toEqual(
      current.artifacts.map((entry) => entry.id).sort(),
    );
    const addressFindings = run.activations.find(
      (activation) => activation.nodeId === MULTI_REVIEW_GRAPH_NODES.addressFindings,
    )!;
    const result = await storage.graphRuns.getGraphArtifact(
      RUN_ID,
      addressFindings.outputs.result!,
    );
    expect(result?.type).toBe("address-findings-result@1");

    // A Multi Review linked to the run still finds its Address Findings step,
    // under the session key it already had.
    const workflow = {
      id: "review-1",
      environmentId: "environment-1",
      targetBranch: "main",
      reviewers: [],
      addressFindingsModel: { agent: "claude", model: "opus" },
      phase: "addressing-findings",
    } as unknown as MultiReviewWorkflow;
    const projected = await projectMultiReviewGraphRun(workflow, run, (id) =>
      storage.graphRuns.getGraphArtifact(RUN_ID, id),
    );
    expect(projected.addressFindingsSession).toMatchObject({
      sessionKey: `graph:${RUN_ID}:fix#iter=1#attempt=1`,
      providerSessionId: "provider-1",
    });
    expect(projected.addressFindingsResult).toEqual(acceptedResult);

    // Workflow results load, under the kind and slot key this build uses.
    const results = new WorkflowResultService(directory);
    closers.push(() => results.closeStorage());
    expect(await results.structured(bespokeKey)).toMatchObject({ value: acceptedResult });
    expect(await results.registered(slotKey)).toBe(false);
    expect(
      await results.structured(graphAgentResultKey(RUN_ID, current.key, "request-1", "result")),
    ).toMatchObject({ value: acceptedResult });
  });
});
