/**
 * Input contract of every public action, shared by the backend handlers, the
 * `orkestrator` CLI and Control MCP.
 *
 * Each entry holds the action's input JSON Schema, the capability that grants
 * it, how risky it is (its confirmation class) and examples. The backend takes
 * each action's accepted keys from this table, and a conformance test keeps the
 * schemas and the handlers' own validation in step; the handlers remain the
 * authority on every value.
 *
 * Schemas use a portable JSON Schema subset that every MCP client and model
 * provider accepts: `type`, `properties`, `required`, `enum`, `items`,
 * `minLength`/`maxLength`, `minItems`/`maxItems`, `minimum`/`maximum`,
 * `description` and `additionalProperties`. No references, no combinators.
 * Rules the subset cannot express (exactly one of two fields, fields that must
 * be given together) are stated in the description.
 */

import { AGENT_PLATFORMS } from "./agent-platforms.js";
import { BUILD_ACTION_INPUTS, REVIEW_LENS_INPUT } from "./public-api-inputs-build.js";
import { GRAPH_ACTION_INPUTS } from "./public-api-inputs-graph.js";
import { PR_ACTION_INPUTS } from "./public-api-inputs-pr.js";
import {
  DELIVERY_POLICIES,
  TICKET_KIND_GUIDANCE,
  TICKET_KINDS,
  TICKET_SECTION_LIMITS,
  TICKET_SECTIONS_GUIDANCE,
} from "./ticket-sections.js";
import { NATIVE_AGENT_GOAL_LIMITS } from "./native-agent-goal.js";
import { PUBLIC_ACTION_NAMES, PUBLIC_API_LIMITS, type PublicActionName } from "./public-api.js";
import {
  PUBLIC_CHANGE_SCOPES,
  PUBLIC_ENVIRONMENT_SETTINGS,
  PUBLIC_PROJECT_SETTINGS,
  type PublicSettingDescriptor,
} from "./public-api-resources.js";

export interface PublicJsonSchema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, PublicJsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | PublicJsonSchema;
  items?: PublicJsonSchema;
  enum?: readonly (string | number | boolean)[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

export interface PublicActionInputSchema extends PublicJsonSchema {
  type: "object";
  properties: Record<string, PublicJsonSchema>;
  required: readonly string[];
  additionalProperties: false;
}

/**
 * Groups of actions a Control MCP credential can be granted. `host` (updating
 * Orkestrator itself) is for the operator's own clients only and must never
 * be granted to an MCP credential an agent could hold.
 */
export const PUBLIC_CAPABILITIES = Object.freeze([
  "discovery",
  "sessions.read",
  "sessions.control",
  "interactions",
  "environments.lifecycle",
  "environments.destructive",
  "exec",
  "projects",
  "settings",
  "tickets",
  "mail",
  "schedules",
  "host",
] as const);

export type PublicCapability = (typeof PUBLIC_CAPABILITIES)[number];

/**
 * When a caller must confirm an action before it runs.
 *
 * - `never`: runs directly.
 * - `voice`: confirmed when the caller uses the voice profile.
 * - `always`: confirmed by every MCP caller. The CLI expresses the same intent
 *   with explicit flags instead.
 */
export type PublicConfirmationClass = "never" | "voice" | "always";

/**
 * Narrows a confirmation class to some calls of the action.
 *
 * - `discard`: only when the input sets `discard: true`.
 * - `approval`: only when the call approves a command or file change (an
 *   `answer` or `approve-for-session` on a non-question interaction).
 */
export type PublicConfirmationCondition = "discard" | "approval";

export interface PublicActionInputContract {
  capability: PublicCapability;
  confirmation: PublicConfirmationClass;
  confirmWhen?: PublicConfirmationCondition;
  input: PublicActionInputSchema;
  /** Valid inputs; each one parses in the backend handler. */
  examples: readonly Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Shared fields

const EXAMPLE_SESSION_ID = "ses_ZW52LTEKc3RhcnR1cC1hZ2VudA";

function id(description: string): PublicJsonSchema {
  return {
    type: "string",
    minLength: 1,
    maxLength: PUBLIC_API_LIMITS.idMaxChars,
    description,
  };
}

const projectId = id("Project ID, from project.list.");
const environmentId = id("Environment ID, from environment.list.");
const sessionId: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 700,
  description: "Session handle (ses_...), from session.list or a launch result. Copy it exactly.",
};
const operationId: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  description: "Operation ID from a receipt.",
};
const goalMaxIterations: PublicJsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit,
  description: `Turns the backend may send for this goal (default ${NATIVE_AGENT_GOAL_LIMITS.maxIterationsDefault} when setting; unchanged when resuming).`,
};
const goalTokenBudget: PublicJsonSchema = {
  type: "integer",
  minimum: 1,
  description: "Tokens the goal may spend; refused for providers whose usage cannot back a budget.",
};
const expectedOperationId: PublicJsonSchema = {
  ...operationId,
  description: "Act only while this run is the session's current turn.",
};
const limit: PublicJsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: PUBLIC_API_LIMITS.pageMaxItems,
  description: `Page size (default ${PUBLIC_API_LIMITS.pageDefaultItems}).`,
};
const cursor: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  description: "nextCursor from the previous page.",
};
const prompt: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: PUBLIC_API_LIMITS.promptMaxChars,
  description: "Prompt text sent to the agent.",
};
const literal: PublicJsonSchema = {
  type: "boolean",
  description:
    "true sends the prompt as plain text: a leading /name never runs a provider command. Omitted: the session's default (a native tab treats a leading /name as a typed command).",
};
const enqueue: PublicJsonSchema = {
  type: "boolean",
  description:
    "true queues the prompt behind a busy session in the backend's durable queue instead of refusing it; providers without a queue refuse.",
};
const attachments: PublicJsonSchema = {
  type: "array",
  maxItems: PUBLIC_API_LIMITS.promptAttachmentsMaxItems,
  description: `Files sent with the prompt, at most ${PUBLIC_API_LIMITS.promptAttachmentsMaxBytes} decoded bytes in total. The backend writes them into the environment workspace; host paths are never accepted.`,
  items: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: PUBLIC_API_LIMITS.promptAttachmentNameMaxChars,
        description: "File name only, without directories.",
      },
      type: {
        type: "string",
        enum: ["image", "file"],
        description: "Omitted: image when the bytes are PNG, JPEG, GIF or WebP, otherwise file.",
      },
      dataBase64: {
        type: "string",
        minLength: 1,
        description: "The file's bytes, base64-encoded.",
      },
    },
    required: ["name", "dataBase64"],
    additionalProperties: false,
  },
};
const environmentType: PublicJsonSchema = {
  type: "string",
  enum: ["local", "container"],
  description: "local uses a Git worktree on the backend host; container uses Docker.",
};
const conversationMode: PublicJsonSchema = {
  type: "string",
  enum: ["plan", "build"],
  description: "Conversation mode (default build).",
};
const expectedRevision: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  description: "Apply only if the stored revision still matches.",
};

const ticketId = id("Ticket ID, from ticket.list.");
const ticketStatus: PublicJsonSchema = {
  type: "string",
  enum: ["backlog", "in-progress", "review", "done"],
};
const ticketTitle: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  description: "Ticket title.",
};
function ticketText(description: string): PublicJsonSchema {
  return { type: "string", maxLength: 100_000, description };
}
const ticketKind: PublicJsonSchema = {
  type: "string",
  enum: TICKET_KINDS,
  description: TICKET_KIND_GUIDANCE,
};
const ticketSections: PublicJsonSchema = {
  type: "object",
  additionalProperties: false,
  description: TICKET_SECTIONS_GUIDANCE,
  properties: {
    summary: ticketText("What the ticket is about."),
    problem: ticketText("What is wrong today."),
    context: ticketText("Background, evidence and where to look."),
    decisions: ticketText("Choices already made."),
    constraints: ticketText("Limits on how the work is done."),
    acceptanceCriteria: {
      type: "array",
      maxItems: TICKET_SECTION_LIMITS.maxAcceptanceCriteria,
      items: { type: "string", minLength: 1, maxLength: TICKET_SECTION_LIMITS.maxCriterionLength },
      description: "One checkable criterion per entry. An unchanged entry keeps its result.",
    },
    checks: {
      type: "array",
      maxItems: TICKET_SECTION_LIMITS.maxChecks,
      items: { type: "string", minLength: 1, maxLength: TICKET_SECTION_LIMITS.maxCheckLength },
      description: "Standard commands that must pass.",
    },
    delivery: {
      type: "object",
      additionalProperties: false,
      properties: {
        policy: {
          type: "string",
          enum: DELIVERY_POLICIES,
          description: "How the work is delivered.",
        },
        note: ticketText("Anything the policy does not say."),
      },
    },
    reporting: ticketText("Report fields beyond the project's standard report."),
    outOfScope: ticketText("What the ticket leaves alone."),
    custom: {
      type: "array",
      maxItems: TICKET_SECTION_LIMITS.maxCustomSections,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body"],
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: TICKET_SECTION_LIMITS.maxCustomTitleLength,
          },
          body: ticketText("Section text."),
        },
      },
      description: "Extra titled sections, in order.",
    },
    notes: ticketText("Anything else."),
  },
};

const agentSelection: Record<string, PublicJsonSchema> = {
  agent: {
    type: "string",
    enum: AGENT_PLATFORMS,
    description: "Agent platform; agent.options lists the enabled ones.",
  },
  model: {
    type: "string",
    minLength: 1,
    maxLength: 500,
    description: "Model ID from agent.options. Omitted: the configured default.",
  },
  reasoning: {
    type: "string",
    minLength: 1,
    maxLength: 100,
    description: "Reasoning level from agent.options; requires model.",
  },
  fastMode: {
    type: "boolean",
    description: "Use the model's fast speed where supported.",
  },
  mode: conversationMode,
};

/** Agent fields of a button action (PR, Resolve): every one optional. */
const actionAgentSelection: Record<string, PublicJsonSchema> = {
  agent: {
    ...agentSelection.agent!,
    description: "Agent platform. Omitted: the configured default for this action.",
  },
  model: agentSelection.model!,
  reasoning: agentSelection.reasoning!,
  fastMode: agentSelection.fastMode!,
};

const workflowId = id("Multi Review workflow ID, from review.list or a review.launch receipt.");

/** One Multi Review model row. */
const reviewSelection: PublicJsonSchema = {
  type: "object",
  properties: {
    agent: { type: "string", enum: AGENT_PLATFORMS, description: "Agent platform." },
    model: { type: "string", minLength: 1, maxLength: 512, description: "Model ID." },
    reasoningEffort: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Reasoning level.",
    },
  },
  required: ["agent", "model"],
  additionalProperties: false,
};

/** A Multi Review reviewer row, which alone may carry a focus. */
const reviewerSelection: PublicJsonSchema = {
  ...reviewSelection,
  properties: {
    ...reviewSelection.properties,
    lens: REVIEW_LENS_INPUT,
  },
};

const createEnvironmentFields: Record<string, PublicJsonSchema> = {
  projectId,
  type: environmentType,
  name: {
    type: "string",
    minLength: 1,
    maxLength: PUBLIC_API_LIMITS.nameMaxChars,
    description: "Environment name. Omitted: generated.",
  },
  baseBranch: {
    type: "string",
    minLength: 1,
    maxLength: 500,
    description: "Branch to start from; give together with baseCommit.",
  },
  baseCommit: {
    type: "string",
    minLength: 40,
    maxLength: 40,
    description: "Full 40-character commit SHA on baseBranch; give together with baseBranch.",
  },
  networkAccessMode: {
    type: "string",
    enum: ["restricted", "full"],
    description: "Container network access. Omitted: the project default.",
  },
};

const scheduleId = id("Scheduled job ID (sch_...), from schedule.list.");
const permissionRuleId = id("Permission rule ID, from permission.rule.list.");
const scheduleTiming: Record<string, PublicJsonSchema> = {
  at: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    description:
      "One-shot time: HH:MM (its next occurrence), YYYY-MM-DDTHH:MM (in timeZone), an ISO time with Z or an offset, or relative +15m, +2h, +1h30m. Give exactly one of at, cron and everySeconds.",
  },
  cron: {
    type: "string",
    minLength: 1,
    maxLength: 200,
    description:
      "Recurring: five-field cron (minute hour day-of-month month day-of-week) or @hourly, @daily, @weekly, @monthly, evaluated in timeZone.",
  },
  everySeconds: {
    type: "integer",
    minimum: 60,
    maximum: 366 * 24 * 60 * 60,
    description: "Recurring: a fixed interval in seconds (elapsed time; DST does not move it).",
  },
  startAt: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    description:
      "With everySeconds: the first fire, in the forms at accepts. Default: one interval from now.",
  },
  timeZone: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    description:
      "IANA time zone for at and cron wall times, e.g. Europe/London. Default: the backend host's zone.",
  },
  catchUpMinutes: {
    type: "integer",
    minimum: 0,
    maximum: 7 * 24 * 60,
    description:
      "A fire missed while the backend was down runs once on return if it is at most this many minutes late; later ones are skipped. Default 15.",
  },
};
const scheduleAction: PublicJsonSchema = {
  type: "object",
  description:
    "What fires. kind action: run one public action (action plus input; a mutation other than schedule.* and actions that always need confirmation). kind prompt: send prompt to an idle agent session (sessionId). kind launch: launch an environment like environment.launch; without baseCommit the base branch's newest commit is resolved when it fires. kind graph: launch a saved graph template (request); the template must be launchable when the schedule is created.",
  properties: {
    kind: { type: "string", enum: ["action", "prompt", "launch", "graph"] },
    request: {
      type: "object",
      additionalProperties: true,
      description:
        "kind graph: the launch request ({ref, projectId, environment, roles?, params?, inputs?, ticket?}), as graph.launch takes it, without requestId (each fire supplies one).",
    },
    action: {
      type: "string",
      enum: PUBLIC_ACTION_NAMES,
      description: "kind action: the public action to run.",
    },
    input: {
      type: "object",
      additionalProperties: true,
      description: "kind action: that action's input, as describe_action documents it.",
    },
    sessionId: { ...sessionId, description: "kind prompt: the target session (ses_...)." },
    prompt,
    mode: conversationMode,
    projectId: { ...projectId, description: "kind launch: the project." },
    type: environmentType,
    agent: agentSelection.agent!,
    model: agentSelection.model!,
    reasoning: agentSelection.reasoning!,
    name: createEnvironmentFields.name!,
    baseBranch: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "kind launch: branch to start from. Default: the repository's base branch.",
    },
    baseCommit: {
      ...createEnvironmentFields.baseCommit!,
      description:
        "kind launch: pin this commit on baseBranch instead of resolving the newest at fire time.",
    },
  },
  required: ["kind"],
  additionalProperties: false,
};
const scheduleName: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  description: "Short label shown in lists. Default: derived from the action.",
};

function settingValueSchema(descriptor: PublicSettingDescriptor): PublicJsonSchema {
  const description = descriptor.description;
  switch (descriptor.type) {
    case "string":
      return { type: "string", minLength: 1, maxLength: 500, description };
    case "port":
      return { type: "integer", minimum: 1, maximum: 65_535, description };
    case "boolean":
      return { type: "boolean", description };
    case "agent":
      return { type: "string", enum: AGENT_PLATFORMS, description };
    case "agent-mode":
      return { type: "string", enum: ["native", "terminal"], description };
    case "string-list":
    case "domain-list":
      return {
        type: "array",
        items: { type: "string" },
        maxItems: descriptor.type === "domain-list" ? 512 : 256,
        description,
      };
    case "port-mappings":
      return {
        type: "array",
        maxItems: 64,
        items: {
          type: "object",
          properties: {
            containerPort: { type: "integer", minimum: 1, maximum: 65_535 },
            hostPort: {
              type: "integer",
              minimum: 0,
              maximum: 65_535,
              description: '0 is valid only with hostPortMode "auto".',
            },
            hostPortMode: {
              type: "string",
              enum: ["auto"],
              description:
                "Automatic host-port allocation; requires hostPort 0. Omit for an explicit host port.",
            },
            protocol: { type: "string", enum: ["tcp", "udp"] },
          },
          required: ["containerPort", "hostPort", "protocol"],
        },
        description,
      };
  }
}

function settingsPatchFields(
  descriptors: readonly PublicSettingDescriptor[],
  readAction: string,
): Record<string, PublicJsonSchema> {
  return {
    set: {
      type: "object",
      description: `Settings to change, by key; ${readAction} shows current values. Use unset, not null, to remove a value.`,
      properties: Object.fromEntries(
        descriptors.map((descriptor) => [descriptor.key, settingValueSchema(descriptor)]),
      ),
      additionalProperties: false,
    },
    unset: {
      type: "array",
      maxItems: PUBLIC_API_LIMITS.patchMaxFields,
      items: {
        type: "string",
        enum: descriptors.map((descriptor) => descriptor.key),
      },
      description: "Setting keys to reset to their inherited or default value.",
    },
    expectedRevision,
  };
}

function schema(
  properties: Record<string, PublicJsonSchema>,
  required: readonly string[] = [],
): PublicActionInputSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// The table

export const PUBLIC_ACTION_INPUTS: Readonly<Record<PublicActionName, PublicActionInputContract>> =
  Object.freeze({
    capabilities: {
      capability: "discovery",
      confirmation: "never",
      input: schema({}),
      examples: [{}],
    },
    "project.list": {
      capability: "discovery",
      confirmation: "never",
      input: schema({ limit, cursor }),
      examples: [{}, { limit: 10 }],
    },
    "project.get": {
      capability: "discovery",
      confirmation: "never",
      input: schema({
        projectId: {
          ...projectId,
          description: "Project ID. Pass exactly one of projectId or name.",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: PUBLIC_API_LIMITS.nameMaxChars,
          description: "Unique project name. Pass exactly one of projectId or name.",
        },
      }),
      examples: [{ name: "orkestrator" }, { projectId: "project-1" }],
    },
    "project.add": {
      capability: "projects",
      confirmation: "never",
      input: schema({
        remote: {
          type: "string",
          minLength: 1,
          maxLength: PUBLIC_API_LIMITS.gitUrlMaxChars,
          description: "Git remote URL. Pass remote, path, or both.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: PUBLIC_API_LIMITS.pathMaxChars,
          description:
            "Absolute checkout path on the backend host; cloned there if missing. Pass remote, path, or both.",
        },
      }),
      examples: [{ remote: "https://github.com/example/app.git" }],
    },
    "project.create": {
      capability: "projects",
      confirmation: "always",
      input: schema(
        {
          path: {
            type: "string",
            minLength: 1,
            maxLength: PUBLIC_API_LIMITS.pathMaxChars,
            description: "Absolute path on the backend host for the new repository.",
          },
          githubPrivate: {
            type: "boolean",
            enum: [true],
            description: "Must be true: confirms that a private GitHub repository is created.",
          },
        },
        ["path", "githubPrivate"],
      ),
      examples: [{ path: "/Users/me/code/new-app", githubPrivate: true }],
    },
    "project.update": {
      capability: "projects",
      confirmation: "never",
      input: schema(
        {
          projectId,
          set: {
            type: "object",
            description:
              "Stored metadata to change; at least one field. Never moves checkouts or edits .git/config.",
            properties: {
              name: {
                type: "string",
                minLength: 1,
                maxLength: PUBLIC_API_LIMITS.nameMaxChars,
              },
              // String or null: the portable subset has no union types.
              folder: {
                maxLength: PUBLIC_API_LIMITS.nameMaxChars,
                description: "Sidebar folder name, or null to remove it.",
              },
              remote: {
                type: "string",
                minLength: 1,
                maxLength: PUBLIC_API_LIMITS.gitUrlMaxChars,
              },
              path: {
                maxLength: PUBLIC_API_LIMITS.pathMaxChars,
                description: "Absolute checkout path on the backend host, or null to detach it.",
              },
            },
            additionalProperties: false,
          },
          expectedRevision,
        },
        ["projectId", "set"],
      ),
      examples: [{ projectId: "project-1", set: { name: "app" } }],
    },
    "project.remove": {
      capability: "projects",
      confirmation: "always",
      input: schema(
        {
          projectId,
          cascade: {
            type: "boolean",
            description:
              "Delete every environment of the project first, each through the normal deletion lifecycle; never deletes the checkout or the remote. Operator credentials only.",
          },
        },
        ["projectId"],
      ),
      examples: [{ projectId: "project-1" }, { projectId: "project-1", cascade: true }],
    },
    "project.init": {
      capability: "projects",
      confirmation: "never",
      input: schema(
        {
          path: {
            type: "string",
            minLength: 1,
            maxLength: PUBLIC_API_LIMITS.pathMaxChars,
            description:
              "Absolute path on the backend host: a new or empty directory for the repository.",
          },
        },
        ["path"],
      ),
      examples: [{ path: "/Users/me/code/scratch" }],
    },
    "project.config.get": {
      capability: "settings",
      confirmation: "never",
      input: schema({ projectId }, ["projectId"]),
      examples: [{ projectId: "project-1" }],
    },
    "project.config.set": {
      capability: "settings",
      confirmation: "never",
      input: schema(
        {
          projectId,
          ...settingsPatchFields(PUBLIC_PROJECT_SETTINGS, "project.config.get"),
        },
        ["projectId"],
      ),
      examples: [{ projectId: "project-1", set: { prBaseBranch: "main" } }],
    },
    "environment.list": {
      capability: "discovery",
      confirmation: "never",
      input: schema({
        projectId,
        status: {
          type: "string",
          enum: ["running", "stopped", "error", "creating", "stopping"],
          description: "Only environments in this state.",
        },
        limit,
        cursor,
      }),
      examples: [{}, { projectId: "project-1", status: "running" }],
    },
    "environment.get": {
      capability: "discovery",
      confirmation: "never",
      input: schema({
        environmentId: {
          ...environmentId,
          description: "Environment ID. Or pass projectId with name.",
        },
        projectId: {
          ...projectId,
          description: "Project ID; give together with name.",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: PUBLIC_API_LIMITS.nameMaxChars,
          description: "Environment name, unique within projectId.",
        },
      }),
      examples: [{ environmentId: "env-1" }, { projectId: "project-1", name: "auth-fix" }],
    },
    "environment.create": {
      capability: "environments.lifecycle",
      confirmation: "never",
      input: schema(createEnvironmentFields, ["projectId", "type"]),
      examples: [{ projectId: "project-1", type: "local", name: "auth-fix" }],
    },
    "environment.start": {
      capability: "environments.lifecycle",
      confirmation: "never",
      input: schema({ environmentId }, ["environmentId"]),
      examples: [{ environmentId: "env-1" }],
    },
    "environment.stop": {
      capability: "environments.lifecycle",
      confirmation: "voice",
      input: schema({ environmentId }, ["environmentId"]),
      examples: [{ environmentId: "env-1" }],
    },
    "environment.recreate": {
      capability: "environments.destructive",
      confirmation: "always",
      confirmWhen: "discard",
      input: schema(
        {
          environmentId,
          discard: {
            type: "boolean",
            description:
              "Reset the environment and delete its local files instead of preserving them.",
          },
        },
        ["environmentId"],
      ),
      examples: [{ environmentId: "env-1" }, { environmentId: "env-1", discard: true }],
    },
    "environment.delete": {
      capability: "environments.destructive",
      confirmation: "always",
      input: schema({ environmentId }, ["environmentId"]),
      examples: [{ environmentId: "env-1" }],
    },
    "environment.fork": {
      capability: "environments.lifecycle",
      confirmation: "never",
      input: schema({ environmentId, type: environmentType }, ["environmentId", "type"]),
      examples: [{ environmentId: "env-1", type: "local" }],
    },
    "environment.rename": {
      capability: "environments.lifecycle",
      confirmation: "never",
      input: schema(
        {
          environmentId,
          name: {
            type: "string",
            minLength: 1,
            maxLength: PUBLIC_API_LIMITS.nameMaxChars,
            description: "New name; the branch is renamed with it.",
          },
        },
        ["environmentId", "name"],
      ),
      examples: [{ environmentId: "env-1", name: "auth-fix-2" }],
    },
    "environment.config.get": {
      capability: "settings",
      confirmation: "never",
      input: schema({ environmentId }, ["environmentId"]),
      examples: [{ environmentId: "env-1" }],
    },
    "environment.config.set": {
      capability: "settings",
      confirmation: "never",
      input: schema(
        {
          environmentId,
          ...settingsPatchFields(PUBLIC_ENVIRONMENT_SETTINGS, "environment.config.get"),
        },
        ["environmentId"],
      ),
      examples: [{ environmentId: "env-1", set: { "agent.defaultAgent": "claude" } }],
    },
    "environment.launch": {
      capability: "environments.lifecycle",
      confirmation: "never",
      input: schema({ ...createEnvironmentFields, ...agentSelection, prompt }, [
        "projectId",
        "type",
        "agent",
        "prompt",
      ]),
      examples: [
        {
          projectId: "project-1",
          type: "local",
          agent: "claude",
          prompt: "Fix the failing login test.",
        },
      ],
    },
    "environment.exec": {
      capability: "exec",
      confirmation: "voice",
      input: schema(
        {
          environmentId,
          argv: {
            type: "array",
            minItems: 1,
            maxItems: PUBLIC_API_LIMITS.execArgvMaxItems,
            items: { type: "string" },
            description: "Program and arguments, passed without a shell.",
          },
          cwd: {
            type: "string",
            minLength: 1,
            maxLength: 1024,
            description: "Working directory relative to the workspace root (default .).",
          },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Extra environment variables. ORKESTRATOR_* names are reserved.",
          },
          stdinBase64: {
            type: "string",
            minLength: 1,
            maxLength: Math.ceil((PUBLIC_API_LIMITS.execStdinMaxBytes * 4) / 3) + 4,
            description: "Standard input, base64-encoded.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1_000,
            maximum: PUBLIC_API_LIMITS.execTimeoutMaxMs,
            description: `Kill the command after this many milliseconds (default ${PUBLIC_API_LIMITS.execTimeoutDefaultMs}).`,
          },
        },
        ["environmentId", "argv"],
      ),
      examples: [{ environmentId: "env-1", argv: ["git", "status", "--short"] }],
    },
    "agent.options": {
      capability: "discovery",
      confirmation: "never",
      input: schema({
        environmentId: {
          ...environmentId,
          description: "Environment ID. Pass exactly one of environmentId or projectId.",
        },
        projectId: {
          ...projectId,
          description: "Project ID. Pass exactly one of environmentId or projectId.",
        },
        refresh: {
          type: "boolean",
          description: "Refresh each enabled agent's model catalogue first.",
        },
      }),
      examples: [{ projectId: "project-1" }],
    },
    "session.list": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema({ environmentId }, ["environmentId"]),
      examples: [{ environmentId: "env-1" }],
    },
    "session.get": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema({ sessionId }, ["sessionId"]),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }],
    },
    "session.start": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema(
        {
          environmentId,
          ...agentSelection,
          title: {
            type: "string",
            minLength: 1,
            maxLength: PUBLIC_API_LIMITS.titleMaxChars,
            description: "Tab title.",
          },
          prompt,
          literal,
          attachments,
        },
        ["environmentId", "agent", "prompt"],
      ),
      examples: [
        {
          environmentId: "env-1",
          agent: "codex",
          prompt: "Review the open diff.",
        },
        {
          environmentId: "env-1",
          agent: "claude",
          prompt: "/review is a word here, not a command.",
          literal: true,
        },
      ],
    },
    "session.prompt": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema({ sessionId, prompt, mode: conversationMode, literal, enqueue, attachments }, [
        "sessionId",
        "prompt",
      ]),
      examples: [
        { sessionId: EXAMPLE_SESSION_ID, prompt: "Now add a test for it." },
        { sessionId: EXAMPLE_SESSION_ID, prompt: "After this turn, run the tests.", enqueue: true },
        {
          sessionId: EXAMPLE_SESSION_ID,
          prompt: "What does this screenshot show?",
          attachments: [{ name: "screen.png", type: "image", dataBase64: "iVBORw0KGgo=" }],
        },
      ],
    },
    "session.commands": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema(
        {
          sessionId,
          refresh: {
            type: "boolean",
            description: "Ask the provider for its command list again first.",
          },
        },
        ["sessionId"],
      ),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }],
    },
    "session.command": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema(
        {
          sessionId,
          command: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description:
              "Command ID or name from session.commands. An ID is matched exactly; a name must match exactly one command.",
          },
          arguments: {
            type: "string",
            maxLength: PUBLIC_API_LIMITS.commandArgumentsMaxBytes,
            description: "Argument text after the command name.",
          },
          expectedBindingRevision: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description:
              "bindingRevision from session.commands: refuse if the command changed since it was listed.",
          },
          enqueue,
        },
        ["sessionId", "command"],
      ),
      examples: [
        { sessionId: EXAMPLE_SESSION_ID, command: "/review", arguments: "the open diff" },
        { sessionId: EXAMPLE_SESSION_ID, command: "/compact" },
      ],
    },
    "session.stop": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema({ sessionId, expectedOperationId }, ["sessionId"]),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }],
    },
    "session.steer": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema(
        {
          sessionId,
          text: {
            type: "string",
            minLength: 1,
            maxLength: PUBLIC_API_LIMITS.steerMaxBytes,
            description: "Guidance added to the running turn.",
          },
          expectedOperationId,
        },
        ["sessionId", "text"],
      ),
      examples: [
        {
          sessionId: EXAMPLE_SESSION_ID,
          text: "Skip the docs; focus on the bug.",
        },
      ],
    },
    "session.config.get": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema({ sessionId }, ["sessionId"]),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }],
    },
    "session.config.set": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema(
        {
          sessionId,
          model: agentSelection.model!,
          reasoning: {
            ...agentSelection.reasoning!,
            description: "Reasoning level from agent.options.",
          },
          fastMode: agentSelection.fastMode!,
          mode: { ...conversationMode, description: "Conversation mode." },
        },
        ["sessionId"],
      ),
      examples: [{ sessionId: EXAMPLE_SESSION_ID, mode: "plan" }],
    },
    "session.history": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema({ sessionId }, ["sessionId"]),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }],
    },
    "session.resume": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema(
        {
          sessionId,
          historyId: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "Conversation ID from session.history.",
          },
        },
        ["sessionId", "historyId"],
      ),
      examples: [{ sessionId: EXAMPLE_SESSION_ID, historyId: "conversation-1" }],
    },
    "session.fork": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema(
        {
          sessionId,
          messageId: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "Fork after this transcript message. Omitted: the latest.",
          },
        },
        ["sessionId"],
      ),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }],
    },
    "session.interactions": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema({ sessionId }, ["sessionId"]),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }],
    },
    "session.interaction.resolve": {
      capability: "interactions",
      confirmation: "voice",
      confirmWhen: "approval",
      input: schema(
        {
          sessionId,
          interactionId: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "Interaction ID from session.interactions.",
          },
          expectedRevision: {
            type: "integer",
            minimum: 0,
            description: "The interaction's revision as last read.",
          },
          action: {
            type: "string",
            enum: ["answer", "approve-for-session", "decline", "deny", "cancel"],
            description:
              "Must be one of the interaction's listed actions. answer approves an approval or answers questions.",
          },
          answers: {
            type: "array",
            maxItems: 32,
            description: "Answers to the interaction's questions, with action answer.",
            items: {
              type: "object",
              properties: {
                questionId: { type: "string", minLength: 1, maxLength: 512 },
                optionIds: { type: "array", items: { type: "string" } },
                freeText: { type: "string", maxLength: 20_000 },
              },
              required: ["questionId"],
              additionalProperties: false,
            },
          },
          feedback: {
            type: "string",
            minLength: 1,
            maxLength: 10_000,
            description: "Note passed to the agent with the decision.",
          },
        },
        ["sessionId", "interactionId", "expectedRevision", "action"],
      ),
      examples: [
        {
          sessionId: EXAMPLE_SESSION_ID,
          interactionId: "interaction-1",
          expectedRevision: 1,
          action: "deny",
          feedback: "Use the existing helper instead.",
        },
      ],
    },
    "session.interaction.hold": {
      capability: "interactions",
      confirmation: "never",
      input: schema(
        {
          sessionId,
          interactionId: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "Interaction ID from session.interactions.",
          },
          held: {
            type: "boolean",
            description:
              "true pauses the countdown (until the hold ceiling or the provider's own limit); false resumes it with a fresh window.",
          },
        },
        ["sessionId", "interactionId", "held"],
      ),
      examples: [{ sessionId: EXAMPLE_SESSION_ID, interactionId: "interaction-1", held: true }],
    },
    "session.goal.set": {
      capability: "sessions.control",
      // A goal can run many unattended turns, so a spoken request confirms it.
      confirmation: "voice",
      input: schema(
        {
          sessionId,
          objective: {
            type: "string",
            minLength: 1,
            maxLength: NATIVE_AGENT_GOAL_LIMITS.objectiveMaxChars,
            description:
              "What the agent keeps working toward. Sent as data, never parsed for flags.",
          },
          check: {
            type: "string",
            minLength: 1,
            maxLength: NATIVE_AGENT_GOAL_LIMITS.checkMaxBytes,
            description:
              "One-line shell command run in the workspace when the agent reports done; exit 0 completes the goal. Omitted: a done report ends the goal as claimed (unverified).",
          },
          verifier: {
            type: "object",
            description:
              "A fresh read-only session that judges the work when the agent reports done; its passing verdict completes the goal. With check, the check runs first and both must pass.",
            properties: {
              agent: {
                type: "string",
                enum: AGENT_PLATFORMS,
                description: "The agent that runs the verifier session.",
              },
              model: {
                type: "string",
                minLength: 1,
                maxLength: NATIVE_AGENT_GOAL_LIMITS.verifierModelMaxChars,
                description: "Model ID. Omitted: the agent's default.",
              },
            },
            required: ["agent"],
            additionalProperties: false,
          },
          maxIterations: goalMaxIterations,
          tokenBudget: goalTokenBudget,
        },
        ["sessionId", "objective"],
      ),
      examples: [
        {
          sessionId: EXAMPLE_SESSION_ID,
          objective: "Make the test suite pass.",
          check: "bun test",
          maxIterations: 10,
        },
        {
          sessionId: EXAMPLE_SESSION_ID,
          objective: "Write the migration guide.",
          verifier: { agent: "codex", model: "o3" },
        },
      ],
    },
    "session.goal.get": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema(
        {
          sessionId,
          includeCheckOutput: {
            type: "boolean",
            description: "true adds the last check's output tail. It is untrusted command output.",
          },
        },
        ["sessionId"],
      ),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }],
    },
    "session.goal.pause": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema({ sessionId }, ["sessionId"]),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }],
    },
    "session.goal.resume": {
      capability: "sessions.control",
      // Resuming can raise the limits, which is the same risk as setting one.
      confirmation: "voice",
      input: schema({ sessionId, maxIterations: goalMaxIterations, tokenBudget: goalTokenBudget }, [
        "sessionId",
      ]),
      examples: [{ sessionId: EXAMPLE_SESSION_ID, maxIterations: 40 }],
    },
    "session.goal.clear": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema({ sessionId }, ["sessionId"]),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }],
    },
    "session.transcript": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema(
        {
          sessionId,
          limit: {
            type: "integer",
            minimum: 1,
            maximum: PUBLIC_API_LIMITS.transcriptMaxMessages,
            description: `Messages per page (default ${PUBLIC_API_LIMITS.transcriptDefaultMessages}).`,
          },
          before: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
            description: "Cursor from the previous page, to read older messages.",
          },
        },
        ["sessionId"],
      ),
      examples: [{ sessionId: EXAMPLE_SESSION_ID, limit: 3 }],
    },
    "changes.view": {
      capability: "discovery",
      confirmation: "never",
      input: schema(
        {
          environmentId,
          scope: {
            type: "string",
            enum: PUBLIC_CHANGE_SCOPES,
            description:
              "environment (default): the environment's baseline to its current workspace.",
          },
          pageSize: {
            type: "integer",
            minimum: 1,
            maximum: PUBLIC_API_LIMITS.pageMaxItems,
            description: `File rows per page (default and maximum ${PUBLIC_API_LIMITS.pageMaxItems}).`,
          },
          cursor: {
            type: "string",
            minLength: 1,
            maxLength: 1024,
            description:
              "files.nextCursor from the previous page; refused once the changes have moved on.",
          },
        },
        ["environmentId"],
      ),
      examples: [{ environmentId: "env-1" }, { environmentId: "env-1", pageSize: 20 }],
    },
    "changes.history": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema(
        {
          sessionId,
          limit: {
            type: "integer",
            minimum: 1,
            maximum: PUBLIC_API_LIMITS.pageMaxItems,
            description: `Turns per page (default ${PUBLIC_API_LIMITS.pageDefaultItems}).`,
          },
          cursor: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            description: "nextCursor from the previous page, to read newer turns.",
          },
        },
        ["sessionId"],
      ),
      examples: [{ sessionId: EXAMPLE_SESSION_ID }, { sessionId: EXAMPLE_SESSION_ID, limit: 10 }],
    },
    "review.launch": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema(
        {
          environmentId,
          reviewers: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            description:
              "Reviewer rows, each with an optional focus (lens). Omitted: the saved Multi Review reviewers and their saved focus. Set only when the user asks for specific reviewers or a focus.",
            items: reviewerSelection,
          },
          reviewModel: {
            ...reviewSelection,
            description: "Preparation and consolidation model. Omitted: the saved one.",
          },
          fixModel: { ...reviewSelection, description: "Fix model. Omitted: the saved one." },
          autoFix: {
            type: "boolean",
            description:
              "Start the Fix session when consolidation reports findings. Omitted: the saved Auto-fix setting (on when autoPr is true).",
          },
          autoPr: {
            type: "boolean",
            description:
              "Open the pull request once the Fix finishes (or straight after a clean consolidation). Never merges. Omitted: the saved Auto-PR setting.",
          },
          targetBranch: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "Branch to review against. Omitted: the project's PR base branch.",
          },
          reviewInstruction: {
            type: "string",
            maxLength: 100_000,
            description: "Review instruction. Omitted: the saved one; empty: none.",
          },
        },
        ["environmentId"],
      ),
      examples: [
        { environmentId: "env-1" },
        { environmentId: "env-1", autoFix: true, autoPr: true },
        {
          environmentId: "env-1",
          reviewers: [
            {
              agent: "claude",
              model: "claude-opus-5",
              lens: { label: "Security", instruction: "Trace untrusted input to its sinks." },
            },
            { agent: "codex", model: "gpt-5.5" },
          ],
        },
      ],
    },
    "review.list": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema({ environmentId }, ["environmentId"]),
      examples: [{ environmentId: "env-1" }],
    },
    "review.get": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema({ workflowId }, ["workflowId"]),
      examples: [{ workflowId: "review-1" }],
    },
    "review.open": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema(
        {
          workflowId,
          surface: {
            type: "string",
            enum: ["root", "fix"],
            description: "root (default): the review tab; fix: its Fix session tab.",
          },
        },
        ["workflowId"],
      ),
      examples: [{ workflowId: "review-1" }, { workflowId: "review-1", surface: "fix" }],
    },
    "review.address": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema({ workflowId }, ["workflowId"]),
      examples: [{ workflowId: "review-1" }],
    },
    "review.cancel": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema({ workflowId }, ["workflowId"]),
      examples: [{ workflowId: "review-1" }],
    },
    "review.start": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema(
        {
          environmentId,
          targetBranch: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "Branch to review against. Omitted: the project's PR base branch.",
          },
          ...actionAgentSelection,
        },
        ["environmentId"],
      ),
      examples: [{ environmentId: "env-1" }, { environmentId: "env-1", targetBranch: "develop" }],
    },
    ...BUILD_ACTION_INPUTS,
    ...GRAPH_ACTION_INPUTS,
    "pr.create": {
      capability: "sessions.control",
      confirmation: "voice",
      input: schema(
        {
          environmentId,
          targetBranch: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "Base branch of the pull request. Omitted: the project's PR base branch.",
          },
          ...actionAgentSelection,
        },
        ["environmentId"],
      ),
      examples: [{ environmentId: "env-1" }, { environmentId: "env-1", targetBranch: "develop" }],
    },
    "pr.resolve": {
      capability: "sessions.control",
      confirmation: "voice",
      input: schema(
        {
          environmentId,
          targetBranch: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description:
              "Branch to merge in. Omitted: the environment's PR base branch, else the project's.",
          },
          ...actionAgentSelection,
        },
        ["environmentId"],
      ),
      examples: [{ environmentId: "env-1" }],
    },
    "pr.push": {
      capability: "sessions.control",
      confirmation: "voice",
      input: schema({ environmentId, ...actionAgentSelection }, ["environmentId"]),
      examples: [{ environmentId: "env-1" }, { environmentId: "env-1", agent: "codex" }],
    },
    ...PR_ACTION_INPUTS,
    "attention.list": {
      capability: "sessions.read",
      confirmation: "never",
      input: schema({
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description:
            "cursor from the previous call: settled runs and setup changes since then. Omitted: the last hour. Pending interactions are always listed.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: PUBLIC_API_LIMITS.attentionMaxItems,
          description: `Most items to return (default ${PUBLIC_API_LIMITS.attentionDefaultItems}).`,
        },
      }),
      examples: [{}, { limit: 5 }],
    },
    "ticket.list": {
      capability: "tickets",
      confirmation: "never",
      input: schema(
        {
          projectId,
          status: { ...ticketStatus, description: "Only tickets in this column." },
          limit,
          cursor,
        },
        ["projectId"],
      ),
      examples: [{ projectId: "project-1" }, { projectId: "project-1", status: "backlog" }],
    },
    "ticket.get": {
      capability: "tickets",
      confirmation: "never",
      input: schema({ projectId, ticketId }, ["projectId", "ticketId"]),
      examples: [{ projectId: "project-1", ticketId: "ticket-1" }],
    },
    "ticket.create": {
      capability: "tickets",
      confirmation: "never",
      input: schema(
        {
          projectId,
          title: ticketTitle,
          kind: ticketKind,
          sections: ticketSections,
          description: ticketText("Ticket description."),
          acceptanceCriteria: ticketText("Acceptance criteria."),
          status: { ...ticketStatus, description: "Column (default backlog)." },
        },
        ["projectId", "title"],
      ),
      examples: [{ projectId: "project-1", title: "Fix the login redirect" }],
    },
    "ticket.update": {
      capability: "tickets",
      confirmation: "never",
      input: schema(
        {
          projectId,
          ticketId,
          title: ticketTitle,
          kind: ticketKind,
          sections: {
            ...ticketSections,
            description: `${TICKET_SECTIONS_GUIDANCE} Sections not named are unchanged.`,
          },
          description: ticketText("New description."),
          acceptanceCriteria: ticketText("New acceptance criteria."),
          status: { ...ticketStatus, description: "Move the ticket to this column." },
        },
        ["projectId", "ticketId"],
      ),
      examples: [{ projectId: "project-1", ticketId: "ticket-1", status: "in-progress" }],
    },
    "ticket.comment": {
      capability: "tickets",
      confirmation: "never",
      input: schema(
        {
          projectId,
          ticketId,
          text: {
            type: "string",
            minLength: 1,
            maxLength: 20_000,
            description: "Comment text.",
          },
        },
        ["projectId", "ticketId", "text"],
      ),
      examples: [{ projectId: "project-1", ticketId: "ticket-1", text: "Reproduced on main." }],
    },
    "mail.mailboxes": {
      capability: "mail",
      confirmation: "never",
      input: schema({
        q: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Filter by environment, tab or project name.",
        },
        offset: { type: "integer", minimum: 0, description: "Rows to skip (default 0)." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: PUBLIC_API_LIMITS.pageMaxItems,
          description: "Rows per page (default 100).",
        },
      }),
      examples: [{}, { q: "auth" }],
    },
    "mail.send": {
      capability: "mail",
      confirmation: "never",
      input: schema(
        {
          toEnvironmentId: {
            ...environmentId,
            description: "Destination environment ID, from mail.mailboxes.",
          },
          toTabId: id("Destination tab ID, from mail.mailboxes."),
          subject: { type: "string", minLength: 1, maxLength: 200, description: "Subject line." },
          body: {
            type: "string",
            minLength: 1,
            maxLength: 32 * 1024,
            description: "Message text, at most 32 KiB of UTF-8.",
          },
        },
        ["toEnvironmentId", "toTabId", "body"],
      ),
      examples: [{ toEnvironmentId: "env-1", toTabId: "startup-agent", body: "Rebase on main." }],
    },
    "node.list": {
      capability: "discovery",
      confirmation: "never",
      input: schema({}),
      examples: [{}],
    },
    "permission.rule.list": {
      capability: "settings",
      confirmation: "never",
      input: schema({
        projectId: { ...projectId, description: "Only rules of this project." },
      }),
      examples: [{}, { projectId: "2a9eac68-2f68-4852-bcf6-11812a0b3a24" }],
    },
    "permission.rule.remove": {
      capability: "settings",
      confirmation: "never",
      input: schema({ ruleId: permissionRuleId }, ["ruleId"]),
      examples: [{ ruleId: "6f1c2b9e-3a4d-4c5e-8f70-112233445566" }],
    },
    "schedule.list": {
      capability: "schedules",
      confirmation: "never",
      input: schema({
        projectId: {
          ...projectId,
          description: "Only schedules owned in or targeting this project.",
        },
        state: { type: "string", enum: ["active", "paused", "completed"] },
        ownerKind: { type: "string", enum: ["operator", "control-mcp", "agent", "coordinator"] },
        offset: { type: "integer", minimum: 0, maximum: 100_000 },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: PUBLIC_API_LIMITS.pageMaxItems,
          description: "Rows per page (default 100).",
        },
      }),
      examples: [{}, { state: "active" }],
    },
    "schedule.get": {
      capability: "schedules",
      confirmation: "never",
      input: schema({ scheduleId }, ["scheduleId"]),
      examples: [{ scheduleId: "sch_0123456789abcdef0123" }],
    },
    "schedule.create": {
      capability: "schedules",
      confirmation: "never",
      input: schema(
        {
          name: scheduleName,
          ...scheduleTiming,
          paused: { type: "boolean", description: "Create it paused." },
          action: scheduleAction,
        },
        ["action"],
      ),
      examples: [
        {
          at: "03:12",
          action: {
            kind: "action",
            action: "mail.send",
            input: {
              toEnvironmentId: "env-1",
              toTabId: "startup-agent",
              body: "Resume the stalled workers.",
            },
          },
        },
        {
          cron: "0 9 * * 1-5",
          timeZone: "Europe/London",
          action: {
            kind: "prompt",
            sessionId: EXAMPLE_SESSION_ID,
            prompt: "Summarise yesterday's CI failures.",
          },
        },
        {
          at: "+2h",
          action: {
            kind: "launch",
            projectId: "project-1",
            type: "local",
            agent: "claude",
            prompt: "Run the nightly audit.",
          },
        },
      ],
    },
    "schedule.update": {
      capability: "schedules",
      confirmation: "never",
      input: schema(
        {
          scheduleId,
          name: scheduleName,
          ...scheduleTiming,
          action: {
            ...scheduleAction,
            description: `Replace the action (owner's schedules only). ${scheduleAction.description}`,
          },
          expectedRevision: {
            type: "integer",
            minimum: 0,
            description: "Apply only if the schedule's revision still matches.",
          },
        },
        ["scheduleId"],
      ),
      examples: [{ scheduleId: "sch_0123456789abcdef0123", cron: "30 3 * * *" }],
    },
    "schedule.pause": {
      capability: "schedules",
      confirmation: "never",
      input: schema({ scheduleId }, ["scheduleId"]),
      examples: [{ scheduleId: "sch_0123456789abcdef0123" }],
    },
    "schedule.resume": {
      capability: "schedules",
      confirmation: "never",
      input: schema({ scheduleId }, ["scheduleId"]),
      examples: [{ scheduleId: "sch_0123456789abcdef0123" }],
    },
    "schedule.run": {
      capability: "schedules",
      confirmation: "never",
      input: schema({ scheduleId }, ["scheduleId"]),
      examples: [{ scheduleId: "sch_0123456789abcdef0123" }],
    },
    "schedule.delete": {
      capability: "schedules",
      confirmation: "never",
      input: schema({ scheduleId }, ["scheduleId"]),
      examples: [{ scheduleId: "sch_0123456789abcdef0123" }],
    },
    "run.get": {
      capability: "discovery",
      confirmation: "never",
      input: schema({
        submittedInput: {
          type: "object",
          description:
            "With action, namespace and requestId: validate the original mutation scope and canonical intent before returning its receipt.",
          additionalProperties: true,
        },
        operationId: {
          ...operationId,
          description: "Operation ID. Or pass requestId instead.",
        },
        requestId: {
          type: "string",
          minLength: 1,
          maxLength: PUBLIC_API_LIMITS.requestIdMaxChars,
          description: "The original request's requestId.",
        },
        action: {
          type: "string",
          enum: PUBLIC_ACTION_NAMES,
          description: "With requestId: the action it was used for, when it was reused.",
        },
        namespace: {
          type: "string",
          minLength: 1,
          maxLength: PUBLIC_API_LIMITS.namespaceMaxChars,
          description: "With requestId: the receipt's namespace.",
        },
      }),
      examples: [{ operationId: "op-1" }, { requestId: "voice-1", action: "session.prompt" }],
    },
    "run.retry": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema({ operationId }, ["operationId"]),
      examples: [{ operationId: "op-1" }],
    },
    "run.discard": {
      capability: "sessions.control",
      confirmation: "always",
      input: schema({ operationId }, ["operationId"]),
      examples: [{ operationId: "op-1" }],
    },
    "run.cancel": {
      capability: "exec",
      confirmation: "never",
      input: schema({ operationId }, ["operationId"]),
      examples: [{ operationId: "op-1" }],
    },
    "run.output": {
      capability: "discovery",
      confirmation: "never",
      input: schema(
        {
          operationId,
          stream: {
            type: "string",
            enum: ["stdout", "stderr"],
            description: "Default stdout.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "Byte offset to read from. Not with tailBytes.",
          },
          tailBytes: {
            type: "integer",
            minimum: 1,
            maximum: PUBLIC_API_LIMITS.execOutputPageMaxBytes,
            description: "Read the last N bytes. Not with offset.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1,
            maximum: PUBLIC_API_LIMITS.execOutputPageMaxBytes,
            description: "Largest window to return.",
          },
        },
        ["operationId"],
      ),
      examples: [{ operationId: "op-1", tailBytes: 4096 }],
    },
    "host.status": {
      capability: "host",
      confirmation: "never",
      input: schema({}),
      examples: [{}],
    },
    "host.update.channel": {
      capability: "host",
      confirmation: "never",
      input: schema({ channel: { type: "string", enum: ["stable", "beta", "unstable"] } }, [
        "channel",
      ]),
      examples: [{ channel: "stable" }, { channel: "beta" }, { channel: "unstable" }],
    },
    "host.update.check": {
      capability: "host",
      confirmation: "never",
      input: schema({}),
      examples: [{}],
    },
    "host.update.apply": {
      capability: "host",
      confirmation: "always",
      input: schema(
        {
          version: {
            type: "string",
            minLength: 5,
            maxLength: 64,
            description:
              "Install only this release (for example 2.22.0). Omit to install the newest release the host finds.",
          },
          confirm: {
            type: "boolean",
            enum: [true],
            description:
              "Must be true: installing restarts the host's Orkestrator app and ends work running there.",
          },
          drain: {
            type: "string",
            enum: ["now", "when-idle"],
            description:
              "now (default): restart after the countdown. when-idle: wait until no agent turn or pipeline is running, up to maxWaitSeconds.",
          },
          maxWaitSeconds: {
            type: "integer",
            minimum: 60,
            maximum: 86400,
            description: "With drain when-idle: restart anyway after this long. Default 3600.",
          },
        },
        ["confirm"],
      ),
      examples: [
        { confirm: true },
        { confirm: true, version: "2.22.0" },
        { confirm: true, drain: "when-idle", maxWaitSeconds: 1800 },
      ],
    },
    "host.update.cancel": {
      capability: "host",
      confirmation: "never",
      input: schema({}),
      examples: [{}],
    },
    "host.toolchain.repair": {
      capability: "host",
      confirmation: "never",
      input: schema({}),
      examples: [{}],
    },
    "host.image.update": {
      capability: "host",
      confirmation: "never",
      input: schema({}),
      examples: [{}],
    },
    "host.gh.update": {
      capability: "host",
      confirmation: "always",
      input: schema(
        {
          channel: {
            type: "string",
            enum: ["pinned", "latest"],
            description:
              "latest installs the newest gh release (not qualified with this Orkestrator); pinned goes back to the pin.",
          },
        },
        ["channel"],
      ),
      examples: [{ channel: "latest" }, { channel: "pinned" }],
    },
  });

/** Top-level input keys `action` accepts. */
export function publicActionInputKeys(action: PublicActionName): readonly string[] {
  return Object.keys(PUBLIC_ACTION_INPUTS[action].input.properties);
}

/** Keys of a nested object property (for example `set`) of `action`'s input. */
export function publicActionNestedKeys(
  action: PublicActionName,
  property: string,
): readonly string[] {
  const nested = PUBLIC_ACTION_INPUTS[action].input.properties[property];
  const properties = nested?.type === "array" ? nested.items?.properties : nested?.properties;
  if (!properties) throw new Error(`${action}.${property} has no nested properties`);
  return Object.keys(properties);
}

/** Every action a capability grants. */
export function publicActionsForCapability(capability: PublicCapability): PublicActionName[] {
  return (Object.keys(PUBLIC_ACTION_INPUTS) as PublicActionName[]).filter(
    (action) => PUBLIC_ACTION_INPUTS[action].capability === capability,
  );
}
