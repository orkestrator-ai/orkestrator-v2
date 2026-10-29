/**
 * Graph run fixtures for the run view's tests: runs of the report's worked
 * examples (§9.1 Multi Review with a panel and a gate, §9.2 the Build
 * Pipeline loop, §9.4 the `items` fan-out over failures), compiled with the
 * real compiler, and activations built
 * through the real identity helpers. Test-only.
 */
import { compile, type CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import {
  graphTemplateExample,
  type GraphTemplateExampleKey,
} from "@orkestrator/protocol/graphs/examples";
import {
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  graphActivationKey,
  type GraphActivationKeyParts,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";

export const FIXTURE_AT = "2026-10-29T10:00:00.000Z";

const plans = new Map<GraphTemplateExampleKey, CompiledGraphPlan>();

export function examplePlan(key: GraphTemplateExampleKey): CompiledGraphPlan {
  let plan = plans.get(key);
  if (!plan) {
    const result = compile(graphTemplateExample(key));
    if (!result.plan) throw new Error(`The ${key} example must compile`);
    plan = result.plan;
    plans.set(key, plan);
  }
  return plan;
}

const ROLES: Record<GraphTemplateExampleKey, GraphRun["bindings"]["roles"]> = {
  "multi-review": {
    preparer: { platform: "claude", model: "opus" },
    reviewer: [{ platform: "codex" }, { platform: "claude", reasoningEffort: "high" }],
    consolidator: { platform: "claude" },
    fixer: { platform: "claude" },
    describer: { platform: "claude" },
  },
  "build-pipeline-loop": {
    builder: { platform: "claude", model: "opus" },
    preparer: { platform: "claude" },
    reviewer: { platform: "codex" },
    fixer: { platform: "claude" },
    verifier: { platform: "codex" },
  },
  "design-bake-off": {},
  "failure-diagnosis": {
    diagnoser: { platform: "claude" },
    fixer: { platform: "codex" },
  },
};

export function runOf(
  key: "multi-review" | "build-pipeline-loop" | "failure-diagnosis",
  overrides: Partial<GraphRun> = {},
): GraphRun {
  const plan = examplePlan(key);
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
      roles: ROLES[key],
      params: Object.fromEntries(
        plan.parameters.flatMap((parameter) =>
          parameter.default !== undefined ? [[parameter.key, parameter.default]] : [],
        ),
      ),
      inputs: { target: "artifact-target" },
    },
    status: "running",
    mock: false,
    activations: [],
    rewinds: [],
    loopIterations: Object.fromEntries(plan.loops.map((loop) => [loop.id, 1])),
    usage: { agentSessions: 0, tokens: 0 },
    revision: 1,
    createdAt: FIXTURE_AT,
    updatedAt: FIXTURE_AT,
    startedAt: FIXTURE_AT,
    ...overrides,
  };
}

export function act(
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
    createdAt: FIXTURE_AT,
    startedAt: FIXTURE_AT,
    ...(overrides.state && !["complete", "failed", "skipped", "cancelled"].includes(overrides.state)
      ? {}
      : { finishedAt: "2026-10-29T10:05:00.000Z" }),
    ...overrides,
  };
}

/** An agent session as the executor records it (item 204). */
export function agentSession(
  overrides: Partial<NonNullable<NodeActivation["session"]>> = {},
): NonNullable<NodeActivation["session"]> {
  return {
    agent: "claude",
    model: "opus",
    requestId: "request-1",
    dispatchState: "sent",
    resultTransport: "tool-call-v1",
    providerSessionId: "provider-session-1",
    sessionKey: "graph-session-1",
    ...overrides,
  };
}

export const POLICY: NonNullable<NodeActivation["policy"]> = {
  id: "pipeline",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "restricted",
};
