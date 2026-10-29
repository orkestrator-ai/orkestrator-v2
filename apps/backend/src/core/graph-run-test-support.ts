/**
 * Graph run fixtures for backend tests: a run of the §9.2 example plan
 * (build, then rounds of prepare, package, review, address and verify),
 * activations and artifacts built through the protocol's identity helpers.
 * Test-only.
 */
import { compile } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import {
  GRAPH_ARTIFACT_FORMAT_VERSION,
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  GRAPH_RUN_INPUT_PRODUCER,
  graphActivationKey,
  graphArtifactDigest,
  graphArtifactFilePath,
  graphArtifactId,
  graphArtifactInlineBytes,
  type GraphArtifact,
  type GraphArtifactBody,
  type GraphArtifactProducer,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { Environment } from "./models.js";

export const GRAPH_FIXTURE_AT = "2026-10-29T00:00:00.000Z";
export const GRAPH_FIXTURE_COMMIT = "a".repeat(40);

let plan: GraphRun["plan"] | null = null;

/** The §9.2 example's compiled plan (compiled once per test process). */
export function graphPlanFixture(): GraphRun["plan"] {
  if (!plan) {
    const result = compile(graphTemplateExample("build-pipeline-loop"));
    if (!result.plan) throw new Error("The §9.2 example must compile");
    plan = result.plan;
  }
  return structuredClone(plan);
}

export function graphRunFixture(overrides: Partial<GraphRun> = {}): GraphRun {
  const compiled = graphPlanFixture();
  return {
    format: GRAPH_RUN_FORMAT,
    formatVersion: GRAPH_RUN_FORMAT_VERSION,
    id: "run-1",
    projectId: "p1",
    environmentId: "e1",
    template: {
      id: compiled.template.id,
      revision: compiled.template.revision,
      digest: compiled.templateDigest,
      scope: "user",
    },
    plan: compiled,
    bindings: { roles: { builder: { platform: "claude" } }, params: {}, inputs: {} },
    status: "running",
    mock: false,
    activations: [],
    rewinds: [],
    loopIterations: { rounds: 1 },
    usage: { agentSessions: 0, tokens: 0 },
    revision: 0,
    createdAt: GRAPH_FIXTURE_AT,
    updatedAt: GRAPH_FIXTURE_AT,
    ...overrides,
  };
}

export function graphActivationFixture(
  nodeId: string,
  options: { iteration?: number; attempt?: number; branchKey?: string } = {},
  overrides: Partial<NodeActivation> = {},
): NodeActivation {
  const parts = {
    nodeId,
    iteration: options.iteration ?? 1,
    attempt: options.attempt ?? 1,
    ...(options.branchKey === undefined ? {} : { branchKey: options.branchKey }),
  };
  return {
    key: graphActivationKey(parts),
    ...parts,
    state: "complete",
    inputs: {},
    outputs: {},
    createdAt: GRAPH_FIXTURE_AT,
    ...overrides,
  };
}

/** A complete artifact envelope (value body unless `file` is given). */
export function graphArtifactFixture(
  runId: string,
  options: {
    type?: string;
    producer?: GraphArtifactProducer;
    value?: unknown;
    file?: { sha256: string; bytes: number };
    inputs?: string[];
  } = {},
): GraphArtifact {
  const type = options.type ?? "workspace@1";
  const body: GraphArtifactBody = options.file
    ? { file: { path: graphArtifactFilePath(runId, options.file.sha256), ...options.file } }
    : { value: options.value ?? { branch: "main", headRef: GRAPH_FIXTURE_COMMIT, baseRef: null } };
  const producer = options.producer ?? {
    nodeId: GRAPH_RUN_INPUT_PRODUCER,
    activation: GRAPH_RUN_INPUT_PRODUCER,
    port: "target",
  };
  const inputs = options.inputs ?? [];
  const digest = graphArtifactDigest(type, body);
  return {
    formatVersion: GRAPH_ARTIFACT_FORMAT_VERSION,
    id: graphArtifactId({ digest, runId, producer, inputs }),
    digest,
    type,
    runId,
    producer,
    inputs,
    createdAt: GRAPH_FIXTURE_AT,
    bytes: "file" in body ? body.file.bytes : graphArtifactInlineBytes(body),
    body,
    state: "live",
  };
}

export function graphEnvironmentFixture(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "e1",
    projectId: "p1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: GRAPH_FIXTURE_AT,
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    ...overrides,
  };
}
