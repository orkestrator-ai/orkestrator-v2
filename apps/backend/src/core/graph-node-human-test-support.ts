/**
 * Graph runs waiting on people, for the attention and coordinator tests of
 * item 208. Test-only.
 */
import { randomUUID } from "node:crypto";
import {
  graphActivationKey,
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { compiledPlan } from "./graph-run-executor-test-support.js";

/** Two human nodes (`first`, `second`) reading one text run input. */
export function humanNodesPlan() {
  const human = (id: string) => ({
    id,
    kind: "human",
    label: id === "first" ? "Approve the brief" : undefined,
    form: { kind: "approve" },
    inputs: [{ name: "brief", type: "text@1" }],
  });
  return compiledPlan({
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "people",
    revision: 1,
    name: "People",
    parameters: [],
    roles: [],
    inputs: [{ name: "brief", type: "text@1" }],
    outputs: [],
    workspace: { kind: "environment" },
    nodes: [human("first"), human("second")],
    edges: [
      { id: "a", from: { input: "brief" }, to: { node: "first", port: "brief" } },
      { id: "b", from: { input: "brief" }, to: { node: "second", port: "brief" } },
    ],
    limits: { maxAgentSessions: 1, maxConcurrentAgents: 1 },
  } as unknown as GraphTemplateV1);
}

/** A human activation of `nodeId` waiting since `openedAt` (answered when `answered`). */
export function humanActivation(
  nodeId: string,
  openedAt: string,
  options: { answered?: boolean; attempt?: number } = {},
): NodeActivation {
  const parts = { nodeId, iteration: 1, attempt: options.attempt ?? 1 };
  return {
    key: graphActivationKey(parts),
    ...parts,
    state: options.answered ? "complete" : "awaiting-human",
    inputs: {},
    outputs: {},
    ...(options.answered ? { outlet: "approved" } : {}),
    human: {
      id: randomUUID(),
      form: "approve",
      openedAt,
      ...(options.answered
        ? { answer: { decision: "approve", outlet: "approved", at: openedAt, by: "user" } }
        : {}),
    },
    createdAt: openedAt,
    startedAt: openedAt,
    ...(options.answered ? { finishedAt: openedAt } : {}),
  };
}

/** A run of {@link humanNodesPlan} in `environmentId`, revision 0 (for `createGraphRun`). */
export function humanRun(
  environmentId: string,
  projectId: string,
  overrides: Partial<GraphRun> = {},
): GraphRun {
  const plan = humanNodesPlan();
  const at = "2026-10-29T12:00:00.000Z";
  return {
    format: GRAPH_RUN_FORMAT,
    formatVersion: GRAPH_RUN_FORMAT_VERSION,
    id: `run-${randomUUID().slice(0, 8)}`,
    projectId,
    environmentId,
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    bindings: { roles: {}, params: {}, inputs: {} },
    status: "waiting",
    mock: false,
    activations: [],
    rewinds: [],
    loopIterations: {},
    usage: { agentSessions: 0, tokens: 0 },
    revision: 0,
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    ...overrides,
  };
}
