/**
 * Launching mock runs (item 213, plan P2.13; the designer's "Mock run" and
 * the `graph_run_mock` command).
 *
 * A mock launch compiles a stored template (the designer saves a draft
 * first) under the project's capability ceiling and starts a run with
 * `mock: true` on the same runtime as a real one. What it does not need:
 *
 * - **Providers.** Roles the caller does not bind are bound to placeholders
 *   (`claude`, model `mock`; a panel role to `panel` of them, default 2): no
 *   mock executor reads them, and nothing checks that a provider is set up.
 * - **An environment.** Without `environmentId` the run is
 *   environment-less: it never provisions one (even for a template whose
 *   workspace asks for a new one) and runs at once. With one, the run is
 *   listed with that environment and removed with it, and still never
 *   touches it (and holds none of its workspace locks).
 * - **Run inputs.** Missing ones take their type's example.
 * - **Trust and acknowledgements.** A mock run has no session and no side
 *   effect, so an untrusted project template can be tried before it is
 *   approved, and pending taint acknowledgements do not stop it. A template
 *   with compile errors cannot run, and a built-in (`engine`) runs on its own
 *   engine (D5): duplicate it first, as for a real launch.
 *
 * Pins: the template's `mockPins`, replaced node by node by the launch's
 * `pins`, checked against the plan's port types (`graphMockPinIssues`) and
 * frozen on the run (`mockOptions`). A `pause` pin needs a live human
 * executor (item 208).
 *
 * Retention: environment-less runs are not removed by environment deletion,
 * so each launch keeps the newest {@link GRAPH_MOCK_RUNS_RETAINED} finished
 * environment-less mock runs of the project and deletes older ones (one
 * store scan per launch, never per pass); a deleted project's are cancelled
 * and deleted, and orphans are swept at startup.
 */
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import type { GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import {
  GRAPH_MOCK_PIN_BOUNDS,
  graphMockPinIssues,
  graphMockPinTargetFromPlan,
  mergeGraphMockPins,
  type GraphMockPins,
  type GraphMockRunOptions,
} from "@orkestrator/protocol/graphs/mock";
import {
  isGraphRunTerminal,
  type GraphModelBinding,
  type GraphRun,
  type GraphRunBindings,
  type GraphRunTemplateRef,
} from "@orkestrator/protocol/graphs/run";
import type { GraphScalarValue } from "@orkestrator/protocol/graphs/template";
import { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";
import { graphMockValue } from "@orkestrator/protocol/graphs/mock";
import { GraphRunServiceError, type GraphRunService } from "./graph-run-service.js";
import { GraphTemplateError } from "./graph-template-errors.js";
import type { GraphTemplateService } from "./graph-template-service.js";
import type { ResourceChangeListener } from "./storage-shared.js";
import type { GraphRunsStorage } from "./storage-graph-runs.js";

/** Finished environment-less mock runs kept per project. */
export const GRAPH_MOCK_RUNS_RETAINED = 20;
/** Placeholder models per panel role, unless the launch says otherwise. */
export const GRAPH_MOCK_DEFAULT_PANEL = 2;
/** The placeholder every unbound role gets. */
export const GRAPH_MOCK_PLACEHOLDER_BINDING: GraphModelBinding = Object.freeze({
  platform: "claude",
  model: "mock",
});

export interface GraphMockLaunchInput {
  ref: GraphTemplateRef;
  projectId: string;
  /** Lists the run with an environment it never touches; default none. */
  environmentId?: string;
  /** Run inputs; missing ones take their type's example. */
  inputs?: Record<string, unknown>;
  params?: Record<string, GraphScalarValue>;
  /** Role bindings to show on the run; missing roles get placeholders. */
  roles?: GraphRunBindings["roles"];
  /** Pins replacing the template's, node by node. */
  pins?: GraphMockPins;
  /** Placeholder models per unbound panel role (1–32; default 2, at most the role's `maxPanel`). */
  panel?: number;
  /** Each activation appears to run this long (0–10,000 ms). */
  stepMs?: number;
}

/** What `graph_run_mock` returns: the run without its frozen plan. */
export interface GraphMockRunSummary {
  id: string;
  projectId: string;
  environmentId?: string;
  status: GraphRun["status"];
  mock: true;
  template: GraphRunTemplateRef;
  createdAt: string;
}

export interface GraphMockLaunchResult {
  run: GraphMockRunSummary;
  /** The effective pins frozen on the run. */
  pins: GraphMockPins | null;
  /** Run inputs that took their type's example. */
  exampleInputs: string[];
  /** Roles bound to placeholders. */
  placeholderRoles: string[];
}

export interface GraphMockRunsDependencies {
  templates: Pick<GraphTemplateService, "compile" | "get">;
  runs: Pick<GraphRunService, "create" | "cancel" | "executors" | "enabled">;
  storage: {
    graphRuns: Pick<GraphRunsStorage, "listAllGraphRuns" | "deleteEnvironmentlessGraphRun">;
    getProject(projectId: string): Promise<unknown>;
    addResourceChangeListener?(listener: ResourceChangeListener): () => void;
  };
  retained?: number;
}

function invalid(message: string): never {
  throw new GraphRunServiceError("invalid-launch", message);
}

const LIBRARY_TO_RUN_SCOPE = { builtin: "built-in", user: "user", project: "project" } as const;

export function graphMockRunSummary(run: GraphRun): GraphMockRunSummary {
  return {
    id: run.id,
    projectId: run.projectId,
    ...(run.environmentId !== undefined ? { environmentId: run.environmentId } : {}),
    status: run.status,
    mock: true,
    template: { ...run.template },
    createdAt: run.createdAt,
  };
}

/** Every unbound role bound to a placeholder (a panel role to `panel` of them). */
export function graphMockRoles(
  plan: CompiledGraphPlan,
  given: GraphRunBindings["roles"] = {},
  panel = GRAPH_MOCK_DEFAULT_PANEL,
): { roles: GraphRunBindings["roles"]; placeholders: string[] } {
  const roles: GraphRunBindings["roles"] = {};
  const placeholders: string[] = [];
  for (const role of plan.roles) {
    if (given[role.key] !== undefined) {
      roles[role.key] = structuredClone(given[role.key]!);
      continue;
    }
    placeholders.push(role.key);
    if (role.multiplicity === "panel") {
      const size = Math.max(1, Math.min(panel, role.maxPanel ?? panel));
      roles[role.key] = Array.from({ length: size }, () => ({ ...GRAPH_MOCK_PLACEHOLDER_BINDING }));
    } else {
      roles[role.key] = { ...GRAPH_MOCK_PLACEHOLDER_BINDING };
    }
  }
  return { roles, placeholders };
}

/** Run inputs with every missing one filled from its type's example. */
export function graphMockInputs(
  plan: CompiledGraphPlan,
  given: Record<string, unknown> = {},
): { inputs: Record<string, unknown>; examples: string[] } {
  const library = new GraphTypeLibrary(plan.types);
  const inputs: Record<string, unknown> = { ...given };
  const examples: string[] = [];
  for (const input of plan.inputs) {
    if (input.name in inputs) continue;
    const resolved = library.resolve(input.type);
    if (!resolved.ok || resolved.type.kind !== "named") continue;
    inputs[input.name] = graphMockValue(resolved.type.definition, "example").value;
    examples.push(input.name);
  }
  return { inputs, examples };
}

export class GraphMockRuns {
  private readonly retained: number;
  private readonly stopListening: () => void;

  constructor(private readonly deps: GraphMockRunsDependencies) {
    this.retained = deps.retained ?? GRAPH_MOCK_RUNS_RETAINED;
    this.stopListening =
      deps.storage.addResourceChangeListener?.((change) => {
        if (change.resource === "project" && change.deleted) {
          void this.forgetProject(change.id).catch(() => undefined);
        }
      }) ?? (() => undefined);
  }

  dispose(): void {
    this.stopListening();
  }

  /** Compiles the stored template and starts a mock run (see the module comment). */
  async launch(input: GraphMockLaunchInput): Promise<GraphMockLaunchResult> {
    if (!this.deps.runs.enabled) {
      throw new GraphRunServiceError(
        "disabled",
        "Graph runs are disabled (ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK)",
      );
    }
    if (
      input.panel !== undefined &&
      (!Number.isSafeInteger(input.panel) || input.panel < 1 || input.panel > 32)
    ) {
      invalid("panel must be an integer from 1 to 32");
    }
    if (
      input.stepMs !== undefined &&
      (!Number.isSafeInteger(input.stepMs) ||
        input.stepMs < 0 ||
        input.stepMs > GRAPH_MOCK_PIN_BOUNDS.maxStepMs)
    ) {
      invalid(`stepMs must be an integer from 0 to ${GRAPH_MOCK_PIN_BOUNDS.maxStepMs}`);
    }
    const compiled = await this.deps.templates.compile(
      { ref: input.ref },
      { projectId: input.projectId, includePlan: true },
    );
    const summary = compiled.summary;
    if (summary?.engine !== undefined) {
      throw new GraphTemplateError(
        "engine-template",
        "A built-in template runs on its own engine; duplicate it to mock a copy as a graph",
      );
    }
    const plan = compiled.plan ?? null;
    if (!plan || !summary) {
      const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      throw new GraphTemplateError(
        "invalid-template",
        `The template does not compile (${errors.length} error${errors.length === 1 ? "" : "s"}${
          errors[0] ? `, first ${errors[0].code}` : ""
        }); fix it before a mock run`,
      );
    }
    const detail = await this.deps.templates.get(input.ref, { projectId: input.projectId });
    const pins = mergeGraphMockPins(detail.template.mockPins, input.pins);
    const issues = graphMockPinIssues(graphMockPinTargetFromPlan(plan), pins);
    if (issues.length > 0) {
      invalid(
        `Mock pins do not fit the graph: ${issues
          .slice(0, 4)
          .map(
            (issue) =>
              `${issue.nodeId}${issue.index !== undefined ? `[${issue.index}]` : ""}: ${issue.message}`,
          )
          .join("; ")}`,
      );
    }
    if (
      pins &&
      Object.values(pins).some((sequence) => sequence.includes("pause")) &&
      !this.deps.runs.executors.resolve("human")
    ) {
      invalid("A pause pin waits for a person, and this backend cannot run human nodes");
    }
    const { roles, placeholders } = graphMockRoles(plan, input.roles, input.panel);
    const { inputs, examples } = graphMockInputs(plan, input.inputs);
    const mockOptions: GraphMockRunOptions = {
      ...(pins ? { pins } : {}),
      ...(input.stepMs ? { stepMs: input.stepMs } : {}),
    };
    const run = await this.deps.runs.create({
      projectId: input.projectId,
      ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
      template: {
        id: plan.template.id,
        revision: plan.template.revision,
        digest: plan.templateDigest,
        scope: LIBRARY_TO_RUN_SCOPE[summary.scope],
      },
      plan,
      roles,
      ...(input.params ? { params: input.params } : {}),
      inputs,
      mock: true,
      ...(Object.keys(mockOptions).length > 0 ? { mockOptions } : {}),
    });
    if (input.environmentId === undefined) {
      await this.prune(input.projectId).catch(() => 0);
    }
    return {
      run: graphMockRunSummary(run),
      pins: pins ?? null,
      exampleInputs: examples,
      placeholderRoles: placeholders,
    };
  }

  /** The project's environment-less mock runs, newest first. */
  private async environmentless(projectId?: string): Promise<GraphRun[]> {
    const runs = await this.deps.storage.graphRuns.listAllGraphRuns();
    return runs
      .filter(
        (run) =>
          run.mock &&
          run.environmentId === undefined &&
          (projectId === undefined || run.projectId === projectId),
      )
      .reverse();
  }

  /** Deletes the project's finished environment-less mock runs beyond the newest kept. */
  async prune(projectId: string): Promise<number> {
    const finished = (await this.environmentless(projectId)).filter((run) =>
      isGraphRunTerminal(run.status),
    );
    let removed = 0;
    for (const run of finished.slice(this.retained)) {
      if (await this.deps.storage.graphRuns.deleteEnvironmentlessGraphRun(run.id)) removed++;
    }
    return removed;
  }

  /**
   * Startup sweep: deletes finished environment-less mock runs whose project
   * no longer exists, and cancels unfinished ones (the next sweep or the
   * project listener removes them).
   */
  async sweepOrphans(): Promise<number> {
    const projects = new Map<string, boolean>();
    let removed = 0;
    for (const run of await this.environmentless()) {
      if (!projects.has(run.projectId)) {
        projects.set(run.projectId, (await this.deps.storage.getProject(run.projectId)) !== null);
      }
      if (projects.get(run.projectId)) continue;
      removed += await this.removeOrCancel(run);
    }
    return removed;
  }

  private async forgetProject(projectId: string): Promise<void> {
    for (const run of await this.environmentless(projectId)) await this.removeOrCancel(run);
  }

  private async removeOrCancel(run: GraphRun): Promise<number> {
    if (isGraphRunTerminal(run.status)) {
      return (await this.deps.storage.graphRuns.deleteEnvironmentlessGraphRun(run.id)) ? 1 : 0;
    }
    await this.deps.runs.cancel(run.id).catch(() => undefined);
    return 0;
  }
}
