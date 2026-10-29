/**
 * Run-record fixtures for the run tests: a run of the §9.2 example plan, and
 * activations and artifacts built through the real identity helpers.
 * Test-only.
 */
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import { compile } from "./compile.js";
import { graphTemplateExample } from "./examples.js";
import {
  graphActivationKey,
  graphArtifactDigest,
  graphArtifactFilePath,
  graphArtifactId,
  graphArtifactInlineBytes,
  type GraphActivationKeyParts,
} from "./run-identity.js";
import {
  GRAPH_ARTIFACT_FORMAT_VERSION,
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  GRAPH_RUN_INPUT_PRODUCER,
  type GraphArtifact,
  type GraphArtifactBody,
  type GraphArtifactProducer,
  type GraphRun,
  type NodeActivation,
} from "./run-model.js";

export const RUN_FIXTURE_AT = "2026-10-29T00:00:00.000Z";
export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);

export const POLICY_FIXTURE: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "restricted",
};

export function graphRunFixture(overrides: Partial<GraphRun> = {}): GraphRun {
  const result = compile(graphTemplateExample("build-pipeline-loop"));
  if (!result.plan) throw new Error("The §9.2 example must compile");
  const plan = result.plan;
  return {
    format: GRAPH_RUN_FORMAT,
    formatVersion: GRAPH_RUN_FORMAT_VERSION,
    id: "run-1",
    projectId: "project-1",
    environmentId: "env-1",
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    bindings: {
      roles: {
        builder: { platform: "claude", model: "opus" },
        reviewer: [{ platform: "codex" }, { platform: "claude", reasoningEffort: "high" }],
      },
      params: {},
      inputs: {},
    },
    status: "running",
    mock: false,
    activations: [],
    rewinds: [],
    loopIterations: { rounds: 1 },
    usage: { agentSessions: 0, tokens: 0 },
    revision: 0,
    createdAt: RUN_FIXTURE_AT,
    updatedAt: RUN_FIXTURE_AT,
    ...overrides,
  };
}

export function activationFixture(
  parts: Partial<GraphActivationKeyParts> & { nodeId: string },
  overrides: Partial<NodeActivation> = {},
): NodeActivation {
  const keyParts: GraphActivationKeyParts = {
    nodeId: parts.nodeId,
    iteration: parts.iteration ?? 1,
    attempt: parts.attempt ?? 1,
    ...(parts.branchKey === undefined ? {} : { branchKey: parts.branchKey }),
  };
  return {
    key: graphActivationKey(keyParts),
    ...keyParts,
    state: "complete",
    inputs: {},
    outputs: {},
    createdAt: RUN_FIXTURE_AT,
    ...overrides,
  };
}

export function artifactFixture(
  runId: string,
  options: {
    type?: string;
    producer?: GraphArtifactProducer;
    activation?: NodeActivation;
    port?: string;
    value?: unknown;
    file?: { sha256: string; bytes: number };
    inputs?: string[];
    workspace?: { headRef: string; baseRef?: string };
  } = {},
): GraphArtifact {
  const type = options.type ?? "workspace@1";
  const body: GraphArtifactBody = options.file
    ? {
        file: { path: graphArtifactFilePath(runId, options.file.sha256), ...options.file },
        ...(options.value === undefined ? {} : { value: options.value }),
      }
    : { value: options.value ?? { branch: "main", headRef: COMMIT_A, baseRef: null } };
  const producer =
    options.producer ??
    (options.activation
      ? {
          nodeId: options.activation.nodeId,
          activation: options.activation.key,
          port: options.port ?? "code",
        }
      : { nodeId: GRAPH_RUN_INPUT_PRODUCER, activation: GRAPH_RUN_INPUT_PRODUCER, port: "target" });
  const inputs = options.inputs ?? [];
  const digest = graphArtifactDigest(type, body);
  const id = graphArtifactId({
    digest,
    runId,
    producer,
    inputs,
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  return {
    formatVersion: GRAPH_ARTIFACT_FORMAT_VERSION,
    id,
    digest,
    type,
    runId,
    producer,
    inputs,
    ...(options.workspace ? { workspace: options.workspace } : {}),
    createdAt: RUN_FIXTURE_AT,
    bytes: "file" in body ? body.file.bytes : graphArtifactInlineBytes(body),
    body,
    state: "live",
  };
}
