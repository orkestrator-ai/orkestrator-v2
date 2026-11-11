/**
 * CLI drivers for `bun scripts/multi-review-evaluation.ts live`: one bounded,
 * tool-free, non-persistent consolidation turn per call, with the structured
 * review report schema enforced by the CLI.
 *
 * - Claude: `claude -p --output-format json --json-schema <schema> --tools ""
 *   --no-session-persistence --strict-mcp-config`. The answer is the result's
 *   `structured_output`; usage is the result's `usage`.
 * - Codex: `codex exec --json --output-schema <file> --output-last-message
 *   <file>`, ephemeral, read-only sandbox, approvals off, user config and
 *   rules ignored, and every tool-bearing feature disabled (the same profile
 *   as the session-title runner, `session-title-runners.ts`, but on the
 *   requested model rather than a custom catalog). The answer is the last
 *   message parsed as JSON; usage is the last `turn.completed` event. Codex
 *   reports no cost. Its environment context is switched off, so the working
 *   directory is not part of the prompt.
 *
 * Each CLI runs through the shared command capture (`runChild`): its own
 * process group, SIGTERM then SIGKILL on the whole group at the deadline, and
 * bounded output, so a CLI that ignores SIGTERM cannot hang the script.
 *
 * Every call runs in a fresh temporary directory unless the caller names one
 * shared directory. The Codex schema and answer files live in their own
 * temporary directory, so a shared working directory stays empty.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandFailedError, runCommand } from "@orkestrator/protocol/node/command-capture";
import { STRUCTURED_REVIEW_REPORT_JSON_SCHEMA } from "@orkestrator/protocol/structured-review";
import {
  CODEX_TITLE_CONFIG_OVERRIDES,
  DISABLED_CODEX_TITLE_FEATURES,
} from "../apps/backend/src/core/session-title-runners.js";

export const EVALUATION_PROVIDERS = ["claude", "codex"] as const;
export type EvaluationProvider = (typeof EVALUATION_PROVIDERS)[number];

/** The model alias used when `--model` is absent. Codex uses its CLI default. */
export const DEFAULT_EVALUATION_MODEL: Record<EvaluationProvider, string | undefined> = {
  claude: "sonnet",
  codex: undefined,
};

/** Environment variable naming each provider's executable (else it is looked up on PATH). */
export const EVALUATION_EXECUTABLE_ENV: Record<EvaluationProvider, string> = {
  claude: "CLAUDE_CLI_PATH",
  codex: "CODEX_CLI_PATH",
};

export const CONSOLIDATION_TURN_TIMEOUT_MS = 15 * 60_000;
const VERSION_TIMEOUT_MS = 30_000;
/** Largest Codex answer file read back; a report is bounded far below this. */
const MAX_CODEX_ANSWER_BYTES = 8 * 1024 * 1024;

/** One consolidation turn's outcome, without any prompt or answer text beyond `answer`. */
export interface ConsolidationTurn {
  ok: boolean;
  /** A content-free reason when `ok` is false (`exit 1`, `turn.failed`, …). */
  failure?: string;
  /** The model's answer as parsed JSON, when there is one. */
  answer?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export function isEvaluationProvider(value: string): value is EvaluationProvider {
  return (EVALUATION_PROVIDERS as readonly string[]).includes(value);
}

export function claudeConsolidationArgs(model: string | undefined): string[] {
  return [
    "-p",
    ...(model ? ["--model", model] : []),
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA),
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Reads `claude -p --output-format json` output. */
export function parseClaudeResult(stdout: string, exitCode: number): ConsolidationTurn {
  if (exitCode !== 0) return { ok: false, failure: `exit ${exitCode}` };
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { ok: false, failure: "unparseable result" };
  }
  const usage = (result.usage ?? {}) as Record<string, unknown>;
  const ok = result.is_error !== true && result.subtype === "success";
  return {
    ok,
    ...(ok ? {} : { failure: typeof result.subtype === "string" ? result.subtype : "error" }),
    ...(result.structured_output === undefined ? {} : { answer: result.structured_output }),
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    costUsd: count(result.total_cost_usd),
  };
}

export function codexConsolidationArgs(input: {
  cwd: string;
  model: string | undefined;
  schemaPath: string;
  outputPath: string;
}): string[] {
  return [
    ...(input.model ? ["--model", input.model] : []),
    "--config",
    'web_search="disabled"',
    ...CODEX_TITLE_CONFIG_OVERRIDES.flatMap((override) => ["--config", override]),
    "--ask-for-approval",
    "never",
    "--sandbox",
    "read-only",
    "--cd",
    input.cwd,
    ...DISABLED_CODEX_TITLE_FEATURES.flatMap((feature) => ["--disable", feature]),
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--json",
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.outputPath,
    "-",
  ];
}

/**
 * Reads `codex exec --json` events (JSON Lines) and the last-message file.
 * Usage comes from the last `turn.completed`; a `turn.failed` or top-level
 * `error` event fails the turn. Non-JSON lines are ignored.
 */
export function parseCodexResult(
  stdout: string,
  exitCode: number,
  lastMessage: string | undefined,
): ConsolidationTurn {
  let usage: Record<string, unknown> | undefined;
  let failure: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "turn.completed" && typeof event.usage === "object" && event.usage) {
      usage = event.usage as Record<string, unknown>;
    } else if (event.type === "turn.failed" || event.type === "error") {
      failure = String(event.type);
    }
  }
  let answer: unknown;
  if (lastMessage !== undefined && lastMessage.trim()) {
    try {
      answer = JSON.parse(lastMessage);
    } catch {
      failure ??= "unparseable answer";
    }
  }
  if (exitCode !== 0) failure = `exit ${exitCode}`;
  else if (!usage && !failure) failure = "no turn.completed event";
  const inputTokens = count(usage?.input_tokens);
  const cacheReadTokens = count(usage?.cached_input_tokens);
  return {
    ok: failure === undefined,
    ...(failure === undefined ? {} : { failure }),
    ...(answer === undefined ? {} : { answer }),
    inputTokens,
    outputTokens: count(usage?.output_tokens),
    cacheReadTokens,
    // OpenAI's input count includes the cached part; there is no write count.
    cacheWriteTokens: undefined,
  };
}

export interface ConsolidationRunInput {
  provider: EvaluationProvider;
  executable: string;
  prompt: string;
  model: string | undefined;
  /** One shared working directory; a fresh temporary one per call when absent. */
  fixedCwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface ChildOutcome {
  stdout: string;
  exitCode: number;
  /** The deadline passed; the child's process group was sent SIGTERM, then SIGKILL. */
  timedOut: boolean;
}

/**
 * Runs one CLI through the shared command capture, which leads the child's own
 * process group, escalates SIGTERM to SIGKILL on the whole group at the
 * deadline and settles even when a descendant holds the output open. A
 * non-zero exit is an outcome here, not an error: the parsers classify it.
 */
export async function runChild(
  argv: string[],
  options: { cwd?: string; stdin?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<ChildOutcome> {
  const [command, ...args] = argv;
  if (!command) throw new Error("runChild needs an executable");
  try {
    const { stdout } = await runCommand(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      // An empty prompt closes stdin at once, as a CLI awaiting EOF needs.
      ...(options.stdin ? { stdin: options.stdin } : {}),
      timeoutMs: options.timeoutMs,
    });
    return { stdout, exitCode: 0, timedOut: false };
  } catch (error) {
    if (!(error instanceof CommandFailedError)) throw error;
    if (error.timedOut) return { stdout: "", exitCode: -1, timedOut: true };
    if (error.executableMissing) return { stdout: "", exitCode: 127, timedOut: false };
    return { stdout: error.stdout, exitCode: error.exitCode ?? -1, timedOut: false };
  }
}

const TIMED_OUT: ConsolidationTurn = { ok: false, failure: "timed out" };

/** Runs one consolidation turn on the chosen provider's CLI. */
export async function runConsolidation(input: ConsolidationRunInput): Promise<ConsolidationTurn> {
  const timeoutMs = input.timeoutMs ?? CONSOLIDATION_TURN_TIMEOUT_MS;
  const cwd = input.fixedCwd ?? (await mkdtemp(path.join(tmpdir(), "mre-live-")));
  try {
    if (input.provider === "claude") {
      const { stdout, exitCode, timedOut } = await runChild(
        [input.executable, ...claudeConsolidationArgs(input.model)],
        { cwd, stdin: input.prompt, timeoutMs, env: input.env },
      );
      return timedOut ? TIMED_OUT : parseClaudeResult(stdout, exitCode);
    }
    const files = await mkdtemp(path.join(tmpdir(), "mre-live-codex-"));
    try {
      const schemaPath = path.join(files, "report-schema.json");
      const outputPath = path.join(files, "answer.json");
      await writeFile(schemaPath, JSON.stringify(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA));
      const { stdout, exitCode, timedOut } = await runChild(
        [
          input.executable,
          ...codexConsolidationArgs({ cwd, model: input.model, schemaPath, outputPath }),
        ],
        { cwd, stdin: input.prompt, timeoutMs, env: input.env },
      );
      if (timedOut) return TIMED_OUT;
      const written = await readFile(outputPath).catch(() => undefined);
      if (written && written.length > MAX_CODEX_ANSWER_BYTES) {
        return { ok: false, failure: "answer over the size limit" };
      }
      return parseCodexResult(stdout, exitCode, written?.toString("utf8"));
    } finally {
      await rm(files, { recursive: true, force: true });
    }
  } finally {
    if (!input.fixedCwd) await rm(cwd, { recursive: true, force: true });
  }
}

/** `<executable> --version`, first line, for the run record; undefined when it fails. */
export async function executableVersion(
  executable: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const { stdout, exitCode } = await runChild([executable, "--version"], { timeoutMs, env });
    return exitCode === 0 ? stdout.trim().split("\n")[0]?.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}
