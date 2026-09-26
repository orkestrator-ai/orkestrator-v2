import { PUBLIC_API_LIMITS, type PublicReceipt } from "@orkestrator/protocol/public-api";
import type {
  PublicAgentOptions,
  PublicInteraction,
  PublicInteractionAnswerInput,
  PublicSessionSummary,
  PublicTranscriptPage,
} from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import { keyValues, receiptLines, sessionLines, sessionRows, table } from "../format.js";
import { readPrompt, readTextSource } from "../inputs.js";
import type { CommandContext, CommandOutcome, CommandSpec, ParsedCommand } from "../spec.js";
import { observe, ObservationStopped } from "../wait.js";
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
  waitForOperation,
} from "./common.js";

const WAIT_OPTIONS = [
  { name: "wait", kind: "boolean" as const, description: "Observe this run until its turn ends." },
  TIMEOUT_OPTION,
  {
    name: "continue-on-interaction",
    kind: "boolean" as const,
    description:
      "While waiting, keep waiting when the run needs an answer (another client may answer).",
  },
];

const CONTROL_OPTIONS = [
  {
    name: "model",
    kind: "string" as const,
    valueName: "MODEL",
    description: "Model ID from `agent options`.",
  },
  {
    name: "reasoning",
    kind: "string" as const,
    valueName: "LEVEL",
    description: "Reasoning level.",
  },
  {
    name: "fast",
    kind: "boolean" as const,
    negatable: true,
    description: "Fast speed where supported.",
  },
  {
    name: "mode",
    kind: "string" as const,
    valueName: "plan|build",
    description: "Conversation mode.",
  },
];

async function finishRun(
  context: CommandContext,
  parsed: ParsedCommand,
  base: CommandOutcome,
): Promise<CommandOutcome> {
  if (parsed.options.wait !== true || !base.receipt) {
    if (parsed.options.timeout !== undefined && parsed.options.wait !== true) {
      throw new CliError("invalid-input", "--timeout needs --wait");
    }
    return base;
  }
  const session = await context.session();
  const final = await waitForOperation(
    context,
    session,
    base.receipt,
    (parsed.options.timeout as number | undefined) ?? DEFAULT_WAIT_MS,
    { continueOnInteraction: parsed.options["continue-on-interaction"] === true },
  );
  const failure = receiptFailure(final);
  return {
    ...base,
    receipt: final,
    human: receiptLines(final),
    ...(failure ? { failure } : {}),
  };
}

function controlsInput(options: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (options.model !== undefined) input.model = options.model;
  if (options.reasoning !== undefined) input.reasoning = options.reasoning;
  const fast = optionalBoolean(options, "fast");
  if (fast !== undefined) input.fastMode = fast;
  if (options.mode !== undefined)
    input.mode = oneOf(options.mode, ["plan", "build"] as const, "--mode");
  return input;
}

function parseAnswers(options: Record<string, unknown>): PublicInteractionAnswerInput[] {
  const answers = new Map<string, PublicInteractionAnswerInput>();
  const entry = (questionId: string) => {
    const existing = answers.get(questionId) ?? { questionId };
    answers.set(questionId, existing);
    return existing;
  };
  for (const raw of (options.choose as string[] | undefined) ?? []) {
    const equals = raw.indexOf("=");
    if (equals <= 0)
      throw new CliError("invalid-input", "--choose expects QUESTION=OPTION[,OPTION]");
    const answer = entry(raw.slice(0, equals));
    answer.optionIds = [
      ...(answer.optionIds ?? []),
      ...raw
        .slice(equals + 1)
        .split(",")
        .filter(Boolean),
    ];
  }
  for (const raw of (options.text as string[] | undefined) ?? []) {
    const equals = raw.indexOf("=");
    if (equals <= 0) throw new CliError("invalid-input", "--text expects QUESTION=TEXT");
    const answer = entry(raw.slice(0, equals));
    if (answer.freeText !== undefined) {
      throw new CliError("invalid-input", "Each question takes at most one --text");
    }
    answer.freeText = raw.slice(equals + 1);
  }
  return [...answers.values()];
}

export const sessionCommands: CommandSpec[] = [
  {
    path: ["agent", "options"],
    summary: "Enabled agents, model catalogues (with freshness), and supported controls.",
    description:
      "Reads the backend's cached catalogues; --refresh asks providers again, which can take a while. An `empty` catalogue is a successful empty answer; `stale`/`unavailable` means the backend could not read it.",
    positionals: [],
    options: [
      {
        name: "environment",
        kind: "string",
        valueName: "ENVIRONMENT_ID",
        description: "Environment whose live catalogue to read.",
      },
      {
        name: "project",
        kind: "string",
        valueName: "PROJECT_ID",
        description: "Project (cached catalogue) when no environment is given.",
      },
      { name: "refresh", kind: "boolean", description: "Ask the providers for a fresh catalogue." },
    ],
    async run(context, parsed) {
      const environmentId = stringOption(parsed.options, "environment");
      const projectId = stringOption(parsed.options, "project");
      if ((environmentId ? 1 : 0) + (projectId ? 1 : 0) !== 1) {
        throw new CliError("invalid-input", "Pass --environment or --project");
      }
      const session = await context.session();
      const options = await session.read<PublicAgentOptions>("agent.options", {
        ...(environmentId ? { environmentId } : { projectId }),
        ...(parsed.options.refresh === true ? { refresh: true } : {}),
      });
      return {
        action: "agent.options",
        result: options,
        connection: session.identity,
        human: table(
          ["AGENT", "ENABLED", "CATALOGUE", "MODELS", "COMPLETION"],
          options.agents.map((agent) => [
            agent.agent,
            agent.enabled ? "yes" : "no",
            `${agent.catalogue.state} (${agent.catalogue.source})`,
            agent.catalogue.models
              .map((model) => model.id)
              .slice(0, 6)
              .join(", "),
            agent.completion,
          ]),
        ),
      };
    },
  },
  {
    path: ["session", "list"],
    summary: "List native-agent sessions of an environment (no transcripts are read).",
    positionals: [],
    options: [
      {
        name: "environment",
        kind: "string",
        valueName: "ENVIRONMENT_ID",
        description: "Environment.",
      },
    ],
    idOutput: "session IDs, one per line",
    async run(context, parsed) {
      const environmentId = stringOption(parsed.options, "environment");
      if (!environmentId) throw new CliError("invalid-input", "--environment is required");
      const session = await context.session();
      const sessions = await session.read<{ items: PublicSessionSummary[]; total: number }>(
        "session.list",
        { environmentId },
      );
      return {
        action: "session.list",
        result: sessions,
        connection: session.identity,
        ids: sessions.items.map((item) => item.id),
        human: sessionRows(sessions.items),
      };
    },
  },
  {
    path: ["session", "get"],
    summary: "Show one session (activity, latest request, pending interactions).",
    positionals: [{ name: "session", required: true }],
    options: [],
    idOutput: "session ID",
    async run(context, parsed) {
      const session = await context.session();
      const summary = await session.read<PublicSessionSummary>("session.get", {
        sessionId: parsed.positionals.session,
      });
      return {
        action: "session.get",
        result: summary,
        connection: session.identity,
        ids: [summary.id],
        human: sessionLines(summary),
      };
    },
  },
  {
    path: ["session", "start"],
    summary: "Start an independent conversation in a ready environment and send its first prompt.",
    description:
      "Creates a new agent tab without focusing it. The response is a submission receipt; add --wait (or run `run wait`) to observe the turn. Independent sessions in one environment share its files.",
    positionals: [],
    options: [
      {
        name: "environment",
        kind: "string",
        valueName: "ENVIRONMENT_ID",
        description: "Ready environment.",
      },
      {
        name: "agent",
        kind: "string",
        valueName: "AGENT",
        description: "claude, codex, cursor, grok, opencode or pi.",
      },
      { name: "title", kind: "string", valueName: "TITLE", description: "Tab title." },
      ...CONTROL_OPTIONS,
      ...PROMPT_OPTIONS,
      ...WAIT_OPTIONS,
      REQUEST_ID_OPTION,
    ],
    idOutput: "session ID",
    async run(context, parsed) {
      const options = parsed.options;
      const environmentId = stringOption(options, "environment");
      const agent = stringOption(options, "agent");
      if (!environmentId || !agent) {
        throw new CliError("invalid-input", "--environment and --agent are required");
      }
      const prompt = await readPrompt(context.io, options);
      const { session, result, receipt, warnings } = await submit<{
        sessionId: string;
        tabId: string;
        runId: string;
      }>(
        context,
        "session.start",
        {
          environmentId,
          agent,
          prompt,
          ...(options.title !== undefined ? { title: options.title } : {}),
          ...controlsInput(options),
        },
        options,
      );
      return finishRun(context, parsed, {
        action: "session.start",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.sessionId],
        human: [
          ...keyValues([
            ["session", result.sessionId],
            ["run", result.runId],
          ]),
        ],
      });
    },
  },
  {
    path: ["session", "prompt"],
    summary: "Send a follow-up prompt to an idle session.",
    description:
      "Busy sessions are refused (exit 8); use `session steer` to redirect an active turn. The target must be the exact session: a vanished session is never replaced by a new one.",
    positionals: [{ name: "session", required: true }],
    options: [
      {
        name: "mode",
        kind: "string",
        valueName: "plan|build",
        description: "Conversation mode for this turn.",
      },
      ...PROMPT_OPTIONS,
      ...WAIT_OPTIONS,
      REQUEST_ID_OPTION,
    ],
    idOutput: "operation (run) ID",
    async run(context, parsed) {
      const options = parsed.options;
      const prompt = await readPrompt(context.io, options);
      const { session, result, receipt, warnings } = await submit<{ runId: string }>(
        context,
        "session.prompt",
        {
          sessionId: parsed.positionals.session,
          prompt,
          ...(options.mode !== undefined
            ? { mode: oneOf(options.mode, ["plan", "build"] as const, "--mode") }
            : {}),
        },
        options,
      );
      return finishRun(context, parsed, {
        action: "session.prompt",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.runId],
        human: receipt ? receiptLines(receipt) : [`run ${result.runId}`],
      });
    },
  },
  {
    path: ["session", "stop"],
    summary: "Stop the session's current turn (not the environment).",
    description:
      "--expect-run binds the stop to that run: if a different turn is now active the stop is refused (exit 8). Success requires the provider to confirm the turn ended; otherwise the result is unknown (exit 7).",
    positionals: [{ name: "session", required: true }],
    options: [
      {
        name: "expect-run",
        kind: "string",
        valueName: "OPERATION_ID",
        description: "Only stop if this run's turn is the active one.",
      },
      REQUEST_ID_OPTION,
    ],
    idOutput: "operation ID",
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit(
        context,
        "session.stop",
        {
          sessionId: parsed.positionals.session,
          ...(parsed.options["expect-run"] !== undefined
            ? { expectedOperationId: parsed.options["expect-run"] }
            : {}),
        },
        parsed.options,
      );
      return {
        action: "session.stop",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: receipt ? [receipt.operationId] : [],
        human: receipt ? receiptLines(receipt) : ["stopped"],
      };
    },
  },
  {
    path: ["session", "steer"],
    summary: "Redirect the active turn (providers that support steering only).",
    positionals: [{ name: "session", required: true }],
    options: [
      {
        name: "text-file",
        kind: "string",
        valueName: "PATH",
        description: "Read the steering text from a file.",
      },
      { name: "text-stdin", kind: "boolean", description: "Read the steering text from stdin." },
      { name: "text", kind: "string", valueName: "TEXT", description: "Inline steering text." },
      {
        name: "expect-run",
        kind: "string",
        valueName: "OPERATION_ID",
        description: "Only steer if this run's turn is active.",
      },
      REQUEST_ID_OPTION,
    ],
    idOutput: "operation ID",
    async run(context, parsed) {
      const text = await readTextSource(context.io, {
        file: parsed.options["text-file"],
        stdin: parsed.options["text-stdin"],
        inline: parsed.options.text,
        label: "Steering text",
        maxBytes: PUBLIC_API_LIMITS.steerMaxBytes,
        names: { file: "--text-file", stdin: "--text-stdin", inline: "--text" },
        required: true,
      });
      const { session, result, receipt, warnings } = await submit(
        context,
        "session.steer",
        {
          sessionId: parsed.positionals.session,
          text,
          ...(parsed.options["expect-run"] !== undefined
            ? { expectedOperationId: parsed.options["expect-run"] }
            : {}),
        },
        parsed.options,
      );
      return {
        action: "session.steer",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: receipt ? [receipt.operationId] : [],
        human: receipt ? receiptLines(receipt) : ["steered"],
      };
    },
  },
  {
    path: ["session", "config", "get"],
    summary: "Show the live session's effective controls.",
    positionals: [{ name: "session", required: true }],
    options: [],
    async run(context, parsed) {
      const session = await context.session();
      const controls = await session.read<Record<string, unknown>>("session.config.get", {
        sessionId: parsed.positionals.session,
      });
      return {
        action: "session.config.get",
        result: controls,
        connection: session.identity,
        human: keyValues(Object.entries(controls)),
      };
    },
  },
  {
    path: ["session", "config", "set"],
    summary: "Change the live session's controls (not environment defaults).",
    description:
      "Applies to this conversation now, as validated by its provider; the response shows the values actually in force (a provider may clamp them). To change defaults for future sessions use `environment config set`.",
    positionals: [{ name: "session", required: true }],
    options: [...CONTROL_OPTIONS, REQUEST_ID_OPTION],
    async run(context, parsed) {
      const controls = controlsInput(parsed.options);
      if (Object.keys(controls).length === 0)
        throw new CliError("invalid-input", "Nothing to change");
      const { session, result, receipt, warnings } = await submit<Record<string, unknown>>(
        context,
        "session.config.set",
        { sessionId: parsed.positionals.session, ...controls },
        parsed.options,
      );
      return {
        action: "session.config.set",
        result,
        receipt,
        warnings,
        connection: session.identity,
        human: keyValues(Object.entries(result)),
      };
    },
  },
  {
    path: ["session", "history"],
    summary: "List earlier provider conversations this session can resume.",
    positionals: [{ name: "session", required: true }],
    options: [],
    async run(context, parsed) {
      const session = await context.session();
      const history = await session.read<{ items: Array<Record<string, unknown>> }>(
        "session.history",
        {
          sessionId: parsed.positionals.session,
        },
      );
      return {
        action: "session.history",
        result: history,
        connection: session.identity,
        human: table(
          ["HISTORY ID", "TITLE", "UPDATED"],
          history.items.map((item) => [
            String(item.id),
            String(item.title ?? ""),
            String(item.updatedAt ?? ""),
          ]),
        ),
      };
    },
  },
  {
    path: ["session", "resume"],
    summary: "Rebind the session to an earlier conversation from `session history`.",
    description: "The current conversation's history is kept; nothing is deleted.",
    positionals: [
      { name: "session", required: true },
      { name: "history-id", required: true },
    ],
    options: [REQUEST_ID_OPTION],
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit(
        context,
        "session.resume",
        { sessionId: parsed.positionals.session, historyId: parsed.positionals["history-id"] },
        parsed.options,
      );
      return { action: "session.resume", result, receipt, warnings, connection: session.identity };
    },
  },
  {
    path: ["session", "fork"],
    summary: "Fork the conversation into a new session (optionally at a message).",
    positionals: [{ name: "session", required: true }],
    options: [
      {
        name: "message",
        kind: "string",
        valueName: "MESSAGE_ID",
        description: "Fork point from the transcript.",
      },
      REQUEST_ID_OPTION,
    ],
    idOutput: "new session ID",
    async run(context, parsed) {
      const { session, result, receipt, warnings } = await submit<{ sessionId: string }>(
        context,
        "session.fork",
        {
          sessionId: parsed.positionals.session,
          ...(parsed.options.message !== undefined ? { messageId: parsed.options.message } : {}),
        },
        parsed.options,
      );
      return {
        action: "session.fork",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.sessionId],
        human: [`forked into ${result.sessionId}`],
      };
    },
  },
  {
    path: ["session", "interactions", "list"],
    summary: "List pending questions and approvals with their permitted answers.",
    positionals: [{ name: "session", required: true }],
    options: [],
    idOutput: "interaction IDs, one per line",
    async run(context, parsed) {
      const session = await context.session();
      const interactions = await session.read<{ items: PublicInteraction[] }>(
        "session.interactions",
        {
          sessionId: parsed.positionals.session,
        },
      );
      return {
        action: "session.interactions",
        result: interactions,
        connection: session.identity,
        ids: interactions.items.map((item) => item.id),
        human: interactions.items.length
          ? interactions.items.flatMap((item) => [
              `${item.id}  ${item.kind}  revision ${item.revision}  ${item.title}`,
              ...item.questions.map(
                (question) =>
                  `  ${question.id}: ${question.prompt} [${question.options.map((option) => option.id).join(", ")}]${question.allowFreeText ? " (free text)" : ""}`,
              ),
              `  actions: ${item.actions.join(", ")}`,
            ])
          : ["(no pending interactions)"],
      };
    },
  },
  {
    path: ["session", "interactions", "resolve"],
    summary: "Answer one pending interaction at its current revision.",
    description:
      "--revision must match the interaction's current revision; a replaced or expired interaction is refused (exit 8), never answered. Nothing is approved implicitly.",
    positionals: [
      { name: "session", required: true },
      { name: "interaction", required: true },
    ],
    options: [
      {
        name: "revision",
        kind: "integer",
        valueName: "N",
        description: "Expected interaction revision (from `interactions list`).",
      },
      {
        name: "action",
        kind: "string",
        valueName: "ACTION",
        description: "answer, approve-for-session, decline, deny or cancel.",
      },
      {
        name: "choose",
        kind: "list",
        valueName: "QUESTION=OPTION[,OPTION]",
        description: "Select option(s) for a question (repeatable).",
      },
      {
        name: "text",
        kind: "list",
        valueName: "QUESTION=TEXT",
        description: "Free-text answer for a question (repeatable).",
      },
      {
        name: "feedback",
        kind: "string",
        valueName: "TEXT",
        description: "Plan feedback when declining a plan.",
      },
      REQUEST_ID_OPTION,
    ],
    async run(context, parsed) {
      const options = parsed.options;
      if (typeof options.revision !== "number")
        throw new CliError("invalid-input", "--revision is required");
      const action = oneOf(
        options.action,
        ["answer", "approve-for-session", "decline", "deny", "cancel"] as const,
        "--action",
      );
      const answers = parseAnswers(options);
      if (action === "answer" && answers.length === 0) {
        throw new CliError("invalid-input", "--action answer needs --choose or --text");
      }
      if (action !== "answer" && answers.length > 0) {
        throw new CliError("invalid-input", "--choose/--text only apply to --action answer");
      }
      const { session, result, receipt, warnings } = await submit(
        context,
        "session.interaction.resolve",
        {
          sessionId: parsed.positionals.session,
          interactionId: parsed.positionals.interaction,
          expectedRevision: options.revision,
          action,
          ...(answers.length > 0 ? { answers } : {}),
          ...(options.feedback !== undefined ? { feedback: options.feedback } : {}),
        },
        options,
      );
      return {
        action: "session.interaction.resolve",
        result,
        receipt,
        warnings,
        connection: session.identity,
        human: receipt ? receiptLines(receipt) : ["resolved"],
      };
    },
  },
  {
    path: ["session", "transcript"],
    summary: "Read a bounded transcript page; --follow polls for new messages.",
    description:
      "Pages are oldest-first and hold at most --limit messages (max 100). Pass the returned olderCursor as --before for earlier history. --follow --jsonl streams one record per new message by polling snapshots; it stops at --timeout or Ctrl+C and never affects the session.",
    positionals: [{ name: "session", required: true }],
    options: [
      {
        name: "limit",
        kind: "integer",
        valueName: "N",
        description: "Messages per page (default 30, max 100).",
      },
      {
        name: "before",
        kind: "string",
        valueName: "CURSOR",
        description: "Older page cursor from a previous read.",
      },
      {
        name: "follow",
        kind: "boolean",
        description: "Keep polling and print new messages (use --jsonl for machines).",
      },
      TIMEOUT_OPTION,
    ],
    jsonl: true,
    async run(context, parsed) {
      const session = await context.session();
      const input: Record<string, unknown> = { sessionId: parsed.positionals.session };
      if (parsed.options.limit !== undefined) input.limit = parsed.options.limit;
      if (parsed.options.before !== undefined) input.before = parsed.options.before;
      if (parsed.options.follow !== true) {
        if (context.global.output === "jsonl") {
          throw new CliError("invalid-input", "--jsonl needs --follow");
        }
        const page = await session.read<PublicTranscriptPage>("session.transcript", input);
        return {
          action: "session.transcript",
          result: page,
          connection: session.identity,
          human: [
            ...page.messages.flatMap((message) => [
              `[${message.role}] ${message.createdAt ?? ""} ${message.id}`,
              ...message.text.split("\n").map((line) => `  ${line}`),
              ...message.parts.map(
                (part) =>
                  `  <${part.type}${part.toolName ? ` ${part.toolName}` : ""}${part.status ? ` ${part.status}` : ""}>`,
              ),
            ]),
            ...(page.olderCursor ? [`older: --before ${page.olderCursor}`] : []),
          ],
        };
      }
      if (parsed.options.before !== undefined) {
        throw new CliError("invalid-input", "--follow reads the newest messages; drop --before");
      }
      const seen = new Set<string>();
      let lastToken: string | null = null;
      let emitted = 0;
      const emit = (record: Record<string, unknown>) => {
        if (context.global.output === "jsonl") context.io.stdout(`${JSON.stringify(record)}\n`);
        else if (context.global.output === "human" && record.type === "message") {
          const message = record.message as PublicTranscriptPage["messages"][number];
          context.io.stdout(`[${message.role}] ${message.text}\n`);
        }
      };
      try {
        await observe<never>(
          async () => {
            const page = await session.read<PublicTranscriptPage>("session.transcript", {
              ...input,
              limit: PUBLIC_API_LIMITS.transcriptMaxMessages,
            });
            if (page.token !== null && page.token === lastToken) return { done: false };
            if (
              lastToken !== null &&
              page.messages.length > 0 &&
              !page.messages.some((m) => seen.has(m.id))
            ) {
              // Everything in the window is new: messages between polls may be
              // beyond the window. Say so instead of silently skipping them.
              emit({
                type: "gap",
                reason: "more new messages than one page; read history with --before",
              });
            }
            lastToken = page.token;
            for (const message of page.messages) {
              if (seen.has(message.id)) continue;
              seen.add(message.id);
              emitted += 1;
              emit({ type: "message", sessionId: page.sessionId, message });
            }
            if (seen.size > 10_000) seen.clear();
            return { done: false };
          },
          {
            timeoutMs: (parsed.options.timeout as number | undefined) ?? DEFAULT_WAIT_MS,
            signal: context.signal,
          },
        );
      } catch (error) {
        if (!(error instanceof ObservationStopped)) throw error;
      }
      return {
        action: "session.transcript",
        result: { followed: true, emitted },
        connection: session.identity,
        human: [],
      };
    },
  },
];

export type { PublicReceipt };
