/**
 * Pass-through node executors and a storage world for graph runtime tests
 * (items 202, 203), so passes run end to end before the real executors
 * (204–208) exist. Test-only.
 *
 * - `agent`: `start` reports `running`; `observe` completes with each output
 *   type's `example` (or stays running while the node or its branch is held).
 * - `system`: completes on `start` with examples.
 * - `gate`: evaluates its branches over the input values and forwards its
 *   inputs on the taken outlet (the real one is `graph-node-gate.ts`).
 * - `merge`: completes with an example of its output type (the real one is
 *   `graph-node-merge.ts`).
 * - `human`: waits (`awaiting-human`) until the test answers with an outlet.
 *
 * Every call is recorded (operation, node, key) with the concurrency it ran
 * at, so tests can check admission caps. `scripts` give a node's outputs per
 * iteration and branch (item 206's loop tests); `skipKinds` leaves kinds to
 * the real executors (the gate and merge of `graph-node-gate.ts` and
 * `graph-node-merge.ts`). An `items` branch's outputs record its item as
 * `sourceItem`, as the real agent executor does (item 401).
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compile,
  type CompiledGraphPlan,
  type GraphPlanNode,
} from "@orkestrator/protocol/graphs/compile";
import { evaluateGraphPredicate } from "@orkestrator/protocol/graphs/predicates";
import {
  graphActivationBranch,
  type GraphRun,
  type GraphRunBindings,
} from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { graphBuiltInType } from "@orkestrator/protocol/graphs/types";
import { GraphArtifactStore } from "./graph-artifacts.js";
import type {
  GraphActivationReport,
  GraphCancelReason,
  GraphExecutableNodeKind,
  GraphExecutorContext,
  GraphExecutorOperation,
  GraphNodeExecutor,
  GraphNodeExecutorRegistry,
} from "./graph-run-executors.js";
import { GraphRunService, type GraphRunServiceOptions } from "./graph-run-service.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import { StorageService } from "./storage.js";

export interface FakeExecutorCall {
  runId: string;
  operation: GraphExecutorOperation;
  kind: GraphExecutableNodeKind;
  nodeId: string;
  key: string;
  reason?: GraphCancelReason;
  /** The model the activation runs on (agents; the branch's for a replicated node). */
  binding?: { platform: string; model?: string };
  /** Calls in flight when this one started, this one included. */
  concurrent: number;
  /** In-flight calls of the same provider group when this one started. */
  concurrentInGroup: number;
}

/** A short, stable result key for a run's activation (result keys allow `[A-Za-z0-9_-]`). */
export function fakeResultKey(runId: string, activationKey: string): string {
  return `rk-${createHash("sha256").update(`${runId}\0${activationKey}`).digest("hex").slice(0, 16)}`;
}

/** The example value of a type reference, from the built-in library or the plan's own types. */
export function graphTypeExample(plan: CompiledGraphPlan, ref: string): unknown {
  const builtIn = graphBuiltInType(ref);
  if (builtIn) return structuredClone(builtIn.example);
  const custom = plan.types.find((type) => `${type.name}@${type.version}` === ref);
  return custom?.example === undefined ? undefined : structuredClone(custom.example);
}

/** What a script sees: one output port of one activation. */
export interface FakeScriptCall {
  port: string;
  iteration: number;
  branchKey?: string;
  attempt: number;
}

/** Pass-through executors for every node kind, with knobs for the tests. */
export class FakeGraphExecutors {
  readonly calls: FakeExecutorCall[] = [];
  /** Kinds `register` leaves out, for the real executors. */
  readonly skipKinds = new Set<GraphExecutableNodeKind>();
  /**
   * Node id → the value of an output port (undefined: the type's example;
   * `null`: the port is not produced).
   */
  readonly scripts = new Map<string, (call: FakeScriptCall) => unknown>();
  /** Node id → causes its next starts fail with, in order (one per start). */
  readonly failQueue = new Map<string, ("provider-error" | "invalid-result" | "timeout")[]>();
  /** `<node>/<branch key>` → causes that branch's next starts fail with, in order. */
  readonly failBranches = new Map<string, ("provider-error" | "invalid-result" | "timeout")[]>();
  /** Nodes whose agent activations stay running until released. */
  readonly held = new Set<string>();
  /** `<node>/<branch key>`: one branch of a replicated node stays running until released. */
  readonly heldBranches = new Set<string>();
  /** Node id → cause: the node's next start fails with it. */
  readonly failStart = new Map<string, "provider-error" | "invalid-result" | "timeout">();
  /** Activation key → outlet a person chose. */
  readonly answers = new Map<string, string>();
  /**
   * Agent starts report a session with one result key per output port
   * (`rk-<run and activation hash>-<port>`), and the compiled policy as applied.
   */
  withSessions = false;
  /** Started executor calls wait on this while set (to observe concurrency). */
  gate: Promise<void> | null = null;
  /** Agent activations still running (started, not completed or cancelled). */
  readonly running = new Set<string>();
  maxRunning = 0;
  private inFlight = 0;
  private readonly inFlightByGroup = new Map<string, number>();

  register(registry: GraphNodeExecutorRegistry, options: { mock?: boolean } = {}): void {
    for (const kind of ["agent", "system", "gate", "merge", "human"] as const) {
      if (this.skipKinds.has(kind)) continue;
      registry.register(this.executor(kind), options);
    }
  }

  callsOf(operation: GraphExecutorOperation, nodeId?: string): FakeExecutorCall[] {
    return this.calls.filter(
      (call) => call.operation === operation && (nodeId === undefined || call.nodeId === nodeId),
    );
  }

  private group(context: GraphExecutorContext): string {
    return context.binding?.platform ?? context.node.kind;
  }

  private async track<T>(
    context: GraphExecutorContext,
    operation: GraphExecutorOperation,
    work: () => Promise<T>,
    reason?: GraphCancelReason,
  ): Promise<T> {
    const group = this.group(context);
    this.inFlight += 1;
    this.inFlightByGroup.set(group, (this.inFlightByGroup.get(group) ?? 0) + 1);
    this.calls.push({
      runId: context.run.id,
      operation,
      kind: context.node.kind as GraphExecutableNodeKind,
      nodeId: context.node.id,
      key: context.activation.key,
      ...(reason ? { reason } : {}),
      ...(context.binding
        ? {
            binding: {
              platform: context.binding.platform,
              ...(context.binding.model !== undefined ? { model: context.binding.model } : {}),
            },
          }
        : {}),
      concurrent: this.inFlight,
      concurrentInGroup: this.inFlightByGroup.get(group)!,
    });
    try {
      if (this.gate) await this.gate;
      return await work();
    } finally {
      this.inFlight -= 1;
      this.inFlightByGroup.set(group, this.inFlightByGroup.get(group)! - 1);
    }
  }

  /** Stores an example artifact for every output port (named types only). */
  async outputs(context: GraphExecutorContext): Promise<Record<string, string>> {
    const outputs: Record<string, string> = {};
    const lineage = Object.values(context.activation.inputs).flat();
    // As the real agent executor does: an `items` branch's outputs stand for its item (item 401).
    const sourceItem = graphActivationBranch(context.run, context.node, context.activation)?.item
      ?.id;
    for (const port of context.node.outputs) {
      if (port.type.startsWith("list<") || port.name === "error") continue;
      const script = this.scripts.get(context.node.id);
      const scripted = script?.({
        port: port.name,
        iteration: context.activation.iteration,
        attempt: context.activation.attempt,
        ...(context.activation.branchKey !== undefined
          ? { branchKey: context.activation.branchKey }
          : {}),
      });
      if (scripted === null) continue;
      const value = scripted ?? graphTypeExample(context.run.plan, port.type);
      if (value === undefined) continue;
      const artifact = await context.artifacts.putValue({
        runId: context.run.id,
        type: port.type,
        producer: { nodeId: context.node.id, activation: context.activation.key, port: port.name },
        inputs: lineage,
        ...(port.choices ? { validation: { choices: port.choices } } : {}),
        ...(sourceItem !== undefined ? { sourceItem } : {}),
        value,
      });
      outputs[port.name] = artifact.id;
    }
    return outputs;
  }

  /** The activation's single-value inputs, forwarded on an outlet. */
  private forwarded(context: GraphExecutorContext): Record<string, string> {
    return Object.fromEntries(
      Object.entries(context.activation.inputs).flatMap(([port, ids]) =>
        Array.isArray(ids) ? [] : [[port, ids]],
      ),
    );
  }

  private async values(context: GraphExecutorContext): Promise<Record<string, unknown>> {
    const values: Record<string, unknown> = {};
    for (const [port, ids] of Object.entries(context.activation.inputs)) {
      const read = async (id: string) => {
        const artifact = await context.artifacts.requireVerified(context.run.id, id);
        return "value" in artifact.body ? artifact.body.value : undefined;
      };
      values[port] = Array.isArray(ids) ? await Promise.all(ids.map(read)) : await read(ids);
    }
    return values;
  }

  /** Whether the activation's node, or its branch, is held. */
  private isHeld(context: GraphExecutorContext): boolean {
    const { nodeId, branchKey } = context.activation;
    return (
      this.held.has(nodeId) ||
      (branchKey !== undefined && this.heldBranches.has(`${nodeId}/${branchKey}`))
    );
  }

  private async complete(context: GraphExecutorContext): Promise<GraphActivationReport> {
    const node = context.node;
    if (node.kind === "gate") {
      const values = await this.values(context);
      const taken =
        node.branches.find(
          (branch) =>
            evaluateGraphPredicate(branch.when, {
              values,
              params: context.run.bindings.params,
              run: { iteration: context.activation.iteration },
            }).value,
        )?.to ?? node.otherwise;
      // As the real gate: no branch and no `otherwise` takes no outlet.
      if (taken === undefined) return { state: "complete", outputs: {} };
      return { state: "complete", outlet: taken, outputs: this.forwarded(context) };
    }
    return { state: "complete", outputs: await this.outputs(context) };
  }

  private executor(kind: GraphExecutableNodeKind): GraphNodeExecutor {
    return {
      kind,
      start: (context) =>
        this.track(context, "start", async () => {
          const cause = this.failStart.get(context.node.id);
          if (cause) {
            this.failStart.delete(context.node.id);
            return { state: "failed", error: "The fake executor failed", cause };
          }
          const branchKey = context.activation.branchKey;
          const queued =
            (branchKey !== undefined
              ? this.failBranches.get(`${context.node.id}/${branchKey}`)?.shift()
              : undefined) ?? this.failQueue.get(context.node.id)?.shift();
          if (queued) return { state: "failed", error: "The fake executor failed", cause: queued };
          if (kind === "agent") {
            this.running.add(context.activation.key);
            this.maxRunning = Math.max(this.maxRunning, this.running.size);
            if (!this.withSessions || context.node.kind !== "agent") return { state: "running" };
            return {
              state: "running",
              policy: context.node.capabilities.policy,
              enforcement: "enforced",
              session: {
                agent: context.binding?.platform ?? "claude",
                requestId: `request-${fakeResultKey(context.run.id, context.activation.key)}`,
                dispatchState: "sent",
                resultTransport: "tool-call-v1",
                resultKeys: Object.fromEntries(
                  context.node.outputs.map((port) => [
                    port.name,
                    `${fakeResultKey(context.run.id, context.activation.key)}-${port.name}`,
                  ]),
                ),
              },
            };
          }
          if (kind === "human") return { state: "awaiting-human", observeAfterMs: null };
          return this.complete(context);
        }),
      observe: (context) =>
        this.track(context, "observe", async () => {
          if (kind === "human") {
            const outlet = this.answers.get(context.activation.key);
            if (outlet === undefined) return { state: "unchanged", observeAfterMs: null };
            return { state: "complete", outlet, outputs: this.forwarded(context) };
          }
          if (this.isHeld(context)) return { state: "unchanged" };
          this.running.delete(context.activation.key);
          return this.complete(context);
        }),
      recover: (context) =>
        this.track(context, "recover", async () => {
          if (context.activation.state === "admitting") {
            return { state: kind === "human" ? "awaiting-human" : "running" };
          }
          if (kind === "human" || this.isHeld(context)) return { state: "unchanged" };
          this.running.delete(context.activation.key);
          return this.complete(context);
        }),
      cancel: (context, reason) =>
        this.track(
          context,
          "cancel",
          async () => {
            this.running.delete(context.activation.key);
            return { state: "cancelled" };
          },
          reason,
        ),
    };
  }
}

/**
 * A read-only reviewer panel (`panel` role, up to 32 models) on the run's
 * target and a fan-in consolidator with no workspace access.
 */
export function graphFanOutTemplate(maxConcurrentAgents: number): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "fan-out",
    revision: 1,
    name: "Fan-out",
    parameters: [],
    roles: [
      { key: "worker", multiplicity: "one" },
      { key: "panel", multiplicity: "panel", maxPanel: 32 },
    ],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs: [
      { name: "report", type: "review-report@1", from: { node: "consolidate", port: "report" } },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "review",
        kind: "agent",
        role: "panel",
        replicate: { over: "panel", role: "panel" },
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { template: "Review.\n\n{{> input.code}}\n" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
      {
        id: "consolidate",
        kind: "agent",
        role: "worker",
        capabilities: { profile: "observer" },
        workspaceAccess: "none",
        prompt: { template: "Consolidate.\n\n{{> input.reports}}\n" },
        inputs: [{ name: "reports", type: "list<review-report@1>" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
    ],
    edges: [
      { id: "target-review", from: { input: "target" }, to: { node: "review", port: "code" } },
      {
        id: "review-consolidate",
        from: { node: "review", port: "report" },
        to: { node: "consolidate", port: "reports" },
      },
    ],
    limits: { maxAgentSessions: 40, maxConcurrentAgents },
  };
}

/** Compiles a template that must compile cleanly. */
export function compiledPlan(template: GraphTemplateV1): CompiledGraphPlan {
  const result = compile(template);
  if (!result.plan) {
    throw new Error(
      `The test template must compile: ${result.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => `${diagnostic.code} ${diagnostic.path ?? ""} ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return result.plan;
}

/** Every role of a plan bound to one model (panel roles to `panel` models). */
export function bindAllRoles(
  plan: CompiledGraphPlan,
  panel = 2,
  platforms: readonly ("claude" | "codex")[] = ["claude"],
): GraphRunBindings["roles"] {
  return Object.fromEntries(
    plan.roles.map((role) => [
      role.key,
      role.multiplicity === "panel"
        ? Array.from({ length: panel }, (_, index) => ({
            platform: platforms[index % platforms.length]!,
            model: `model-${index + 1}`,
          }))
        : { platform: platforms[0]!, model: "model" },
    ]),
  );
}

export interface GraphRunWorld {
  dataDir: string;
  storage: StorageService;
  artifacts: GraphArtifactStore;
  fakes: FakeGraphExecutors;
  service(options?: Partial<GraphRunServiceOptions>): GraphRunService;
  cleanup(): Promise<void>;
}

/** A temporary store with environments `e1` and `e2` in project `p1`. */
export async function graphRunWorld(dataDir?: string): Promise<GraphRunWorld> {
  const root = dataDir ?? (await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-runtime-")));
  const storage = new StorageService(root);
  await storage.init();
  if (!dataDir) {
    await storage.addEnvironment(graphEnvironmentFixture());
    await storage.addEnvironment(graphEnvironmentFixture({ id: "e2", order: 1 }));
  }
  const artifacts = new GraphArtifactStore({
    storage,
    fence: { beginMutation: () => () => undefined },
  });
  const fakes = new FakeGraphExecutors();
  const services: GraphRunService[] = [];
  return {
    dataDir: root,
    storage,
    artifacts,
    fakes,
    service(options = {}) {
      const service = new GraphRunService(storage, { artifacts, ...options });
      fakes.register(service.executors);
      services.push(service);
      return service;
    },
    async cleanup() {
      for (const service of services.splice(0)) await service.shutdown();
      storage.close();
      if (!dataDir) await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** The node of a run's plan by id. */
export function planNode(run: Pick<GraphRun, "plan">, id: string): GraphPlanNode {
  const node = run.plan.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}
