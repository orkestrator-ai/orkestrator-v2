import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import { multiReviewBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import { compile, type CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
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
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
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
    const template = {
      format: "orkestrator.graph",
      formatVersion: 1,
      id: "pipeline",
      nodes: [
        { id: "fix", kind: "agent", role: "builder", prompt: { builtIn: "pipeline-fix" } },
        { id: "address", kind: "agent", role: "fixer", prompt: { builtIn: "address-review" } },
        {
          id: "verify",
          kind: "agent",
          role: "verifier",
          prompt: { builtIn: "verify" },
          inputs: [{ name: "address", type: "fix-result@1" }],
        },
        // Not a step: a user's own node keeps its name.
        { id: "fix-docs", kind: "agent", role: "builder", prompt: { template: "fix the docs" } },
      ],
      edges: [
        {
          id: "fix-prepare",
          from: { node: "fix", port: "code" },
          to: { node: "address", port: "code" },
        },
        {
          id: "address-verify-report",
          from: { node: "address", port: "report" },
          to: { node: "verify", port: "address" },
          transform: [{ op: "adapt", adapter: "fix-result-to-file-list" }],
        },
      ],
      loops: [
        {
          id: "rounds",
          nodes: ["fix", "address", "verify"],
          until: { path: "verify.verdict.complete", op: "eq", value: true },
          carry: [{ from: { node: "verify", port: "code" }, to: { node: "fix", port: "code" } }],
        },
      ],
      roles: [{ key: "fixer", multiplicity: "one", defaultsFrom: ["fixReviewIssues"] }],
      parameters: [],
    };
    expect(upgradeGraphTemplate(template)).toMatchObject({
      nodes: [
        { id: "rework", prompt: { builtIn: "pipeline-rework" } },
        {
          id: "address-findings",
          role: "addresser",
          prompt: { builtIn: "pipeline-address-findings" },
        },
        { id: "verify", inputs: [{ name: "addressFindings", type: "address-findings-result@1" }] },
        { id: "fix-docs", prompt: { template: "fix the docs" } },
      ],
      edges: [
        { id: "rework-prepare", from: { node: "rework" }, to: { node: "address-findings" } },
        {
          id: "address-findings-verify-report",
          to: { node: "verify", port: "addressFindings" },
          transform: [{ adapter: "address-findings-result-to-file-list" }],
        },
      ],
      loops: [
        {
          nodes: ["rework", "address-findings", "verify"],
          until: { path: "verify.verdict.complete" },
          carry: [{ to: { node: "rework" } }],
        },
      ],
      roles: [{ key: "addresser", defaultsFrom: ["addressFindings"] }],
    });
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
            ref: { scope: "built-in", id: "multi-review" },
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
            "built-in:multi-review": {
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
      storage.graphTemplates.getGraphLaunchDefaults("project-1", "built-in:multi-review"),
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
