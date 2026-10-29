/**
 * "Describe a graph" (plan P2.15, report §7.1 point 2, D1, D6).
 *
 * The user describes a graph in words; a designer agent submits a
 * `graph-template` workflow result whose contract is the template itself.
 * This module holds what the browser and the backend share:
 *
 * - {@link graphTemplateJsonSchema}: the template as a provider-facing JSON
 *   schema. It is a *tool-transport* schema. The template cannot be expressed
 *   in the strict structured-output subset (`schema-subset.ts`): most fields
 *   are optional, predicates nest recursively, and custom type schemas and
 *   system parameters are open objects. So the schema guides the model (every
 *   field, its enum values, the required ones) and stays portable (no `$ref`,
 *   bounded depth), while the authority is {@link graphTemplateResultIssues}.
 * - {@link graphTemplateResultIssues}: the template guard (101), the two
 *   authoring rules below, and the compiler's errors (107) as workflow result
 *   issues. A rejected submission hands them back to the agent, which
 *   corrects the draft through the existing repair loop.
 * - The job record the web renders ({@link GraphDescribeJobView}).
 *
 * Authoring rules beyond the compiler: a drafted template never carries
 * `acknowledgements` (only the user accepts a warning, D4) and never names a
 * built-in `engine`. The draft opens in the designer unsaved; it cannot run
 * until the user saves it. The coordinator has no route to any of this (D6).
 * Browser-safe.
 */
import { AGENT_PLATFORMS, type AgentPlatform } from "../agent-platforms.js";
import { ARTIFACT_STORAGE_CLASSES } from "./artifact-type-def.js";
import type { JsonSchema } from "../structured-output.js";
import type { WorkflowResultValidationIssue } from "../workflow-results.js";
import {
  type GraphCapabilityCeiling,
  graphCapabilityCeilingIssues,
} from "./capability-profiles.js";
import { compile, type GraphCompileDiagnostic } from "./compile.js";
import {
  GRAPH_CAPABILITY_PROFILES,
  GRAPH_COLLECT_WAITS,
  GRAPH_EDGE_TRANSFORM_OPS,
  GRAPH_ENFORCEMENT_TIERS,
  GRAPH_ENVIRONMENT_KINDS,
  GRAPH_FAILURE_POLICIES,
  GRAPH_HUMAN_FORMS,
  GRAPH_MERGE_STRATEGIES,
  GRAPH_PARAMETER_TYPES,
  GRAPH_PROVENANCE_MODES,
  GRAPH_RENDER_MODES,
  GRAPH_ITEMS_TRUNCATE,
  GRAPH_RETRY_CAUSES,
  GRAPH_ROLE_DEFAULT_ACTION_KEYS,
  GRAPH_ROLE_MULTIPLICITIES,
  GRAPH_ROLE_PANEL_DEFAULT_SOURCES,
  GRAPH_SYSTEM_ACTIONS,
  GRAPH_TEMPLATE_FORMAT,
  GRAPH_TEMPLATE_FORMAT_VERSION,
  GRAPH_VOTE_TIE_POLICIES,
  GRAPH_WORKSPACE_ACCESS,
  type GraphTemplateV1,
} from "./template-model.js";
import { validateGraphTemplate } from "./template.js";

export const GRAPH_TEMPLATE_RESULT_KIND = "graph-template" as const;

export const GRAPH_DESCRIBE_BOUNDS = Object.freeze({
  /** The user's description, in UTF-16 code units. */
  maxDescriptionChars: 8_000,
  /** The draft to modify, serialized; larger drafts are refused rather than truncated. */
  maxBaseDraftBytes: 64 * 1024,
  /** The report §9 examples the prompt quotes, serialized. */
  maxExampleBytes: 16 * 1024,
  /** Issues one rejected submission reports (the workflow result cap). */
  maxIssues: 32,
  /** A stored failure message. */
  maxErrorChars: 2_000,
});

// --------------------------------------------------------------- context

/**
 * The trusted context of a `graph-template` slot: what the draft is compiled
 * against (the user's enabled providers and the project's ceiling, D18), so
 * an accepted draft compiles in the designer too.
 */
export interface GraphTemplateResultContext {
  type: "graph-template";
  /** Enabled agent platforms; empty means every platform. */
  providers: AgentPlatform[];
  ceiling?: GraphCapabilityCeiling;
}

/** Why a stored context is unusable, or null. */
export function graphTemplateResultContextProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Expected an object";
  const record = value as Record<string, unknown>;
  if (record.type !== "graph-template") return "Expected type graph-template";
  for (const key of Object.keys(record)) {
    if (key !== "type" && key !== "providers" && key !== "ceiling") return `Unknown field ${key}`;
  }
  if (
    !Array.isArray(record.providers) ||
    record.providers.length > AGENT_PLATFORMS.length ||
    !record.providers.every((entry) => (AGENT_PLATFORMS as readonly unknown[]).includes(entry))
  ) {
    return "providers must list agent platforms";
  }
  if (record.ceiling !== undefined && graphCapabilityCeilingIssues(record.ceiling).length > 0) {
    return "ceiling is not a capability ceiling";
  }
  return null;
}

// ---------------------------------------------------------------- issues

function issue(path: string, code: string, message: string): WorkflowResultValidationIssue {
  return { path: path.slice(0, 256), code: code.slice(0, 128), message: message.slice(0, 512) };
}

function resultPath(path: string | undefined): string {
  if (!path || path === "$") return "$";
  return path.startsWith("$") ? path : `$.${path}`;
}

/** Where a diagnostic points, in words the agent can act on. */
function diagnosticWhere(diagnostic: GraphCompileDiagnostic): string {
  const parts: string[] = [];
  const add = (label: string, id: string | undefined) => {
    // Most messages already name what they are about.
    if (id && !diagnostic.message.includes(id)) parts.push(`${label} ${id}`);
  };
  add("node", diagnostic.nodeId);
  add("edge", diagnostic.edgeId);
  add("loop", diagnostic.loopId);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** One compiler error as a result issue: the code, the path and the message. */
export function graphCompileDiagnosticIssue(
  diagnostic: GraphCompileDiagnostic,
): WorkflowResultValidationIssue {
  return issue(
    resultPath(diagnostic.path),
    diagnostic.code,
    `${diagnostic.message}${diagnosticWhere(diagnostic)}`,
  );
}

/**
 * Everything wrong with a drafted template, as workflow result issues, at
 * most {@link GRAPH_DESCRIBE_BOUNDS.maxIssues}: the template guard's errors;
 * else the authoring rules and the compiler's errors under `context`.
 * Warnings are left for the user (the designer shows them, and taint warnings
 * wait for the user's acknowledgement). Empty: the draft compiles.
 */
export function graphTemplateResultIssues(
  value: unknown,
  context?: GraphTemplateResultContext,
): WorkflowResultValidationIssue[] {
  const max = GRAPH_DESCRIBE_BOUNDS.maxIssues;
  const guard = validateGraphTemplate(value);
  if (!guard.ok) {
    return guard.errors
      .slice(0, max)
      .map((error) => issue(resultPath(error.path), error.code, error.message));
  }
  const template = guard.value;
  const issues: WorkflowResultValidationIssue[] = [];
  if (template.acknowledgements !== undefined) {
    issues.push(
      issue(
        "$.acknowledgements",
        "acknowledgement-not-allowed",
        "Leave acknowledgements out: only the user accepts a warning, in the designer.",
      ),
    );
  }
  if (template.engine !== undefined) {
    issues.push(
      issue(
        "$.engine",
        "engine-not-allowed",
        "Leave engine out: it marks the built-in templates that run on their own engine.",
      ),
    );
  }
  const result = compile(template, {
    ...(context && context.providers.length > 0 ? { providers: context.providers } : {}),
    ...(context?.ceiling ? { ceiling: context.ceiling } : {}),
  });
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity !== "error") continue;
    if (issues.length >= max) break;
    issues.push(graphCompileDiagnosticIssue(diagnostic));
  }
  return issues;
}

// ---------------------------------------------------------------- schema

type Schema = Record<string, unknown>;

const text = (description?: string): Schema => ({
  type: "string",
  ...(description ? { description } : {}),
});
const integer = (description?: string): Schema => ({
  type: "integer",
  ...(description ? { description } : {}),
});
const boolean = (description?: string): Schema => ({
  type: "boolean",
  ...(description ? { description } : {}),
});
const choice = (values: readonly string[], description?: string): Schema => ({
  type: "string",
  enum: [...values],
  ...(description ? { description } : {}),
});
const list = (items: Schema, description?: string): Schema => ({
  type: "array",
  items,
  ...(description ? { description } : {}),
});
/** A free-form object the validator checks (predicates, type schemas, params, layout). */
const open = (description: string): Schema => ({ type: "object", description });
const scalar = (description?: string): Schema => ({
  anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
  ...(description ? { description } : {}),
});
function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}

const PREDICATE =
  "Predicate: {path, op, value} with op eq|neq|lt|lte|gt|gte|in; {path, op: exists|empty|nonEmpty}; {path, op: count, compare, value}; or {all: [...]}, {any: [...]}, {not: {...}}.";

function predicate(): Schema {
  return open(PREDICATE);
}

function portRef(withInput: boolean): Schema {
  return object(
    {
      node: text(),
      port: text(),
      outlet: text("A gate or human outlet; the port is then one of that node's inputs."),
      ...(withInput ? { input: text("A run input name, instead of node and port.") } : {}),
    },
    [],
  );
}

function inputPort(): Schema {
  return object(
    {
      name: text(),
      type: text("name@major, or list<name@major> for fan-in"),
      label: text(),
      description: text(),
      required: boolean(),
      render: choice(GRAPH_RENDER_MODES),
      collect: object(
        {
          wait: choice(GRAPH_COLLECT_WAITS),
          count: integer(),
          minSuccessful: integer(),
          includeFailures: boolean(),
        },
        ["wait", "minSuccessful", "includeFailures"],
      ),
      firstIterationFrom: portRef(true),
    },
    ["name", "type"],
  );
}

function outputPort(): Schema {
  return object(
    {
      name: text("The result tool is submit_<name>."),
      type: text("name@major"),
      label: text(),
      description: text(),
      required: boolean(),
      provenance: choice(GRAPH_PROVENANCE_MODES),
      choices: list(text(), "decision@1 outputs: the allowed choices."),
    },
    ["name", "type"],
  );
}

function lens(): Schema {
  return object({ key: text(), label: text(), instruction: text(), role: text() }, [
    "key",
    "label",
    "instruction",
  ]);
}

function replicateAxis(withCross: boolean): Schema {
  return object(
    {
      over: choice(
        withCross
          ? ["panel", "lenses", "items", "samples", "cross"]
          : ["panel", "lenses", "items", "samples"],
      ),
      role: text("panel: the panel role."),
      lenses: list(lens()),
      input: text("items: the input port (list<T>, or a type with items) to fan out over."),
      maxBranches: integer("items: the most branches; items beyond it are truncated."),
      truncate: choice(GRAPH_ITEMS_TRUNCATE, "items: run the first maxBranches, or fail."),
      count: integer("samples: how many."),
      ...(withCross ? { axes: list(replicateAxis(false), "cross: the combined axes.") } : {}),
    },
    ["over"],
  );
}

function node(): Schema {
  return object(
    {
      id: text("kebab-case, unique"),
      // Sub-graphs (item 402) are not compiled yet, so the contract does not
      // offer them.
      kind: choice(["agent", "system", "gate", "merge", "human"]),
      label: text(),
      description: text(),
      inputs: list(inputPort()),
      outputs: list(outputPort(), "Not on gate and human nodes."),
      when: predicate(),
      retry: object({ attempts: integer(), on: list(choice(GRAPH_RETRY_CAUSES)) }, [
        "attempts",
        "on",
      ]),
      timeoutMs: integer(),
      onFailure: choice(GRAPH_FAILURE_POLICIES),
      role: text("agent: a role key."),
      prompt: object(
        {
          builtIn: text("A built-in prompt id."),
          template: text("A prompt template."),
        },
        [],
      ),
      capabilities: object(
        {
          profile: choice(GRAPH_CAPABILITY_PROFILES),
          allow: list(text()),
          deny: list(text()),
        },
        ["profile"],
      ),
      workspaceAccess: choice(GRAPH_WORKSPACE_ACCESS),
      minEnforcement: choice(GRAPH_ENFORCEMENT_TIERS),
      session: object({ mode: choice(["fresh", "continue"]), from: text() }, ["mode"]),
      replicate: replicateAxis(true),
      askHuman: boolean(),
      action: choice(GRAPH_SYSTEM_ACTIONS, "system: the action."),
      params: open("system: parameter key to a string, number, boolean or a list of those."),
      branches: list(
        object({ to: text("The outlet."), when: predicate(), label: text() }, ["to", "when"]),
        "gate: tried in order.",
      ),
      otherwise: text("gate: the outlet when no branch holds."),
      strategy: object(
        {
          kind: choice(GRAPH_MERGE_STRATEGIES),
          key: list(text(), "dedupe: field paths."),
          tie: choice(GRAPH_VOTE_TIE_POLICIES),
          path: text(),
          score: text(),
          prefer: choice(["highest", "lowest"]),
        },
        ["kind"],
      ),
      form: object(
        {
          kind: choice(GRAPH_HUMAN_FORMS),
          edit: text("edit: the input the user may edit."),
          instructions: text(),
          options: list(
            object({ to: text(), label: text(), description: text() }, ["to", "label"]),
          ),
        },
        ["kind"],
      ),
    },
    ["id", "kind"],
  );
}

function parameter(): Schema {
  return object(
    {
      key: text(),
      type: choice(GRAPH_PARAMETER_TYPES),
      label: text(),
      description: text(),
      default: scalar(),
      min: { type: "number" },
      max: { type: "number" },
      maxBytes: integer(),
      options: list(text(), "enum parameters."),
    },
    ["key", "type"],
  );
}

function role(): Schema {
  return object(
    {
      key: text(),
      label: text(),
      description: text(),
      multiplicity: choice(GRAPH_ROLE_MULTIPLICITIES),
      maxPanel: integer(),
      defaultsFrom: list(
        choice([...GRAPH_ROLE_DEFAULT_ACTION_KEYS, ...GRAPH_ROLE_PANEL_DEFAULT_SOURCES]),
      ),
    },
    ["key", "multiplicity"],
  );
}

function customType(): Schema {
  return object(
    {
      name: text("kebab-case; not a built-in type name"),
      version: integer(),
      label: text(),
      description: text(),
      schema: open("A JSON schema in the cross-provider subset."),
      storage: choice(ARTIFACT_STORAGE_CLASSES),
      budgets: object({ maxBytes: integer(), maxStringBytes: integer(), maxItems: integer() }, [
        "maxBytes",
      ]),
      items: object({ path: text(), idPrefix: text() }, ["path", "idPrefix"]),
      sharedFields: list(text()),
      render: object({ markdown: text(), summary: list(text()) }, []),
      example: open("A sample value that fits the schema."),
    },
    ["name", "version", "schema", "storage", "budgets"],
  );
}

function edge(): Schema {
  return object(
    {
      id: text(),
      from: portRef(true),
      to: object({ node: text(), port: text() }, ["node", "port"]),
      transform: list(
        object(
          {
            op: choice(GRAPH_EDGE_TRANSFORM_OPS),
            fields: list(text()),
            where: predicate(),
            count: integer(),
            path: text(),
            adapter: text(),
          },
          ["op"],
        ),
      ),
      zip: boolean(),
    },
    ["id", "from", "to"],
  );
}

function loop(): Schema {
  return object(
    {
      id: text(),
      label: text(),
      nodes: list(text()),
      until: predicate(),
      maxIterations: integer(),
      carry: list(
        object(
          { from: portRef(false), to: object({ node: text(), port: text() }, ["node", "port"]) },
          ["from", "to"],
        ),
      ),
    },
    ["id", "nodes", "until", "maxIterations", "carry"],
  );
}

let cachedSchema: JsonSchema | undefined;

/**
 * `GraphTemplateV1` as a portable tool-input schema (see the module comment):
 * no `$ref`, no recursion, open objects where the template nests freely.
 * `acknowledgements` and `engine` are not offered (authoring rules).
 */
export function graphTemplateJsonSchema(): JsonSchema {
  cachedSchema ??= Object.freeze(
    object(
      {
        format: choice([GRAPH_TEMPLATE_FORMAT]),
        formatVersion: { type: "integer", enum: [GRAPH_TEMPLATE_FORMAT_VERSION] },
        id: text("kebab-case slug"),
        revision: integer("0 for a draft"),
        name: text(),
        description: text(),
        parameters: list(parameter()),
        roles: list(role()),
        types: list(customType()),
        inputs: list(
          object(
            {
              name: text(),
              type: text(),
              label: text(),
              description: text(),
              required: boolean(),
            },
            ["name", "type"],
          ),
        ),
        outputs: list(
          object(
            {
              name: text(),
              type: text(),
              label: text(),
              description: text(),
              required: boolean(),
              from: portRef(false),
            },
            ["name", "type", "from"],
          ),
        ),
        workspace: object(
          {
            kind: choice(["environment", "none"]),
            create: object({ kind: choice(GRAPH_ENVIRONMENT_KINDS) }, ["kind"]),
          },
          ["kind"],
        ),
        nodes: list(node()),
        edges: list(edge()),
        loops: list(loop()),
        limits: object(
          {
            maxAgentSessions: integer(),
            maxConcurrentAgents: integer(),
            maxTokens: integer(),
            maxWallClockMs: integer(),
          },
          ["maxAgentSessions", "maxConcurrentAgents"],
        ),
        layout: open("Designer positions by node id: {x, y}. Optional."),
      },
      [
        "format",
        "formatVersion",
        "id",
        "revision",
        "name",
        "parameters",
        "roles",
        "inputs",
        "workspace",
        "nodes",
        "edges",
        "limits",
      ],
    ),
  ) as JsonSchema;
  return cachedSchema;
}

// ------------------------------------------------------------------- jobs

export const GRAPH_DESCRIBE_JOB_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type GraphDescribeJobStatus = (typeof GRAPH_DESCRIBE_JOB_STATUSES)[number];

/**
 * What a running job is doing, for the progress line: starting the session,
 * the agent drafting, the agent correcting a draft the compiler refused, or
 * a draft received and being finished.
 */
export type GraphDescribeProgress = "starting" | "drafting" | "correcting" | "finishing";

/** One describe job as the web sees it (no session or result internals). */
export interface GraphDescribeJobView {
  id: string;
  environmentId: string;
  projectId: string;
  status: GraphDescribeJobStatus;
  /** Running jobs only. */
  progress?: GraphDescribeProgress;
  /** Drafts the backend refused and the agent was asked to correct (repair turns). */
  repairs: number;
  agent: AgentPlatform;
  model?: string;
  /** The user's description, so a failed request can be retried. */
  description: string;
  /** The request asked to modify a draft. */
  modifying: boolean;
  /** Completed jobs: the draft to open, unsaved, in the designer. */
  template?: GraphTemplateV1;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** `graph_describe_start` input. */
export interface GraphDescribeStartInput {
  environmentId: string;
  description: string;
  agent: AgentPlatform;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  /** The draft to modify ("modify current draft"). */
  baseDraft?: GraphTemplateV1;
}

export function isGraphDescribeTerminal(status: GraphDescribeJobStatus): boolean {
  return status !== "running";
}
