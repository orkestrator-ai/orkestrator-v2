import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { GRAPH_LAUNCH_BOUNDS } from "@orkestrator/protocol/graphs/launch";
import {
  REVIEW_LENS_INSTRUCTION_MAX_BYTES,
  reviewLensFromText,
  type ReviewLens,
} from "@orkestrator/protocol/review-lens";
import {
  parsePublicGraphTemplateRef,
  PUBLIC_GRAPH_TEMPLATE_REF_HELP,
  PUBLIC_GRAPH_VALIDATE_TEXT_MAX_BYTES,
} from "@orkestrator/protocol/public-api-inputs-graph";
import type {
  PublicGraphRunActionResult,
  PublicGraphRunSummary,
  PublicGraphTemplateDetail,
  PublicGraphTemplateSummary,
  PublicGraphValidation,
  PublicPage,
} from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import { keyValues, table } from "../format.js";
import { readTextSource } from "../inputs.js";
import type { CommandContext, CommandSpec, OptionSpec } from "../spec.js";
import { REQUEST_ID_OPTION, stringOption, submit } from "./common.js";

/**
 * Graphs (item 214, D17): `graph list|show|validate|launch|status|cancel`.
 * Saved templates are listed, read, compiled and launched here; they are
 * created and edited only in the app's designer (D6). A launch goes through
 * the same backend service as the app's "Run graph…" and the coordinator's
 * `launch_graph`, so every entry point launches the same run. Input values
 * and focus text are read here and sent once; receipts and summaries carry
 * IDs, states and counts, never the values.
 */

const PROJECT_OPTION: OptionSpec = {
  name: "project",
  kind: "string",
  valueName: "PROJECT_ID",
  description: "Project ID (project list).",
};

const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const ROLE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

interface RoleBinding {
  agent: string;
  model?: string;
  reasoningEffort?: string;
  lens?: ReviewLens;
}

/** A template reference, checked here so a malformed one sends nothing. */
function templateText(raw: unknown, projectId: string | undefined): string {
  const ref = parsePublicGraphTemplateRef(raw, projectId ?? "project");
  if ("error" in ref) {
    throw new CliError(
      "invalid-input",
      `${ref.error.replace(/^template/, "TEMPLATE")}; use ${PUBLIC_GRAPH_TEMPLATE_REF_HELP}`,
    );
  }
  if (ref.scope === "project" && !projectId) {
    throw new CliError("invalid-input", "A project: template needs --project");
  }
  return raw as string;
}

/** `AGENT[/MODEL[@EFFORT]]`; a model ID may contain `/`, the effort follows the last `@`. */
function parseMember(raw: string, flag: string, role: string): RoleBinding {
  const slash = raw.indexOf("/");
  const agent = slash < 0 ? raw : raw.slice(0, slash);
  if (!(AGENT_PLATFORMS as readonly string[]).includes(agent)) {
    throw new CliError(
      "invalid-input",
      `${flag} ${role}= names agent ${JSON.stringify(agent)}; use one of ${AGENT_PLATFORMS.join(", ")}`,
    );
  }
  if (slash < 0) return { agent };
  const modelPart = raw.slice(slash + 1);
  const at = modelPart.lastIndexOf("@");
  const model = at > 0 ? modelPart.slice(0, at) : modelPart;
  const reasoningEffort = at > 0 ? modelPart.slice(at + 1) : undefined;
  if (!model) throw new CliError("invalid-input", `${flag} ${role}= needs a model after /`);
  return { agent, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/** `KEY=AGENT[/MODEL[@EFFORT]][,AGENT…]`: one role's models, a panel's comma-separated. */
function parseRoles(options: Record<string, unknown>): Map<string, RoleBinding[]> {
  const roles = new Map<string, RoleBinding[]>();
  for (const raw of (options.role as string[] | undefined) ?? []) {
    const equals = raw.indexOf("=");
    const key = raw.slice(0, equals);
    const rest = raw.slice(equals + 1);
    if (equals <= 0 || !ROLE_KEY.test(key) || !rest) {
      throw new CliError(
        "invalid-input",
        "--role expects KEY=AGENT[/MODEL[@EFFORT]], a panel's models separated by commas",
      );
    }
    if (roles.has(key)) throw new CliError("invalid-input", `--role ${key} was given twice`);
    const members = rest.split(",").map((member) => parseMember(member.trim(), "--role", key));
    if (members.length > 32) {
      throw new CliError("invalid-input", `--role ${key} lists more than 32 models`);
    }
    roles.set(key, members);
  }
  return roles;
}

/** `ROLE[.N]=VALUE`: a role and the 1-based panel position its focus applies to. */
function parseFocusTarget(
  raw: string,
  flag: string,
): { role: string; position: number; value: string } {
  const match = /^([A-Za-z_][A-Za-z0-9_-]{0,63})(?:\.(\d+))?=([\s\S]+)$/.exec(raw);
  const position = match?.[2] ? Number(match[2]) : 1;
  if (!match || !Number.isSafeInteger(position) || position < 1) {
    throw new CliError(
      "invalid-input",
      `${flag} expects ROLE[.N]=VALUE with N a --role model position from 1`,
    );
  }
  return { role: match[1]!, position, value: match[3]! };
}

/** Each `--focus`/`--focus-file` lens, set on the `--role` model it names. */
async function applyFocus(
  context: CommandContext,
  options: Record<string, unknown>,
  roles: Map<string, RoleBinding[]>,
): Promise<void> {
  const entries = [
    ...((options.focus as string[] | undefined) ?? []).map((raw) => ({
      flag: "--focus",
      ...parseFocusTarget(raw, "--focus"),
      file: false,
    })),
    ...((options["focus-file"] as string[] | undefined) ?? []).map((raw) => ({
      flag: "--focus-file",
      ...parseFocusTarget(raw, "--focus-file"),
      file: true,
    })),
  ];
  for (const entry of entries) {
    const member = roles.get(entry.role)?.[entry.position - 1];
    if (!member) {
      throw new CliError(
        "invalid-input",
        `${entry.flag} ${entry.role}.${entry.position}= names no --role ${entry.role} model at that position`,
      );
    }
    if (member.lens) {
      throw new CliError(
        "invalid-input",
        `${entry.role} model ${entry.position} has more than one focus`,
      );
    }
    const text = entry.file
      ? await readTextSource(context.io, {
          file: entry.value,
          label: `${entry.role} model ${entry.position} focus`,
          maxBytes: REVIEW_LENS_INSTRUCTION_MAX_BYTES + 512,
          names: { file: "--focus-file", stdin: "--focus-file -" },
          required: true,
        })
      : entry.value;
    try {
      member.lens = reviewLensFromText(text ?? "");
    } catch (error) {
      throw new CliError(
        "invalid-input",
        `${entry.flag} for ${entry.role} model ${entry.position}: ${(error as Error).message}`,
      );
    }
  }
}

/** `--param KEY=VALUE`: `true`, `false`, `null` and numbers as JSON scalars, anything else as text. */
function parseParams(
  options: Record<string, unknown>,
): Map<string, string | number | boolean | null> {
  const params = new Map<string, string | number | boolean | null>();
  for (const raw of (options.param as string[] | undefined) ?? []) {
    const equals = raw.indexOf("=");
    const key = raw.slice(0, equals);
    if (equals <= 0 || !INPUT_NAME.test(key)) {
      throw new CliError("invalid-input", "--param expects KEY=VALUE");
    }
    if (params.has(key)) throw new CliError("invalid-input", `--param ${key} was given twice`);
    const text = raw.slice(equals + 1);
    let value: string | number | boolean | null = text;
    if (text === "true") value = true;
    else if (text === "false") value = false;
    else if (text === "null") value = null;
    else if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text))) {
      value = Number(text);
    }
    params.set(key, value);
  }
  return params;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError("invalid-input", `${label} is not valid JSON`);
  }
}

/** `--input NAME=JSON` and `--input-file NAME=PATH` (`-`: stdin). */
async function parseInputs(
  context: CommandContext,
  options: Record<string, unknown>,
): Promise<Map<string, unknown>> {
  const entries = [
    ...((options.input as string[] | undefined) ?? []).map((raw) => ({ raw, file: false })),
    ...((options["input-file"] as string[] | undefined) ?? []).map((raw) => ({ raw, file: true })),
  ];
  if (entries.filter((entry) => entry.file && entry.raw.endsWith("=-")).length > 1) {
    throw new CliError("invalid-input", "Only one --input-file may read stdin (-)");
  }
  const inputs = new Map<string, unknown>();
  let bytes = 0;
  for (const entry of entries) {
    const flag = entry.file ? "--input-file" : "--input";
    const equals = entry.raw.indexOf("=");
    const name = entry.raw.slice(0, equals);
    const value = entry.raw.slice(equals + 1);
    if (equals <= 0 || !INPUT_NAME.test(name) || !value) {
      throw new CliError("invalid-input", `${flag} expects NAME=${entry.file ? "PATH" : "JSON"}`);
    }
    if (inputs.has(name)) throw new CliError("invalid-input", `Run input ${name} was given twice`);
    const text = entry.file
      ? await readTextSource(context.io, {
          ...(value === "-" ? { stdin: true } : { file: value }),
          label: `Run input ${name}`,
          maxBytes: GRAPH_LAUNCH_BOUNDS.maxInputBytes,
          names: { file: "--input-file", stdin: "--input-file -" },
          required: true,
        })
      : value;
    bytes += Buffer.byteLength(text!);
    if (bytes > GRAPH_LAUNCH_BOUNDS.maxInputBytes) {
      throw new CliError(
        "input-too-large",
        `Run inputs are larger than ${GRAPH_LAUNCH_BOUNDS.maxInputBytes} bytes together`,
      );
    }
    inputs.set(name, parseJson(text!, `Run input ${name}`));
  }
  return inputs;
}

/** The `graph.launch` input the flags describe, refused here before anything is sent. */
export async function graphLaunchInput(
  context: CommandContext,
  template: string,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const projectId = stringOption(options, "project");
  if (!projectId) throw new CliError("invalid-input", "--project is required");
  const environmentId = stringOption(options, "environment");
  const targets = [
    environmentId ? "environment" : null,
    options["new-worktree"] === true ? "worktree" : null,
    options["new-container"] === true ? "container" : null,
  ].filter(Boolean);
  if (targets.length !== 1) {
    throw new CliError(
      "invalid-input",
      "Pass exactly one of --environment ENV, --new-worktree and --new-container",
    );
  }
  const roles = parseRoles(options);
  await applyFocus(context, options, roles);
  const params = parseParams(options);
  const inputs = await parseInputs(context, options);
  const ticketId = stringOption(options, "ticket");
  const ticketInput = stringOption(options, "ticket-input");
  if (ticketInput && !ticketId)
    throw new CliError("invalid-input", "--ticket-input needs --ticket");
  return {
    projectId,
    template: templateText(template, projectId),
    ...(environmentId
      ? { environmentId }
      : { newEnvironment: options["new-container"] === true ? "container" : "worktree" }),
    ...(roles.size > 0 ? { roles: Object.fromEntries(roles) } : {}),
    ...(params.size > 0 ? { params: Object.fromEntries(params) } : {}),
    ...(inputs.size > 0 ? { inputs: Object.fromEntries(inputs) } : {}),
    ...(ticketId ? { ticketId } : {}),
    ...(ticketInput ? { ticketInput } : {}),
  };
}

function actionLines(result: PublicGraphRunActionResult): string[] {
  return keyValues([
    ["run", result.runId],
    ["template", `${result.template.name} (${result.template.id} r${result.template.revision})`],
    ["environment", result.environmentId ?? "(being created)"],
    ["status", result.status],
  ]);
}

function nodeText(nodes: Record<string, number>): string {
  return (
    Object.entries(nodes)
      .map(([state, count]) => `${count} ${state}`)
      .join(", ") || "none yet"
  );
}

export const graphCommands: CommandSpec[] = [
  {
    path: ["graph", "list"],
    action: "graph.list",
    summary: "List saved graph templates, with trust and whether each can be launched.",
    description:
      "Built-in and user templates, and with --project that project's .orkestrator/graphs templates. Built-ins that run on their own engine are listed but cannot be launched as graphs; duplicate them in the app's designer.",
    positionals: [],
    options: [
      { ...PROJECT_OPTION, description: "Also list this project's templates (project list)." },
      { name: "limit", kind: "integer", valueName: "N", description: "Items per page (max 200)." },
      {
        name: "cursor",
        kind: "string",
        valueName: "CURSOR",
        description: "Continue from a previous page.",
      },
    ],
    idOutput: "template references, one per line",
    async run(context, parsed) {
      const projectId = stringOption(parsed.options, "project");
      const session = await context.session();
      const page = await session.read<PublicPage<PublicGraphTemplateSummary>>("graph.list", {
        ...(projectId ? { projectId } : {}),
        ...(parsed.options.limit !== undefined ? { limit: parsed.options.limit } : {}),
        ...(parsed.options.cursor !== undefined ? { cursor: parsed.options.cursor } : {}),
      });
      return {
        action: "graph.list",
        result: page,
        connection: session.identity,
        ids: page.items.map((template) => template.template),
        human: [
          ...table(
            ["TEMPLATE", "NAME", "TRUST", "LAUNCHABLE", "SESSIONS"],
            page.items.map((template) => [
              template.template,
              template.name,
              template.trust,
              template.launchable ? "yes" : template.engine ? "no (engine)" : "no",
              template.agentSessions
                ? `${template.agentSessions.best}-${template.agentSessions.worst}`
                : "",
            ]),
          ),
          ...(page.nextCursor ? [`more: --cursor ${page.nextCursor}`] : []),
        ],
      };
    },
  },
  {
    path: ["graph", "show"],
    action: "graph.show",
    summary: "Show a graph template: roles, parameters, inputs and nodes.",
    description:
      "With --project, also the providers each role may run on there (with its enforcement tier and why one is unavailable) and the defaults a launch uses for what it leaves out.",
    positionals: [
      { name: "template", required: true, description: PUBLIC_GRAPH_TEMPLATE_REF_HELP },
    ],
    options: [
      PROJECT_OPTION,
      {
        name: "environment",
        kind: "string",
        valueName: "ENV",
        description: "Judge it for this existing environment (with --project).",
      },
    ],
    async run(context, parsed) {
      const projectId = stringOption(parsed.options, "project");
      const environmentId = stringOption(parsed.options, "environment");
      if (environmentId && !projectId) {
        throw new CliError("invalid-input", "--environment needs --project");
      }
      const template = templateText(parsed.positionals.template, projectId);
      const session = await context.session();
      const detail = await session.read<PublicGraphTemplateDetail>("graph.show", {
        template,
        ...(projectId ? { projectId } : {}),
        ...(environmentId ? { environmentId } : {}),
      });
      return {
        action: "graph.show",
        result: detail,
        connection: session.identity,
        human: [
          ...keyValues([
            ["template", detail.template],
            ["name", detail.name],
            ["trust", detail.trust],
            ["launchable", detail.launchable ? "yes" : "no"],
            [
              "workspace",
              detail.workspace.create ? `new ${detail.workspace.create}` : detail.workspace.kind,
            ],
            ...detail.roles.map((role): [string, unknown] => [
              `role ${role.key}`,
              role.multiplicity === "panel" ? `panel (max ${role.maxPanel ?? 32})` : "one model",
            ]),
            ...detail.parameters.map((parameter): [string, unknown] => [
              `param ${parameter.key}`,
              `${parameter.type}${parameter.default !== null ? ` = ${String(parameter.default)}` : ""}`,
            ]),
            ...detail.inputs.map((entry): [string, unknown] => [
              `input ${entry.name}`,
              `${entry.type}${entry.required ? "" : " (optional)"}`,
            ]),
            ["steps", detail.steps.map((node) => node.id).join(", ")],
          ]),
          ...(detail.launch
            ? detail.launch.roles.map(
                (role) =>
                  `${role.key}: ${role.providers
                    .map(
                      (provider) =>
                        `${provider.agent} ${provider.available ? provider.tier : "unavailable"}`,
                    )
                    .join(", ")}`,
              )
            : []),
          ...(detail.launch && !detail.launch.launchable && detail.launch.blockedReason
            ? [`not launchable: ${detail.launch.blockedReason}`]
            : []),
        ],
      };
    },
  },
  {
    path: ["graph", "validate"],
    action: "graph.validate",
    summary: "Compile a saved graph template, or a template file without saving it.",
    description:
      "Reports the compiler's diagnostics and cost estimate. Give a TEMPLATE reference, or --file PATH (- reads stdin) for a .graph.json document; nothing is saved either way. Exits 0 when it compiles; the result's `ok` and `launchable` say more.",
    positionals: [
      { name: "template", required: false, description: PUBLIC_GRAPH_TEMPLATE_REF_HELP },
    ],
    options: [
      {
        name: "file",
        kind: "string",
        valueName: "PATH",
        description: `A template's JSON file to compile instead (at most ${PUBLIC_GRAPH_VALIDATE_TEXT_MAX_BYTES} bytes); - reads stdin.`,
      },
      { ...PROJECT_OPTION, description: "Compile under this project's capability ceiling." },
    ],
    inputFields: { file: "text" },
    async run(context, parsed) {
      const projectId = stringOption(parsed.options, "project");
      const file = stringOption(parsed.options, "file");
      const raw = parsed.positionals.template;
      if ((raw === undefined) === (file === undefined)) {
        throw new CliError("invalid-input", "Give a TEMPLATE reference or --file PATH, not both");
      }
      const text = file
        ? await readTextSource(context.io, {
            ...(file === "-" ? { stdin: true } : { file }),
            label: "Template",
            maxBytes: PUBLIC_GRAPH_VALIDATE_TEXT_MAX_BYTES,
            names: { file: "--file", stdin: "--file -" },
            required: true,
          })
        : undefined;
      const session = await context.session();
      const result = await session.read<PublicGraphValidation>("graph.validate", {
        ...(text !== undefined ? { text } : { template: templateText(raw, projectId) }),
        ...(projectId ? { projectId } : {}),
      });
      return {
        action: "graph.validate",
        result,
        connection: session.identity,
        human: [
          ...keyValues([
            ["ok", result.ok ? "yes" : "no"],
            [
              "launchable",
              result.launchable ? "yes" : result.blockedBy ? `no (${result.blockedBy})` : "no",
            ],
            ["errors", result.errors],
            ["warnings", result.warnings],
            ...(result.cost
              ? ([
                  [
                    "agent sessions",
                    `${result.cost.agentSessions.best}-${result.cost.agentSessions.worst}`,
                  ],
                ] as Array<[string, unknown]>)
              : []),
          ]),
          ...result.diagnostics.map(
            (diagnostic) =>
              `${diagnostic.severity} ${diagnostic.code}${diagnostic.nodeId ? ` (${diagnostic.nodeId})` : ""}: ${diagnostic.message}`,
          ),
          ...(result.omittedDiagnostics > 0 ? [`… ${result.omittedDiagnostics} more`] : []),
        ],
      };
    },
  },
  {
    path: ["graph", "launch"],
    action: "graph.launch",
    summary: "Run a saved graph template, as Run graph… does in the app.",
    description:
      "Runs the template in an existing environment (--environment) or a new worktree or container it creates. Roles, parameters and inputs left out use the template's saved launch defaults for the project, then Settings; a provider below a step's enforcement floor is refused. The run continues in the backend; follow it with `graph status`.",
    positionals: [
      { name: "template", required: true, description: PUBLIC_GRAPH_TEMPLATE_REF_HELP },
    ],
    options: [
      PROJECT_OPTION,
      {
        name: "environment",
        kind: "string",
        valueName: "ENV",
        description: "Run in this existing environment of the project.",
      },
      {
        name: "new-worktree",
        kind: "boolean",
        description: "Run in a new Git worktree environment the run creates.",
      },
      {
        name: "new-container",
        kind: "boolean",
        description: "Run in a new restricted container environment the run creates.",
      },
      {
        name: "role",
        kind: "list",
        valueName: "KEY=AGENT[/MODEL[@EFFORT]]",
        description:
          "A role's model (repeatable); a panel role's models separated by commas, e.g. reviewer=claude,codex/gpt-5.5@high.",
      },
      {
        name: "focus",
        kind: "list",
        valueName: "ROLE[.N]=TEXT",
        description:
          "Focus (lens) for --role model N (default 1): the first line is the label (at most 64 characters), the rest the instruction (at most 4 KiB).",
      },
      {
        name: "focus-file",
        kind: "list",
        valueName: "ROLE[.N]=PATH",
        description: "Read a --role model's focus from a local file, laid out like --focus.",
      },
      {
        name: "param",
        kind: "list",
        valueName: "KEY=VALUE",
        description: "A parameter value (repeatable); true, false, null and numbers are typed.",
      },
      {
        name: "input",
        kind: "list",
        valueName: "NAME=JSON",
        description: "A run input's JSON value (repeatable).",
      },
      {
        name: "input-file",
        kind: "list",
        valueName: "NAME=PATH",
        description: "Read a run input's JSON from a local file (repeatable); - reads stdin.",
      },
      {
        name: "ticket",
        kind: "string",
        valueName: "TICKET_ID",
        description: "A Kanban ticket bound as the template's ticket input (ticket list).",
      },
      {
        name: "ticket-input",
        kind: "string",
        valueName: "NAME",
        description: "The ticket input to fill when the template has several.",
      },
      REQUEST_ID_OPTION,
    ],
    inputFields: {
      "new-worktree": "newEnvironment",
      "new-container": "newEnvironment",
      role: "roles",
      focus: "roles",
      "focus-file": "roles",
      param: "params",
      input: "inputs",
      "input-file": "inputs",
      ticket: "ticketId",
    },
    idOutput: "graph run ID",
    async run(context, parsed) {
      const input = await graphLaunchInput(
        context,
        parsed.positionals.template as string,
        parsed.options,
      );
      const { session, result, receipt, warnings } = await submit<PublicGraphRunActionResult>(
        context,
        "graph.launch",
        input,
        parsed.options,
      );
      return {
        action: "graph.launch",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.runId],
        human: actionLines(result),
      };
    },
  },
  {
    path: ["graph", "status"],
    action: "graph.status",
    summary: "Show a graph run: status, nodes by state and usage.",
    positionals: [{ name: "run", required: true, description: "Graph run ID." }],
    options: [],
    inputFields: { run: "runId" },
    async run(context, parsed) {
      const session = await context.session();
      const run = await session.read<PublicGraphRunSummary>("graph.status", {
        runId: parsed.positionals.run,
      });
      return {
        action: "graph.status",
        result: run,
        connection: session.identity,
        human: keyValues([
          ["run", run.id],
          ["template", `${run.template.name} (${run.template.id} r${run.template.revision})`],
          ["environment", run.environmentId ?? "(being created)"],
          ["status", run.mock ? `${run.status} (mock)` : run.status],
          ["activations", nodeText(run.activations)],
          ["agent sessions", run.usage.agentSessions],
          ["tokens", run.usage.tokens],
          ...(run.error ? ([["error", run.error]] as Array<[string, unknown]>) : []),
        ]),
      };
    },
  },
  {
    path: ["graph", "cancel"],
    action: "graph.cancel",
    summary: "Cancel a graph run; its record, artifacts and environment are kept.",
    positionals: [{ name: "run", required: true, description: "Graph run ID." }],
    options: [REQUEST_ID_OPTION],
    inputFields: { run: "runId" },
    idOutput: "graph run ID",
    async run(context, parsed) {
      const runId = parsed.positionals.run as string;
      const { session, result, receipt, warnings } = await submit<PublicGraphRunActionResult>(
        context,
        "graph.cancel",
        { runId },
        parsed.options,
      );
      return {
        action: "graph.cancel",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [runId],
        human: actionLines(result),
      };
    },
  },
];
