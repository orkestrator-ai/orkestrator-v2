import { parseGraphLaunchRequest } from "@orkestrator/protocol/graphs/launch";
import { parseGraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { GraphLaunchError, type GraphRunLaunchService } from "./graph-run-launch.js";

/**
 * Graph launches from the app (item 214; shapes in
 * `@orkestrator/protocol/graphs/launch`):
 *
 * - `graph_launch_options {ref, projectId, environmentId?, create?}` →
 *   `GraphLaunchOptions`, what the launch dialog shows;
 * - `graph_run_launch {ref, projectId, environment, roles?, params?, inputs?,
 *   ticket?, saveDefaults?, requestId?}` → `GraphLaunchResult`, launched as
 *   the user (`requestedBy: "user"`).
 *
 * A refusal throws a `GraphLaunchError` whose `code` the gateway forwards
 * (`GRAPH_LAUNCH_ERROR_CODES`). The CLI, the coordinator and schedules reach
 * the same service through their own surfaces.
 */

function launches(context: CommandContext): GraphRunLaunchService {
  if (!context.graphLaunches)
    throw new GraphLaunchError("disabled", "Graph launches are unavailable");
  return context.graphLaunches;
}

function invalid(message: string): never {
  throw new GraphLaunchError("invalid-request", message);
}

export function registerGraphLaunchCommands(register: CommandRegistrar): void {
  register("graph_launch_options", async (args, context) => {
    const unknown = Object.keys(args).filter(
      (key) => !["ref", "projectId", "environmentId", "create"].includes(key),
    );
    if (unknown.length > 0) invalid(`Unknown arguments: ${unknown.slice(0, 5).join(", ")}`);
    const ref = parseGraphTemplateRef(args.ref);
    if ("error" in ref) invalid(ref.error);
    if (typeof args.projectId !== "string" || !args.projectId || args.projectId.length > 200) {
      invalid("projectId must be a project id");
    }
    if (
      args.environmentId !== undefined &&
      args.environmentId !== null &&
      (typeof args.environmentId !== "string" || args.environmentId.length > 200)
    ) {
      invalid("environmentId must be an environment id");
    }
    if (args.create !== undefined && args.create !== "worktree" && args.create !== "container") {
      invalid("create must be worktree or container");
    }
    return launches(context).options({
      ref,
      projectId: args.projectId,
      ...(typeof args.environmentId === "string" && args.environmentId
        ? { environmentId: args.environmentId }
        : {}),
      ...(args.create ? { create: args.create as "worktree" | "container" } : {}),
    });
  });

  register("graph_run_launch", async (args, context) => {
    let request;
    try {
      request = parseGraphLaunchRequest(args);
    } catch (error) {
      invalid(error instanceof Error ? error.message : "Invalid launch request");
    }
    return launches(context).launch(request, { requestedBy: "user" });
  });
}
