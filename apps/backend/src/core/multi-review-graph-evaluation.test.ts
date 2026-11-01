/**
 * The Multi Review evaluation corpus on the graph engine (item 301, parity
 * box "evaluation corpus scores").
 *
 * Every corpus case (`multi-review-evaluation-corpus.ts`) is replayed as a
 * graph run of the Multi Review template Multi Review launches
 * (`multiReviewGraphEngineTemplate`): real stores, a sealed package, one
 * `review` activation per panel position whose report is a stored
 * `review-report@1` artifact (a failed reviewer leaves an `error@1` marker, a
 * stopped one nothing), and a `consolidate` activation reading them. Each case
 * then proves, against the bespoke engine (`multi-review-evaluation.test.ts`):
 *
 * 1. the consolidation prompt the graph renders is the bespoke one, once the
 *    opaque ids (reviewer id, source ids) are mapped one-to-one;
 * 2. a consolidation answer, translated to graph ids, gets the bespoke
 *    provenance verdict (same issue paths, codes and messages) through the
 *    graph output slot the agent executor opens;
 * 3. the accepted consolidation, projected onto the Multi Review record,
 *    scores and overlaps exactly as the bespoke consolidation does.
 *
 * Deterministic: no clocks, no waits, no agents.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphPlanAgentNode } from "@orkestrator/protocol/graphs/compile";
import {
  graphActivationKey,
  graphNodeBranches,
  type GraphArtifact,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";
import {
  MULTI_REVIEW_WORKFLOW_VERSION,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import {
  MULTI_REVIEW_REPORTS_FRAME_CLOSE,
  MULTI_REVIEW_REPORTS_FRAME_OPEN,
} from "@orkestrator/protocol/review-evidence-frames";
import { reviewPackageArtifactPath } from "@orkestrator/protocol/review-artifacts";
import { SHIPPED_REVIEW_LENS_PRESETS } from "@orkestrator/protocol/review-lens";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import type { ReviewPackageReference } from "@orkestrator/protocol/review-workflow";
import {
  stripStructuredReviewProvenance,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { WorkflowResultValidationIssue } from "@orkestrator/protocol/workflow-results";
import { GraphArtifactStore } from "./graph-artifacts.js";
import { graphBuiltInPromptText, graphReviewCoverageGapIds } from "./graph-agent-builtins.js";
import { graphAgentPolicy } from "./graph-agent-policy.js";
import {
  graphInputItemIds,
  loadGraphAgentInputs,
  renderGraphAgentPrompt,
  type GraphAgentInputs,
} from "./graph-agent-prompt.js";
import { GraphAgentResults } from "./graph-agent-results.js";
import { compiledPlan } from "./graph-run-executor-test-support.js";
import {
  GRAPH_FIXTURE_AT,
  graphEnvironmentFixture,
  graphRunFixture,
} from "./graph-run-test-support.js";
import { evaluationCorpus, type EvaluationCase } from "./multi-review-evaluation-corpus.js";
import {
  evaluationConsolidationPrompt,
  referenceConsolidation,
  referenceOverlap,
  scoreConsolidation,
} from "./multi-review-evaluation.js";
import {
  MULTI_REVIEW_GRAPH_NODES,
  multiReviewGraphSourceIds,
  projectMultiReviewGraphRun,
} from "./multi-review-graph-projection.js";
import { multiReviewGraphEngineTemplate } from "./multi-review-graph-template.js";
import { createMultiReviewConsolidationPrompt } from "./multi-review-prompts.js";
import {
  consolidationOverlap,
  consolidationReports,
  consolidationResultContext,
  deriveConsolidatedProvenance,
} from "./review-fanout-provenance.js";
import { parseStructuredReportResult } from "./review-fanout.js";
import { runCommand } from "./shell.js";
import { StorageService } from "./storage.js";
import { validateWorkflowResult } from "./workflow-result-contracts.js";
import { validateRegisteredWorkflowResult } from "./workflow-result-registry.js";

// Tests edit payloads into shapes the types forbid.
// oxlint-disable-next-line typescript/no-explicit-any
type Draft = any;

const N = MULTI_REVIEW_GRAPH_NODES;
const ENVIRONMENT_ID = "eval-env";
const PROJECT_ID = "p1";
const TARGET_BRANCH = "main";
const HEAD = "2".repeat(40);
const BASE = "3".repeat(40);
const corpus = evaluationCorpus();
const plan = compiledPlan(multiReviewGraphEngineTemplate({ targetBranch: TARGET_BRANCH }));

function byId(id: string): EvaluationCase {
  return corpus.find((entry) => entry.id === id)!;
}

/** Every reviewer gets a different shipped lens, in configured order (as the bespoke suite does). */
function withLenses(entry: EvaluationCase): EvaluationCase {
  return {
    ...entry,
    reviewers: entry.reviewers.map((reviewer, index) => {
      const preset = SHIPPED_REVIEW_LENS_PRESETS[index % SHIPPED_REVIEW_LENS_PRESETS.length]!;
      return { ...reviewer, lens: { label: preset.label, instruction: preset.instruction } };
    }),
  };
}

// ------------------------------------------------------------------ world

let root = "";
let storage: StorageService;
let artifacts: GraphArtifactStore;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-evaluation-"));
  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree);
  await runCommand("git", ["init", "-q", "-b", "main", worktree]);
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  await storage.addEnvironment(
    graphEnvironmentFixture({ id: ENVIRONMENT_ID, projectId: PROJECT_ID, worktreePath: worktree }),
  );
  artifacts = new GraphArtifactStore({ storage, fence: { beginMutation: () => () => undefined } });
});

afterAll(async () => {
  storage?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixture

/** One corpus case as a graph run, consolidation ready to prompt. */
interface CaseRun {
  entry: EvaluationCase;
  run: GraphRun;
  consolidate: NodeActivation;
  node: GraphPlanAgentNode;
  reviewPackage: ReviewPackageReference;
  /** Where the run sealed its hash-verified copy of the package. */
  sealedPath: string;
  /** Graph id → bespoke id (artifact id → reviewer id, item ids → source ids). */
  toBespoke: Map<string, string>;
  /** Bespoke source id → graph item id. */
  toGraph: Map<string, string>;
  /** Graph item ids by kind, from the stored artifacts. */
  graphSources: { issue: string[]; "coverage-gap": string[] };
  inputs: GraphAgentInputs;
}

function agentNode(id: string): GraphPlanAgentNode {
  return plan.nodes.find(
    (node): node is GraphPlanAgentNode => node.kind === "agent" && node.id === id,
  )!;
}

function activation(
  nodeId: string,
  fields: Partial<NodeActivation> & { branchKey?: string } = {},
): NodeActivation {
  const parts = {
    nodeId,
    iteration: 1,
    attempt: 1,
    ...(fields.branchKey === undefined ? {} : { branchKey: fields.branchKey }),
  };
  return {
    key: graphActivationKey(parts),
    ...parts,
    state: "complete",
    inputs: {},
    outputs: {},
    createdAt: GRAPH_FIXTURE_AT,
    startedAt: GRAPH_FIXTURE_AT,
    finishedAt: GRAPH_FIXTURE_AT,
    ...fields,
  };
}

function session(agent: ReviewerRecord["agent"], model: string, requestId: string) {
  return {
    agent,
    model,
    requestId,
    dispatchState: "sent" as const,
    resultTransport: "tool-call-v1",
  };
}

/**
 * A report as a provider submits it through its result tool: the provider
 * schema's nullable keys (`alternativeFixes`, `reviewModels`,
 * `reviewSourceIds`) are present, null where the finding has none. Both
 * engines' result slots require them; Multi Review's domain parse drops the
 * nulls again on acceptance.
 */
function withPlaceholders(report: Draft): Draft {
  const value = structuredClone(report);
  const fill = (finding: Draft, keys: string[]) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return finding;
    for (const key of keys) if (!(key in finding)) finding[key] = null;
    return finding;
  };
  if (Array.isArray(value.issues)) {
    value.issues = value.issues.map((issue: Draft) =>
      fill(issue, ["alternativeFixes", "reviewModels", "reviewSourceIds"]),
    );
  }
  if (Array.isArray(value.testCoverageGaps)) {
    value.testCoverageGaps = value.testCoverageGaps.map((gap: Draft) =>
      fill(gap, ["reviewModels", "reviewSourceIds"]),
    );
  }
  return value;
}

/** A reviewer's answer as submitted: no backend-issued ids or model labels. */
function submitted(report: StructuredReviewReport): StructuredReviewReport {
  return withPlaceholders(stripStructuredReviewProvenance(report));
}

let runCounter = 0;

async function caseRun(entry: EvaluationCase): Promise<CaseRun> {
  runCounter += 1;
  const runId = `eval-${runCounter}-${entry.id}`;
  const run: GraphRun = graphRunFixture({
    id: runId,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    plan,
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    bindings: {
      roles: {
        preparer: { platform: "claude", model: "preparer" },
        reviewer: entry.reviewers.map((reviewer) => ({
          platform: reviewer.agent,
          model: reviewer.model,
          ...(reviewer.lens ? { lens: reviewer.lens } : {}),
        })),
        consolidator: { platform: "claude", model: "consolidator" },
        fixer: { platform: "claude", model: "fixer" },
        describer: { platform: "claude", model: "describer" },
      },
      params: { autoFix: false, autoPr: false, targetBranch: TARGET_BRANCH },
      inputs: {},
    },
    loopIterations: {},
  });
  await storage.graphRuns.createGraphRun(run);

  // The sealed package, as `run-validation-and-seal` stores it: the package
  // file copied into the run's artifact directory, its descriptor naming the
  // review-artifacts path the package was generated at.
  const contents = Buffer.from(JSON.stringify({ evaluation: entry.id, files: 5 }));
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const packageId = `eval-package-${runCounter}`;
  const reviewPackage: ReviewPackageReference = {
    kind: "file",
    id: packageId,
    round: 1,
    preparedAt: GRAPH_FIXTURE_AT,
    targetBranch: TARGET_BRANCH,
    baseRef: BASE,
    headRef: HEAD,
    filePath: reviewPackageArtifactPath(packageId, sha256),
    sha256,
    bytes: contents.byteLength,
    changedFileCount: 5,
    limitations: [],
  };
  const plan0 = activation(N.plan);
  const packageStep = activation(N.package);
  const sealed = await artifacts.putFile({
    runId,
    type: "review-package@2",
    producer: { nodeId: N.package, activation: packageStep.key, port: "package" },
    contents,
    extension: "json",
    value: reviewPackage,
  });
  packageStep.outputs = { package: sealed.id };

  // One review activation per panel position.
  const library = new GraphTypeLibrary(plan.types);
  const toBespoke = new Map<string, string>();
  const toGraph = new Map<string, string>();
  const graphSources: CaseRun["graphSources"] = { issue: [], "coverage-gap": [] };
  const reviews: NodeActivation[] = [];
  const reports: string[] = [];
  for (const [index, reviewer] of entry.reviewers.entries()) {
    const position = index + 1;
    const review = activation(N.review, {
      branchKey: `panel.${position}`,
      inputs: { package: sealed.id },
      session: session(reviewer.agent, reviewer.model, `review-${position}`),
    });
    if (reviewer.status === "completed" && reviewer.report) {
      // What the reviewer submitted: no backend-issued ids or model labels.
      const stored = await artifacts.putValue({
        runId,
        type: "review-report@1",
        producer: { nodeId: N.review, activation: review.key, port: "report" },
        inputs: [sealed.id],
        value: submitted(reviewer.report),
      });
      review.outputs = { report: stored.id };
      reports.push(stored.id);
      toBespoke.set(stored.id, reviewer.id);
      graphInputItemIds(library, stored).forEach((itemId, k) => {
        toBespoke.set(itemId, `${reviewer.id}/issue-${k + 1}`);
        toGraph.set(`${reviewer.id}/issue-${k + 1}`, itemId);
        graphSources.issue.push(itemId);
      });
      graphReviewCoverageGapIds(stored.producer, reviewer.report.testCoverageGaps.length).forEach(
        (gapId, k) => {
          toBespoke.set(gapId, `${reviewer.id}/coverage-gap-${k + 1}`);
          toGraph.set(`${reviewer.id}/coverage-gap-${k + 1}`, gapId);
          graphSources["coverage-gap"].push(gapId);
        },
      );
    } else if (reviewer.status === "failed") {
      // A failed branch reaches the all-settled fan-in as a failure marker.
      review.state = "failed";
      review.error = reviewer.error ?? "Reviewer failed";
      const marker = await artifacts.putValue({
        runId,
        type: "error@1",
        producer: { nodeId: N.review, activation: review.key, port: "error" },
        inputs: [sealed.id],
        value: {
          node: N.review,
          cause: "provider-error",
          code: "activation_failed",
          message: "The reviewer failed.",
          attempts: 1,
          retryable: false,
        },
      });
      review.outputs = { error: marker.id };
      reports.push(marker.id);
    } else {
      // A stopped branch settles with nothing to pass on.
      review.state = "cancelled";
    }
    reviews.push(review);
  }

  const consolidate = activation(N.consolidate, {
    state: "running",
    finishedAt: undefined,
    inputs: { reports, package: sealed.id },
    session: session("claude", "consolidator", "consolidate-1"),
  });
  run.activations = [plan0, packageStep, ...reviews, consolidate];
  const node = agentNode(N.consolidate);
  const inputs = await loadGraphAgentInputs(run, node, consolidate, artifacts);
  return {
    entry,
    run,
    consolidate,
    node,
    reviewPackage,
    sealedPath: (sealed.body as { file: { path: string } }).file.path,
    toBespoke,
    toGraph,
    graphSources,
    inputs,
  };
}

const runs = new Map<string, CaseRun>();
const lensedRuns = new Map<string, CaseRun>();

beforeAll(async () => {
  for (const entry of corpus) {
    runs.set(entry.id, await caseRun(entry));
    lensedRuns.set(entry.id, await caseRun(withLenses(entry)));
  }
});

// ------------------------------------------------------------------ prompt

/** The consolidation built-in's text for the activation, as `renderGraphAgentPrompt` asks for it. */
function graphConsolidationText(fixture: CaseRun, options: { package?: boolean } = {}): string {
  const builtInInputs = { ...fixture.inputs.builtInInputs };
  if (options.package === false) delete builtInInputs.package;
  return graphBuiltInPromptText({
    builtIn: "consolidation",
    inputs: builtInInputs,
    outputs: { report: "report" },
    targetBranch: TARGET_BRANCH,
  });
}

/** Replaces each JSON-quoted graph id with its bespoke id. Ids never occur unquoted. */
function normalizeIds(text: string, fixture: CaseRun): string {
  const bespokeIds = new Set(fixture.toBespoke.values());
  expect(bespokeIds.size).toBe(fixture.toBespoke.size);
  let normalized = text;
  for (const [graphId, bespokeId] of fixture.toBespoke) {
    const quoted = JSON.stringify(graphId);
    expect(text).toContain(quoted);
    normalized = normalized.split(quoted).join(JSON.stringify(bespokeId));
  }
  return normalized;
}

function rendered(fixture: CaseRun): string {
  const results = new GraphAgentResults({
    run: fixture.run,
    node: fixture.node,
    activation: fixture.consolidate,
    service: undefined,
    sources: fixture.inputs.sources,
  });
  const policy = graphAgentPolicy({
    node: fixture.node,
    environment: graphEnvironmentFixture({ id: ENVIRONMENT_ID }),
    platform: "claude",
    host: { claudeSandbox: true },
  });
  return renderGraphAgentPrompt({
    run: fixture.run,
    node: fixture.node,
    activation: fixture.consolidate,
    inputs: fixture.inputs,
    compiled: policy.compiled,
    actions: fixture.node.grantedActions,
    enforcement: policy.enforcement,
    resultKeys: results.keys("request-1"),
    resultTools: "port",
    targetBranch: TARGET_BRANCH,
  });
}

describe("the graph consolidation prompt is the bespoke one", () => {
  test.each(corpus.map((entry) => [entry.id] as const))(
    "%s: without the package input, the graph text equals the corpus prompt after id normalization",
    (id) => {
      for (const fixture of [runs.get(id)!, lensedRuns.get(id)!]) {
        expect(normalizeIds(graphConsolidationText(fixture, { package: false }), fixture)).toBe(
          evaluationConsolidationPrompt(fixture.entry, "compact"),
        );
      }
    },
  );

  test.each(corpus.map((entry) => [entry.id] as const))(
    "%s: with the sealed package, the rendered prompt carries the bespoke package-scoped prompt",
    (id) => {
      for (const fixture of [runs.get(id)!, lensedRuns.get(id)!]) {
        const bespoke = createMultiReviewConsolidationPrompt({
          targetBranch: TARGET_BRANCH,
          reports: consolidationReports(fixture.entry.reviewers),
          reviewPackage: fixture.reviewPackage,
        });
        const text = graphConsolidationText(fixture);
        // The graph names the package copy it sealed and verified (same
        // SHA-256 and bytes), not the path the package was generated at: the
        // file the prompt names is the file that was verified.
        const sealed = JSON.stringify(fixture.sealedPath);
        const generated = JSON.stringify(fixture.reviewPackage.filePath);
        expect(fixture.sealedPath).not.toBe(fixture.reviewPackage.filePath);
        expect(text).toContain(sealed);
        expect(text).not.toContain(generated);
        expect(normalizeIds(text, fixture).split(sealed).join(generated)).toBe(bespoke);
        // The corpus prompt has no package; the only difference is the
        // package scope rule the bespoke engine adds for a packaged review.
        const corpusPrompt = evaluationConsolidationPrompt(fixture.entry, "compact");
        const rule = `\n- Every reviewer was dispatched against the same backend-verified immutable review package at ${JSON.stringify(fixture.reviewPackage.filePath)}.`;
        const at = bespoke.indexOf(rule);
        expect(at).toBeGreaterThan(0);
        const end = bespoke.indexOf("\n", at + 1);
        expect(bespoke.slice(0, at) + bespoke.slice(end)).toBe(corpusPrompt);
        // The agent's whole prompt opens with exactly that text.
        expect(rendered(fixture).startsWith(text)).toBe(true);
      }
    },
  );

  test("invalid-and-failed: failed and stopped reviewers are omitted from both prompts", () => {
    const fixture = runs.get("invalid-and-failed")!;
    const reports = fixture.consolidate.inputs.reports as string[];
    // The fan-in delivered the failed branch's marker; the stopped branch has none.
    expect(reports).toHaveLength(2);
    expect(fixture.inputs.values.elements?.reports).toEqual([
      { itemIds: [fixture.graphSources.issue[0]!] },
      { failure: true },
    ]);
    const builtIn = fixture.inputs.builtInInputs!.reports as unknown[];
    expect(builtIn).toHaveLength(1);
    const text = graphConsolidationText(fixture, { package: false });
    const evidence = JSON.parse(
      text.split(MULTI_REVIEW_REPORTS_FRAME_OPEN)[1]!.split(MULTI_REVIEW_REPORTS_FRAME_CLOSE)[0]!,
    ) as { reviewers: Array<{ reviewerId: string }> };
    expect(
      evidence.reviewers.map((reviewer) => fixture.toBespoke.get(reviewer.reviewerId)),
    ).toEqual(["reviewer-1"]);
    const bespoke = evaluationConsolidationPrompt(fixture.entry, "compact");
    for (const prompt of [normalizeIds(text, fixture), bespoke]) {
      expect(prompt).not.toContain("reviewer-2");
      expect(prompt).not.toContain("reviewer-3");
      expect(prompt).not.toContain("Reviewer failed");
      expect(prompt).not.toContain("The reviewer failed.");
    }
  });
});

// ------------------------------------------------------------------ provenance

/** Bespoke ids → graph ids in a consolidation answer; unknown ids stay as they are. */
function toGraphIds(report: Draft, fixture: CaseRun): Draft {
  const map = (ids: unknown) =>
    Array.isArray(ids)
      ? ids.map((id) => (typeof id === "string" ? (fixture.toGraph.get(id) ?? id) : id))
      : ids;
  const value = structuredClone(report);
  for (const field of ["issues", "testCoverageGaps"]) {
    if (!Array.isArray(value[field])) continue;
    for (const finding of value[field]) {
      if (finding && typeof finding === "object" && "reviewSourceIds" in finding) {
        finding.reviewSourceIds = map(finding.reviewSourceIds);
      }
    }
  }
  return value;
}

/** The consolidate node's output slot, validated as the agent executor validates a submission. */
function graphSlotIssues(fixture: CaseRun, value: unknown): WorkflowResultValidationIssue[] {
  const results = new GraphAgentResults({
    run: fixture.run,
    node: fixture.node,
    activation: fixture.consolidate,
    service: undefined,
    sources: fixture.inputs.sources,
  });
  const slot = results.slots.find((entry) => entry.port.name === "report")!;
  const input = results.slotInput(slot, "request-1", "claude");
  return validateRegisteredWorkflowResult("graph-output", value, {
    schema: input.schema,
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.context ? { context: input.context } : {}),
  });
}

function bespokeIssues(entry: EvaluationCase, value: unknown): WorkflowResultValidationIssue[] {
  return validateWorkflowResult(
    "consolidated-review",
    value,
    undefined,
    consolidationResultContext(entry.reviewers),
  );
}

/**
 * The reference as the consolidator submits it, then every way its citations
 * can go wrong (bespoke ids), then every corpus answer acceptance must reject.
 */
function answers(entry: EvaluationCase): Array<[string, Draft]> {
  const reference = withPlaceholders(referenceConsolidation(entry));
  const context = consolidationResultContext(entry.reviewers);
  const ids = Object.keys(context.sources);
  const gapId = ids.find((id) => context.sources[id] === "coverage-gap");
  const issueId = ids.find((id) => context.sources[id] === "issue");
  const each = (field: "issues" | "testCoverageGaps", change: (finding: Draft) => void) => {
    const value: Draft = structuredClone(reference);
    value[field].forEach(change);
    return value;
  };
  const list: Array<[string, Draft]> = [
    ["reference", structuredClone(reference)],
    [
      "invented source",
      each("issues", (finding) => finding.reviewSourceIds.push("reviewer-9/issue-1")),
    ],
    ["empty citations", each("issues", (finding) => (finding.reviewSourceIds = []))],
    ["missing citations", each("testCoverageGaps", (finding) => delete finding.reviewSourceIds)],
    ["review models filled in", each("issues", (finding) => (finding.reviewModels = ["model"]))],
    [
      "an invented finding",
      {
        ...structuredClone(reference),
        issues: [
          ...structuredClone(reference.issues),
          {
            ...submitted(byId("contradiction").reviewers[0]!.report!).issues[0]!,
            reviewSourceIds: [],
          },
        ],
      },
    ],
  ];
  if (gapId) {
    list.push([
      "an issue citing a coverage gap",
      each("issues", (finding) => finding.reviewSourceIds.push(gapId)),
    ]);
  }
  if (issueId) {
    list.push([
      "a coverage gap citing an issue",
      each("testCoverageGaps", (finding) => (finding.reviewSourceIds = [issueId])),
    ]);
  }
  return list;
}

/** A review activation's report slot, validated as the agent executor validates a submission. */
function reviewSlotIssues(fixture: CaseRun, value: unknown): WorkflowResultValidationIssue[] {
  const review = fixture.run.activations.find((entry) => entry.nodeId === N.review)!;
  const results = new GraphAgentResults({
    run: fixture.run,
    node: agentNode(N.review),
    activation: review,
    service: undefined,
    sources: {},
  });
  const slot = results.slots.find((entry) => entry.port.name === "report")!;
  const input = results.slotInput(slot, "request-1", "claude");
  return validateRegisteredWorkflowResult("graph-output", value, {
    schema: input.schema,
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.context ? { context: input.context } : {}),
  });
}

/**
 * Where the bespoke engine refuses a reviewer's answer: its result slot
 * (`review-report`), then acceptance (`parseStructuredReportResult`), whose
 * budget check names the field over its budget.
 */
function bespokeReviewerRefusal(value: unknown): Array<{ path: string; code: string }> {
  const slot = validateWorkflowResult("review-report", value);
  if (slot.length > 0) return slot.map(({ path, code }) => ({ path, code }));
  const accepted = parseStructuredReportResult({ ok: true, value } as never);
  return accepted.success ? [] : accepted.error.issues.map(({ path, code }) => ({ path, code }));
}

/**
 * Cases whose reference consolidation fits one `review-report@1`. The
 * `limit-boundaries` reference merges 101 issues, past the type's 100-issue
 * list budget, which the bespoke consolidation raises to the panel's source
 * total (`parseStructuredReportResult` with the reviewers); see the parity
 * gap test below.
 */
const WITHIN_TYPE_BUDGET = corpus.filter((entry) => entry.id !== "limit-boundaries");

describe("graph consolidation provenance matches the bespoke contract", () => {
  test.each(WITHIN_TYPE_BUDGET.map((entry) => [entry.id] as const))(
    "%s: the reference and every citation fault get the bespoke verdict, issue for issue",
    (id) => {
      const fixture = runs.get(id)!;
      const entry = fixture.entry;
      // The graph's sources are the bespoke sources under graph ids, typed alike.
      const bespokeSources = consolidationResultContext(entry.reviewers).sources;
      expect(fixture.inputs.sources).toEqual(
        Object.fromEntries(
          Object.entries(bespokeSources).map(([sourceId, kind]) => [
            fixture.toGraph.get(sourceId)!,
            kind,
          ]),
        ),
      );
      let rejected = 0;
      for (const [label, value] of answers(entry)) {
        const expected = bespokeIssues(entry, value);
        expect({ label, issues: graphSlotIssues(fixture, toGraphIds(value, fixture)) }).toEqual({
          label,
          issues: expected,
        });
        if (label === "reference") expect(expected).toEqual([]);
        if (expected.length > 0) rejected += 1;
      }
      expect(rejected).toBeGreaterThan(0);
    },
  );

  test("every corpus rejected answer is refused by the graph review slot at the field bespoke acceptance names", () => {
    const rejected = corpus.flatMap((entry) =>
      (entry.rejectedReports ?? []).map((answer) => ({ entry, answer })),
    );
    expect(rejected).toHaveLength(5);
    for (const { entry, answer } of rejected) {
      const value = withPlaceholders(answer.report);
      const graph = reviewSlotIssues(runs.get(entry.id)!, value);
      const bespoke = bespokeReviewerRefusal(value);
      expect({ reason: answer.reason, refused: graph.length > 0 }).toEqual({
        reason: answer.reason,
        refused: true,
      });
      expect({ reason: answer.reason, paths: graph.map((issue) => issue.path) }).toEqual({
        reason: answer.reason,
        paths: bespoke.map((issue) => issue.path),
      });
      // Codes agree except for prose over its byte budget, which the graph
      // type check calls too_large and bespoke acceptance invalid_value.
      expect({ reason: answer.reason, codes: graph.map((issue) => issue.code) }).toEqual({
        reason: answer.reason,
        codes: bespoke.map(({ path, code }) =>
          path.endsWith(".evidence") && code === "invalid_value" ? "too_large" : code,
        ),
      });
    }
  });

  // A consolidation may keep every source finding: the graph slot raises the
  // report's issue and coverage-gap caps to the sources' totals
  // (`reviewLimits`), as the bespoke consolidation does.
  test("limit-boundaries: the graph slot accepts a consolidation that keeps all 101 source issues, as the bespoke one does", () => {
    const fixture = runs.get("limit-boundaries")!;
    const reference = withPlaceholders(referenceConsolidation(fixture.entry));
    expect(reference.issues).toHaveLength(101);
    expect(bespokeIssues(fixture.entry, reference)).toEqual([]);
    const accepted = parseStructuredReportResult(
      { ok: true, value: reference } as never,
      fixture.entry.reviewers,
    );
    expect(accepted.success).toBe(true);
    expect(graphSlotIssues(fixture, toGraphIds(reference, fixture))).toEqual([]);
  });
});

// ------------------------------------------------------------------ scores

function workflowFor(fixture: CaseRun): MultiReviewWorkflow {
  return {
    version: MULTI_REVIEW_WORKFLOW_VERSION,
    controller: "backend",
    id: `workflow-${fixture.run.id}`,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    targetBranch: TARGET_BRANCH,
    reviewers: fixture.entry.reviewers.map((reviewer) => ({
      id: reviewer.id,
      agent: reviewer.agent,
      model: reviewer.model,
      ...(reviewer.lens ? { lens: reviewer.lens } : {}),
      status: "pending" as const,
    })),
    fixModel: { agent: "claude", model: "fixer" },
    phase: "reviewing",
    engine: "graph",
    graphRun: { runId: fixture.run.id },
    createdAt: GRAPH_FIXTURE_AT,
    updatedAt: GRAPH_FIXTURE_AT,
    backendRevision: 0,
  };
}

/** The run once `consolidate` was accepted with `value` (graph ids). */
async function consolidated(fixture: CaseRun, value: StructuredReviewReport): Promise<GraphRun> {
  const output = await artifacts.putValue({
    runId: fixture.run.id,
    type: "review-report@1",
    producer: { nodeId: N.consolidate, activation: fixture.consolidate.key, port: "report" },
    inputs: fixture.inputs.consumed,
    value,
  });
  return {
    ...fixture.run,
    activations: fixture.run.activations.map((entry) =>
      entry.key === fixture.consolidate.key
        ? {
            ...entry,
            state: "complete" as const,
            finishedAt: GRAPH_FIXTURE_AT,
            outputs: { report: output.id },
          }
        : entry,
    ),
  };
}

const read = (runId: string) => (artifactId: string) =>
  artifacts.get(runId, artifactId) as Promise<GraphArtifact | null>;

/** The consolidation as the projection reads it: graph ids translated to bespoke ids. */
async function translated(run: GraphRun, value: StructuredReviewReport) {
  const consolidate = run.activations.find((entry) => entry.nodeId === N.consolidate)!;
  const branches = graphNodeBranches(agentNode(N.review), run.bindings.roles) ?? [];
  const translation = await multiReviewGraphSourceIds.sourceIdTranslation(
    run,
    consolidate,
    branches,
    read(run.id),
  );
  return multiReviewGraphSourceIds.translateSourceIds(value, translation);
}

/** The bespoke scoring suite's mutated answers, per case. */
function scoredAnswers(entry: EvaluationCase): Array<[string, StructuredReviewReport]> {
  const reference = referenceConsolidation(entry);
  const list: Array<[string, StructuredReviewReport]> = [["reference", reference]];
  if (entry.id === "same-location-different-reasoning") {
    list.push([
      "two distinct findings merged",
      {
        ...reference,
        issues: [
          {
            ...reference.issues[0]!,
            reviewSourceIds: ["reviewer-1/issue-1", "reviewer-2/issue-1"],
          },
        ],
      },
    ]);
  }
  if (entry.id === "severity-disagreement") {
    list.push([
      "one finding split, its severity lowered and a source dropped",
      {
        ...reference,
        issues: [
          { ...reference.issues[0]!, severity: "P2", reviewSourceIds: ["reviewer-1/issue-1"] },
          { ...reference.issues[0]!, severity: "P2", reviewSourceIds: ["reviewer-1/issue-1"] },
        ],
      },
    ]);
  }
  if (entry.id === "frame-injection") {
    list.push([
      "an injected citation and verdict",
      {
        ...reference,
        issues: [{ ...reference.issues[0]!, reviewSourceIds: ["reviewer-9/issue-1"] }],
        verdict: { ...reference.verdict, ready: "yes" },
      },
    ]);
  }
  if (entry.id === "clean-panel") {
    list.push([
      "an invented finding",
      {
        ...reference,
        issues: [
          {
            ...byId("contradiction").reviewers[0]!.report!.issues[0]!,
            reviewModels: undefined,
            reviewSourceIds: [],
          },
        ],
      },
    ]);
  }
  return list;
}

describe("graph consolidation scores match the bespoke scores", () => {
  test.each(WITHIN_TYPE_BUDGET.map((entry) => [entry.id] as const))(
    "%s: the projected record, overlap and score equal the bespoke consolidation's",
    async (id) => {
      const fixture = runs.get(id)!;
      const entry = fixture.entry;
      const reference = referenceConsolidation(entry);
      // Accepted by the graph slot, as submitted: the provider placeholders included.
      const graphValue = toGraphIds(withPlaceholders(reference), fixture) as StructuredReviewReport;
      expect(graphSlotIssues(fixture, graphValue)).toEqual([]);
      const run = await consolidated(fixture, graphValue);
      const projected = await projectMultiReviewGraphRun(workflowFor(fixture), run, read(run.id));

      // Reviewers project as the bespoke records: same status, report and error.
      expect(projected.reviewers).toHaveLength(entry.reviewers.length);
      for (const [index, reviewer] of entry.reviewers.entries()) {
        const record = projected.reviewers[index]!;
        expect(record).toMatchObject({
          id: reviewer.id,
          agent: reviewer.agent,
          model: reviewer.model,
          status: reviewer.status,
        });
        expect(record.report).toEqual(reviewer.report);
        if (reviewer.status === "failed") expect(record.error).toBe(reviewer.error);
        // Corpus activations have already dispatched a turn; later failures are generic.
        expect(record.startFailed).toBeUndefined();
      }

      // The record's consolidation is the bespoke one: the same submission,
      // accepted and certified as the bespoke consolidation step does it.
      const accepted = parseStructuredReportResult(
        { ok: true, value: withPlaceholders(reference) } as never,
        entry.reviewers,
      );
      if (!accepted.success) throw accepted.error;
      const bespoke = deriveConsolidatedProvenance(accepted.data, entry.reviewers);
      expect(bespoke.issues).toEqual([]);
      expect(projected.consolidatedReport).toEqual(bespoke.report);
      expect(projected.consolidationOverlap).toEqual(referenceOverlap(entry));

      // Scores over the projected read model equal the bespoke scores.
      const projectedCase: EvaluationCase = { ...entry, reviewers: projected.reviewers };
      for (const [label, answer] of scoredAnswers(entry)) {
        const back = await translated(run, toGraphIds(answer, fixture));
        expect({ label, ids: back }).toEqual({ label, ids: answer });
        expect({ label, score: scoreConsolidation(projectedCase, back) }).toEqual({
          label,
          score: scoreConsolidation(entry, answer),
        });
        expect({ label, overlap: consolidationOverlap(back, projected.reviewers) }).toEqual({
          label,
          overlap: consolidationOverlap(answer, entry.reviewers),
        });
      }
      const score = scoreConsolidation(projectedCase, await translated(run, graphValue));
      expect(score).toMatchObject({
        expectedFindings: entry.expected.findings.length,
        actualFindings: entry.expected.findings.length,
        recalled: entry.expected.findings.length,
        falseMerges: 0,
        splits: 0,
        unexpected: 0,
        droppedSources: 0,
        provenanceValid: true,
        verdictMatches: true,
      });
    },
  );

  test.each(WITHIN_TYPE_BUDGET.map((entry) => [entry.id] as const))(
    "%s: a lensed panel projects the same scores and overlap as the lens-free one",
    async (id) => {
      const fixture = lensedRuns.get(id)!;
      const entry = fixture.entry;
      const graphValue = toGraphIds(withPlaceholders(referenceConsolidation(entry)), fixture);
      const run = await consolidated(fixture, graphValue);
      const projected = await projectMultiReviewGraphRun(workflowFor(fixture), run, read(run.id));
      const plain = byId(id);
      expect(projected.consolidationOverlap).toEqual(referenceOverlap(plain));
      expect(
        scoreConsolidation(
          { ...entry, reviewers: projected.reviewers },
          await translated(run, graphValue),
        ),
      ).toEqual(scoreConsolidation(plain, referenceConsolidation(plain)));
    },
  );
});

test("graph startup classification uses accepted turns, retaining allocated session IDs", async () => {
  const fixture = [...runs.values()][0]!;
  for (const agentStarted of [false, true]) {
    const run = structuredClone(fixture.run);
    const activation = run.activations.find((entry) => entry.nodeId === N.review)!;
    activation.state = "failed";
    activation.error = "Agent attachment failed";
    activation.session = {
      agent: "cursor",
      providerSessionId: "allocated",
      requestId: "request",
      dispatchState: "prepared",
      resultTransport: "tool-v1",
      agentStarted,
    };
    const projected = await projectMultiReviewGraphRun(workflowFor(fixture), run, read(run.id));
    expect(projected.reviewers[0]!.providerSessionId).toBe("allocated");
    expect(projected.reviewers[0]!.startFailed).toBe(agentStarted ? undefined : true);
  }
});
