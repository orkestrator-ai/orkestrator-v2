import type { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { describe, list, str, strictObject, toolInput, type Infer } from "../tool-schema.js";
import { workflowStatusWakeResult } from "./review-actions.js";
import { isRecord, readAnnotations, toolResult } from "./tool-support.js";
import type { CoordinatorControlScope } from "./tools.js";
import type { ControlMcpInvoker } from "../control-shared-actions.js";

/**
 * Saved graph templates for the coordinator (item 214, D6): list them, read
 * one template's launch options, launch one, read and cancel the runs of
 * this project. There is deliberately no tool that creates, saves, edits,
 * duplicates, imports or describes a template — authoring stays with the
 * user in the designer; a test asserts no such tool exists.
 *
 * A launch reserves a durable `graph-run` workflow association before it
 * acts, so the conversation gets one status wake when the run ends and one
 * each time it waits for a person. Results are content-free.
 */

const AGENT_PLATFORM = Schema.Literals(["claude", "codex", "cursor", "grok", "opencode", "pi"]);

const modelBinding = strictObject({
  platform: AGENT_PLATFORM,
  model: Schema.optionalKey(str({ trim: true, min: 1, max: 256 })),
  reasoningEffort: Schema.optionalKey(str({ trim: true, min: 1, max: 256 })),
  fastMode: Schema.optionalKey(Schema.Boolean),
  lens: Schema.optionalKey(
    describe(
      strictObject({
        label: str({ trim: true, min: 1, max: 64 }),
        instruction: str({ trim: true, min: 1, max: 4096 }),
      }),
      "A panel member's review focus, copied into the run.",
    ),
  ),
});

const templateRef = describe(
  strictObject({
    scope: Schema.Literals(["builtin", "user", "project"]),
    id: Schema.optionalKey(
      describe(str({ trim: true, min: 1, max: 64 }), "builtin and user templates."),
    ),
    path: Schema.optionalKey(
      describe(
        str({ trim: true, min: 1, max: 300 }),
        "project templates: the file under .orkestrator/graphs/.",
      ),
    ),
  }),
  "The template, as list_graph_templates reports its ref.",
);

function refArgument(ref: Infer<typeof templateRef>, projectId: string): Record<string, unknown> {
  if (ref.scope === "project") return { scope: "project", projectId, path: ref.path };
  return { scope: ref.scope, id: ref.id };
}

/** Graph launch refusals carry a stable code; keep it in the tool's error text. */
async function coded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code =
      isRecord(error) && typeof error.code === "string" ? `${error.code}: ` : "graph-error: ";
    throw new Error(`${code}${error instanceof Error ? error.message : String(error)}`);
  }
}

export function registerCoordinatorGraphTools(
  server: McpServer,
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
): void {
  server.registerTool(
    "list_graph_templates",
    {
      title: "List saved graph templates",
      description:
        "List the graph templates this project can run (built-in, user and trusted project templates) with whether each is launchable. With ref, read that template's launch options instead: its roles (with the providers each may run on, their enforcement tier and why one is unavailable), parameters, inputs, environment default and cost estimate. Built-in templates run on their own engines and cannot be launched as graphs; untrusted project templates cannot be launched until the user approves them.",
      inputSchema: toolInput(
        Schema.Struct({
          ref: Schema.optionalKey(templateRef),
          environmentId: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 200 }),
              "With ref: judge the launch as on this existing environment.",
            ),
          ),
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ ref, environmentId }) =>
      coded(async () => {
        if (environmentId) await invoke("get_environment", { environmentId });
        const listed = await invoke<unknown>("list_coordinator_graph_templates", {
          scope,
          ...(ref ? { ref: refArgument(ref, scope.projectId) } : {}),
          ...(environmentId ? { environmentId } : {}),
        });
        if (!isRecord(listed)) throw new Error("Graph templates returned no result");
        return toolResult(listed);
      }),
  );

  server.registerTool(
    "launch_graph",
    {
      title: "Launch a saved graph",
      description:
        "Launch a saved graph template as a run, in a new worktree or container the run creates, or in an existing worker environment (one environment per run). Omit roles and params to use the defaults saved for this template, else the user's saved action defaults. Read list_graph_templates with ref first to see the roles, providers and inputs. ticket fills the template's ticket input from a Kanban ticket. You get one status wake when the run ends and one when it waits for a person; finish your turn instead of polling. You cannot create or edit templates.",
      inputSchema: toolInput(
        Schema.Struct({
          requestId: describe(
            str({ trim: true, min: 1, max: 256 }),
            "Idempotency key: retrying with it returns the same run.",
          ),
          template: templateRef,
          environment: strictObject({
            kind: Schema.Literals(["new", "existing"]),
            create: Schema.optionalKey(
              describe(
                Schema.Literals(["worktree", "container"]),
                "kind new: what the run creates.",
              ),
            ),
            environmentId: Schema.optionalKey(
              describe(
                str({ trim: true, min: 1, max: 200 }),
                "kind existing: a worker environment of this project.",
              ),
            ),
          }),
          roles: Schema.optionalKey(
            describe(
              Schema.Record(
                Schema.String,
                Schema.Union([modelBinding, list(modelBinding, { min: 1, max: 32 })]),
              ),
              "Optional per-role models: one binding, or a list for a panel role. Omitted roles keep their defaults.",
            ),
          ),
          params: Schema.optionalKey(
            describe(
              Schema.Record(
                Schema.String,
                Schema.Union([str({ max: 4096 }), Schema.Finite, Schema.Boolean, Schema.Null]),
              ),
              "Optional parameter values by key; omitted ones keep their defaults.",
            ),
          ),
          inputs: Schema.optionalKey(
            describe(
              Schema.Record(Schema.String, Schema.Unknown),
              "Run input values by name (value inputs only).",
            ),
          ),
          ticket: Schema.optionalKey(
            describe(
              strictObject({
                taskId: str({ trim: true, min: 1, max: 200 }),
                input: Schema.optionalKey(str({ trim: true, min: 1, max: 64 })),
              }),
              "A Kanban ticket of this project as the template's ticket input.",
            ),
          ),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ requestId, template, environment, roles, params, inputs, ticket }) =>
      coded(async () => {
        let launchEnvironment: Record<string, unknown>;
        if (environment.kind === "existing") {
          if (!environment.environmentId) {
            throw new Error("invalid-request: environment.environmentId is required for existing");
          }
          // The scoped invoker refuses another project's environment and the project home.
          await invoke("get_environment", { environmentId: environment.environmentId });
          launchEnvironment = { kind: "existing", environmentId: environment.environmentId };
        } else {
          if (!environment.create) {
            throw new Error("invalid-request: environment.create is required for new");
          }
          launchEnvironment = { kind: "new", create: environment.create };
        }
        const started = await invoke<unknown>("start_coordinator_graph_run", {
          scope,
          requestId,
          request: {
            ref: refArgument(template, scope.projectId),
            environment: launchEnvironment,
            ...(roles ? { roles } : {}),
            ...(params ? { params } : {}),
            ...(inputs ? { inputs } : {}),
            ...(ticket ? { ticket } : {}),
          },
        });
        if (!isRecord(started) || !isRecord(started.launch)) {
          throw new Error("Graph launch returned no result");
        }
        return toolResult({
          runId: started.launch.runId,
          launch: started.launch,
          ...(await workflowStatusWakeResult(invoke)),
        });
      }),
  );

  server.registerTool(
    "get_graph_run",
    {
      title: "Get a graph run",
      description:
        "Read a graph run of this project: status, usage, activation counts, the steps waiting for a person and the failed steps.",
      inputSchema: toolInput(Schema.Struct({ runId: str({ trim: true, min: 1, max: 128 }) })),
      annotations: readAnnotations(),
    },
    async ({ runId }) =>
      coded(async () => {
        const run = await invoke<unknown>("get_coordinator_graph_run", { scope, runId });
        if (!isRecord(run)) throw new Error("Graph run returned no result");
        return toolResult(run);
      }),
  );

  server.registerTool(
    "cancel_graph_run",
    {
      title: "Cancel a graph run",
      description:
        "Cancel a graph run of this project. Running steps are stopped; artifacts and the run record are kept.",
      inputSchema: toolInput(Schema.Struct({ runId: str({ trim: true, min: 1, max: 128 }) })),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) =>
      coded(async () => {
        const run = await invoke<unknown>("cancel_coordinator_graph_run", { scope, runId });
        if (!isRecord(run)) throw new Error("Graph run returned no result");
        return toolResult(run);
      }),
  );
}
