/**
 * What every mock executor shares (item 213; see `graph-mock-provider.ts`):
 * which pin applies to an activation, reading its inputs, storing its
 * outputs through the run's artifact store (so mock values pass the same
 * validation as real ones), pinned failures and the `stepMs` delay.
 */
import { createHash } from "node:crypto";
import {
  graphMockPinAt,
  type GraphMockPin,
  type GraphMockWorkspaceValue,
} from "@orkestrator/protocol/graphs/mock";
import type { GraphArtifact, GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import {
  GraphTypeLibrary,
  type GraphErrorCause,
  type GraphTypeDefinition,
} from "@orkestrator/protocol/graphs/types";
import { isGraphStorageError } from "./graph-run-errors.js";
import type { GraphActivationReport, GraphExecutorContext } from "./graph-run-executors.js";

/**
 * The activation's position in its node's pin sequence: how many activations
 * of the same node and branch the run created before it (retries, loop
 * iterations and restarts alike).
 */
export function graphMockOrdinal(
  run: Pick<GraphRun, "activations">,
  activation: Pick<NodeActivation, "key" | "nodeId" | "branchKey">,
): number {
  let ordinal = 0;
  for (const entry of run.activations) {
    if (entry.key === activation.key) return ordinal;
    if (entry.nodeId === activation.nodeId && entry.branchKey === activation.branchKey) ordinal++;
  }
  return ordinal;
}

/** The pin that applies to this activation, if any. */
export function graphMockPinFor(context: GraphExecutorContext): GraphMockPin | undefined {
  return graphMockPinAt(
    context.run.mockOptions?.pins,
    context.node.id,
    graphMockOrdinal(context.run, context.activation),
  );
}

/** A `{ outputs }` pin's custom values by port; empty for every other pin. */
export function graphMockCustomOutputs(pin: GraphMockPin | undefined): Record<string, unknown> {
  if (pin === undefined || typeof pin === "string" || "fail" in pin || "outlet" in pin) return {};
  return pin.outputs;
}

/** One input port as a mock reads it. */
export interface GraphMockInput {
  port: string;
  type: string;
  ids: string[];
  artifacts: GraphArtifact[];
}

/** The activation's inputs, read from the run's artifacts (values only; files are never read). */
export async function graphMockInputs(context: GraphExecutorContext): Promise<GraphMockInput[]> {
  const inputs: GraphMockInput[] = [];
  for (const port of context.node.inputs) {
    const bound = context.activation.inputs[port.name];
    if (bound === undefined) continue;
    const ids = Array.isArray(bound) ? bound : [bound];
    const artifacts: GraphArtifact[] = [];
    for (const id of ids) {
      const artifact = await context.artifacts.get(context.run.id, id);
      if (artifact) artifacts.push(artifact);
    }
    inputs.push({ port: port.name, type: port.type, ids, artifacts });
  }
  return inputs;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueOf(artifact: GraphArtifact | undefined): unknown {
  return artifact && "value" in artifact.body ? artifact.body.value : undefined;
}

/** The first single `workspace@1` input's value. */
export function graphMockBaseWorkspace(
  inputs: readonly GraphMockInput[],
): GraphMockWorkspaceValue | undefined {
  for (const input of inputs) {
    if (input.type !== "workspace@1") continue;
    const value = valueOf(input.artifacts[0]);
    if (
      record(value) &&
      typeof value.branch === "string" &&
      typeof value.headRef === "string" &&
      (value.baseRef === null || typeof value.baseRef === "string")
    ) {
      return { branch: value.branch, headRef: value.headRef, baseRef: value.baseRef };
    }
  }
  return undefined;
}

/** The criterion ids of the first `ticket@1` input, as the agent executor reads them. */
export function graphMockCriterionIds(inputs: readonly GraphMockInput[]): string[] | undefined {
  for (const input of inputs) {
    if (!input.type.startsWith("ticket@")) continue;
    const value = valueOf(input.artifacts[0]);
    if (!record(value) || !Array.isArray(value.criteria)) continue;
    const ids = value.criteria.flatMap((criterion) =>
      record(criterion) && typeof criterion.id === "string" ? [criterion.id] : [],
    );
    if (ids.length > 0) return ids;
  }
  return undefined;
}

export function graphMockDefinition(run: Readonly<GraphRun>, type: string): GraphTypeDefinition {
  const resolved = new GraphTypeLibrary(run.plan.types).resolve(type);
  if (!resolved.ok || resolved.type.kind !== "named") {
    throw new GraphMockOutputError(`The output type ${type} does not resolve in the run's plan`);
  }
  return resolved.type.definition;
}

/** A mock output that could not be stored: the activation fails `invalid-result`. */
export class GraphMockOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphMockOutputError";
  }
}

/** Ports a mock never fills: the routed `error` output is the pass's (item 206). */
export function graphMockSkipsPort(port: { name: string; type: string }): boolean {
  return port.type === "error@1";
}

/** What the mock stores for one output port. */
export interface GraphMockStore {
  port: { name: string; type: string; choices?: string[] };
  value: unknown;
  definition: GraphTypeDefinition;
  lineage: readonly string[];
  workspace?: { headRef: string; baseRef?: string };
  itemIds?: readonly string[];
  criterionIds?: readonly string[];
}

/**
 * Stores one mock output: a value artifact, or for a reference type an
 * unwritten file whose descriptor is the value (`putMockReference`).
 * Returns the artifact id; a refused value throws {@link GraphMockOutputError}
 * naming the port and the issue paths (never the value).
 */
export async function graphMockStoreOutput(
  context: GraphExecutorContext,
  output: GraphMockStore,
): Promise<string> {
  const base = {
    runId: context.run.id,
    type: output.port.type,
    producer: {
      nodeId: context.node.id,
      activation: context.activation.key,
      port: output.port.name,
    },
    inputs: output.lineage,
    ...(output.workspace ? { workspace: output.workspace } : {}),
    ...(output.itemIds ? { itemIds: output.itemIds } : {}),
    ...(output.port.choices || output.criterionIds
      ? {
          validation: {
            ...(output.port.choices ? { choices: output.port.choices } : {}),
            ...(output.criterionIds ? { criterionIds: output.criterionIds } : {}),
          },
        }
      : {}),
  };
  try {
    if (output.definition.storage === "reference") {
      const contents = Buffer.from(
        JSON.stringify({
          mock: true,
          run: context.run.id,
          activation: context.activation.key,
          port: output.port.name,
        }),
        "utf8",
      );
      const artifact = await context.artifacts.putMockReference({
        ...base,
        contents,
        extension: "json",
        ...(output.value === undefined ? {} : { value: output.value }),
      });
      return artifact.id;
    }
    const artifact = await context.artifacts.putValue({ ...base, value: output.value });
    return artifact.id;
  } catch (error) {
    if (isGraphStorageError(error, "invalid-artifact")) {
      const issues = error.issues?.length ? ` (${error.issues.slice(0, 4).join(", ")})` : "";
      throw new GraphMockOutputError(
        `The mock output ${output.port.name} fails ${output.port.type}${issues}`,
      );
    }
    throw error;
  }
}

/** The report of a pinned failure. */
export function graphMockFailure(pin: { fail: GraphErrorCause; message?: string }) {
  return {
    state: "failed" as const,
    cause: pin.fail,
    error: pin.message ?? `Mock run: pinned ${pin.fail}`,
  };
}

/**
 * Runs `produce` once the activation has appeared to run for
 * `mockOptions.stepMs`; until then it reports `running`.
 */
export async function graphMockStep(
  context: GraphExecutorContext,
  produce: () => Promise<GraphActivationReport>,
): Promise<GraphActivationReport> {
  const stepMs = context.run.mockOptions?.stepMs ?? 0;
  if (stepMs > 0) {
    const startedAt = context.activation.startedAt
      ? Date.parse(context.activation.startedAt)
      : Number.NaN;
    if (context.operation === "start" || Number.isNaN(startedAt)) {
      return { state: "running", observeAfterMs: stepMs };
    }
    const elapsed = context.now().getTime() - startedAt;
    if (elapsed < stepMs) return { state: "unchanged", observeAfterMs: stepMs - elapsed };
  }
  try {
    return await produce();
  } catch (error) {
    if (error instanceof GraphMockOutputError) {
      return { state: "failed", cause: "invalid-result", error: error.message };
    }
    throw error;
  }
}

/** A short, stable id for log lines and fake identities. */
export function graphMockDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
