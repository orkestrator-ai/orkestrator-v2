import { parseGraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import { parseGraphMockPins } from "@orkestrator/protocol/graphs/mock";
import { isGraphRunId, type GraphRunBindings } from "@orkestrator/protocol/graphs/run";
import type { GraphScalarValue } from "@orkestrator/protocol/graphs/template";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import type { GraphMockRuns } from "./graph-mock-launch.js";
import { GraphRunServiceError } from "./graph-run-service.js";

/**
 * Mock runs (item 213, plan P2.13) and the effect journal of a run.
 *
 * `graph_run_mock` compiles a stored template and starts a mock run: no
 * provider sessions, no tokens, no side effects, no environment unless one
 * is named (`graph-mock-launch.ts`).
 *
 * `{ ref, projectId, environmentId?, inputs?, params?, roles?, pins?, panel?, stepMs? }`
 * → `GraphMockLaunchResult` (`{ run, pins, exampleInputs, placeholderRoles }`).
 *
 * `graph_run_effects { runId }` → `{ effects: GraphEffectRecord[] }`: what a
 * run's system nodes did (`intended`, `done`, `failed`) or, in a mock run,
 * would have done (`simulated`, data `{ wouldRun }`), oldest first, at most
 * {@link GRAPH_RUN_EFFECTS_LIMIT} (the newest). The run view's inspector
 * reads it (item 211).
 *
 * Refusals throw `GraphRunServiceError` (`invalid-launch`, `not-found`,
 * `disabled`) or, for the template, `GraphTemplateError` (`not-found`,
 * `engine-template`, `invalid-template`); the gateway forwards `code`.
 */

export const GRAPH_RUN_EFFECTS_LIMIT = 500;

function mockRuns(context: CommandContext): GraphMockRuns {
  if (!context.graphMock) throw new GraphRunServiceError("disabled", "Graph runs are unavailable");
  return context.graphMock;
}

function invalid(message: string): never {
  throw new GraphRunServiceError("invalid-launch", message);
}

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) invalid(`Unknown arguments: ${unknown.slice(0, 5).join(", ")}`);
}

function idArg(value: unknown, name: string, required: true): string;
function idArg(value: unknown, name: string, required: false): string | undefined;
function idArg(value: unknown, name: string, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) invalid(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    invalid(`${name} must be an id`);
  }
  return value;
}

function recordArg(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function integerArg(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value)) invalid(`${name} must be an integer`);
  return value as number;
}

function paramsArg(value: unknown): Record<string, GraphScalarValue> | undefined {
  const params = recordArg(value, "params");
  if (!params) return undefined;
  for (const [key, entry] of Object.entries(params)) {
    if (!["string", "number", "boolean"].includes(typeof entry)) {
      invalid(`params.${key} must be a string, number or boolean`);
    }
  }
  return params as Record<string, GraphScalarValue>;
}

export function registerGraphMockCommands(register: CommandRegistrar): void {
  register("graph_run_mock", async (args, context) => {
    onlyKeys(args, [
      "ref",
      "projectId",
      "environmentId",
      "inputs",
      "params",
      "roles",
      "pins",
      "panel",
      "stepMs",
    ]);
    const ref = parseGraphTemplateRef(args.ref);
    if ("error" in ref) invalid(ref.error);
    const projectId = idArg(args.projectId, "projectId", true);
    if (!(await context.storage.getProject(projectId))) {
      throw new GraphRunServiceError("not-found", "The project does not exist");
    }
    const environmentId = idArg(args.environmentId, "environmentId", false);
    if (environmentId !== undefined) {
      const environment = await context.storage.getEnvironment(environmentId);
      if (!environment || environment.projectId !== projectId) {
        throw new GraphRunServiceError(
          "not-found",
          "The environment does not exist in the project",
        );
      }
    }
    let pins;
    if (args.pins !== undefined && args.pins !== null) {
      const parsed = parseGraphMockPins(args.pins);
      if (!parsed.ok) invalid(`Invalid pins: ${parsed.errors.slice(0, 4).join("; ")}`);
      pins = parsed.pins;
    }
    const inputs = recordArg(args.inputs, "inputs");
    const params = paramsArg(args.params);
    const roles = recordArg(args.roles, "roles") as GraphRunBindings["roles"] | undefined;
    const panel = integerArg(args.panel, "panel");
    const stepMs = integerArg(args.stepMs, "stepMs");
    return mockRuns(context).launch({
      ref,
      projectId,
      ...(environmentId !== undefined ? { environmentId } : {}),
      ...(inputs ? { inputs } : {}),
      ...(params ? { params } : {}),
      ...(roles ? { roles } : {}),
      ...(pins ? { pins } : {}),
      ...(panel !== undefined ? { panel } : {}),
      ...(stepMs !== undefined ? { stepMs } : {}),
    });
  });

  register("graph_run_effects", async (args, context) => {
    onlyKeys(args, ["runId"]);
    const runId = args.runId;
    if (!isGraphRunId(runId)) invalid("runId must be a run id");
    if (!(await context.storage.graphRuns.getGraphRun(runId))) {
      throw new GraphRunServiceError("not-found", "The graph run does not exist");
    }
    const effects = await context.storage.graphEffects.listGraphEffects(runId);
    return { effects: effects.slice(-GRAPH_RUN_EFFECTS_LIMIT) };
  });
}
