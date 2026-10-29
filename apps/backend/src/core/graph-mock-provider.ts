/**
 * Mock runs (plan P2.13, report §7.5): node executors that answer without a
 * provider, a commit or a side effect, so a user can test a graph's control
 * flow (gates, loops, merges, retries, failure routes, the run view) for
 * free.
 *
 * Registered with `{ mock: true }` on the run service's registry
 * ({@link installGraphMockExecutors}). The registry never lets a mock run
 * fall back to a live `agent` or `system` executor, and gates and merges are
 * deterministic, so they run live. Every mock executor therefore runs in the
 * same scheduler passes as a real run: admission, workspace locks within the
 * run, retries, `onFailure`, loops and the record's bounds all apply.
 *
 * - **Agents** create no provider session and use no tokens. Each output
 *   port answers with its pin (`graphs/mock-pins.ts`), else its type's
 *   example (generated from the schema when the type has none), fitted to the
 *   port (a decision's choices, a ticket's criteria). `workspace@1` outputs
 *   carry a deterministic fake commit (`graphMockWorkspace`); nothing touches
 *   git, so guards (item 209) have nothing to check and are no-ops: a mock
 *   activation records no baseline, policy or guard result. A mock agent
 *   never asks a question (`ask_human`).
 * - **System nodes** ({@link GraphMockSystemExecutor},
 *   `graph-mock-system.ts`) answer the same way; side-effecting actions
 *   record "would have run" in the effect journal instead of acting.
 * - **Human nodes** answer by default (approve; an `edit` form forwards the
 *   value unedited; a `choose` form takes its first option), so a mock run
 *   completes unattended. A pin takes another outlet (with an edited value),
 *   fails, or `pause`s: the activation is handed to the live human executor
 *   (item 208) and waits for a person like a real run.
 *
 * Outputs are stored through the run's artifact store, so every mock value
 * passes the same type validation as a real one; a pinned value that does not
 * fails the activation with `invalid-result`. Values are deterministic per
 * run, activation and port, so a restarted backend that runs `start` again
 * stores the same artifacts (the store is idempotent for the same envelope).
 *
 * `mockOptions.stepMs` makes each activation report `running` for that long
 * first, so a person watching the run view sees it move. Logs carry ids,
 * kinds and counts only.
 */
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import { graphMockValue, graphMockWorkspace } from "@orkestrator/protocol/graphs/mock";
import { graphActivationBranch } from "@orkestrator/protocol/graphs/run";
import { graphAgentItemIds } from "./graph-agent-results.js";
import {
  graphMockBaseWorkspace,
  graphMockCustomOutputs,
  graphMockCriterionIds,
  graphMockDefinition,
  graphMockFailure,
  graphMockInputs,
  graphMockPinFor,
  graphMockSkipsPort,
  graphMockStep,
  graphMockStoreOutput,
} from "./graph-mock-outputs.js";
import { GraphMockSystemExecutor } from "./graph-mock-system.js";
import type {
  GraphActivationReport,
  GraphCancelReason,
  GraphExecutorContext,
  GraphNodeExecutor,
  GraphNodeExecutorRegistry,
} from "./graph-run-executors.js";
import type { GraphEffectsStorage } from "./storage-graph-effects.js";

export interface GraphMockExecutorDependencies {
  storage: { graphEffects: Pick<GraphEffectsStorage, "recordSimulatedGraphEffect"> };
  /** This backend process, recorded on "would have run" records. */
  owner: string;
}

// ---------------------------------------------------------------- agent

/** Mock `agent` nodes: pinned, example or generated outputs; no session, no tokens. */
export class GraphMockAgentExecutor implements GraphNodeExecutor {
  readonly kind = "agent" as const;

  start(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return graphMockStep(context, () => this.produce(context));
  }

  observe(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return graphMockStep(context, () => this.produce(context));
  }

  recover(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return graphMockStep(context, () => this.produce(context));
  }

  /** Nothing runs elsewhere, so every cancel reason stops it at once. */
  async cancel(_context: GraphExecutorContext, _reason: GraphCancelReason) {
    return { state: "cancelled" as const };
  }

  private async produce(context: GraphExecutorContext): Promise<GraphActivationReport> {
    const pin = graphMockPinFor(context);
    if (pin !== undefined && typeof pin !== "string" && "fail" in pin) {
      return graphMockFailure(pin);
    }
    const node = context.node as Extract<GraphPlanNode, { kind: "agent" }>;
    const inputs = await graphMockInputs(context);
    const lineage = inputs.flatMap((input) => input.ids);
    const base = graphMockBaseWorkspace(inputs);
    const criterionIds = graphMockCriterionIds(inputs);
    const writes = node.workspaceAccess === "write";
    const custom = graphMockCustomOutputs(pin);
    const mode = pin === "generated" ? "generated" : "example";
    // One fake commit per activation: every workspace output of a writing node names it.
    const commit = graphMockWorkspace({
      runId: context.run.id,
      activationKey: context.activation.key,
      port: "code",
      writes,
      ...(base ? { base } : {}),
    });
    const headRef = writes || base ? commit.headRef : undefined;
    const workspace =
      node.workspaceAccess !== "none" && headRef
        ? {
            headRef,
            ...(commit.baseRef && writes ? { baseRef: commit.baseRef } : {}),
            ...(!writes && base?.baseRef ? { baseRef: base.baseRef } : {}),
          }
        : undefined;
    const outputs: Record<string, string> = {};
    // An `items` branch's outputs stand for its item, as live runs record (item 401).
    const sourceItem = graphActivationBranch(context.run, node, context.activation)?.item?.id;
    for (const port of node.outputs) {
      if (graphMockSkipsPort(port)) continue;
      const definition = graphMockDefinition(context.run, port.type);
      let value: unknown;
      if (Object.hasOwn(custom, port.name)) {
        value = custom[port.name];
        if (value === null) continue;
      } else if (definition.builtIn && definition.name === "workspace") {
        value = commit;
      } else {
        value = graphMockValue(definition, mode, {
          ...(port.choices ? { choices: port.choices } : {}),
          ...(criterionIds ? { criterionIds } : {}),
          ...(headRef ? { headRef } : {}),
        }).value;
      }
      const itemIds = graphAgentItemIds(definition, value, context.activation);
      outputs[port.name] = await graphMockStoreOutput(context, {
        port,
        value,
        definition,
        lineage,
        ...(workspace ? { workspace } : {}),
        ...(itemIds ? { itemIds } : {}),
        ...(sourceItem !== undefined ? { sourceItem } : {}),
        ...(criterionIds && definition.name === "verification-verdict" ? { criterionIds } : {}),
      });
    }
    return { state: "complete", outputs };
  }
}

// ---------------------------------------------------------------- human

/**
 * Mock `human` nodes: answer at once (approve, the first choice, the edit
 * forwarded unedited) unless pinned; a `pause` pin hands the activation to
 * the live human executor (item 208), so it waits for a person.
 */
export class GraphMockHumanExecutor implements GraphNodeExecutor {
  readonly kind = "human" as const;

  constructor(private readonly registry: GraphNodeExecutorRegistry) {}

  /** The live human executor a `pause` pin waits on, when this backend has one. */
  private live(): GraphNodeExecutor | undefined {
    return this.registry.resolve("human");
  }

  private paused(context: GraphExecutorContext): boolean {
    return graphMockPinFor(context) === "pause";
  }

  private noPerson(): GraphActivationReport {
    return {
      state: "failed",
      cause: "system-error",
      error: "Mock run: a pause pin needs human nodes, which this backend cannot run yet",
    };
  }

  start(context: GraphExecutorContext): Promise<GraphActivationReport> {
    if (this.paused(context))
      return this.live()?.start(context) ?? Promise.resolve(this.noPerson());
    return graphMockStep(context, () => this.answer(context));
  }

  observe(context: GraphExecutorContext): Promise<GraphActivationReport> {
    if (this.paused(context)) {
      return this.live()?.observe(context) ?? Promise.resolve(this.noPerson());
    }
    return graphMockStep(context, () => this.answer(context));
  }

  recover(context: GraphExecutorContext): Promise<GraphActivationReport> {
    if (this.paused(context)) {
      const live = this.live();
      if (!live) return Promise.resolve(this.noPerson());
      if (live.recover) return live.recover(context);
      return context.activation.state === "admitting" ? live.start(context) : live.observe(context);
    }
    return graphMockStep(context, () => this.answer(context));
  }

  /** Any reason: a paused activation hands it to the live executor, others stop at once. */
  async cancel(context: GraphExecutorContext, reason: GraphCancelReason) {
    const live = this.paused(context) ? this.live() : undefined;
    if (live) return live.cancel(context, reason);
    return { state: "cancelled" as const };
  }

  private async answer(context: GraphExecutorContext): Promise<GraphActivationReport> {
    const node = context.node as Extract<GraphPlanNode, { kind: "human" }>;
    const pin = graphMockPinFor(context);
    if (pin !== undefined && typeof pin !== "string" && "fail" in pin) {
      return graphMockFailure(pin);
    }
    const outlet =
      pin !== undefined && typeof pin !== "string" && "outlet" in pin
        ? pin.outlet
        : node.form.kind === "choose"
          ? node.form.options[0]!.to
          : "approved";
    // As a gate does: the taken outlet forwards the single-value inputs.
    const outputs: Record<string, string> = Object.fromEntries(
      Object.entries(context.activation.inputs).flatMap(([port, ids]) =>
        Array.isArray(ids) ? [] : [[port, ids]],
      ),
    );
    const edited =
      pin !== undefined && typeof pin !== "string" && "outlet" in pin ? pin.outputs : undefined;
    if (edited && node.form.kind === "edit") {
      const name = node.form.edit;
      const input = node.inputs.find((port) => port.name === name);
      const value = edited[name];
      if (input && value !== undefined && value !== null) {
        const bound = context.activation.inputs[name];
        outputs[name] = await graphMockStoreOutput(context, {
          port: { name, type: input.type },
          value,
          definition: graphMockDefinition(context.run, input.type),
          lineage: bound === undefined ? [] : Array.isArray(bound) ? bound : [bound],
        });
      }
    }
    return { state: "complete", outlet, outputs };
  }
}

// ---------------------------------------------------------------- wiring

/**
 * Registers the mock `agent`, `system` and `human` executors (`{ mock: true }`)
 * on a run service's registry. Returns the unregister function.
 */
export function installGraphMockExecutors(
  registry: GraphNodeExecutorRegistry,
  deps: GraphMockExecutorDependencies,
): () => void {
  const unregister = [
    registry.register(new GraphMockAgentExecutor(), { mock: true }),
    registry.register(new GraphMockSystemExecutor(deps), { mock: true }),
    registry.register(new GraphMockHumanExecutor(registry), { mock: true }),
  ];
  return () => {
    for (const remove of unregister) remove();
  };
}
