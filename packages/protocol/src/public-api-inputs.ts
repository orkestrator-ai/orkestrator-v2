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
      input: schema({ projectId }, ["projectId"]),
      examples: [{ projectId: "project-1" }],
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
        },
        ["environmentId", "agent", "prompt"],
      ),
      examples: [
        {
          environmentId: "env-1",
          agent: "codex",
          prompt: "Review the open diff.",
        },
      ],
    },
    "session.prompt": {
      capability: "sessions.control",
      confirmation: "never",
      input: schema({ sessionId, prompt, mode: conversationMode }, ["sessionId", "prompt"]),
      examples: [{ sessionId: EXAMPLE_SESSION_ID, prompt: "Now add a test for it." }],
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
