import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  GraphDescribeError,
  parseGraphDescribeStartInput,
  type GraphDescribeService,
} from "./graph-describe-service.js";

/**
 * "Describe a graph" (item 215): the designer's own commands. They are not
 * public actions, so neither the CLI nor a Control MCP credential (the
 * coordinator, D6) can reach them.
 *
 * - `graph_describe_start {environmentId, description, agent, model?,
 *   reasoningEffort?, fastMode?, baseDraft?}` → the new job
 *   (`GraphDescribeJobView`); refused while the environment has one running.
 * - `graph_describe_status {environmentId}` → the latest job, or null.
 * - `graph_describe_cancel {environmentId}` → the job after cancelling.
 * - `graph_describe_dismiss {environmentId, jobId}` → `{dismissed}`.
 */

function service(context: CommandContext): GraphDescribeService {
  if (!context.graphDescribe) {
    throw new GraphDescribeError("unavailable", "Describe a graph is unavailable");
  }
  return context.graphDescribe;
}

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new GraphDescribeError(
      "invalid-request",
      `Unknown arguments: ${unknown.slice(0, 5).join(", ")}`,
    );
  }
}

function idArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new GraphDescribeError("invalid-request", `${name} is required`);
  }
  return value;
}

export function registerGraphDescribeCommands(register: CommandRegistrar): void {
  register("graph_describe_start", async (args, context) =>
    service(context).start(parseGraphDescribeStartInput(args)),
  );

  register("graph_describe_status", async (args, context) => {
    onlyKeys(args, ["environmentId"]);
    return service(context).status(idArg(args.environmentId, "environmentId"));
  });

  register("graph_describe_cancel", async (args, context) => {
    onlyKeys(args, ["environmentId"]);
    return service(context).cancel(idArg(args.environmentId, "environmentId"));
  });

  register("graph_describe_dismiss", async (args, context) => {
    onlyKeys(args, ["environmentId", "jobId"]);
    return {
      dismissed: service(context).dismiss(
        idArg(args.environmentId, "environmentId"),
        idArg(args.jobId, "jobId"),
      ),
    };
  });
}
