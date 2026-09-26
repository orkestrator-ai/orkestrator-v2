import {
  PUBLIC_API_LIMITS,
  type PublicActionName,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import type {
  PublicEnvironmentSummary,
  PublicPage,
} from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import { environmentLines, environmentRows, receiptLines } from "../format.js";
import { readPrompt, readTextSource } from "../inputs.js";
import type {
  CommandContext,
  CommandOutcome,
  CommandSpec,
  OptionSpec,
  ParsedCommand,
} from "../spec.js";
import {
  DEFAULT_WAIT_MS,
  oneOf,
  optionalBoolean,
  PROMPT_OPTIONS,
  receiptFailure,
  REQUEST_ID_OPTION,
  stringOption,
  submit,
  TIMEOUT_OPTION,
  waitForEnvironment,
  waitForOperation,
  type EnvironmentCondition,
} from "./common.js";
import { settingsCommands } from "./settings.js";

const TYPE_OPTION: OptionSpec = {
  name: "type",
  kind: "string",
  valueName: "local|container",
  description: "Workspace type: a local Git worktree or a Docker container.",
};

function waitOption(conditions: EnvironmentCondition[]): OptionSpec {
  return {
    name: "wait",
    kind: "string",
    valueName: conditions.join("|"),
    description: `Observe until the environment is ${conditions.join(" or ")} (bounded by --timeout).`,
  };
}

async function lifecycle(
  context: CommandContext,
  parsed: ParsedCommand,
  action: PublicActionName,
  conditions: EnvironmentCondition[],
): Promise<CommandOutcome> {
  const environmentId = String(parsed.positionals.environment);
  const wait =
    parsed.options.wait === undefined
      ? undefined
      : oneOf(parsed.options.wait, conditions, "--wait");
  if (parsed.options.timeout !== undefined && wait === undefined) {
    throw new CliError("invalid-input", "--timeout needs --wait");
  }
  const { session, result, receipt, warnings } = await submit<Record<string, unknown>>(
    context,
    action,
    { environmentId },
    parsed.options,
  );
  let finalReceipt: PublicReceipt | undefined = receipt;
  let environment: PublicEnvironmentSummary | null | undefined;
  if (wait) {
    const waited = await waitForEnvironment(
      context,
      session,
      environmentId,
      wait,
      receipt,
      (parsed.options.timeout as number | undefined) ?? DEFAULT_WAIT_MS,
    );
    finalReceipt = waited.receipt ?? finalReceipt;
    environment = waited.environment;
  }
  return {
    action,
    result: wait ? { ...result, environment: environment ?? null, condition: wait } : result,
    receipt: finalReceipt,
    warnings,
    connection: session.identity,
    ids: finalReceipt ? [finalReceipt.operationId] : [],
    human: environment
      ? environmentLines(environment)
      : finalReceipt
        ? receiptLines(finalReceipt)
        : ["ok"],
  };
}

export const environmentCommands: CommandSpec[] = [
  {
    path: ["environment", "list"],
    summary: "List environments from the backend snapshot.",
    positionals: [],
    options: [
      {
        name: "project",
        kind: "string",
        valueName: "PROJECT_ID",
        description: "Only this project.",
      },
      {
        name: "status",
        kind: "string",
        valueName: "STATUS",
        description: "running, stopped, error, creating or stopping.",
      },
      { name: "limit", kind: "integer", valueName: "N", description: "Items per page (max 200)." },
      {
        name: "cursor",
        kind: "string",
        valueName: "CURSOR",
        description: "Continue from a previous page.",
      },
    ],
    idOutput: "environment IDs, one per line",
    async run(context, parsed) {
      const session = await context.session();
      const input: Record<string, unknown> = {};
      for (const key of ["project", "status", "limit", "cursor"] as const) {
        if (parsed.options[key] !== undefined)
          input[key === "project" ? "projectId" : key] = parsed.options[key];
      }
      const page = await session.read<PublicPage<PublicEnvironmentSummary>>(
        "environment.list",
        input,
      );
      return {
        action: "environment.list",
        result: page,
        connection: session.identity,
        ids: page.items.map((environment) => environment.id),
        human: [
          ...environmentRows(page.items),
          ...(page.nextCursor ? [`more: --cursor ${page.nextCursor}`] : []),
        ],
      };
    },
  },
  {
    path: ["environment", "get"],
    summary: "Show one environment by ID, or by --project and --name when unique.",
    positionals: [{ name: "environment", required: false }],
    options: [
      {
        name: "project",
        kind: "string",
        valueName: "PROJECT_ID",
        description: "Scope for --name.",
      },
      { name: "name", kind: "string", valueName: "NAME", description: "Exact environment name." },
    ],
    idOutput: "environment ID",
    async run(context, parsed) {
      const id = parsed.positionals.environment as string | undefined;
      const name = stringOption(parsed.options, "name");
      const project = stringOption(parsed.options, "project");
      if (id && (name || project)) {
        throw new CliError("invalid-input", "Pass an environment ID or --project with --name");
      }
      if (!id && !(name && project)) {
        throw new CliError("invalid-input", "Name lookup needs both --project and --name");
      }
      const session = await context.session();
      const environment = await session.read<PublicEnvironmentSummary>(
        "environment.get",
        id ? { environmentId: id } : { projectId: project, name },
      );
      return {
        action: "environment.get",
        result: environment,
        connection: session.identity,
        ids: [environment.id],
        human: environmentLines(environment),
      };
    },
  },
  {
    path: ["environment", "create"],
    summary: "Create an environment record (does not start it).",
    description:
      "--base-branch with --base-commit (a full 40-character SHA) pins the exact base; the backend validates it and records what was used. Without them the project's default branch is used at start time.",
    positionals: [],
    options: [
      { name: "project", kind: "string", valueName: "PROJECT_ID", description: "Owning project." },
      TYPE_OPTION,
      {
        name: "name",
        kind: "string",
        valueName: "NAME",
        description: "Environment name (generated when omitted).",
      },
      { name: "base-branch", kind: "string", valueName: "BRANCH", description: "Base branch." },
      {
        name: "base-commit",
        kind: "string",
        valueName: "SHA",
        description: "Immutable base commit (40 hex).",
      },
      {
        name: "network",
        kind: "string",
        valueName: "restricted|full",
        description: "Container network mode.",
      },
      REQUEST_ID_OPTION,
    ],
    idOutput: "environment ID",
    async run(context, parsed) {
      const options = parsed.options;
      const projectId = stringOption(options, "project");
      if (!projectId) throw new CliError("invalid-input", "--project is required");
      const type = oneOf(options.type, ["local", "container"] as const, "--type");
      const input: Record<string, unknown> = { projectId, type };
      if (options.name !== undefined) input.name = options.name;
      if (options["base-branch"] !== undefined) input.baseBranch = options["base-branch"];
      if (options["base-commit"] !== undefined) input.baseCommit = options["base-commit"];
      if (options.network !== undefined) {
        input.networkAccessMode = oneOf(
          options.network,
          ["restricted", "full"] as const,
          "--network",
        );
      }
      const { session, result, receipt, warnings } = await submit<{
        environment: PublicEnvironmentSummary;
      }>(context, "environment.create", input, options);
      return {
        action: "environment.create",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.environment.id],
        human: environmentLines(result.environment),
      };
    },
  },
  {
    path: ["environment", "start"],
    summary: "Start an environment; setup continues in the backend.",
    description:
      "`--wait running` returns once processes run; `--wait ready` also requires setup to complete (an explicit setup override is reported, never applied by the CLI). Setup failure exits 1 with the recorded reason.",
    positionals: [{ name: "environment", required: true }],
    options: [waitOption(["running", "ready"]), TIMEOUT_OPTION, REQUEST_ID_OPTION],
    idOutput: "operation ID",
    run: (context, parsed) => lifecycle(context, parsed, "environment.start", ["running", "ready"]),
  },
  {
    path: ["environment", "stop"],
    summary: "Stop an environment's processes (and container).",
    positionals: [{ name: "environment", required: true }],
    options: [waitOption(["stopped"]), TIMEOUT_OPTION, REQUEST_ID_OPTION],
    idOutput: "operation ID",
    run: (context, parsed) => lifecycle(context, parsed, "environment.stop", ["stopped"]),
  },
  {
    path: ["environment", "recreate"],
    summary: "DESTRUCTIVE: remove and recreate the container (container environments only).",
    description:
      "The container filesystem outside the mounted workspace is discarded. Local worktree environments cannot be recreated.",
    positionals: [{ name: "environment", required: true }],
    options: [waitOption(["running", "ready"]), TIMEOUT_OPTION, REQUEST_ID_OPTION],
    idOutput: "operation ID",
    run: (context, parsed) =>
      lifecycle(context, parsed, "environment.recreate", ["running", "ready"]),
  },
  {
    path: ["environment", "delete"],
    summary:
      "DESTRUCTIVE: stop and delete the environment, its worktree or container, and its record.",
    description:
      "Uncommitted work in the environment is lost. Cleanup is tracked by the operation; a failed cleanup stays inspectable and can be retried with a new request.",
    positionals: [{ name: "environment", required: true }],
    options: [waitOption(["deleted"]), TIMEOUT_OPTION, REQUEST_ID_OPTION],
    idOutput: "operation ID",
    run: (context, parsed) => lifecycle(context, parsed, "environment.delete", ["deleted"]),
  },
  {
    path: ["environment", "fork"],
    summary: "Create a new environment from this environment's current state.",
    positionals: [{ name: "environment", required: true }],
    options: [TYPE_OPTION, REQUEST_ID_OPTION],
    idOutput: "new environment ID",
    async run(context, parsed) {
      const type = oneOf(parsed.options.type, ["local", "container"] as const, "--type");
      const { session, result, receipt, warnings } = await submit<{
        environment: PublicEnvironmentSummary;
      }>(
        context,
        "environment.fork",
        { environmentId: parsed.positionals.environment, type },
        parsed.options,
      );
      return {
        action: "environment.fork",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.environment.id],
        human: environmentLines(result.environment),
      };
    },
  },
  {
    path: ["environment", "rename"],
    summary: "Rename an environment (and its branch).",
    positionals: [
      { name: "environment", required: true },
      { name: "name", required: true },
    ],
    options: [REQUEST_ID_OPTION],
    idOutput: "environment ID",
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit<{
        environment: PublicEnvironmentSummary;
      }>(
        context,
        "environment.rename",
        { environmentId: parsed.positionals.environment, name: parsed.positionals.name },
        parsed.options,
      );
      return {
        action: "environment.rename",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.environment.id],
        human: environmentLines(result.environment),
      };
    },
  },
  {
    path: ["environment", "launch"],
    summary: "Create and start an environment whose startup agent receives one first prompt.",
    description:
      "The backend owns the whole flow: create, start, setup, then exactly one initial prompt to the startup session. Do not follow it with `session start`. --wait ready observes setup; follow the prompt's run with `run wait`.",
    positionals: [],
    options: [
      { name: "project", kind: "string", valueName: "PROJECT_ID", description: "Owning project." },
      TYPE_OPTION,
      {
        name: "agent",
        kind: "string",
        valueName: "AGENT",
        description: "claude, codex, cursor, grok, opencode or pi.",
      },
      {
        name: "model",
        kind: "string",
        valueName: "MODEL",
        description: "Model ID from `agent options`.",
      },
      {
        name: "reasoning",
        kind: "string",
        valueName: "LEVEL",
        description: "Reasoning level (requires --model).",
      },
      {
        name: "fast",
        kind: "boolean",
        negatable: true,
        description: "Fast speed where supported.",
      },
      {
        name: "mode",
        kind: "string",
        valueName: "plan|build",
        description: "Conversation mode (default build).",
      },
      { name: "name", kind: "string", valueName: "NAME", description: "Environment name." },
      { name: "base-branch", kind: "string", valueName: "BRANCH", description: "Base branch." },
      {
        name: "base-commit",
        kind: "string",
        valueName: "SHA",
        description: "Immutable base commit.",
      },
      {
        name: "network",
        kind: "string",
        valueName: "restricted|full",
        description: "Container network mode.",
      },
      ...PROMPT_OPTIONS,
      waitOption(["ready"]),
      TIMEOUT_OPTION,
      REQUEST_ID_OPTION,
    ],
    idOutput: "environment ID",
    async run(context, parsed) {
      const options = parsed.options;
      const projectId = stringOption(options, "project");
      if (!projectId) throw new CliError("invalid-input", "--project is required");
      const agent = stringOption(options, "agent");
      if (!agent) throw new CliError("invalid-input", "--agent is required");
      const prompt = await readPrompt(context.io, options);
      const input: Record<string, unknown> = {
        projectId,
        type: oneOf(options.type, ["local", "container"] as const, "--type"),
        agent,
        prompt,
        mode:
          options.mode === undefined
            ? "build"
            : oneOf(options.mode, ["plan", "build"] as const, "--mode"),
      };
      for (const [flag, key] of [
        ["model", "model"],
        ["reasoning", "reasoning"],
        ["name", "name"],
        ["base-branch", "baseBranch"],
        ["base-commit", "baseCommit"],
      ] as const) {
        if (options[flag] !== undefined) input[key] = options[flag];
      }
      const fast = optionalBoolean(options, "fast");
      if (fast !== undefined) input.fastMode = fast;
      if (options.network !== undefined) {
        input.networkAccessMode = oneOf(
          options.network,
          ["restricted", "full"] as const,
          "--network",
        );
      }
      const wait =
        options.wait === undefined ? undefined : oneOf(options.wait, ["ready"] as const, "--wait");
      const { session, result, receipt, warnings } = await submit<{
        environment: PublicEnvironmentSummary;
        sessionId: string;
      }>(context, "environment.launch", input, options);
      let environment = result.environment;
      let finalReceipt = receipt;
      if (wait) {
        const waited = await waitForEnvironment(
          context,
          session,
          result.environment.id,
          "ready",
          undefined,
          (options.timeout as number | undefined) ?? DEFAULT_WAIT_MS,
        );
        environment = waited.environment ?? environment;
        finalReceipt = receipt
          ? await session
              .readWithReceipt("run.get", { operationId: receipt.operationId })
              .then((read) => read.receipt ?? receipt)
          : receipt;
      }
      return {
        action: "environment.launch",
        result: { ...result, environment },
        receipt: finalReceipt,
        warnings,
        connection: session.identity,
        ids: [environment.id],
        human: [...environmentLines(environment), `session ${result.sessionId}`],
      };
    },
  },
  {
    path: ["environment", "exec"],
    summary: "Run one command in the environment workspace and report its exit status.",
    description:
      "Arguments after `--` are passed as argv without a shell; use `-- sh -c '...'` to opt into shell expansion. The command runs in a backend-owned worker that outlives this client; --wait observes it and exits with the operation's result (`--exit-code` passes the child's exit code through instead). Output is kept in bounded private artifacts; read it with `run output`.",
    positionals: [{ name: "environment", required: true }],
    acceptsRest: true,
    options: [
      {
        name: "cwd",
        kind: "string",
        valueName: "RELATIVE_DIR",
        description: "Working directory relative to the workspace root.",
      },
      {
        name: "env",
        kind: "list",
        valueName: "KEY=VALUE",
        description: "Extra environment variable (repeatable).",
      },
      {
        name: "stdin-file",
        kind: "string",
        valueName: "PATH",
        description: "Local file supplied as the command's stdin.",
      },
      {
        name: "exec-timeout",
        kind: "duration",
        valueName: "DURATION",
        description: "Kill the command after this long (default 30m, max 6h).",
      },
      { name: "wait", kind: "boolean", description: "Observe until the command exits." },
      {
        name: "exit-code",
        kind: "boolean",
        description: "With --wait: exit with the child's own exit code.",
      },
      TIMEOUT_OPTION,
      REQUEST_ID_OPTION,
    ],
    idOutput: "operation ID",
    async run(context, parsed) {
      const options = parsed.options;
      const argv = parsed.rest;
      if (argv.length === 0) throw new CliError("invalid-input", "Pass the command after `--`");
      if (argv.length > PUBLIC_API_LIMITS.execArgvMaxItems) {
        throw new CliError("input-too-large", "Too many command arguments");
      }
      const env: Record<string, string> = {};
      for (const raw of (options.env as string[] | undefined) ?? []) {
        const equals = raw.indexOf("=");
        if (equals <= 0) throw new CliError("invalid-input", "--env expects KEY=VALUE");
        env[raw.slice(0, equals)] = raw.slice(equals + 1);
      }
      let stdinBase64: string | undefined;
      if (options["stdin-file"] !== undefined) {
        const text = await readTextSource(context.io, {
          file: options["stdin-file"],
          label: "Command stdin",
          maxBytes: PUBLIC_API_LIMITS.execStdinMaxBytes,
          names: { file: "--stdin-file", stdin: "--stdin" },
          required: true,
        }).catch((error: unknown) => {
          if (error instanceof CliError && error.code === "empty-input") return "";
          throw error;
        });
        stdinBase64 = Buffer.from(text ?? "", "utf8").toString("base64");
      }
      if (options["exit-code"] === true && options.wait !== true) {
        throw new CliError("invalid-input", "--exit-code needs --wait");
      }
      const { session, receipt, result, warnings } = await submit<Record<string, unknown>>(
        context,
        "environment.exec",
        {
          environmentId: parsed.positionals.environment,
          argv,
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(stdinBase64 !== undefined ? { stdinBase64 } : {}),
          ...(options["exec-timeout"] !== undefined ? { timeoutMs: options["exec-timeout"] } : {}),
        },
        options,
      );
      if (!receipt) throw new CliError("response-invalid", "environment.exec returned no receipt");
      if (options.wait !== true) {
        return {
          action: "environment.exec",
          result,
          receipt,
          warnings,
          connection: session.identity,
          ids: [receipt.operationId],
          human: receiptLines(receipt),
        };
      }
      const final = await waitForOperation(
        context,
        session,
        receipt,
        (options.timeout as number | undefined) ?? DEFAULT_WAIT_MS,
      );
      // Human mode shows the command's own output (bounded tails); machine
      // modes read it explicitly with `run output`.
      const human: string[] = [];
      if (context.global.output === "human") {
        for (const stream of ["stdout", "stderr"] as const) {
          const window = await session
            .read<{ text: string; totalBytes: number; offset: number }>("run.output", {
              operationId: final.operationId,
              stream,
              tailBytes: 64 * 1024,
            })
            .catch(() => null);
          if (!window || window.totalBytes === 0) continue;
          if (window.offset > 0)
            human.push(`[${stream}: showing the last 64 KiB of ${window.totalBytes} bytes]`);
          if (stream === "stdout") context.io.stdout(window.text);
          else context.io.stderr(window.text);
        }
        human.push(
          `exit ${final.execution?.exitCode ?? "-"}${final.execution?.signal ? ` (${final.execution.signal})` : ""} · ${final.operationId}`,
        );
      }
      const outcome: CommandOutcome = {
        action: "environment.exec",
        result: { execution: final.execution ?? null },
        receipt: final,
        warnings,
        connection: session.identity,
        ids: [final.operationId],
        human,
      };
      if (options["exit-code"] === true) {
        const exitCode = final.execution?.exitCode;
        return {
          ...outcome,
          exitCodeOverride:
            typeof exitCode === "number" ? exitCode : final.execution?.signal ? 128 + 15 : 1,
        };
      }
      const failure = receiptFailure(final);
      return failure ? { ...outcome, failure } : outcome;
    },
  },
  ...settingsCommands("environment"),
];
