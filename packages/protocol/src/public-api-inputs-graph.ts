/**
 * Input contracts of the graph public actions (`graph.*`, item 214): list,
 * show and validate saved templates, launch one, and read or cancel a run.
 * There is no authoring action (D6): templates are created and edited in the
 * app's designer only. Split from `public-api-inputs.ts`, which composes them
 * into `PUBLIC_ACTION_INPUTS`; the same portable JSON Schema subset applies.
 */

import { AGENT_PLATFORMS } from "./agent-platforms.js";
import { GRAPH_LAUNCH_BOUNDS } from "./graphs/launch.js";
import {
  GRAPH_PROJECT_TEMPLATE_DIRECTORY,
  parseGraphTemplateRef,
  type GraphTemplateRef,
} from "./graphs/library.js";
import { PUBLIC_API_LIMITS } from "./public-api.js";
import { REVIEW_LENS_INPUT } from "./public-api-inputs-build.js";
import type {
  PublicActionInputContract,
  PublicActionInputSchema,
  PublicJsonSchema,
} from "./public-api-inputs.js";

/** UTF-8 bytes of template JSON `graph.validate` accepts inline (the request bound leaves room). */
export const PUBLIC_GRAPH_VALIDATE_TEXT_MAX_BYTES = 512 * 1024;
/** Diagnostics `graph.validate` returns; the rest are counted. */
export const PUBLIC_GRAPH_DIAGNOSTICS_MAX = 50;

/** `scope:id` template references as the CLI and MCP tools write them. */
export const PUBLIC_GRAPH_TEMPLATE_REF_HELP =
  "builtin:<id>, user:<id> or project:<file> (a .orkestrator/graphs/*.graph.json file of the project)";

/**
 * A `scope:id` reference as the CLI and MCP tools write it. A project
 * template names its path in the project the request targets, so `project:`
 * needs `projectId`. Returns a message when the text is not a reference.
 */
export function parsePublicGraphTemplateRef(
  text: unknown,
  projectId?: string,
): GraphTemplateRef | { error: string } {
  if (typeof text !== "string")
    return { error: `template must be ${PUBLIC_GRAPH_TEMPLATE_REF_HELP}` };
  const colon = text.indexOf(":");
  const scope = colon > 0 ? text.slice(0, colon) : "";
  const rest = colon > 0 ? text.slice(colon + 1) : "";
  if (!rest) return { error: `template must be ${PUBLIC_GRAPH_TEMPLATE_REF_HELP}` };
  if (scope === "builtin" || scope === "user") {
    const ref = parseGraphTemplateRef({ scope, id: rest });
    return "error" in ref ? { error: `template: ${ref.error}` } : ref;
  }
  if (scope === "project") {
    if (!projectId) return { error: "A project: template needs projectId" };
    // A bare file name is short for the project's graphs directory.
    const path = rest.includes("/") ? rest : `${GRAPH_PROJECT_TEMPLATE_DIRECTORY}/${rest}`;
    const ref = parseGraphTemplateRef({ scope, projectId, path });
    return "error" in ref ? { error: `template: ${ref.error}` } : ref;
  }
  return { error: `template must be ${PUBLIC_GRAPH_TEMPLATE_REF_HELP}` };
}

/** The `scope:id` text of a reference (the inverse of {@link parsePublicGraphTemplateRef}). */
export function publicGraphTemplateRefText(ref: GraphTemplateRef): string {
  return ref.scope === "project" ? `project:${ref.path}` : `${ref.scope}:${ref.id}`;
}

function schema(
  properties: Record<string, PublicJsonSchema>,
  required: readonly string[] = [],
): PublicActionInputSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const id = (description: string): PublicJsonSchema => ({
  type: "string",
  minLength: 1,
  maxLength: PUBLIC_API_LIMITS.idMaxChars,
  description,
});

const template: PublicJsonSchema = {
  type: "string",
  minLength: 3,
  maxLength: 400,
  description: `Saved template, as ${PUBLIC_GRAPH_TEMPLATE_REF_HELP}. From graph.list.`,
};

const runId = id("Graph run ID, from a graph.launch receipt.");

const binding: PublicJsonSchema = {
  type: "object",
  properties: {
    agent: { type: "string", enum: AGENT_PLATFORMS, description: "Agent platform." },
    model: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Model ID from agent.options. Omitted: the platform's default model.",
    },
    reasoningEffort: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Reasoning level; requires model.",
    },
    fastMode: { type: "boolean", description: "Use the model's fast speed where supported." },
    lens: REVIEW_LENS_INPUT,
  },
  required: ["agent"],
  additionalProperties: false,
};

export const GRAPH_ACTION_INPUTS: Readonly<
  Record<
    | "graph.list"
    | "graph.show"
    | "graph.validate"
    | "graph.launch"
    | "graph.status"
    | "graph.cancel",
    PublicActionInputContract
  >
> = Object.freeze({
  "graph.list": {
    capability: "sessions.read",
    confirmation: "never",
    input: schema({
      projectId: id("Also list this project's .orkestrator/graphs templates, with their trust."),
      limit: {
        type: "integer",
        minimum: 1,
        maximum: PUBLIC_API_LIMITS.pageMaxItems,
        description: `Page size (default ${PUBLIC_API_LIMITS.pageDefaultItems}).`,
      },
      cursor: {
        type: "string",
        minLength: 1,
        maxLength: 512,
        description: "nextCursor from the previous page.",
      },
    }),
    examples: [{}, { projectId: "project-1", limit: 20 }],
  },
  "graph.show": {
    capability: "sessions.read",
    confirmation: "never",
    input: schema(
      {
        template,
        projectId: id(
          "Judge the template for this project: its ceiling, the providers each role may run on on this host, and the saved launch defaults.",
        ),
        environmentId: id("Judge it for this existing environment's policy (requires projectId)."),
      },
      ["template"],
    ),
    examples: [
      { template: "user:nightly-review" },
      { template: "user:nightly-review", projectId: "project-1" },
    ],
  },
  "graph.validate": {
    capability: "sessions.read",
    confirmation: "never",
    input: schema({
      template: {
        ...template,
        description: `Saved template to compile, as ${PUBLIC_GRAPH_TEMPLATE_REF_HELP}. Give exactly one of template and text.`,
      },
      text: {
        type: "string",
        minLength: 2,
        maxLength: PUBLIC_GRAPH_VALIDATE_TEXT_MAX_BYTES,
        description: `A template file's JSON, compiled without being saved, at most ${PUBLIC_GRAPH_VALIDATE_TEXT_MAX_BYTES} bytes. Give exactly one of template and text.`,
      },
      projectId: id("Compile under this project's capability ceiling."),
    }),
    examples: [
      { template: "user:nightly-review", projectId: "project-1" },
      { text: '{"format":"orkestrator.graph","formatVersion":1}' },
    ],
  },
  "graph.launch": {
    capability: "environments.lifecycle",
    confirmation: "voice",
    input: schema(
      {
        projectId: id("Project the run belongs to, from project.list."),
        template,
        environmentId: id(
          "Run in this existing environment of the project. Give exactly one of environmentId and newEnvironment.",
        ),
        newEnvironment: {
          type: "string",
          enum: ["worktree", "container"],
          description:
            "Run in a new environment the run creates: a Git worktree on the backend host, or a restricted Docker container. Give exactly one of environmentId and newEnvironment.",
        },
        roles: {
          type: "object",
          description:
            "Role key → its models (graph.show lists the roles). A one-model role takes a list of exactly one; a panel role 1 to its maximum. Roles left out use the saved launch defaults, else the Settings defaults. A provider below a step's enforcement floor is refused.",
          additionalProperties: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: binding,
          },
        },
        params: {
          type: "object",
          description:
            "Parameter key → a string, number or boolean value, checked against the template's declaration. Omitted parameters use the saved defaults, then the template's.",
          additionalProperties: {
            description: "A string, number or boolean.",
          },
        },
        inputs: {
          type: "object",
          description: `Run input name → its JSON value, checked against the input's type (value inputs only), at most ${GRAPH_LAUNCH_BOUNDS.maxInputBytes} bytes in total. Receipts and summaries never include the values.`,
          additionalProperties: { description: "The input's JSON value." },
        },
        ticketId: id(
          "A Kanban ticket of the project to bind as the template's ticket@1 input (its title, description, criteria and comments). The ticket is linked to the run's environment.",
        ),
        ticketInput: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description:
            "The ticket@1 input the ticket fills; needed only when the template has several.",
        },
      },
      ["projectId", "template"],
    ),
    examples: [
      { projectId: "project-1", template: "user:nightly-review", newEnvironment: "worktree" },
      {
        projectId: "project-1",
        template: "user:ticket-build",
        environmentId: "env-1",
        ticketId: "ticket-1",
        roles: {
          builder: [{ agent: "codex", model: "gpt-5.5", reasoningEffort: "high" }],
          reviewer: [
            {
              agent: "claude",
              model: "claude-opus-5",
              lens: { label: "Security", instruction: "Trace untrusted input to its sinks." },
            },
            { agent: "codex" },
          ],
        },
        params: { maxRounds: 2, autoFix: true },
      },
    ],
  },
  "graph.status": {
    capability: "sessions.read",
    confirmation: "never",
    input: schema({ runId }, ["runId"]),
    examples: [{ runId: "run-1" }],
  },
  "graph.cancel": {
    capability: "sessions.control",
    confirmation: "never",
    input: schema({ runId }, ["runId"]),
    examples: [{ runId: "run-1" }],
  },
});
