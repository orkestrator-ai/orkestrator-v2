import { publicGraphTemplateRefText } from "@orkestrator/protocol/public-api-inputs-graph";
import type {
  ScheduleAction,
  ScheduledJob,
  ScheduledJobSummary,
} from "@orkestrator/protocol/scheduled-jobs";
import { describeScheduleTrigger } from "@orkestrator/protocol/scheduled-jobs";
import { CliError } from "../errors.js";
import { keyValues, table } from "../format.js";
import { readTextSource } from "../inputs.js";
import type { CommandContext, CommandSpec, OptionSpec } from "../spec.js";
import { oneOf, PROMPT_OPTIONS, REQUEST_ID_OPTION, stringOption, submit } from "./common.js";
import { GRAPH_LAUNCH_OPTIONS, graphLaunchInput, graphScheduleLaunchRequest } from "./graphs.js";

/**
 * `orkestrator schedule …`: scheduled jobs owned by the operator. The backend
 * owns the timing; these commands only create, inspect and manage schedules.
 */

const SCHEDULE_ID = { name: "schedule", required: true, description: "Schedule ID (sch_...)." };

const TIMING_OPTIONS: OptionSpec[] = [
  {
    name: "at",
    kind: "string",
    valueName: "TIME",
    description:
      "Once: HH:MM (next occurrence), YYYY-MM-DDTHH:MM, an ISO time with an offset, or +15m.",
  },
  {
    name: "cron",
    kind: "string",
    valueName: "EXPR",
    description: 'Recurring: five-field cron, e.g. "0 9 * * 1-5", or @daily.',
  },
  {
    name: "every",
    kind: "duration",
    valueName: "DURATION",
    description: "Recurring: a fixed interval (at least 1m).",
  },
  {
    name: "start-at",
    kind: "string",
    valueName: "TIME",
    description: "With --every: the first fire.",
  },
  {
    name: "time-zone",
    kind: "string",
    valueName: "ZONE",
    description: "IANA zone for --at and --cron, e.g. Europe/London. Default: the backend host's.",
  },
  {
    name: "catch-up-minutes",
    kind: "integer",
    valueName: "N",
    description:
      "Run a fire missed while the backend was down if at most N minutes late (default 15).",
  },
  { name: "name", kind: "string", valueName: "TEXT", description: "Label shown in lists." },
];

const ACTION_OPTIONS: OptionSpec[] = [
  {
    name: "mail",
    kind: "string",
    valueName: "ENV:TAB",
    description: "Action: send agent mail (mail.send) to this mailbox.",
  },
  { name: "subject", kind: "string", valueName: "TEXT", description: "With --mail: subject." },
  { name: "body", kind: "string", valueName: "TEXT", description: "With --mail: message text." },
  {
    name: "body-file",
    kind: "string",
    valueName: "PATH",
    description: "With --mail: read the text from a file.",
  },
  {
    name: "session",
    kind: "string",
    valueName: "SESSION",
    description:
      "Action: prompt this idle session (session.prompt); give the prompt with --prompt…",
  },
  {
    name: "launch-project",
    kind: "string",
    valueName: "PROJECT_ID",
    description: "Action: launch an environment in this project (environment.launch).",
  },
  {
    name: "agent",
    kind: "string",
    valueName: "AGENT",
    description: "With --launch-project: agent platform.",
  },
  {
    name: "type",
    kind: "string",
    valueName: "TYPE",
    description: "With --launch-project: local (default) or container.",
  },
  {
    name: "model",
    kind: "string",
    valueName: "MODEL",
    description: "With --launch-project: model ID.",
  },
  {
    name: "base-branch",
    kind: "string",
    valueName: "BRANCH",
    description: "With --launch-project: base branch.",
  },
  {
    name: "base-commit",
    kind: "string",
    valueName: "SHA",
    description:
      "With --launch-project: pin this commit; omitted, the branch's newest commit at fire time.",
  },
  {
    name: "mode",
    kind: "string",
    valueName: "MODE",
    description: "With --session or --launch-project: plan or build.",
  },
  {
    name: "action",
    kind: "string",
    valueName: "ACTION",
    description: "Action: any public mutation by name (e.g. ticket.comment) with --input-json.",
  },
  {
    name: "input-json",
    kind: "string",
    valueName: "JSON",
    description: "With --action: its input object.",
  },
  {
    name: "graph",
    kind: "string",
    valueName: "TEMPLATE",
    description:
      "Action: launch this saved graph template (builtin:ID, user:ID or project:FILE) with --project and one of --environment, --new-worktree, --new-container.",
  },
  {
    name: "project",
    kind: "string",
    valueName: "PROJECT_ID",
    description: "With --graph: the project the run belongs to.",
  },
  ...GRAPH_LAUNCH_OPTIONS.map((option) => ({
    ...option,
    description: `With --graph: ${option.description.charAt(0).toLowerCase()}${option.description.slice(1)}`,
  })),
  ...PROMPT_OPTIONS,
];

/** Flags that only describe a `--graph` launch. */
const GRAPH_ONLY_OPTIONS = ["project", ...GRAPH_LAUNCH_OPTIONS.map((option) => option.name)];

/** Every action-building flag fills the one `action` input property. */
const ACTION_INPUT_FIELDS: Record<string, string> = Object.fromEntries(
  ACTION_OPTIONS.map((option) => [option.name, "action"]),
);

function timingInput(options: Record<string, unknown>): Record<string, unknown> {
  const every = options.every;
  if (typeof every === "number" && every % 1000 !== 0) {
    throw new CliError("invalid-input", "--every must be whole seconds");
  }
  const at = stringOption(options, "at");
  const cron = stringOption(options, "cron");
  const startAt = stringOption(options, "start-at");
  const timeZone = stringOption(options, "time-zone");
  const name = stringOption(options, "name");
  return {
    ...(at !== undefined ? { at } : {}),
    ...(cron !== undefined ? { cron } : {}),
    ...(typeof every === "number" ? { everySeconds: every / 1000 } : {}),
    ...(startAt !== undefined ? { startAt } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(typeof options["catch-up-minutes"] === "number"
      ? { catchUpMinutes: options["catch-up-minutes"] }
      : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

async function actionInput(
  context: CommandContext,
  options: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const io = context.io;
  const chosen = ["mail", "session", "launch-project", "action", "graph"].filter(
    (name) => options[name] !== undefined,
  );
  if (chosen.length > 1) {
    throw new CliError("invalid-input", `--${chosen.join(", --")} are mutually exclusive`);
  }
  if (chosen[0] !== "graph") {
    const stray = GRAPH_ONLY_OPTIONS.find((name) => isGiven(options[name]));
    if (stray) throw new CliError("invalid-input", `--${stray} needs --graph`);
  }
  if (chosen.length === 0) return undefined;
  const prompt = () =>
    readTextSource(io, {
      file: options["prompt-file"],
      stdin: options["prompt-stdin"],
      inline: options.prompt,
      label: "Prompt",
      maxBytes: 400_000,
      names: { file: "--prompt-file", stdin: "--prompt-stdin", inline: "--prompt" },
      required: true,
    });
  const mode =
    options.mode !== undefined
      ? { mode: oneOf(options.mode, ["plan", "build"] as const, "--mode") }
      : {};
  switch (chosen[0]) {
    case "mail": {
      const [environmentId, tabId, extra] = String(options.mail).split(":");
      if (!environmentId || !tabId || extra !== undefined) {
        throw new CliError("invalid-input", "--mail expects ENVIRONMENT_ID:TAB_ID");
      }
      const body = await readTextSource(io, {
        file: options["body-file"],
        inline: options.body,
        label: "Message",
        maxBytes: 32 * 1024,
        names: { file: "--body-file", stdin: "--body-stdin", inline: "--body" },
        required: true,
      });
      const subject = stringOption(options, "subject");
      return {
        kind: "action",
        action: "mail.send",
        input: {
          toEnvironmentId: environmentId,
          toTabId: tabId,
          body,
          ...(subject ? { subject } : {}),
        },
      };
    }
    case "session":
      return { kind: "prompt", sessionId: options.session, prompt: await prompt(), ...mode };
    case "graph": {
      // The same flags and checks as `graph launch`; the schedule stores the
      // launch request and each fire launches it (`requestedBy: "schedule"`).
      const launch = await graphLaunchInput(context, String(options.graph), options);
      return { kind: "graph", request: graphScheduleLaunchRequest(launch) };
    }
    case "launch-project": {
      const agent = stringOption(options, "agent");
      if (!agent) throw new CliError("invalid-input", "--launch-project needs --agent");
      const type =
        options.type === undefined
          ? "local"
          : oneOf(options.type, ["local", "container"] as const, "--type");
      const model = stringOption(options, "model");
      const baseBranch = stringOption(options, "base-branch");
      const baseCommit = stringOption(options, "base-commit");
      return {
        kind: "launch",
        projectId: options["launch-project"],
        agent,
        type,
        prompt: await prompt(),
        ...mode,
        ...(model ? { model } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        ...(baseCommit ? { baseCommit } : {}),
      };
    }
    default: {
      let input: unknown = {};
      const raw = stringOption(options, "input-json");
      if (raw !== undefined) {
        try {
          input = JSON.parse(raw) as unknown;
        } catch {
          throw new CliError("invalid-input", "--input-json is not valid JSON");
        }
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new CliError("invalid-input", "--input-json must be a JSON object");
      }
      return { kind: "action", action: options.action, input };
    }
  }
}

/** A flag the parser filled: a value, a true boolean or a non-empty list. */
function isGiven(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== false;
}

function actionText(action: ScheduleAction): string {
  if (action.kind === "action") return action.action;
  if (action.kind === "graph") return `graph ${publicGraphTemplateRefText(action.request.ref)}`;
  return action.kind;
}

function lastOutcome(job: ScheduledJobSummary): string {
  const fire = job.activeFire ?? job.lastFire;
  if (!fire) return "-";
  return fire.error ? `${fire.state}: ${fire.error.code}` : fire.state;
}

function scheduleLines(job: ScheduledJob): string[] {
  return [
    ...keyValues([
      ["id", job.id],
      ["name", job.name],
      ["owner", job.ownerLabel],
      ["state", job.pausedReason ? `${job.state} (${job.pausedReason})` : job.state],
      ["when", describeScheduleTrigger(job.trigger, job.timeZone)],
      ["time zone", job.timeZone],
      ["next fire", job.nextFireAt ?? "-"],
      ["catch-up", `${job.catchUpMinutes} min`],
      ["action", actionText(job.action)],
    ]),
    "",
    ...table(
      ["FIRE", "SLOT", "STATE", "ERROR"],
      [...job.fires]
        .reverse()
        .map((fire) => [
          fire.fireId,
          fire.scheduledFor,
          fire.state,
          fire.error ? `${fire.error.code}: ${fire.error.message}` : "",
        ]),
    ),
  ];
}

function simpleMutation(verb: "pause" | "resume" | "run" | "delete", summary: string): CommandSpec {
  const action = `schedule.${verb}` as const;
  return {
    path: ["schedule", verb],
    action,
    summary,
    positionals: [SCHEDULE_ID],
    options: [REQUEST_ID_OPTION],
    inputFields: { schedule: "scheduleId" },
    idOutput: "schedule ID",
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit<Record<string, unknown>>(
        context,
        action,
        { scheduleId: parsed.positionals.schedule },
        parsed.options,
      );
      return {
        action,
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [String(parsed.positionals.schedule)],
        human: keyValues(Object.entries(result)),
      };
    },
  };
}

export const scheduleCommands: CommandSpec[] = [
  {
    path: ["schedule", "list"],
    action: "schedule.list",
    summary: "List scheduled jobs with their next fire, owner and last outcome.",
    positionals: [],
    options: [
      {
        name: "project",
        kind: "string",
        valueName: "PROJECT_ID",
        description: "Owned in or aimed at this project.",
      },
      {
        name: "state",
        kind: "string",
        valueName: "STATE",
        description: "active, paused or completed.",
      },
      {
        name: "owner-kind",
        kind: "string",
        valueName: "KIND",
        description: "operator, control-mcp, agent or coordinator.",
      },
      { name: "offset", kind: "integer", valueName: "N", description: "Rows to skip." },
      { name: "limit", kind: "integer", valueName: "N", description: "Rows (max 200)." },
    ],
    async run(context, parsed) {
      const session = await context.session();
      const options = parsed.options;
      const page = await session.read<{ schedules: ScheduledJobSummary[]; total: number }>(
        "schedule.list",
        {
          ...(options.project !== undefined ? { projectId: options.project } : {}),
          ...(options.state !== undefined ? { state: options.state } : {}),
          ...(options["owner-kind"] !== undefined ? { ownerKind: options["owner-kind"] } : {}),
          ...(options.offset !== undefined ? { offset: options.offset } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        },
      );
      return {
        action: "schedule.list",
        result: page,
        connection: session.identity,
        human: table(
          ["ID", "NAME", "STATE", "NEXT FIRE", "OWNER", "LAST"],
          page.schedules.map((job) => [
            job.id,
            job.name,
            job.state,
            job.nextFireAt ?? "-",
            job.ownerLabel,
            lastOutcome(job),
          ]),
        ),
      };
    },
  },
  {
    path: ["schedule", "get"],
    action: "schedule.get",
    summary: "Show one scheduled job and its fire history.",
    positionals: [SCHEDULE_ID],
    options: [],
    inputFields: { schedule: "scheduleId" },
    async run(context, parsed) {
      const session = await context.session();
      const result = await session.read<{ schedule: ScheduledJob }>("schedule.get", {
        scheduleId: parsed.positionals.schedule,
      });
      return {
        action: "schedule.get",
        result,
        connection: session.identity,
        human: scheduleLines(result.schedule),
      };
    },
  },
  {
    path: ["schedule", "create"],
    action: "schedule.create",
    summary: "Schedule mail, a prompt, an environment launch, a graph run or another action.",
    description:
      "Give one of --at, --cron or --every, and one action: --mail ENV:TAB with --body, --session SES with --prompt, --launch-project P with --agent and --prompt, --graph TEMPLATE with --project and where it runs (the flags of `graph launch`), or --action NAME with --input-json. A graph template must be launchable when the schedule is created; roles and parameters left out take its saved launch defaults when it fires.",
    positionals: [],
    options: [
      ...TIMING_OPTIONS,
      { name: "paused", kind: "boolean", description: "Create it paused." },
      ...ACTION_OPTIONS,
      REQUEST_ID_OPTION,
    ],
    inputFields: { ...ACTION_INPUT_FIELDS, every: "everySeconds", "start-at": "startAt" },
    idOutput: "schedule ID",
    examples: [
      'orkestrator schedule create --at 03:12 --mail env-1:startup-agent --body "Resume the stalled workers."',
      'orkestrator schedule create --cron "0 9 * * 1-5" --session ses_... --prompt "Summarise CI failures."',
      'orkestrator schedule create --cron "0 2 * * *" --graph user:nightly-review --project p1 --new-worktree --role reviewer=claude,codex',
    ],
    async run(context, parsed) {
      const action = await actionInput(context, parsed.options);
      if (!action)
        throw new CliError(
          "invalid-input",
          "Choose an action: --mail, --session, --launch-project, --graph or --action",
        );
      const { session, result, receipt, warnings } = await submit<{
        scheduleId: string;
        nextFireAt: string | null;
      }>(
        context,
        "schedule.create",
        {
          ...timingInput(parsed.options),
          ...(parsed.options.paused === true ? { paused: true } : {}),
          action,
        },
        parsed.options,
      );
      return {
        action: "schedule.create",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.scheduleId],
        human: [`scheduled ${result.scheduleId}; next fire ${result.nextFireAt ?? "none"}`],
      };
    },
  },
  {
    path: ["schedule", "update"],
    action: "schedule.update",
    summary: "Change a schedule's time, zone, catch-up window, name or action.",
    positionals: [SCHEDULE_ID],
    options: [
      ...TIMING_OPTIONS,
      ...ACTION_OPTIONS,
      {
        name: "expected-revision",
        kind: "integer",
        valueName: "N",
        description: "Apply only at this revision.",
      },
      REQUEST_ID_OPTION,
    ],
    inputFields: {
      ...ACTION_INPUT_FIELDS,
      schedule: "scheduleId",
      every: "everySeconds",
      "start-at": "startAt",
    },
    idOutput: "schedule ID",
    async run(context, parsed) {
      const action = await actionInput(context, parsed.options);
      const { session, result, receipt, warnings } = await submit<Record<string, unknown>>(
        context,
        "schedule.update",
        {
          scheduleId: parsed.positionals.schedule,
          ...timingInput(parsed.options),
          ...(action ? { action } : {}),
          ...(typeof parsed.options["expected-revision"] === "number"
            ? { expectedRevision: parsed.options["expected-revision"] }
            : {}),
        },
        parsed.options,
      );
      return {
        action: "schedule.update",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [String(parsed.positionals.schedule)],
        human: keyValues(Object.entries(result)),
      };
    },
  },
  simpleMutation("pause", "Pause a schedule; nothing fires until it is resumed."),
  simpleMutation("resume", "Resume a paused schedule from its next future slot."),
  simpleMutation("run", "Fire a schedule once now, leaving its regular slots unchanged."),
  simpleMutation("delete", "Delete a schedule and its history."),
];
