/**
 * The `human` node executor and its answers (plan P2.8, D15, report §6.8).
 *
 * A person takes part in a run at an explicit point: `approve` (approve or
 * reject), `edit` (approve with an edited value of one input, or reject) and
 * `choose` (pick one of the node's outlets). Shapes and validation are in
 * `@orkestrator/protocol/graphs/run` (`run-human.ts`).
 *
 * ## Lifecycle
 *
 * - `start` records a {@link GraphHumanWait} with a fresh UUID and reports the
 *   activation `awaiting-human`; the pass then derives the run status
 *   `waiting` when nothing else is admitted ("waiting for you"). A lost
 *   report is harmless: nobody can answer a wait that was never saved, so a
 *   repeated `start` records a new one. The executor asks to be observed only
 *   when woken (`observeAfterMs: null`), or once the node's `timeoutMs` is due.
 * - An answer ({@link GraphHumanAnswers.answer}) is validated, an edited value
 *   is stored as a new artifact (validated against the input's type, its
 *   lineage the original), and the answer is recorded under the run's lock
 *   through `GraphRunService.updateActivation`, which wakes the run to
 *   observe the activation.
 * - `observe` (and `recover`, after a backend restart) completes an answered
 *   activation with the answer's outlet, forwarding its single-value inputs
 *   as its outputs (an edited value in place of the original), as a gate does.
 *   Unanswered, it keeps waiting: the wait is in the run record, so it
 *   survives a restart and any view rehydrates it.
 * - `cancel` settles the activation. A timeout arrives as `cancel(…,
 *   "timeout")`; the pass turns it into a `timeout` failure, which routes to
 *   the node's implicit `error` port (`onFailure: route`, the default for a
 *   human node with `timeoutMs`), so the outlets' consumers are skipped. An
 *   answer recorded before the deadline still wins. A restart (item 210)
 *   supersedes the activation with reason `restarted`; its wait dies with it,
 *   and an answer naming it is refused as stale.
 *
 * Fail closed (root invariant 10): a malformed, stale or mismatched answer is
 * refused and never recorded, and an edited value that fails its type is
 * never stored. Nothing here logs an answer, a note or an edited value.
 */
import { randomUUID } from "node:crypto";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import {
  graphHumanAnswerOutlet,
  graphHumanAnswerProblem,
  graphHumanForwardedOutputs,
  type GraphAgentAnswerer,
  type GraphHumanAnswer,
  type GraphHumanAnswerInput,
  type GraphHumanWait,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import { GraphStorageError } from "./graph-run-errors.js";
import type {
  GraphActivationReport,
  GraphCancelReason,
  GraphExecutorContext,
  GraphNodeExecutor,
} from "./graph-run-executors.js";
import type { GraphRunService } from "./graph-run-service.js";

/** Slack past `timeoutMs` before the timed-out wait is observed, so the pass sees it due. */
const TIMEOUT_OBSERVE_SLACK_MS = 50;

export class GraphHumanAnswerError extends Error {
  constructor(
    readonly code: "not-found" | "invalid-answer",
    message: string,
  ) {
    super(message);
    this.name = "GraphHumanAnswerError";
  }
}

/** When to observe a waiting activation next: at its deadline, or only when woken. */
function observeAfter(context: GraphExecutorContext): number | null {
  const timeoutMs = context.node.timeoutMs;
  if (timeoutMs === undefined) return null;
  const since = Date.parse(
    context.activation.startedAt ??
      context.activation.human?.openedAt ??
      context.now().toISOString(),
  );
  if (!Number.isFinite(since)) return TIMEOUT_OBSERVE_SLACK_MS;
  return Math.max(0, since + timeoutMs - context.now().getTime()) + TIMEOUT_OBSERVE_SLACK_MS;
}

function decided(
  activation: Readonly<NodeActivation>,
  answer: GraphHumanAnswer,
): GraphActivationReport {
  return {
    state: "complete",
    outlet: answer.outlet,
    outputs: graphHumanForwardedOutputs(activation, answer),
  };
}

async function open(context: GraphExecutorContext): Promise<GraphActivationReport> {
  const { node, activation } = context;
  if (node.kind !== "human") throw new Error("The human executor runs human nodes only");
  const wait = activation.human;
  if (wait?.answer) return decided(activation, wait.answer);
  if (wait) {
    return activation.state === "awaiting-human"
      ? { state: "unchanged", observeAfterMs: observeAfter(context) }
      : { state: "awaiting-human", observeAfterMs: observeAfter(context) };
  }
  const opened: GraphHumanWait = {
    id: randomUUID(),
    form: node.form.kind,
    openedAt: context.now().toISOString(),
  };
  return { state: "awaiting-human", human: opened, observeAfterMs: observeAfter(context) };
}

async function stop(
  context: GraphExecutorContext,
  reason: GraphCancelReason,
): Promise<GraphActivationReport> {
  const answer = context.activation.human?.answer;
  // A person who answered in time is honoured even if the deadline passed
  // before the pass observed it; any other stop leaves the wait unanswered.
  if (answer && reason === "timeout") {
    const timeoutMs = context.node.timeoutMs;
    const since = Date.parse(context.activation.startedAt ?? context.activation.createdAt);
    const at = Date.parse(answer.at);
    if (
      timeoutMs === undefined ||
      !Number.isFinite(since) ||
      (Number.isFinite(at) && at <= since + timeoutMs)
    ) {
      return decided(context.activation, answer);
    }
  }
  return { state: "cancelled" };
}

/** The human executor. Register it once on `graphRuns.executors` (live runs; mock runs fall back to it). */
export function createGraphHumanExecutor(): GraphNodeExecutor {
  return {
    kind: "human",
    start: open,
    observe: open,
    recover: open,
    cancel: stop,
  };
}

// ---------------------------------------------------------------- answers

export interface GraphHumanAnswersDependencies {
  runs: Pick<GraphRunService, "get" | "updateActivation">;
  artifacts: Pick<GraphArtifactStore, "requireVerified" | "putValue">;
  clock?: () => Date;
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/** The `choices` the producing port declares, for a `decision@1` edit's validation. */
function producerChoices(
  run: GraphRun,
  nodeId: string,
  port: string,
): readonly string[] | undefined {
  const producer: GraphPlanNode | undefined = run.plan.nodes.find((node) => node.id === nodeId);
  return producer?.outputs.find((output) => output.name === port)?.choices;
}

/**
 * Records a person's answer to a waiting human node (`graph_run_answer`'s
 * human-node form). Shares the run service's locked activation update with
 * `GraphAgentQuestions.answer`, so both refuse a stale answer the same way.
 */
export class GraphHumanAnswers {
  private readonly clock: () => Date;

  constructor(private readonly dependencies: GraphHumanAnswersDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async answer(
    location: { runId: string; activationKey: string },
    input: GraphHumanAnswerInput,
    by: GraphAgentAnswerer,
  ): Promise<NodeActivation> {
    const run = await this.dependencies.runs.get(location.runId);
    if (!run) throw new GraphHumanAnswerError("not-found", "The graph run does not exist");
    const activation = run.activations.find((entry) => entry.key === location.activationKey);
    if (!activation) {
      throw new GraphHumanAnswerError("not-found", "The run has no such activation");
    }
    const node = run.plan.nodes.find((entry) => entry.id === activation.nodeId);
    const early = graphHumanAnswerProblem(node, activation, input);
    if (early) throw new GraphHumanAnswerError("invalid-answer", early);
    const human = node as Extract<GraphPlanNode, { kind: "human" }>;
    const outlet = graphHumanAnswerOutlet(human, input)!;
    const edited =
      input.value !== undefined && human.form.kind === "edit"
        ? await this.storeEdit(run, activation, human.form.edit, input.value)
        : undefined;
    const answer: GraphHumanAnswer = {
      decision: input.decision,
      outlet,
      ...(edited ? { edited } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      at: this.clock().toISOString(),
      by,
    };
    try {
      return await this.dependencies.runs.updateActivation(
        location.runId,
        location.activationKey,
        (current, latest) => {
          const latestNode = latest.plan.nodes.find((entry) => entry.id === current.nodeId);
          const problem = graphHumanAnswerProblem(latestNode, current, input);
          if (problem) throw new GraphHumanAnswerError("invalid-answer", problem);
          return { ...current, human: { ...current.human!, answer } };
        },
      );
    } catch (error) {
      if (error instanceof GraphHumanAnswerError) throw error;
      // A run that moved on (cancelled, restarted) refuses the answer as stale.
      if (error instanceof Error && "code" in error) {
        const code = (error as { code: unknown }).code;
        throw new GraphHumanAnswerError(
          code === "not-found" ? "not-found" : "invalid-answer",
          error.message,
        );
      }
      throw error;
    }
  }

  /**
   * Stores an edited value as a new artifact of the original's type, its
   * lineage the original, produced by this activation on the edited port.
   * Returns undefined when the value is unchanged (the original is forwarded).
   */
  private async storeEdit(
    run: GraphRun,
    activation: NodeActivation,
    port: string,
    value: unknown,
  ): Promise<{ port: string; artifactId: string } | undefined> {
    const originalId = activation.inputs[port];
    if (typeof originalId !== "string") {
      throw new GraphHumanAnswerError(
        "invalid-answer",
        "The edited input has no single value to replace",
      );
    }
    let original;
    try {
      original = await this.dependencies.artifacts.requireVerified(run.id, originalId);
    } catch {
      throw new GraphHumanAnswerError("invalid-answer", "The value to edit cannot be read");
    }
    if (original.body.value === undefined || "file" in original.body) {
      throw new GraphHumanAnswerError(
        "invalid-answer",
        `${original.type} is a file reference and cannot be edited; approve or reject it`,
      );
    }
    if (sameValue(original.body.value, value)) return undefined;
    const choices = producerChoices(run, original.producer.nodeId, original.producer.port);
    try {
      const stored = await this.dependencies.artifacts.putValue({
        runId: run.id,
        type: original.type,
        producer: { nodeId: activation.nodeId, activation: activation.key, port },
        inputs: [originalId],
        ...(original.workspace ? { workspace: original.workspace } : {}),
        ...(original.itemIds ? { itemIds: original.itemIds } : {}),
        ...(choices ? { validation: { choices } } : {}),
        value,
      });
      return { port, artifactId: stored.id };
    } catch (error) {
      if (error instanceof GraphStorageError) {
        const issues = error.issues ?? [];
        throw new GraphHumanAnswerError(
          "invalid-answer",
          `The edited value does not fit ${original.type}${issues.length > 0 ? `: ${issues.join(", ")}` : `: ${error.message}`}`,
        );
      }
      throw error;
    }
  }
}
